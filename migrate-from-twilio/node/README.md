# Twilio → Dial migration inventory

Takes stock of a Twilio account before a migration: every number and what it can do,
how much traffic actually flows through it, the 10DLC registrations behind that traffic,
and the things that **can't** move to Dial as-is.

Output is a single `twilio-inventory.json` plus a summary printed to your terminal.

## What it reads

| Area | Twilio resource |
|---|---|
| Account identity | `Accounts/{sid}` — SID, friendly name, trial vs full |
| Subaccounts | `Accounts` — flagged so none get missed |
| Phone numbers | `IncomingPhoneNumbers` — capabilities, TwiML URLs, webhooks, trunk, Messaging Service |
| Short codes | `SMS/ShortCodes` |
| Traffic | `Usage/Records/Monthly` — SMS, MMS and calls, inbound and outbound, by month |
| Messaging Services | `Services` and their inbound webhooks |
| 10DLC | `a2p/BrandRegistrations` and each service's `Compliance/Usa2p` campaign |

From that it derives a readiness report — **blockers** (things Dial doesn't do), **decisions**
(things that move but change shape), and a rough monthly cost at Dial list prices.

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
node inventory.mjs --months 6        # usage window (default 12)
node inventory.mjs --redact          # mask phone numbers, keep counts and capabilities
node inventory.mjs --per-number      # attribute traffic to individual numbers (slow)
node inventory.mjs --out inv.json    # output path
```

**`--redact`** masks the last four digits of every number and drops friendly names. Use it when
sharing the inventory before a contract is in place — the counts, capabilities and volumes that a
quote is built from all survive.

**`--per-number`** walks the Messages and Calls lists to attribute volume to individual numbers.
Twilio's Usage API reports account totals only, so this is the only way to get a per-number
breakdown — and on a busy account it's slow and rate-limited. It's capped at 50,000 records per
resource (`--max-scan`); the output sets `perNumber.truncated` when it hits the cap.

## Subaccounts

The script scans **one account**. If it reports subaccounts, run it once per subaccount SID —
numbers and traffic live on the subaccount that owns them, not on the parent.

## Reading the output

The summary ends with three lists:

- **Blockers** — non-US numbers, short codes, fax, SIP trunks. These need a decision that isn't
  "move it to Dial".
- **Decisions** — numbers answering with TwiML, per-number SMS webhooks, existing 10DLC campaigns.
  These migrate, but the shape changes; the [migration guide](https://docs.getdial.ai/documentation/migrate/twilio)
  covers each one.
- **Notes** — MMS and toll-free, which have their own wrinkles.

The cost estimate is an upper bound at list prices: it uses the US SMS rate for all messages and
ignores volume pricing. It's for sizing a conversation, not for signing.

## Next

Send `twilio-inventory.json` (run with `--redact` if it's going out before a contract) to your Dial
contact, or work through it yourself with the
[Migrate from Twilio](https://docs.getdial.ai/documentation/migrate/twilio) guide.
