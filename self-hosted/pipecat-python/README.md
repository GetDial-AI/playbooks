# Dial Self-Hosted playbook — Pipecat (Python)

Run a [Pipecat](https://pipecat.ai) voice agent on a real phone call.

[Dial Self-Hosted **audio** mode](https://docs.getdial.ai/documentation/platform/self-hosted)
pipes the raw call audio to a WebSocket server you host, full duplex, and expects the
agent's audio back. Pipecat already knows how to run a real-time voice pipeline over a
WebSocket — it just needs to be told what the frames on that socket look like. That's a
`FrameSerializer`, and this playbook is one: **[`dial_serializer.py`](./dial_serializer.py)**,
next to [`bot.py`](./bot.py) — a stock speech-to-text → LLM → text-to-speech pipeline that
could be running on any Pipecat transport.

Dial handles the phone number, the carrier, and the call. Pipecat handles the conversation.

## What's here

| File | What it does |
|---|---|
| [`dial_serializer.py`](./dial_serializer.py) | `DialFrameSerializer` — the Dial audio protocol as a Pipecat serializer. The reusable piece; lift it into your own project. |
| [`bot.py`](./bot.py) | The pipeline: [Deepgram](https://deepgram.com) → [OpenAI](https://openai.com) → [Cartesia](https://cartesia.ai), with Silero VAD. Swap any of them. |
| [`server.py`](./server.py) | FastAPI host: verifies `X-Dial-Signature`, reads `call_connected`, starts one bot per call. |

The protocol types and the signature helper come from
[`dial-sdk`](https://pypi.org/project/dial-sdk/); the serializer never hand-rolls a message
shape. Full contract: the
[self-hosted audio protocol](https://docs.getdial.ai/api-reference/self-hosted-audio-protocol).

## Run it

Requires **Python 3.11+** and a Dial account with
[Self-Hosted access granted](https://docs.getdial.ai/documentation/platform/self-hosted#request-access).

```bash
pip install -r requirements.txt   # or: uv sync
cp .env.example .env              # fill in the four keys
./run.sh                          # listens on :8080
```

Expose it and point Dial at the tunnel:

```bash
ngrok http 8080
# Forwarding  https://<id>.ngrok-free.app -> http://localhost:8080
```

Then save and activate the **audio** config — note `wss`, not `https`, and the `/ws` path
(Dial appends `/<call_id>` itself):

```bash
curl -X POST https://api.getdial.ai/v1/self-hosted \
  -H "Authorization: Bearer $DIAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "action": "activate", "config": { "type": "audio",
        "wsUrl": "wss://<id>.ngrok-free.app/ws",
        "audioInboundFormat": "mulaw_8000", "audioOutboundFormat": "mulaw_8000" } }'
```

Copy the signing secret it returns (or `GET /v1/self-hosted/secret?mode=audio`) into `.env`
as `DIAL_SIGNING_SECRET`, restart, and call your Dial number. You can do all of this from the
[dashboard Self-Hosted page](https://getdial.ai/dashboard/self-hosted) instead.

`activate` routes **every** call on your account — inbound and outbound — at this server.
`{"action": "disable"}` hands them back to Dial's managed agent.

## How the two protocols meet

`DialFrameSerializer` is the entire adapter. Both directions, in full:

| Dial → Pipecat | | Pipecat → Dial | |
|---|---|---|---|
| `media` | `InputAudioRawFrame` | `AudioRawFrame` | `media` |
| `dtmf` | `InputDTMFFrame` | `InterruptionFrame` | `clear` |
| `ping_pong` | *(echoed back)* | `EndFrame` / `CancelFrame` | `end_call` |

Three things are worth pointing out:

**Barge-in is explicit.** Dial buffers and paces playback, so when the caller talks over the
agent, Dial is still holding audio the caller hasn't heard yet. Pipecat's `InterruptionFrame`
becomes a `clear`, which drops it — without that, the old answer keeps playing under the new one.

**The keepalive round-trips through the pipeline.** Dial pings every ~2s and wants the identical
frame back within ~5s, but a serializer can't write to the socket. So `deserialize` returns the
pong as an `OutputTransportMessageUrgentFrame`, which travels down to the output transport and
comes straight back out through `serialize`. (Pipecat's own Genesys serializer does the same.)

**Audio formats are negotiated per call, not per server.** `call_connected` carries the
inbound and outbound formats from your Self-Hosted config — any of `mulaw_8000`, `alaw_8000`,
`l16_8000`, `l16_16000`, `l16_24000`. The serializer transcodes both legs, and
`pipeline_sample_rates()` picks the pipeline's rates to match, so text-to-speech renders
directly at the rate Dial wants and only the inbound leg is ever resampled. Nothing to
configure in the bot.

## Hanging up after a goodbye

`end_call` discards whatever Dial still has queued, so ending the pipeline right after the
agent's last words cuts them off. When the goodbye has to land, use a `mark` — a playback
checkpoint Dial echoes back once the caller has actually heard everything before it:

```python
serializer = DialFrameSerializer(
    call.call_id, call.formats,
    params=DialFrameSerializer.InputParams(auto_end_call=False),
)
...
await worker.queue_frames([TTSSpeakFrame("Thanks for calling!"), dial_mark_frame("goodbye")])
# then end the pipeline when that mark comes back
```

Left alone (`auto_end_call=True`, the default), the serializer hangs up as soon as the pipeline
ends or is cancelled, which is right for most bots — Pipecat paces its own output in real time,
so Dial's queue stays shallow.

## Make it yours

Replace `stt`, `llm`, or `tts` in [`bot.py`](./bot.py) with any of Pipecat's
[supported services](https://docs.pipecat.ai/server/services/supported-services) — the
serializer doesn't care. For a speech-to-speech model instead of the cascade, swap the three
services for a realtime one (OpenAI Realtime, Gemini Live) and set the matching audio format on
your Self-Hosted config: `l16_24000` outbound skips a transcode entirely.

`call_connected` also hands you `instruction` (used here as the system prompt), `language`,
`direction`, and the `from` / `to` numbers — enough to route or personalize per call.

## Not handled (kept minimal)

`duration_warning` is logged, not acted on — a production bot should start wrapping up when it
arrives. Reconnects are detected (`reconnect: true` skips the greeting) but no conversation
state is carried across them; keep it keyed by `call_id` if you need it.

While Self-Hosted audio is on, Dial never hears the call: no transcripts, recordings, or
summaries, and the built-in agent tools are inert. Your stack owns all of it.
