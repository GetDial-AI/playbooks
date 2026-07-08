# Dial Self-Hosted AUDIO echo — Python

The smallest possible server for [Dial Self-Hosted **audio** mode](https://docs.getdial.ai/documentation/platform/self-hosted):
Dial pipes the raw call audio to **your** WebSocket server, full duplex, and this
server echoes it straight back — so the caller hears themselves. Press `#` to
hang up.

It speaks the [Self-hosted audio protocol](https://docs.getdial.ai/api-reference/self-hosted-audio-protocol)
via [`dial-sdk`](https://pypi.org/project/dial-sdk/)'s `AudioPipeSession`
(signature verification, base64↔bytes codec, keepalive — you just write
`on_media`).

## Run it

```bash
pip install -r requirements.txt   # or: uv sync
cp .env.example .env              # fill in DIAL_SIGNING_SECRET
./run.sh                          # listens on :8080
```

Expose it with [ngrok](https://ngrok.com) (`ngrok http 8080`), then in the
[dashboard Self-Hosted page](https://getdial.ai/dashboard/self-hosted) choose the
**Audio** variant, set the WebSocket URL to your tunnel's `wss://…` address, copy
the signing secret into `.env`, and enable. Call your Dial number — you'll hear
yourself.

## Make it yours

Replace the one echo line —

```python
on_media=lambda audio, seq: session.send_media(audio),
```

— with your own voice stack: feed `audio` (raw bytes in your configured inbound
format) to a speech-to-speech model or an STT→LLM→TTS chain, and stream the
agent's audio back with `session.send_media(...)`. Use `session.clear()` for
barge-in and `session.end_call()` to hang up. Formats are set per-direction in
the dashboard (default `mulaw_8000`).
