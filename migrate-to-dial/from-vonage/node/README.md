# Vonage → Dial migration inventory

> **Just need to run it?** See [QUICKSTART.md](./QUICKSTART.md) — four steps, about a minute.

Takes stock of a Vonage API account before a migration: every number and what it can do, how
it's wired today, the applications behind that wiring, and — on request — how much traffic
actually flows through it.

It **reports, it doesn't advise** — everything in the output is a fact read from Vonage.
No recommendations, no pricing, no judgement about what should move.

The output contains your real phone numbers and account identifiers; treat it as you would
any export from your Vonage dashboard.

Output is two files — `vonage-inventory.json` and `vonage-inventory.csv` — plus a summary
printed to your terminal.

## What it reads

| Area | Vonage resource |
|---|---|
| Account | `account/get-balance` — balance and auto-reload |
| Phone numbers | `account/numbers` — country, type, features, routing, app binding, limitations |
| Applications | `v2/applications` — names and the webhooks actually serving each number |
| Subaccounts | `accounts/{key}/subaccounts` — flagged so none get missed |
| Traffic | `v2/reports/records` — SMS and voice, inbound and outbound (opt-in; see below) |

## What it can't read: 10DLC

Vonage exposes **10DLC brands and campaigns in the dashboard only** — there is no documented
REST endpoint that lists them. So the script can't collect them, and rather than quietly
omitting the gap it records it in the output (`tenDlc` in the JSON, a `[10DLC]` section in the
CSV) and says so in the terminal summary.

Export them by hand from **Messaging → Brands and Campaigns (10DLC)**: each brand and campaign,
its status, and which numbers are linked to it. It matters more than it looks — a 10DLC
registration does not follow a number to a new provider.

## Safety

You're handing a script your production telecom credentials, so two things are deliberate:

- **Zero dependencies.** Node 18+ and nothing else. `inventory.mjs` is one file you can read
  end to end before running it.
- **Read-only.** Every request is a `GET`. Nothing in the file creates, updates, or deletes
  anything in your Vonage account.

Vonage has no separately revocable read-only credential, so this is the account's own API
secret — which is exactly why the two properties above are non-negotiable. Rotate the secret in
the dashboard once the migration is done.

## Setup

```bash
cd migrate-to-dial/from-vonage/node
cp .env.example .env    # fill in your Vonage API key and secret
node inventory.mjs
```

## Options

```bash
node inventory.mjs --usage                 # also count messages and calls (slower)
node inventory.mjs --usage --since 2026-01-01
node inventory.mjs --max-records 100000    # raise the per-category scan cap
node inventory.mjs --out inv.json          # output path
node inventory.mjs --no-csv                # JSON only, skip the spreadsheet
```

**`--usage`** is opt-in because Vonage has no aggregate: the Reports API returns one row per
message and per call, so volume has to be counted by walking them. The window defaults to the
last 90 days (`--since` to change it) and each category stops at `--max-records` (default
50,000), with `usage.truncated` set in the output when a cap is hit.

The rows are summed and discarded — no message bodies and no per-record detail reach the
output, and the per-number table only ever lists **your own** numbers, never the handsets at
the other end of a message.

## The CSV

`vonage-inventory.csv` holds everything in one sheet, as titled sections stacked one after
another — `[ACCOUNT]`, `[NUMBERS]`, `[APPLICATIONS]`, `[SUBACCOUNTS]`, `[10DLC]`, and, with
`--usage`, `[USAGE TOTALS]`, `[USAGE BY MONTH]` and `[PER-NUMBER TRAFFIC]`. Sections with
nothing in them are left out.

They're stacked rather than merged into one set of columns because the tables have different
shapes: a union of every column would leave most cells blank on most rows and read worse.
Excel and Sheets both open it fine — each section has its own header row and a blank line
before the next.

Two details that matter when this lands in Excel:

- **Numbers stay text.** Excel reads a cell starting with `+`, `=`, `-` or `@` as a formula,
  which mangles E.164 numbers. Those values are written with a leading apostrophe — Excel's
  own "treat this as text" marker, invisible in the cell. The same escape defuses
  [CSV injection](https://owasp.org/www-community/attacks/CSV_Injection), so a name someone
  typed into Vonage can't execute when you open the sheet.
- **UTF-8 is declared.** The file carries a byte-order mark, so accented names survive the
  trip into Excel instead of arriving as mojibake.

## Reading the numbers table

Two columns are worth knowing about:

- **`port_out_supported_by_vonage`** restates Vonage's own published rule — they support
  porting long virtual numbers out [in the US and Canada only](https://api.support.vonage.com/hc/en-us/articles/206027907-Porting-Long-Virtual-Numbers)
  — against each number's country. It's their constraint, reported; not a judgement about
  the number.
- **`toll_free`** is derived from the number's area code as well as its Vonage `type`, because
  the type isn't set consistently. Toll-free numbers port under a different process from local
  ones, so they're worth separating early.

A number wired to an **application** carries no webhook URLs of its own — the routing lives on
the application instead. That's why applications are collected: a report that only read the
numbers would show blanks and suggest they were unrouted.

## Subaccounts

Vonage scopes `account/numbers` to the credentials in the request header, not to anything in
the URL. So unlike some providers, a parent's credentials **cannot** read a subaccount's
numbers — there's no `--subaccount` flag to add.

The script lists the subaccounts it can see so none get missed, and stops there. To inventory
one, run the script again with that subaccount's own API key and secret in `.env`.

## Next

Send the output — the JSON, the CSV, the 10DLC export and a recent invoice — to your Dial
contact, who'll work through what it means for your migration: what moves cleanly, what
changes shape, and what Dial doesn't do.
