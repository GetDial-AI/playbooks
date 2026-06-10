# Dial SMS & Voice playbook — Node dashboard

A full web dashboard built on the [`@getdial/sdk`](https://www.npmjs.com/package/@getdial/sdk)
Node SDK. It demonstrates Dial's core messaging + voice capabilities end to end:

- 🗣️ **Place AI voice calls** — type a number + an instruction, and Dial's AI agent makes the call.
- 💬 **Send SMS** from your Dial number.
- 📨 **Receive SMS & call events live** — inbound texts, `call.ended`, and `call.transcribed`
  events stream in real time over a WebSocket, powered by the SDK's `EventsConnection`.
- 📋 **Browse call history** and open full transcripts.

Built with **Express** + the [`ws`](https://www.npmjs.com/package/ws) WebSocket server and a
dependency-free vanilla-JS frontend. Written in **TypeScript**, run directly with
[`tsx`](https://tsx.is) — no build step.

> This is the Node sibling of [`sms-and-voice/python-fastapi`](../python-fastapi) — same
> dashboard, same API surface, different stack.

## Run it

The Dial API key is read **only** from `.env`:

```bash
npm install
cp .env.example .env        # then put your sk_live_... key in DIAL_API_KEY
npm start                   # listens on :8000 (override with PORT)
```

Open http://localhost:8000

`npm run dev` runs with `--watch` for auto-reload; `npm run typecheck` type-checks against
the SDK's types. Get a key by signing up at [getdial.ai](https://getdial.ai).

## How receiving works

- While the server runs it holds an open `EventsConnection` to Dial and pushes
  `message.received` / `call.ended` / `call.transcribed` events to every connected
  browser tab via `/ws`. **Text or call your Dial number** and watch the inbox update live.
- On page load the inbox is also seeded from stored inbound messages
  (`GET /api/messages?direction=inbound`), so you see history even for texts that
  arrived while the server was down.

## API surface

| Method | Path                  | Purpose                                       |
|--------|-----------------------|-----------------------------------------------|
| GET    | `/`                   | Dashboard UI                                  |
| GET    | `/api/numbers`        | Your provisioned numbers                      |
| GET    | `/api/messages`       | Message history (`?direction=`)               |
| GET    | `/api/calls`          | Call history (`?direction=`)                  |
| GET    | `/api/calls/:id`      | Single call + transcript                      |
| POST   | `/api/sms`            | Send an SMS `{to, body}`                       |
| POST   | `/api/call`           | Place a call `{to, instruction, language?}`    |
| WS     | `/ws`                 | Live inbound events                           |

## Files

```
server.ts         Express app: routes, validation, WebSocket
dial-service.ts   @getdial/sdk wrapper + live EventsConnection → in-memory pub/sub hub
config.ts         loads DIAL_API_KEY from the environment (the only auth source)
public/           index.html dashboard, style.css, app.js
```

## Notes

- Phone numbers must be **E.164** (`+14155550123`); validated client- and server-side.
- The AI voice agent's behavior on **inbound** calls is set per-number in Dial
  (`inboundInstruction`); **outbound** behavior is the `instruction` you type per call.
- Outbound calls and SMS reach real numbers and may incur charges.
