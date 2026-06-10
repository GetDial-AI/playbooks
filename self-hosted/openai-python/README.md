# Dial Self-Hosted playbook — OpenAI WebSocket server (Python)

A minimal reference server for [Dial Self-Hosted mode](https://docs.getdial.ai/documentation/platform/self-hosted):
Dial drives each call by opening a WebSocket to **your** server, and your server
answers turns with your own LLM. This example uses the **OpenAI SDK** and focuses
on **transcript interrupts** — cancelling the in-flight reply when the caller
speaks again so the agent never talks over them.

It speaks the [Self-hosted protocol](https://docs.getdial.ai/api-reference/self-hosted-protocol)
via [`dial-sdk`](https://pypi.org/project/dial-sdk/) (pydantic schemas +
`verify_dial_signature`).

This is the Python port of the [`openai-node`](https://github.com/GetDial-AI/playbooks/tree/main/self-hosted/openai-node)
playbook — same functionality, built on `dial-sdk` and
[`websockets`](https://websockets.readthedocs.io) instead of `@getdial/sdk` + `ws`.

## Run it

```bash
pip install -r requirements.txt      # or: uv sync
cp .env.example .env                  # fill in OPENAI_API_KEY and DIAL_SIGNING_SECRET
python server.py                      # listens on :8080  (or: ./run.sh)
```

Requires **Python 3.10+**. The server is `asyncio`-based; `.env` is loaded
automatically via `python-dotenv`.

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

Each call keeps one in-flight OpenAI stream as an `asyncio.Task`. When a newer
`response_required` arrives (the caller spoke again), the server **cancels** the
previous task and answers the new turn — superseding the stale reply. That's the
whole trick: keep the streaming task per turn and cancel it the moment Dial asks
for the next one. (`asyncio.Task.cancel()` is the Python analog of the Node
`AbortController`.)

## Ending the call

The model gets an `end_call` **OpenAI function tool**. This is an *OpenAI* tool
that lives inside this server — the Dial protocol itself has no tool channel.
When the model calls `end_call`, the server maps it to a `Response` with
`end_call=True`, which tells Dial to hang up after the farewell is spoken.

## Not handled (kept minimal)

No per-word timing and no metadata channel — matching the v1 protocol. (The
`end_call` tool above is the model's own OpenAI tool, not a Dial-protocol tool.)
