# Vonage inventory — quickstart

A read-only script that reads your Vonage API account and writes two files describing what
is on it. It only ever reads: every request is a `GET`, and it has no dependencies to install.

Takes about a minute.

## 1. Get your Vonage credentials

Sign in at [dashboard.nexmo.com](https://dashboard.nexmo.com). Your **API key** and
**API secret** are on the home page, top-left under your account name.

Vonage has no separate read-only key, so this is the account's own secret — which is why the
script has no dependencies and no write path. You can rotate the secret in the dashboard once
the migration is done.

## 2. Download the script

```bash
git clone https://github.com/GetDial-AI/playbooks
cd playbooks/migrate-to-dial/from-vonage/node
```

## 3. Add your credentials

```bash
cp .env.example .env
```

Open `.env` and fill in the two values:

```
VONAGE_API_KEY=abcd1234
VONAGE_API_SECRET=your_api_secret
```

## 4. Run it

Requires [Node](https://nodejs.org) 18 or newer. There's nothing to install.

```bash
node inventory.mjs
```

You'll get a summary in the terminal and two files in the same folder:

- `vonage-inventory.json`
- `vonage-inventory.csv` — opens in Excel or Google Sheets

Want message and call volume too? Add `--usage` — it takes longer. See [README.md](./README.md).

## 5. One thing to export by hand

The script cannot read your **10DLC brands and campaigns** — Vonage only exposes those in the
dashboard, with no API behind them.

In the dashboard, go to **Messaging → Brands and Campaigns (10DLC)** and send a screenshot or
export of each brand and campaign, including its status and which numbers are linked to it.

While you're there, it also helps to grab a recent **invoice** (Billing → Invoices).

## 6. Send them back

Send the two files, the 10DLC export and the invoice to your Dial contact. They contain your
real phone numbers and account identifiers, so treat them like any other export from your
Vonage dashboard.

---

Something not working, or the account is too large to finish? Tell your Dial contact what you
saw — don't spend time on it.

For everything the script collects and the options it takes, see [README.md](./README.md).
