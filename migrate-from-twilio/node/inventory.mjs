#!/usr/bin/env node
/**
 * Twilio → Dial migration inventory.
 *
 * Reads a Twilio account and writes `twilio-inventory.json` — plus a set of
 * spreadsheet-ready CSVs — describing what is on it: the numbers and what they
 * can do, how they are wired today, how much traffic actually flows through
 * them, and the 10DLC registrations behind that traffic.
 *
 * It reports, it does not advise. Customers run this against their own account
 * and send back the result, so everything here is a fact read from Twilio —
 * no recommendations, no pricing, no judgement about what should move.
 *
 * Two properties are deliberate, because the people running this are handing a
 * script their production telecom credentials:
 *
 *   - **Zero dependencies.** Node 18+ and nothing else, so the whole thing can
 *     be read top to bottom before it runs.
 *   - **Read-only.** Every request below is a GET. There is no code path in this
 *     file that creates, updates, or deletes anything in a Twilio account.
 *
 * Usage:
 *   node inventory.mjs [--per-number] [--no-csv] [--out FILE]
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";

/**
 * Load `.env` next to this script. Node only reads one automatically when it is
 * started with --env-file, and the documented way to run this is a bare
 * `node inventory.mjs` — so parse it here rather than making the README carry a
 * flag. Real environment variables always win, so exporting a value overrides
 * the file. Deliberately tiny: no dependency is worth adding for this.
 */
function loadDotEnv(path = new URL(".env", import.meta.url)) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

// Usage categories worth pulling. Twilio exposes hundreds; these are the ones
// that map onto something Dial either charges for or cannot do.
const USAGE_CATEGORIES = [
  "sms-inbound",
  "sms-outbound",
  "mms-inbound",
  "mms-outbound",
  "calls-inbound",
  "calls-outbound",
];

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { perNumber: false, out: "twilio-inventory.json", maxScan: 50000, csv: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--per-number") opts.perNumber = true;
    else if (arg === "--no-csv") opts.csv = false;
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--max-scan") opts.maxScan = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(`Twilio → Dial migration inventory (read-only)

  --per-number    Also count messages/calls per number (slow; see README)
  --max-scan N    Cap records scanned by --per-number (default 50000)
  --out FILE      Output path (default twilio-inventory.json)
  --no-csv        Skip the CSV; write only the JSON
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

// ── Twilio HTTP ────────────────────────────────────────────────────────────

/**
 * Credentials. An API Key (SK…) + secret is preferred over the account's main
 * auth token: it is revocable on its own, so the key handed to a migration
 * script can be destroyed afterwards without rotating the account.
 */
function credentials() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const key = process.env.TWILIO_API_KEY || accountSid;
  const secret = process.env.TWILIO_API_SECRET || process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !secret) {
    console.error(
      "Missing credentials. Set TWILIO_ACCOUNT_SID and either\n" +
        "  TWILIO_API_KEY + TWILIO_API_SECRET  (preferred), or\n" +
        "  TWILIO_AUTH_TOKEN\n" +
        "Copy .env.example to .env and fill it in.",
    );
    process.exit(1);
  }
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) {
    console.error(`TWILIO_ACCOUNT_SID should look like AC… — got "${accountSid}"`);
    process.exit(1);
  }
  return { accountSid, auth: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64") };
}

let AUTH_HEADER = "";

async function twilioGet(url, { tolerate404 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: AUTH_HEADER, Accept: "application/json" } });

    // Twilio rate-limits with 429; back off and retry a few times.
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get("retry-after") || 2) * 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 404 && tolerate404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Twilio rejected the credentials (${res.status}). Check TWILIO_ACCOUNT_SID and the key/token, ` +
          `and that the key belongs to this account.`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }
    return res.json();
  }
}

/**
 * Twilio has two pagination dialects: the 2010-04-01 API returns a
 * `next_page_uri` path, while the newer versioned APIs return
 * `meta.next_page_url` plus `meta.key`. Handle both so callers don't care.
 */
async function twilioList(url, resourceKey, { limit = Infinity, tolerate404 = false } = {}) {
  const out = [];
  let next = url;
  while (next && out.length < limit) {
    const page = await twilioGet(next, { tolerate404 });
    if (!page) return out;

    const key = page.meta?.key || resourceKey;
    const items = page[key];
    if (!Array.isArray(items)) break;
    out.push(...items);

    const rawNext = page.meta?.next_page_url ?? page.next_page_uri ?? null;
    if (!rawNext) break;
    next = rawNext.startsWith("http") ? rawNext : `https://api.twilio.com${rawNext}`;
  }
  return out.slice(0, limit);
}

// ── Helpers ────────────────────────────────────────────────────────────────

const A = (sid) => `https://api.twilio.com/2010-04-01/Accounts/${sid}`;

/**
 * The usage window always starts at the account's creation date — a migration
 * wants the whole history, not a trailing window, and Twilio dates the account
 * for us. Twilio returns RFC-2822 ("Tue, 18 Aug 2020 20:04:00 +0000"); the
 * Usage API wants YYYY-MM-DD.
 */
function toStartDate(twilioDate) {
  const parsed = new Date(twilioDate);
  if (Number.isNaN(parsed.getTime())) {
    // Never seen in practice, but a bad date shouldn't lose the whole run —
    // 2008 predates Twilio itself, so it can only over-collect.
    return "2008-01-01";
  }
  parsed.setUTCDate(1);
  return parsed.toISOString().slice(0, 10);
}

/** Twilio reports country via the number itself; derive an ISO-ish hint. */
function countryOf(num) {
  if (typeof num !== "string" || !num.startsWith("+")) return "unknown";
  if (num.startsWith("+1")) return "US/CA";
  return "non-US";
}

function sum(rows, field) {
  return rows.reduce((t, r) => t + (Number(r[field]) || 0), 0);
}

// ── Collectors ─────────────────────────────────────────────────────────────

async function fetchAccount(sid) {
  const acct = await twilioGet(`${A(sid)}.json`);
  return {
    sid: acct.sid,
    friendlyName: acct.friendly_name,
    status: acct.status,
    type: acct.type, // "Trial" or "Full"
    dateCreated: acct.date_created,
  };
}

async function fetchSubaccounts(sid) {
  const accounts = await twilioList(
    `https://api.twilio.com/2010-04-01/Accounts.json?PageSize=1000`,
    "accounts",
  );
  return accounts
    .filter((a) => a.sid !== sid)
    .map((a) => ({ sid: a.sid, friendlyName: a.friendly_name, status: a.status }));
}

async function fetchNumbers(sid) {
  const numbers = await twilioList(`${A(sid)}/IncomingPhoneNumbers.json?PageSize=1000`, "incoming_phone_numbers");
  return numbers.map((n) => ({
    sid: n.sid,
    number: n.phone_number,
    country: countryOf(n.phone_number),
    friendlyName: n.friendly_name,
    capabilities: {
      voice: !!n.capabilities?.voice,
      sms: !!n.capabilities?.sms,
      mms: !!n.capabilities?.mms,
      fax: !!n.capabilities?.fax,
    },
    // How the number is wired today. Each of these is a behavior that has to be
    // re-expressed on Dial — a TwiML URL becomes an inbound agent instruction,
    // an SMS webhook becomes a Dial webhook subscription.
    voiceUrl: n.voice_url || null,
    voiceApplicationSid: n.voice_application_sid || null,
    smsUrl: n.sms_url || null,
    smsApplicationSid: n.sms_application_sid || null,
    statusCallback: n.status_callback || null,
    messagingServiceSid: n.messaging_service_sid || null,
    trunkSid: n.trunk_sid || null,
    emergencyStatus: n.emergency_status || null,
    addressRequired: n.address_sid ? true : false,
    dateCreated: n.date_created,
  }));
}

async function fetchShortCodes(sid) {
  const codes = await twilioList(`${A(sid)}/SMS/ShortCodes.json?PageSize=1000`, "short_codes", {
    tolerate404: true,
  });
  return codes.map((c) => ({
    sid: c.sid,
    shortCode: c.short_code,
    friendlyName: c.friendly_name,
    smsUrl: c.sms_url || null,
  }));
}

/**
 * Usage for one scope.
 *
 * Twilio's Usage API defaults to `IncludeSubaccounts=true`, so a parent
 * account's usage silently contains every subaccount's traffic — while
 * IncomingPhoneNumbers, Calls and Messages on the same account are parent-only.
 * Left at the default, the inventory reports numbers for one account and
 * traffic for hundreds, and running it per subaccount then double-counts.
 * So the parameter is always sent explicitly, and both scopes are collected
 * when subaccounts exist.
 */
async function fetchUsage(sid, startDate, includeSubaccounts) {
  const byCategory = {};

  for (const category of USAGE_CATEGORIES) {
    const rows = await twilioList(
      `${A(sid)}/Usage/Records/Monthly.json?Category=${category}&StartDate=${startDate}` +
        `&IncludeSubaccounts=${includeSubaccounts ? "true" : "false"}&PageSize=1000`,
      "usage_records",
    );
    byCategory[category] = rows.map((r) => ({
      month: r.start_date?.slice(0, 7),
      count: Number(r.count) || 0,
      usage: Number(r.usage) || 0,
      usageUnit: r.usage_unit,
      price: Number(r.price) || 0,
      priceUnit: r.price_unit,
    }));
  }

  // Roll the monthly rows into totals and a per-month average, which is what a
  // quote is actually built from.
  // Twilio only returns months that actually have records, so the denominator
  // is the number of months observed, not the number requested. It's reported
  // alongside the average so a sparse account doesn't read as a busy one.
  const totals = {};
  for (const [category, rows] of Object.entries(byCategory)) {
    const observedMonths = rows.length || 1;
    totals[category] = {
      monthsObserved: rows.length,
      totalCount: sum(rows, "count"),
      totalUsage: Number(sum(rows, "usage").toFixed(2)),
      usageUnit: rows[0]?.usageUnit ?? null,
      totalPrice: Number(sum(rows, "price").toFixed(2)),
      avgMonthlyCount: Math.round(sum(rows, "count") / observedMonths),
      avgMonthlyUsage: Number((sum(rows, "usage") / observedMonths).toFixed(2)),
    };
  }

  return { since: startDate, includesSubaccounts: includeSubaccounts, monthly: byCategory, totals };
}

async function fetchMessagingServices(sid) {
  const services = await twilioList(
    "https://messaging.twilio.com/v1/Services?PageSize=1000",
    "services",
    { tolerate404: true },
  );

  const out = [];
  for (const s of services) {
    // Each Messaging Service carries at most one A2P campaign.
    const campaigns = await twilioList(
      `https://messaging.twilio.com/v1/Services/${s.sid}/Compliance/Usa2p?PageSize=50`,
      "compliance",
      { tolerate404: true },
    ).catch(() => []);

    out.push({
      sid: s.sid,
      friendlyName: s.friendly_name,
      inboundRequestUrl: s.inbound_request_url || null,
      statusCallback: s.status_callback || null,
      useInboundWebhookOnNumber: !!s.use_inbound_webhook_on_number,
      campaigns: campaigns.map((c) => ({
        sid: c.sid,
        brandRegistrationSid: c.brand_registration_sid,
        status: c.campaign_status,
        useCase: c.us_app_to_person_usecase,
        description: c.description,
      })),
    });
  }
  return out;
}

async function fetchBrands() {
  const brands = await twilioList(
    "https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=1000",
    "data",
    { tolerate404: true },
  ).catch(() => []);

  return brands.map((b) => ({
    sid: b.sid,
    status: b.status,
    brandType: b.brand_type,
    identityStatus: b.identity_status,
    failureReason: b.failure_reason || null,
  }));
}

/**
 * Optional per-number traffic. The Usage API reports account totals only, so
 * the only way to attribute volume to a number is to walk the Messages and
 * Calls lists. That is slow and rate-limited on a busy account, which is why
 * it is opt-in and capped.
 */
async function fetchPerNumber(sid, since, maxScan) {
  const counts = new Map();
  /** Get (or create) the tally row for a number, so callers can just increment. */
  const rowFor = (num) => {
    if (!num) return null;
    let row = counts.get(num);
    if (!row) {
      row = { messagesOut: 0, messagesIn: 0, callsOut: 0, callsIn: 0, callMinutes: 0 };
      counts.set(num, row);
    }
    return row;
  };

  let truncated = false;

  const messages = await twilioList(
    `${A(sid)}/Messages.json?DateSent%3E=${since}&PageSize=1000`,
    "messages",
    { limit: maxScan },
  );
  if (messages.length >= maxScan) truncated = true;
  for (const m of messages) {
    const outbound = String(m.direction || "").startsWith("outbound");
    const num = outbound ? m.from : m.to;
    const row = rowFor(num);
    if (!row) continue;
    if (outbound) row.messagesOut++;
    else row.messagesIn++;
  }

  const calls = await twilioList(`${A(sid)}/Calls.json?StartTime%3E=${since}&PageSize=1000`, "calls", {
    limit: maxScan,
  });
  if (calls.length >= maxScan) truncated = true;
  for (const c of calls) {
    const outbound = String(c.direction || "").startsWith("outbound");
    const num = outbound ? c.from : c.to;
    const row = rowFor(num);
    if (!row) continue;
    if (outbound) row.callsOut++;
    else row.callsIn++;
    row.callMinutes += Math.ceil((Number(c.duration) || 0) / 60);
  }

  // Keys here include counterparty and subaccount numbers, not just the ones
  // on this account.
  const numbers = Object.fromEntries(counts);

  return {
    since,
    truncated,
    scannedMessages: messages.length,
    scannedCalls: calls.length,
    numbers,
  };
}



// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * One escape handles two problems at once.
 *
 * Excel treats a cell starting with `=`, `+`, `-` or `@` as a formula — which
 * mangles every E.164 number in this file, and, worse, turns a friendly name
 * someone chose in Twilio into executable content when the sheet is opened
 * (CSV injection). Prefixing those values with an apostrophe is Excel's own
 * "this is text" marker: it forces the cell to text, displays nothing, and
 * defuses the formula. Other readers show a literal apostrophe, which is the
 * right trade when the stated destination is a spreadsheet.
 */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";

  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Everything in one sheet.
 *
 * The inventory is several tables of different shapes, so they are stacked as
 * titled sections rather than forced into one set of columns — a union of every
 * column would leave most cells blank on most rows and read worse. Excel and
 * Sheets both open a stacked CSV fine; each section has its own header row and
 * a blank line before the next.
 */
function buildCsv(inv) {
  const sections = [];
  const section = (title, headers, rows) => {
    if (!rows.length) return;
    sections.push({ title, headers, rows });
  };

  section("ACCOUNT", ["field", "value"], [
    ["account_sid", inv.account.sid],
    ["friendly_name", inv.account.friendlyName],
    ["type", inv.account.type],
    ["status", inv.account.status],
    ["date_created", inv.account.dateCreated],
    ["usage_since", inv.since],
    ["subaccounts", inv.subaccounts.length],
    ["numbers", inv.numbers.length],
    ["short_codes", inv.shortCodes.length],
    ["generated_at", inv.generatedAt],
  ]);

  section(
    "NUMBERS",
    [
      "number", "country", "friendly_name", "voice", "sms", "mms", "fax",
      "voice_url", "sms_url", "status_callback", "messaging_service_sid",
      "trunk_sid", "emergency_status", "date_created", "sid",
    ],
    inv.numbers.map((n) => [
      n.number, n.country, n.friendlyName,
      n.capabilities.voice, n.capabilities.sms, n.capabilities.mms, n.capabilities.fax,
      n.voiceUrl, n.smsUrl, n.statusCallback, n.messagingServiceSid,
      n.trunkSid, n.emergencyStatus, n.dateCreated, n.sid,
    ]),
  );

  section(
    "SHORT CODES",
    ["short_code", "friendly_name", "sms_url", "sid"],
    inv.shortCodes.map((c) => [c.shortCode, c.friendlyName, c.smsUrl, c.sid]),
  );

  // Scope matters: `this-account` matches the numbers above, `with-subaccounts`
  // is the rolled-up figure the Twilio console shows.
  const scopes = [["this-account", inv.usage]];
  if (inv.usageWithSubaccounts) scopes.push(["with-subaccounts", inv.usageWithSubaccounts]);

  section(
    "USAGE TOTALS",
    ["scope", "category", "months_observed", "total_count", "total_usage", "usage_unit", "total_price", "avg_monthly_count", "avg_monthly_usage"],
    scopes.flatMap(([scope, u]) =>
      Object.entries(u.totals)
        .filter(([, t]) => t.totalCount || t.totalUsage)
        .map(([category, t]) => [
          scope, category, t.monthsObserved, t.totalCount, t.totalUsage, t.usageUnit,
          t.totalPrice, t.avgMonthlyCount, t.avgMonthlyUsage,
        ]),
    ),
  );

  const byMonth = [];
  for (const [scope, u] of scopes) {
    for (const [category, months] of Object.entries(u.monthly)) {
      for (const m of months) {
        byMonth.push([scope, m.month, category, m.count, m.usage, m.usageUnit, m.price, m.priceUnit]);
      }
    }
  }
  byMonth.sort(
    (a, b) =>
      String(a[0]).localeCompare(String(b[0])) ||
      String(a[1]).localeCompare(String(b[1])) ||
      String(a[2]).localeCompare(String(b[2])),
  );
  section("USAGE BY MONTH", ["scope", "month", "category", "count", "usage", "usage_unit", "price", "price_unit"], byMonth);

  section(
    "MESSAGING SERVICES",
    ["sid", "friendly_name", "inbound_request_url", "status_callback", "use_inbound_webhook_on_number", "campaign_sid", "campaign_status", "campaign_use_case", "brand_sid"],
    inv.messagingServices.flatMap((s) => {
      const base = [s.sid, s.friendlyName, s.inboundRequestUrl, s.statusCallback, s.useInboundWebhookOnNumber];
      if (!s.campaigns.length) return [[...base, "", "", "", ""]];
      return s.campaigns.map((c) => [...base, c.sid, c.status, c.useCase, c.brandRegistrationSid]);
    }),
  );

  section(
    "10DLC BRANDS",
    ["sid", "status", "brand_type", "identity_status", "failure_reason"],
    inv.brands.map((b) => [b.sid, b.status, b.brandType, b.identityStatus, b.failureReason]),
  );

  if (inv.perNumber) {
    section(
      "PER-NUMBER TRAFFIC",
      ["number", "messages_out", "messages_in", "calls_out", "calls_in", "call_minutes"],
      Object.entries(inv.perNumber.numbers).map(([num, r]) => [
        num, r.messagesOut, r.messagesIn, r.callsOut, r.callsIn, r.callMinutes,
      ]),
    );
  }

  section(
    "SUBACCOUNTS",
    ["sid", "friendly_name", "status"],
    inv.subaccounts.map((s) => [s.sid, s.friendlyName, s.status]),
  );

  const lines = [];
  for (const { title, headers, rows } of sections) {
    if (lines.length) lines.push("");
    // Bracketed, not "== TITLE ==": a leading = would trip the formula escape
    // above and land an apostrophe in the file.
    lines.push(csvCell(`[${title}]`));
    lines.push(headers.map(csvCell).join(","));
    for (const row of rows) lines.push(row.map(csvCell).join(","));
  }
  // BOM so Excel reads it as UTF-8, CRLF because Excel is happiest with it.
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

// ── Report ─────────────────────────────────────────────────────────────────

function printSummary(inv) {
  const { account, numbers, usage } = inv;
  const line = (s = "") => console.log(s);

  line();
  line("─".repeat(72));
  line("  Twilio → Dial migration inventory");
  line("─".repeat(72));
  line(`  Account       ${account.friendlyName} (${account.sid})`);
  line(`  Type          ${account.type}${account.status !== "active" ? ` · ${account.status}` : ""}`);
  if (inv.subaccounts.length) line(`  Subaccounts   ${inv.subaccounts.length} (not scanned — run again per subaccount)`);
  line();

  const cap = (k) => numbers.filter((n) => n.capabilities[k]).length;
  line(`  Numbers       ${numbers.length}  ·  voice ${cap("voice")} · sms ${cap("sms")} · mms ${cap("mms")}`);
  line(`  US/CA         ${numbers.filter((n) => n.country === "US/CA").length}`);
  if (inv.shortCodes.length) line(`  Short codes   ${inv.shortCodes.length}`);
  line();

  const observed = Math.max(0, ...USAGE_CATEGORIES.map((c) => usage.totals[c]?.monthsObserved || 0));
  line(
    `  Usage — this account only, full history since ${usage.since}` +
      `  (${observed} month${observed === 1 ? "" : "s"} with activity)`,
  );
  for (const c of USAGE_CATEGORIES) {
    const t = usage.totals[c];
    if (!t || (!t.totalCount && !t.totalUsage)) continue;
    const unit = t.usageUnit ? ` ${t.usageUnit}` : "";
    line(
      `    ${c.padEnd(16)} ${String(t.totalCount).padStart(9)} total  ·  ${String(t.avgMonthlyCount).padStart(
        8,
      )}/mo  ·  ${t.totalUsage}${unit}`,
    );
  }
  line();

  // Only worth showing when subaccounts actually carry traffic of their own.
  const roll = inv.usageWithSubaccounts;
  if (roll) {
    const differs = USAGE_CATEGORIES.some(
      (c) => (roll.totals[c]?.totalCount || 0) !== (usage.totals[c]?.totalCount || 0),
    );
    if (differs) {
      line(`  Including all ${inv.subaccounts.length} subaccounts`);
      for (const c of USAGE_CATEGORIES) {
        const t = roll.totals[c];
        const own = usage.totals[c]?.totalCount || 0;
        if (!t || (!t.totalCount && !t.totalUsage)) continue;
        const unit = t.usageUnit ? ` ${t.usageUnit}` : "";
        line(
          `    ${c.padEnd(16)} ${String(t.totalCount).padStart(9)} total  ·  ` +
            `${String(t.totalCount - own).padStart(8)} from subaccounts  ·  ${t.totalUsage}${unit}`,
        );
      }
    } else {
      line("  Subaccounts carry no traffic of their own.");
    }
    line();
  }

  line("─".repeat(72));
  line();
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { accountSid, auth } = credentials();
  AUTH_HEADER = auth;

  const step = (msg) => process.stderr.write(`  … ${msg}\n`);

  step("account");
  const account = await fetchAccount(accountSid);

  // Everything time-bounded below starts the day the account was created, so a
  // migration sees the full history rather than a window someone had to pick.
  const since = toStartDate(account.dateCreated);

  step("subaccounts");
  const subaccounts = await fetchSubaccounts(accountSid);

  step("phone numbers");
  const numbers = await fetchNumbers(accountSid);

  step("short codes");
  const shortCodes = await fetchShortCodes(accountSid);

  // Parent-only, so the traffic matches the numbers listed above it.
  step(`usage (since ${since})`);
  const usage = await fetchUsage(accountSid, since, false);

  // The rollup is the account's true footprint, and is what the Twilio console
  // shows. Only worth a second pass when there are subaccounts to roll up.
  let usageWithSubaccounts = null;
  if (subaccounts.length) {
    step(`usage including ${subaccounts.length} subaccount(s)`);
    usageWithSubaccounts = await fetchUsage(accountSid, since, true);
  }

  step("messaging services & 10DLC campaigns");
  const messagingServices = await fetchMessagingServices(accountSid);

  step("10DLC brands");
  const brands = await fetchBrands();

  let perNumber = null;
  if (opts.perNumber) {
    step(`per-number traffic (scanning up to ${opts.maxScan} records each)`);
    perNumber = await fetchPerNumber(accountSid, since, opts.maxScan);
  }

  const inventory = {
    generatedAt: new Date().toISOString(),
    generatedBy: "dial playbooks/migrate-from-twilio/node",
    since,
    account,
    subaccounts,
    numbers,
    shortCodes,
    usage,
    usageWithSubaccounts,
    messagingServices,
    brands,
    perNumber,
  };

  writeFileSync(opts.out, JSON.stringify(inventory, null, 2));
  let csvPath = null;
  if (opts.csv) {
    csvPath = opts.out.replace(/\.json$/i, "") + ".csv";
    writeFileSync(csvPath, buildCsv(inventory));
  }

  printSummary(inventory);
  console.log(`  Written to ${opts.out}`);
  if (csvPath) console.log(`             ${csvPath}`);
}

main().catch((err) => {
  console.error(`\n  Failed: ${err.message}\n`);
  process.exit(1);
});
