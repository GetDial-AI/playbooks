# Dial Self-Hosted playbook — OpenAI WebSocket server

A minimal reference server for [Dial Self-Hosted mode](https://docs.getdial.ai/documentation/platform/self-hosted):
Dial drives each call by opening a WebSocket to **your** server, and your server
answers turns with your own LLM. This example uses the **OpenAI SDK** and focuses
on **transcript interrupts** — cancelling the in-flight reply when the caller
speaks again so the agent never talks over them.

It speaks the [Self-hosted protocol](https://docs.getdial.ai/api-reference/self-hosted-protocol)
via [`@getdial/sdk`](https://www.npmjs.com/package/@getdial/sdk) (schemas +
`verifyDialSignature`).

## Run it

```bash
npm install
cp .env.example .env   # fill in OPENAI_API_KEY and DIAL_SIGNING_SECRET
npm start              # listens on :8080
```

Written in **TypeScript** and run directly with [`tsx`](https://tsx.is) — no build
step. `npm run typecheck` type-checks `server.ts` against the SDK's protocol types.

Expose it with [ngrok](https://ngrok.com) and use the **wss** URL:

```bash
ngrok http 8080
# Forwarding  https://<id>.ngrok-free.app -> http://localhost:8080
```

Then enable Self-Hosted in Dial with the tunnel's `wss://` URL (note `wss`, not `https`):

```bash
curl -X PUT https://getdial.ai/api/v1/self-hosted \
  -H "Authorization: Bearer $DIAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "wsUrl": "wss://<id>.ngrok-free.app", "enabled": true }'
```

The response returns the **signing secret once** — put it in `.env` as
`DIAL_SIGNING_SECRET`. Now place or receive a call: Dial connects to
`wss://<id>.ngrok-free.app/<call_id>`, your server verifies the signature and
drives the conversation with OpenAI.

## How the interrupt handling works

Each call keeps one in-flight OpenAI stream. When a newer `response_required`
arrives (the caller spoke again), the server **aborts** the previous stream and
answers the new turn — superseding the stale reply. That's the whole trick:
keep an `AbortController` per turn and cancel it the moment Dial asks for the
next one.

## Ending the call

The model gets an `end_call` **OpenAI function tool**. This is an *OpenAI* tool
that lives inside this server — the Dial protocol itself has no tool channel.
When the model calls `end_call`, the server maps it to a `response` with
`end_call: true`, which tells Dial to hang up after the farewell is spoken.

## Not handled (kept minimal)

No per-word timing and no metadata channel — matching the v1 protocol. (The
`end_call` tool above is the model's own OpenAI tool, not a Dial-protocol tool.)
