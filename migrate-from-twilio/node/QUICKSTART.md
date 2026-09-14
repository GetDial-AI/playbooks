# Twilio inventory — quickstart

A read-only script that reads your Twilio account and writes two files describing what's on
it. It only ever reads: every request is a `GET`, and it has no dependencies to install.

Takes about a minute.

## 1. Get your Twilio credentials

In the [Twilio Console](https://console.twilio.com):

- **Account SID** — on the dashboard, starts with `AC`.
- **API Key** — Account → *API keys & tokens* → **Create API key** (Standard). Copy the key
  SID (`SK…`) and the secret. **The secret is shown once.**

An API key is preferred over your auth token because you can delete it afterwards without
rotating your account.

## 2. Download the script

```bash
git clone https://github.com/GetDial-AI/playbooks
cd playbooks/migrate-from-twilio/node
```

## 3. Add your credentials

```bash
cp .env.example .env
```

Open `.env` and fill in the three values:

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY=SK...
TWILIO_API_SECRET=...
```

## 4. Run it

Requires [Node](https://nodejs.org) 18 or newer. There's nothing to install.

```bash
node inventory.mjs
```

You'll get a summary in the terminal and two files in the same folder:

- `twilio-inventory.json`
- `twilio-inventory.csv` — opens in Excel or Google Sheets

## 5. Send them back

Send both files to your Dial contact. They contain your real phone numbers and account
identifiers, so treat them like any other export from your Twilio console.

---

Something not working, or the account is too large to finish? Tell your Dial contact what you
saw — don't spend time on it.

For everything the script collects and the options it takes, see [README.md](./README.md).
