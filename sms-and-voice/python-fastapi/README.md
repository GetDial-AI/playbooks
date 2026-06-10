# Dial SMS &amp; Voice playbook — Python dashboard

A full web dashboard built on the [`dial-sdk`](https://pypi.org/project/dial-sdk/) Python
library. It demonstrates Dial's core messaging + voice capabilities end to end:

- 🗣️ **Place AI voice calls** — type a number + an instruction, and Dial's AI agent makes the call.
- 💬 **Send SMS** from your Dial number.
- 📨 **Receive SMS &amp; call events live** — inbound texts, `call.ended`, and `call.transcribed`
  events stream in real time over a WebSocket, powered by the SDK's `EventsConnection`.
- 📋 **Browse call history** and open full transcripts.

Built with **FastAPI** (async, matching the SDK) + a dependency-free vanilla-JS frontend.

## Run it

The Dial API key is read **only** from `.env`:

```bash
cp .env.example .env        # then put your sk_live_... key in DIAL_API_KEY
uv run uvicorn app:app --reload --port 8000
```

Open http://localhost:8000

Get a key by signing up at [getdial.ai](https://getdial.ai). No `uv`?
`pip install -e .` into a virtualenv works too, then `uvicorn app:app --reload`.

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
| GET    | `/api/calls/{id}`     | Single call + transcript                      |
| POST   | `/api/sms`            | Send an SMS `{to, body}`                       |
| POST   | `/api/call`           | Place a call `{to, instruction, language?}`    |
| WS     | `/ws`                 | Live inbound events                           |

## Files

```
app.py            FastAPI app: routes, validation, WebSocket
dial_service.py   dial-sdk wrapper + live EventsConnection → in-memory pub/sub hub
config.py         loads DIAL_API_KEY from .env (the only auth source)
templates/        index.html dashboard
static/           style.css, app.js
```

## Notes

- Phone numbers must be **E.164** (`+14155550123`); validated client- and server-side.
- The AI voice agent's behavior on **inbound** calls is set per-number in Dial
  (`inbound_instruction`); **outbound** behavior is the `instruction` you type per call.
- Outbound calls and SMS reach real numbers and may incur charges.
