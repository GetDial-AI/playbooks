#!/usr/bin/env node
/**
 * Twilio → Dial migration inventory.
 *
 * Reads a Twilio account and writes a single `twilio-inventory.json` describing
 * everything that has to be accounted for in a migration: the numbers and what
 * they can do, how much traffic actually flows through them, the 10DLC
 * registrations behind that traffic, and the things Dial cannot take as-is.
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
 *   node inventory.mjs [--months 12] [--redact] [--per-number] [--out FILE]
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

// ── Dial list prices, for the cost estimate ────────────────────────────────
// Published at https://getdial.ai/pricing. These are list rates: volume
// pricing is a conversation, not a constant, so the estimate is an upper bound.
const DIAL_RATES = {
  numberPerMonth: 3.0,
  smsPerMessageUS: 0.02,
  voicePerMinuteManaged: 0.22,
  voicePerMinuteSelfHosted: 0.13,
};

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
  const opts = { months: 12, redact: false, perNumber: false, out: "twilio-inventory.json", maxScan: 50000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--redact") opts.redact = true;
    else if (arg === "--per-number") opts.perNumber = true;
    else if (arg === "--months") opts.months = Number(argv[++i]);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--max-scan") opts.maxScan = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(`Twilio → Dial migration inventory (read-only)

  --months N      How many months of usage history to pull (default 12)
  --redact        Mask phone numbers in the output; keep counts and capabilities
  --per-number    Also count messages/calls per number (slow; see README)
  --max-scan N    Cap records scanned by --per-number (default 50000)
  --out FILE      Output path (default twilio-inventory.json)
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(opts.months) || opts.months < 1) {
    console.error("--months must be a positive number");
    process.exit(1);
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

function monthsAgo(n) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}

/** Mask a number for sharing before a contract is signed: +1415555**** */
function maskNumber(e164) {
  if (typeof e164 !== "string" || e164.length < 5) return e164;
  return e164.slice(0, -4) + "****";
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

async function fetchNumbers(sid, redact) {
  const numbers = await twilioList(`${A(sid)}/IncomingPhoneNumbers.json?PageSize=1000`, "incoming_phone_numbers");
  return numbers.map((n) => ({
    sid: n.sid,
    number: redact ? maskNumber(n.phone_number) : n.phone_number,
    country: countryOf(n.phone_number),
    friendlyName: redact ? undefined : n.friendly_name,
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

async function fetchShortCodes(sid, redact) {
  const codes = await twilioList(`${A(sid)}/SMS/ShortCodes.json?PageSize=1000`, "short_codes", {
    tolerate404: true,
  });
  return codes.map((c) => ({
    sid: c.sid,
    shortCode: redact ? "****" : c.short_code,
    friendlyName: redact ? undefined : c.friendly_name,
    smsUrl: c.sms_url || null,
  }));
}

async function fetchUsage(sid, months) {
  const startDate = monthsAgo(months);
  const byCategory = {};

  for (const category of USAGE_CATEGORIES) {
    const rows = await twilioList(
      `${A(sid)}/Usage/Records/Monthly.json?Category=${category}&StartDate=${startDate}&PageSize=1000`,
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

  return { since: startDate, monthly: byCategory, totals };
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
async function fetchPerNumber(sid, months, maxScan, redact) {
  const since = monthsAgo(months);
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

  // These keys include counterparty and subaccount numbers, not just the ones
  // on this account — so --redact has to reach them too.
  const numbers = Object.fromEntries(
    [...counts.entries()].map(([num, row]) => [redact ? maskNumber(num) : num, row]),
  );

  return {
    since,
    truncated,
    scannedMessages: messages.length,
    scannedCalls: calls.length,
    numbers,
  };
}

// ── Analysis ───────────────────────────────────────────────────────────────

/**
 * The part a human actually reads: what moves cleanly, what needs a decision,
 * and what Dial does not do at all. Everything here is derived from the data
 * above — no extra API calls.
 */
function analyze({ numbers, shortCodes, usage, messagingServices }) {
  const blockers = [];
  const decisions = [];
  const notes = [];

  const nonUS = numbers.filter((n) => n.country === "non-US");
  if (nonUS.length) {
    blockers.push(
      `${nonUS.length} number(s) are outside the US/CA. Dial provisions US numbers today, so these need a ` +
        `plan of their own — keep them where they are, or replace the workflow with a US number.`,
    );
  }

  if (shortCodes.length) {
    blockers.push(
      `${shortCodes.length} short code(s) in use. Dial does not offer short codes; short-code traffic has to ` +
        `move to long codes or stay put.`,
    );
  }

  const faxOnly = numbers.filter((n) => n.capabilities.fax && !n.capabilities.voice && !n.capabilities.sms);
  if (faxOnly.length) {
    blockers.push(`${faxOnly.length} fax-only number(s). Dial does not carry fax.`);
  }

  const trunked = numbers.filter((n) => n.trunkSid);
  if (trunked.length) {
    blockers.push(
      `${trunked.length} number(s) are attached to a SIP trunk. Dial is an API/agent platform, not a SIP ` +
        `carrier — trunked numbers need a different home.`,
    );
  }

  const mmsUsed = (usage.totals["mms-outbound"]?.totalCount || 0) + (usage.totals["mms-inbound"]?.totalCount || 0);
  if (mmsUsed > 0) {
    notes.push(`${mmsUsed} MMS message(s) in the window — Dial sends media, confirm the formats you rely on.`);
  }

  const withVoiceApp = numbers.filter((n) => n.voiceUrl || n.voiceApplicationSid);
  if (withVoiceApp.length) {
    decisions.push(
      `${withVoiceApp.length} number(s) answer calls with TwiML. Dial answers with an AI voice agent driven by an ` +
        `instruction, not a TwiML document — each of these flows has to be rewritten as an inbound instruction, or ` +
        `run self-hosted over a WebSocket if you want to keep your own logic.`,
    );
  }

  const withSmsWebhook = numbers.filter((n) => n.smsUrl || n.smsApplicationSid);
  if (withSmsWebhook.length) {
    decisions.push(
      `${withSmsWebhook.length} number(s) post inbound SMS to a webhook. On Dial this becomes one account-level ` +
        `webhook subscription (or an event stream), not a per-number URL.`,
    );
  }

  const campaigns = messagingServices.flatMap((s) => s.campaigns);
  if (campaigns.length) {
    decisions.push(
      `${campaigns.length} A2P 10DLC campaign(s) registered on Twilio. Registrations belong to the account that ` +
        `filed them and do not transfer — you re-register on Dial. Keep the Twilio campaign alive until cutover ` +
        `is finished.`,
    );
  }

  const tollFree = numbers.filter((n) => /^\+1(800|833|844|855|866|877|888)/.test(n.number));
  if (tollFree.length) {
    notes.push(`${tollFree.length} toll-free number(s) — toll-free verification is a separate process from 10DLC.`);
  }

  return { blockers, decisions, notes };
}

/** Upper-bound monthly estimate at Dial list prices. */
function estimate({ numbers, usage }) {
  const movable = numbers.filter((n) => n.country === "US/CA").length;
  const smsPerMonth =
    (usage.totals["sms-outbound"]?.avgMonthlyCount || 0) + (usage.totals["sms-inbound"]?.avgMonthlyCount || 0);
  const voiceMinutesPerMonth =
    (usage.totals["calls-outbound"]?.avgMonthlyUsage || 0) + (usage.totals["calls-inbound"]?.avgMonthlyUsage || 0);

  const numberCost = movable * DIAL_RATES.numberPerMonth;
  const smsCost = smsPerMonth * DIAL_RATES.smsPerMessageUS;
  const voiceManaged = voiceMinutesPerMonth * DIAL_RATES.voicePerMinuteManaged;
  const voiceSelfHosted = voiceMinutesPerMonth * DIAL_RATES.voicePerMinuteSelfHosted;

  const round = (n) => Number(n.toFixed(2));
  return {
    basis: {
      numbersPricedUS: movable,
      avgMonthlySms: smsPerMonth,
      avgMonthlyVoiceMinutes: Number(voiceMinutesPerMonth.toFixed(1)),
      rates: DIAL_RATES,
    },
    monthly: {
      numbers: round(numberCost),
      sms: round(smsCost),
      voiceManaged: round(voiceManaged),
      voiceSelfHosted: round(voiceSelfHosted),
      totalWithManagedVoice: round(numberCost + smsCost + voiceManaged),
      totalWithSelfHostedVoice: round(numberCost + smsCost + voiceSelfHosted),
    },
    caveat:
      "List prices, US SMS rate, and average monthly volume. International SMS is tiered, and volume pricing is " +
      "not reflected here — treat this as an upper bound, not a quote.",
  };
}

// ── Report ─────────────────────────────────────────────────────────────────

function printSummary(inv) {
  const { account, numbers, usage, analysis, dialEstimate } = inv;
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
  line(`  Usage since ${usage.since}  (${observed} month${observed === 1 ? "" : "s"} with activity)`);
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

  if (analysis.blockers.length) {
    line("  Blockers — these cannot move to Dial as-is");
    for (const b of analysis.blockers) line(`    ✗ ${b}`);
    line();
  }
  if (analysis.decisions.length) {
    line("  Decisions — these move, but the shape changes");
    for (const d of analysis.decisions) line(`    • ${d}`);
    line();
  }
  if (analysis.notes.length) {
    line("  Notes");
    for (const n of analysis.notes) line(`    – ${n}`);
    line();
  }

  const e = dialEstimate.monthly;
  line(`  Rough Dial monthly (list prices, upper bound)`);
  line(`    numbers ${e.numbers}  +  sms ${e.sms}  +  voice ${e.voiceManaged} managed / ${e.voiceSelfHosted} self-hosted`);
  line(`    ≈ $${e.totalWithManagedVoice}/mo managed   ·   $${e.totalWithSelfHostedVoice}/mo self-hosted`);
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

  step("subaccounts");
  const subaccounts = await fetchSubaccounts(accountSid);

  step("phone numbers");
  const numbers = await fetchNumbers(accountSid, opts.redact);

  step("short codes");
  const shortCodes = await fetchShortCodes(accountSid, opts.redact);

  step(`usage (${opts.months} months)`);
  const usage = await fetchUsage(accountSid, opts.months);

  step("messaging services & 10DLC campaigns");
  const messagingServices = await fetchMessagingServices(accountSid);

  step("10DLC brands");
  const brands = await fetchBrands();

  let perNumber = null;
  if (opts.perNumber) {
    step(`per-number traffic (scanning up to ${opts.maxScan} records each)`);
    perNumber = await fetchPerNumber(accountSid, opts.months, opts.maxScan, opts.redact);
  }

  const analysis = analyze({ numbers, shortCodes, usage, messagingServices });
  const dialEstimate = estimate({ numbers, usage });

  const inventory = {
    generatedAt: new Date().toISOString(),
    generatedBy: "dial playbooks/migrate-from-twilio/node",
    redacted: opts.redact,
    windowMonths: opts.months,
    account,
    subaccounts,
    numbers,
    shortCodes,
    usage,
    messagingServices,
    brands,
    perNumber,
    analysis,
    dialEstimate,
  };

  writeFileSync(opts.out, JSON.stringify(inventory, null, 2));
  printSummary(inventory);
  console.log(`  Written to ${opts.out}`);
  if (!opts.redact) {
    console.log("  Contains real phone numbers — re-run with --redact before sharing externally.\n");
  }
}

main().catch((err) => {
  console.error(`\n  Failed: ${err.message}\n`);
  process.exit(1);
});
