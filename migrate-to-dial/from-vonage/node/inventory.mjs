#!/usr/bin/env node
/**
 * Vonage → Dial migration inventory.
 *
 * Reads a Vonage API account and writes `vonage-inventory.json` — plus one
 * spreadsheet-ready CSV — describing what is on it: the numbers and what they
 * can do, how they are wired today, the applications behind that wiring, and
 * (on request) how much traffic actually flows through them.
 *
 * It reports, it does not advise. Customers run this against their own account
 * and send back the result, so everything here is a fact read from Vonage —
 * no recommendations, no pricing, no judgement about what should move.
 *
 * Two properties are deliberate, because the people running this are handing a
 * script their production telecom credentials:
 *
 *   - **Zero dependencies.** Node 18+ and nothing else, so the whole thing can
 *     be read top to bottom before it runs.
 *   - **Read-only.** Every request below is a GET. There is no code path in this
 *     file that creates, updates, or deletes anything in a Vonage account.
 *
 * One thing this cannot collect: 10DLC brands and campaigns. Vonage exposes
 * those in the dashboard only — there is no documented REST endpoint to list
 * them — so the output records the gap and the summary says what to export by
 * hand. See `tenDlc` in the JSON.
 *
 * Usage:
 *   node inventory.mjs [--usage] [--since YYYY-MM-DD] [--max-records N]
 *                      [--no-csv] [--out FILE]
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

// Vonage splits its API across two hosts: the older key/secret API on
// rest.nexmo.com (numbers, balance) and the newer one on api.nexmo.com
// (applications, subaccounts, reports). Both take the same Basic credentials.
const REST = "https://rest.nexmo.com";
const API = "https://api.nexmo.com";

// The Reports products worth pulling. Vonage exposes a dozen more (VERIFY,
// VIDEO, …); these are the two that describe phone-number traffic.
const USAGE_PRODUCTS = ["SMS", "VOICE-CALL"];

// US toll-free area codes. Vonage reports `landline-toll-free` as a number
// type, but only for some numbers, so the prefix is the reliable test.
const TOLL_FREE_NPAS = new Set(["800", "833", "844", "855", "866", "877", "888"]);

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { usage: false, since: null, maxRecords: 50000, out: "vonage-inventory.json", csv: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--usage") opts.usage = true;
    else if (arg === "--no-csv") opts.csv = false;
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--max-records") opts.maxRecords = Number(argv[++i]);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(`Vonage → Dial migration inventory (read-only)

  --usage           Also pull message/call volume (slower; see README)
  --since DATE      Start of the usage window, YYYY-MM-DD (default: 90 days ago)
  --max-records N   Cap records scanned per product (default 50000)
  --out FILE        Output path (default vonage-inventory.json)
  --no-csv          Skip the CSV; write only the JSON
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    console.error(`--since should look like 2026-01-31 — got "${opts.since}"`);
    process.exit(1);
  }
  return opts;
}

// ── Vonage HTTP ────────────────────────────────────────────────────────────

/**
 * Credentials. Vonage authenticates these endpoints with the account's API key
 * and secret, Base64-encoded and joined by a colon. Unlike some providers there
 * is no separately revocable key for read-only use, so the secret handed to this
 * script is the account's own — which is the reason the file has no write path
 * and no dependencies. Rotate it in the dashboard once the migration is done.
 */
function credentials() {
  const apiKey = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error(
      "Missing credentials. Set VONAGE_API_KEY and VONAGE_API_SECRET.\n" +
        "Copy .env.example to .env and fill it in — both values are on the\n" +
        "dashboard home page at https://dashboard.nexmo.com.",
    );
    process.exit(1);
  }
  return { apiKey, auth: "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64") };
}

let AUTH_HEADER = "";

async function vonageGet(url, { tolerate404 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: AUTH_HEADER, Accept: "application/json" } });

    // Vonage rate-limits with 429; back off and retry a few times.
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get("retry-after") || 2) * 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 404 && tolerate404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Vonage rejected the credentials (${res.status}). Check VONAGE_API_KEY and ` +
          `VONAGE_API_SECRET against the dashboard home page.`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }
    return res.json();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Vonage returns numbers bare (`14155550123`); everything downstream wants E.164. */
function toE164(msisdn) {
  if (!msisdn) return "";
  return msisdn.startsWith("+") ? msisdn : `+${msisdn}`;
}

/** The NANP area code, for the toll-free test. Empty for non-NANP numbers. */
function npaOf(msisdn) {
  const digits = String(msisdn || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1, 4) : "";
}

function monthOf(iso) {
  return typeof iso === "string" && iso.length >= 7 ? iso.slice(0, 7) : "unknown";
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// ── Reads ──────────────────────────────────────────────────────────────────

async function fetchBalance() {
  const body = await vonageGet(`${REST}/account/get-balance`, { tolerate404: true });
  if (!body) return null;
  return { value: body.value ?? null, autoReload: body.autoReload ?? null };
}

/**
 * Every number on the account. `size` caps at 100 and `index` is 1-based, so
 * this pages until it has the `count` Vonage reported on the first page.
 */
async function fetchNumbers() {
  const out = [];
  for (let index = 1; ; index++) {
    const page = await vonageGet(`${REST}/account/numbers?size=100&index=${index}`);
    const items = page?.numbers ?? [];
    out.push(...items);
    const total = Number(page?.count ?? out.length);
    if (!items.length || out.length >= total) break;
  }

  return out.map((n) => {
    const features = Array.isArray(n.features) ? n.features : [];
    const npa = npaOf(n.msisdn);
    return {
      number: toE164(n.msisdn),
      country: n.country ?? "",
      type: n.type ?? "",
      features,
      sms: features.includes("SMS"),
      voice: features.includes("VOICE"),
      mms: features.includes("MMS"),
      tollFree: TOLL_FREE_NPAS.has(npa) || String(n.type ?? "").includes("toll-free"),
      // How this number is wired today. `voiceCallbackType` is one of
      // app / tel / sip, and `voiceCallbackValue` is the matching target.
      moHttpUrl: n.moHttpUrl ?? "",
      voiceCallbackType: n.voiceCallbackType ?? "",
      voiceCallbackValue: n.voiceCallbackValue ?? "",
      messagesCallbackType: n.messagesCallbackType ?? "",
      messagesCallbackValue: n.messagesCallbackValue ?? "",
      appId: n.app_id ?? n.appId ?? "",
      // Vonage flags per-feature restrictions here (e.g. a number that cannot
      // reach some networks). Usually absent; when present it matters.
      limitations: Array.isArray(n.limitations) ? n.limitations : [],
      // Vonage documents port-out for long virtual numbers in the US and Canada
      // only. This restates that rule against the number's own country — it is
      // Vonage's published constraint, not a judgement about this number.
      // https://api.support.vonage.com/hc/en-us/articles/206027907-Porting-Long-Virtual-Numbers
      portOutSupportedByVonage: n.country === "US" || n.country === "CA",
    };
  });
}

/**
 * Applications, so a number's `app_id` resolves to a name and the webhooks
 * actually serving it. A number wired to an application carries no URLs of its
 * own — the routing lives here instead, and a migration that only read the
 * number would see blanks and conclude it was unrouted.
 */
async function fetchApplications() {
  const out = [];
  for (let page = 1; ; page++) {
    const body = await vonageGet(`${API}/v2/applications?page_size=100&page=${page}`, { tolerate404: true });
    if (!body) break;
    const items = body._embedded?.applications ?? [];
    out.push(...items);
    const totalPages = Number(body.total_pages ?? 1);
    if (!items.length || page >= totalPages) break;
  }

  return out.map((a) => {
    const caps = a.capabilities ?? {};
    const webhooks = {};
    for (const [product, config] of Object.entries(caps)) {
      for (const [hook, spec] of Object.entries(config?.webhooks ?? {})) {
        if (spec?.address) webhooks[`${product}.${hook}`] = spec.address;
      }
    }
    return {
      id: a.id,
      name: a.name ?? "",
      capabilities: Object.keys(caps),
      webhooks,
    };
  });
}

/**
 * Subaccounts, so none get missed. Their numbers are NOT listed here: Vonage
 * scopes `/account/numbers` to the credentials in the header, not to a URL, so
 * a subaccount's inventory needs a separate run with that subaccount's own key
 * and secret. Reporting the parent's numbers as the subaccount's would be wrong,
 * so the script names them and stops.
 */
async function fetchSubaccounts(apiKey) {
  const body = await vonageGet(`${API}/accounts/${apiKey}/subaccounts`, { tolerate404: true });
  const items = body?._embedded?.subaccounts ?? [];
  return items.map((s) => ({
    apiKey: s.api_key,
    name: s.name ?? "",
    suspended: s.suspended ?? false,
    usePrimaryAccountBalance: s.use_primary_account_balance ?? null,
    createdAt: s.created_at ?? "",
  }));
}

/**
 * Message and call volume over a window, via the synchronous Reports endpoint.
 *
 * Opt-in (`--usage`) and windowed, because Vonage has no aggregate: Reports
 * returns one row per message or call, so a busy account is a lot of rows for a
 * number that only sizes the migration. The rows are summed here and thrown
 * away — no message bodies or per-record detail reach the output.
 */
async function fetchUsage(apiKey, since, until, maxRecords, ownNumbers) {
  const owned = new Set(ownNumbers);
  const byMonth = {};
  const byNumber = {};
  const totals = {};
  let truncated = false;

  for (const product of USAGE_PRODUCTS) {
    for (const direction of ["inbound", "outbound"]) {
      const key = `${product.toLowerCase()}-${direction}`;
      totals[key] = { records: 0, priceTotal: 0, currency: "" };

      const params = new URLSearchParams({
        account_id: apiKey,
        product,
        direction,
        date_start: `${since}T00:00:00Z`,
        date_end: `${until}T00:00:00Z`,
      });
      let url = `${API}/v2/reports/records?${params}`;
      let scanned = 0;

      while (url && scanned < maxRecords) {
        const body = await vonageGet(url, { tolerate404: true });
        if (!body) break;
        const records = body.records ?? [];

        for (const r of records) {
          scanned++;
          // Vonage names the timestamp differently per product; take whichever
          // this row actually carries rather than assuming one shape.
          const month = monthOf(r.date_received ?? r.date_start ?? r.date_finalized ?? "");
          // The account's own number is the sender on the way out and the
          // recipient on the way in.
          const own = toE164(direction === "outbound" ? r.from : r.to);
          const price = Number(r.total_price ?? 0) || 0;

          totals[key].records++;
          totals[key].priceTotal += price;
          if (r.currency && !totals[key].currency) totals[key].currency = r.currency;

          byMonth[month] ??= {};
          byMonth[month][key] = (byMonth[month][key] ?? 0) + 1;

          // Only the account's own numbers get a row. The other end of a
          // message is a customer's handset, and a per-number table that mixed
          // the two would read as though the account owned numbers it does not
          // — besides putting third-party numbers in a file that gets emailed.
          if (own && owned.has(own)) {
            byNumber[own] ??= {};
            byNumber[own][key] = (byNumber[own][key] ?? 0) + 1;
          }
        }

        if (body.request_status === "TRUNCATED") truncated = true;
        const next = body._links?.next?.href ?? null;
        if (!next || !records.length) break;
        url = next.startsWith("http") ? next : `${API}${next}`;
      }
      if (scanned >= maxRecords) truncated = true;
    }
  }

  for (const t of Object.values(totals)) t.priceTotal = Number(t.priceTotal.toFixed(4));
  return { since, until, truncated, totals, byMonth, byNumber };
}

// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * One escape handles two problems at once.
 *
 * Excel treats a cell starting with `=`, `+`, `-` or `@` as a formula — which
 * mangles every E.164 number in this file, and, worse, turns a name someone
 * chose in Vonage into executable content when the sheet is opened (CSV
 * injection). Prefixing those values with an apostrophe is Excel's own "this is
 * text" marker: it forces the cell to text, displays nothing, and defuses the
 * formula. Other readers show a literal apostrophe, which is the right trade
 * when the stated destination is a spreadsheet.
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
    if (rows.length) sections.push({ title, headers, rows });
  };

  section("ACCOUNT", ["field", "value"], [
    ["api_key", inv.account.apiKey],
    ["balance", inv.account.balance?.value ?? ""],
    ["numbers", inv.numbers.length],
    ["applications", inv.applications.length],
    ["subaccounts", inv.subaccounts.length],
    ["usage_window", inv.usage ? `${inv.usage.since} → ${inv.usage.until}` : "not collected"],
    ["generated_at", inv.generatedAt],
  ]);

  section(
    "NUMBERS",
    [
      "number", "country", "type", "sms", "voice", "mms", "toll_free",
      "port_out_supported_by_vonage", "mo_http_url", "voice_callback_type",
      "voice_callback_value", "app_id", "limitations",
    ],
    inv.numbers.map((n) => [
      n.number, n.country, n.type, n.sms, n.voice, n.mms, n.tollFree,
      n.portOutSupportedByVonage, n.moHttpUrl, n.voiceCallbackType,
      n.voiceCallbackValue, n.appId,
      n.limitations.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join(" | "),
    ]),
  );

  section(
    "APPLICATIONS",
    ["id", "name", "capabilities", "webhooks"],
    inv.applications.map((a) => [
      a.id, a.name, a.capabilities.join(" | "),
      Object.entries(a.webhooks).map(([k, v]) => `${k}=${v}`).join(" | "),
    ]),
  );

  section(
    "SUBACCOUNTS",
    ["api_key", "name", "suspended", "shares_primary_balance", "created_at"],
    inv.subaccounts.map((s) => [s.apiKey, s.name, s.suspended, s.usePrimaryAccountBalance, s.createdAt]),
  );

  if (inv.usage) {
    const keys = Object.keys(inv.usage.totals);
    section("USAGE TOTALS", ["category", "records", "price_total", "currency"],
      keys.map((k) => [k, inv.usage.totals[k].records, inv.usage.totals[k].priceTotal, inv.usage.totals[k].currency]));

    section("USAGE BY MONTH", ["month", ...keys],
      Object.keys(inv.usage.byMonth).sort().map((m) => [m, ...keys.map((k) => inv.usage.byMonth[m][k] ?? 0)]));

    section("PER-NUMBER TRAFFIC", ["number", ...keys],
      Object.keys(inv.usage.byNumber).sort().map((n) => [n, ...keys.map((k) => inv.usage.byNumber[n][k] ?? 0)]));
  }

  section("10DLC", ["field", "value"], [
    ["collected", inv.tenDlc.collected],
    ["reason", inv.tenDlc.reason],
    ["export_by_hand_from", inv.tenDlc.where],
  ]);

  // A byte-order mark, so Excel reads the file as UTF-8 instead of turning
  // accented names into mojibake.
  let out = "﻿";
  for (const s of sections) {
    out += `[${s.title}]\n${s.headers.map(csvCell).join(",")}\n`;
    for (const row of s.rows) out += row.map(csvCell).join(",") + "\n";
    out += "\n";
  }
  return out;
}

// ── Summary ────────────────────────────────────────────────────────────────

function printSummary(inv) {
  const line = (s = "") => console.log(s);
  const byCountry = {};
  for (const n of inv.numbers) byCountry[n.country || "??"] = (byCountry[n.country || "??"] ?? 0) + 1;

  line();
  line("─".repeat(72));
  line(`  Vonage account ${inv.account.apiKey}`);
  line("─".repeat(72));
  line();
  line(`  Numbers        ${inv.numbers.length}`);
  for (const [country, count] of Object.entries(byCountry).sort()) {
    const portable = inv.numbers.filter((n) => n.country === country && n.portOutSupportedByVonage).length;
    line(`                 ${country}: ${count}  (Vonage supports port-out for ${portable})`);
  }
  const caps = ["sms", "voice", "mms"].map((c) => `${c}: ${inv.numbers.filter((n) => n[c]).length}`);
  line(`                 ${caps.join("   ")}`);
  const tollFree = inv.numbers.filter((n) => n.tollFree).length;
  if (tollFree) line(`                 toll-free: ${tollFree}  (ports separately from local numbers)`);
  const limited = inv.numbers.filter((n) => n.limitations.length).length;
  if (limited) line(`                 with limitations: ${limited}`);
  line();
  line(`  Applications   ${inv.applications.length}`);
  line(`  Subaccounts    ${inv.subaccounts.length}${inv.subaccounts.length ? "  (run again with each one's own key/secret)" : ""}`);
  line();

  if (inv.usage) {
    line(`  Traffic ${inv.usage.since} → ${inv.usage.until}${inv.usage.truncated ? "  (truncated — see --max-records)" : ""}`);
    for (const [k, t] of Object.entries(inv.usage.totals)) {
      line(`                 ${k.padEnd(22)} ${String(t.records).padStart(8)}`);
    }
  } else {
    line("  Traffic        not collected — re-run with --usage to include it");
  }
  line();
  line("  10DLC          not collected — Vonage has no API for it.");
  line("                 Export by hand: Dashboard → Messaging → Brands and Campaigns.");
  line("                 Include each brand and campaign's status and linked numbers.");
  line();
  line("─".repeat(72));
  line();
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { apiKey, auth } = credentials();
  AUTH_HEADER = auth;

  const step = (msg) => process.stderr.write(`  … ${msg}\n`);

  step("account");
  const balance = await fetchBalance();

  step("phone numbers");
  const numbers = await fetchNumbers();

  step("applications");
  const applications = await fetchApplications();

  step("subaccounts");
  const subaccounts = await fetchSubaccounts(apiKey);

  let usage = null;
  if (opts.usage) {
    const since = opts.since ?? daysAgo(90);
    const until = new Date().toISOString().slice(0, 10);
    step(`traffic ${since} → ${until} (up to ${opts.maxRecords} records per category)`);
    usage = await fetchUsage(apiKey, since, until, opts.maxRecords, numbers.map((n) => n.number));
  }

  const inventory = {
    generatedAt: new Date().toISOString(),
    generatedBy: "dial playbooks/migrate-to-dial/from-vonage/node",
    account: { apiKey, balance },
    numbers,
    applications,
    subaccounts,
    usage,
    // Recorded rather than silently omitted: a reader of this file should be
    // able to see that 10DLC is missing and why, without reading the README.
    tenDlc: {
      collected: false,
      reason: "Vonage exposes 10DLC brands and campaigns in the dashboard only; there is no documented REST endpoint to list them.",
      where: "Vonage Dashboard → Messaging → Brands and Campaigns (10DLC)",
    },
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
