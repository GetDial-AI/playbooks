# Twilio → Dial migration inventory

Takes stock of a Twilio account before a migration: every number and what it can do, how
it's wired today, how much traffic actually flows through it, and the 10DLC registrations
behind that traffic.

It **reports, it doesn't advise** — everything in the output is a fact read from Twilio.
No recommendations, no pricing, no judgement about what should move.

Output is `twilio-inventory.json`, a set of CSVs you can open straight in Excel or Sheets,
and a summary printed to your terminal.

## What it reads

| Area | Twilio resource |
|---|---|
| Account identity | `Accounts/{sid}` — SID, friendly name, trial vs full |
| Subaccounts | `Accounts` — flagged so none get missed |
| Phone numbers | `IncomingPhoneNumbers` — capabilities, TwiML URLs, webhooks, trunk, Messaging Service |
| Short codes | `SMS/ShortCodes` |
| Traffic | `Usage/Records/Monthly` — SMS, MMS and calls, inbound and outbound, by month, from day one, in both scopes (see below) |
| Messaging Services | `Services` and their inbound webhooks |
| 10DLC | `a2p/BrandRegistrations` and each service's `Compliance/Usa2p` campaign |

## Safety

You're handing a script your production telecom credentials, so two things are deliberate:

- **Zero dependencies.** Node 18+ and nothing else. `inventory.mjs` is one file you can read
  end to end before running it.
- **Read-only.** Every request is a `GET`. Nothing in the file creates, updates, or deletes
  anything in your Twilio account.

Prefer an [API Key](https://www.twilio.com/docs/iam/api-keys) (`SK…`) over the account's main
auth token — you can delete the key when the migration is done without rotating the account.

## Setup

```bash
cd migrate-from-twilio/node
cp .env.example .env    # fill in your Twilio credentials
node inventory.mjs
```

## Options

```bash
node inventory.mjs --redact          # mask phone numbers, keep counts and capabilities
node inventory.mjs --per-number      # attribute traffic to individual numbers (slow)
node inventory.mjs --out inv.json    # output path
node inventory.mjs --no-csv          # JSON only, skip the spreadsheets
```

There's no time-window flag: usage always covers the account's **full history**, starting
from the month it was created. A migration wants the whole picture, and Twilio dates the
account for us, so there's nothing to pick.

**`--redact`** masks the last four digits of every number and drops friendly names. Use it when
sharing the inventory before a contract is in place — the counts, capabilities and volumes that a
quote is built from all survive.

**`--per-number`** walks the Messages and Calls lists to attribute volume to individual numbers.
Twilio's Usage API reports account totals only, so this is the only way to get a per-number
breakdown — and on a busy account it's slow and rate-limited. Since the window is the account's
whole life, it's capped at 50,000 records per resource (`--max-scan`); the output sets
`perNumber.truncated` when it hits the cap, and the account-level totals stay exact either way.

## The CSVs

The inventory is several tables, so it becomes several sheets rather than one flattened file.
They're named off the JSON path, so a run's files sort together:

| File | One row per |
|---|---|
| `…​.numbers.csv` | phone number — capabilities, TwiML/SMS URLs, Messaging Service, trunk |
| `…​.usage.csv` | month × category — long format, ready to pivot |
| `…​.usage-totals.csv` | category — totals, averages, and the months observed |
| `…​.short-codes.csv` | short code (only when the account has any) |
| `…​.subaccounts.csv` | subaccount (only when the account has any) |
| `…​.per-number.csv` | number, with `--per-number` |

Two details that matter when these land in Excel:

- **Numbers stay text.** Excel reads a cell starting with `+`, `=`, `-` or `@` as a formula, which
  mangles E.164 numbers. Those values are written with a leading apostrophe — Excel's own "treat
  this as text" marker, invisible in the cell. The same escape defuses
  [CSV injection](https://owasp.org/www-community/attacks/CSV_Injection), so a friendly name
  someone typed into Twilio can't execute when you open the sheet.
- **UTF-8 is declared.** The files carry a byte-order mark, so accented names survive the trip
  into Excel instead of arriving as mojibake.

## Subaccounts

Twilio is inconsistent here, and it's the easiest number on the whole report to misread.

`IncomingPhoneNumbers`, `Calls` and `Messages` return **only the account you queried**. The
Usage API is the opposite: it defaults to `IncludeSubaccounts=true`, so a parent account's
usage silently includes every subaccount's traffic. Left alone, that reports numbers for one
account and traffic for hundreds.

So usage is collected **twice**, with the scope always sent explicitly:

| Scope | Meaning |
|---|---|
| `this-account` | Only the account you queried — matches the numbers in the same report |
| `with-subaccounts` | The parent plus every subaccount, which is what the Twilio console shows |

The terminal prints the first and, when subaccounts carry traffic of their own, the second
with the difference broken out. Every row in the usage CSVs carries a `scope` column, so the
two can't be added together by accident.

To inventory the **numbers** on a subaccount, run the script again with that subaccount's SID
— numbers live on the subaccount that owns them. Use the `this-account` figures when you do,
or you'll count the same traffic once per run.

## Reading the output

`twilio-inventory.json` holds everything; the CSVs are the same data split into sheets.
The terminal summary is just the headline counts — numbers by capability, and total and
average monthly volume per category over the account's full history.

## Next

Send the output — the JSON, the CSVs, or both — to your Dial contact. Run it with `--redact`
if it's going out before a contract is in place.

For what the data means for a migration — what moves cleanly, what changes shape, and what
Dial doesn't do — see the
[Migrate from Twilio](https://docs.getdial.ai/documentation/migrate/twilio) guide.
