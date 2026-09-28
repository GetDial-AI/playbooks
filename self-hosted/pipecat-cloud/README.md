# Dial Self-Hosted playbook — Pipecat Cloud

Run a [Pipecat](https://pipecat.ai) voice agent on [Pipecat Cloud](https://pipecat.daily.co)
and put it on a real phone call — with no server of your own.

This is the [`pipecat-python`](../pipecat-python) voice agent — [Deepgram](https://deepgram.com)
→ [OpenAI](https://openai.com) → [Cartesia](https://cartesia.ai), with Silero VAD — moved onto
Pipecat Cloud's entrypoint. Instead of a WebSocket URL, you give Dial the agent's name and
your Pipecat Cloud public key. Before every connection Dial calls the agent's `/start`
endpoint, gets a single-use token, and connects with it, so Pipecat authenticates the call:
no FastAPI host, no tunnel, no `X-Dial-Signature` to verify.

Dial handles the phone number, the carrier, and the call. Pipecat Cloud runs and scales the
conversation.

## What's here

| File | What it does |
|---|---|
| [`bot.py`](./bot.py) | Pipecat Cloud entrypoint: reads `call_connected`, then runs the STT → LLM → TTS pipeline through `DialFrameSerializer`. |
| [`dial_serializer.py`](./dial_serializer.py) | Copy of [`../pipecat-python/dial_serializer.py`](../pipecat-python/dial_serializer.py) — the Dial audio protocol as a Pipecat serializer. Keep them in sync. |
| [`pcc-deploy.toml`](./pcc-deploy.toml) | Agent `dial-voice-agent` in `us-west`, token auth on, the secret set with your AI keys, one warm agent. |
| [`Dockerfile`](./Dockerfile) | Pipecat's base image plus the two Python files. |
| [`.env.example`](./.env.example) | The keys the secret set needs. Reference only; Pipecat Cloud doesn't read it. |

How the serializer maps the two protocols (barge-in, keepalive, format negotiation) is
explained in the [`pipecat-python` README](../pipecat-python#how-the-two-protocols-meet); none
of it changes on Pipecat Cloud. Full contract: the
[self-hosted audio protocol](https://docs.getdial.ai/api-reference/self-hosted-audio-protocol/overview).
Setup reference: [Self-Hosted → Pipecat Cloud](https://docs.getdial.ai/documentation/platform/self-hosted#pipecat-cloud).

## Before you start

- A [Pipecat Cloud](https://pipecat.daily.co) account and its CLI:
  ```bash
  uv tool install "pipecat-ai[cli]" --with pipecatcloud
  pipecat cloud auth login
  ```
- API keys for [Deepgram](https://console.deepgram.com), [OpenAI](https://platform.openai.com/api-keys),
  and [Cartesia](https://play.cartesia.ai/keys).
- A Dial account with
  [Self-Hosted access granted](https://docs.getdial.ai/documentation/platform/self-hosted#request-access).

New to the Pipecat Cloud target? Deploy the [echo playbook](../pipecat-cloud-echo) first. It
needs no AI keys and proves the Dial → Pipecat Cloud path on its own, so if this agent then
misbehaves you know it's the pipeline, not the plumbing.

## 1. Store your AI keys as a secret set

Pipecat Cloud injects a secret set's keys into the agent as environment variables. Create
the one `pcc-deploy.toml` names, in the agent's region:

```bash
pipecat cloud secrets set dial-voice-agent-secrets --region us-west \
  DEEPGRAM_API_KEY=... OPENAI_API_KEY=... CARTESIA_API_KEY=...
```

Or fill in a copy of [`.env.example`](./.env.example) and load it in one go (`.env` is
gitignored):

```bash
cp .env.example .env    # fill in the three keys
pipecat cloud secrets set dial-voice-agent-secrets --region us-west --file .env
```

`OPENAI_MODEL` (default `gpt-4.1`) and `CARTESIA_VOICE_ID` are optional; add them to the set to
override the defaults. `pipecat cloud secrets list dial-voice-agent-secrets` shows the keys
stored (not their values).

## 2. Deploy the agent

```bash
pipecat cloud deploy                         # builds in the cloud from this folder
pipecat cloud agent status dial-voice-agent  # wait until it reports ready
```

`deploy` reads `pcc-deploy.toml`. Rename the agent there (or pass `pipecat cloud deploy
<agent_name>`) if you want a different name — whatever it is, that's the name Dial needs.

## 3. Get a public key

Dial starts sessions with your Pipecat Cloud **public** key (`pk_…`). List the ones you have,
or create one for Dial (it's shown once — copy it straight into Dial):

```bash
pipecat cloud organizations keys list
pipecat cloud organizations keys create --name dial
```

> [!WARNING]
> **Treat the public key as a secret.** Despite the name, anyone who has it can start sessions
> on your agents, which Pipecat bills to you. Never share it, commit it, or put it in
> client-side code. Give it to Dial and nothing else. Dial stores it encrypted and only ever
> shows it masked. If it leaks, revoke it (`pipecat cloud organizations keys revoke`) and
> save a new one in Dial.

## 4. Point Dial at it

On the [dashboard Self-Hosted page](https://getdial.ai/dashboard/self-hosted), open the
**audio** card, choose **Pipecat Cloud** as the target, and enter the agent name
(`dial-voice-agent`) and the public key. Or over REST:

```bash
curl -X POST https://api.getdial.ai/v1/self-hosted \
  -H "Authorization: Bearer $DIAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "action": "activate", "config": { "type": "audio",
        "pipecatCloud": { "agentName": "dial-voice-agent", "publicKey": "pk_..." },
        "audioInboundFormat": "mulaw_8000", "audioOutboundFormat": "mulaw_8000" } }'
```

`pipecatCloud` takes the place of `wsUrl`: send one or the other, and saving one clears the
other. There's no signing secret to copy — Pipecat's token authenticates the connection.

`activate` routes **every** call on your account — inbound and outbound — at this agent.
`{"action": "disable"}` hands them back to Dial's managed agent.

## 5. Call it

Call your Dial number. The agent greets you and answers; talk over it and it stops. Its logs
show each session's `/start` body and the call it opened:

```bash
pipecat cloud agent logs dial-voice-agent
```

If the call ends as `failed` straight away, `/start` was refused: check the agent name, the
public key, and that the agent is deployed and ready. If it connects but the agent never
speaks, check the secret set — a missing or wrong AI key shows up in the logs.

## Keep an agent warm

`pcc-deploy.toml` sets `min_agents = 1`, and production should keep it at least that. With no
warm agent, the first call after an idle spell waits on a cold start: Pipecat accepts the
connection before a bot is running to answer it, so the caller hears several seconds of
silence after pickup (6–11 s on live calls) until Dial notices and reconnects to a warm agent.
Raise `min_agents` to the number of calls you expect at once.

## Per-call context

Pipecat Cloud passes Dial's `/start` body to the bot as `runner_args.body`:

```json
{ "call_id": "...", "direction": "inbound", "from": "+14155550123", "to": "+14155550199" }
```

`bot.py` turns it into one line of the system prompt ("This is an inbound call: +1415… called
you."), on top of the call's own `instruction` from `call_connected`. It's there before the
first frame arrives, so it's also the place to look up the caller in your CRM or pick a prompt
per number. A mid-call reconnect is a fresh `/start` and a fresh session; `call_connected`
then has `reconnect: true` and the bot skips its greeting.

## Make it yours

Replace `stt`, `llm`, or `tts` in [`bot.py`](./bot.py) with any of Pipecat's
[supported services](https://docs.pipecat.ai/server/services/supported-services), add their
keys to the secret set and their extras to [`requirements.txt`](./requirements.txt), and
redeploy. The serializer doesn't care. Hanging up after a goodbye works the same as in the
[`pipecat-python` playbook](../pipecat-python#hanging-up-after-a-goodbye).

## Not handled (kept minimal)

`duration_warning` is logged, not acted on — a production bot should start wrapping up when it
arrives. No conversation state is carried across a reconnect; keep it keyed by `call_id`
outside the session if you need it.

While Self-Hosted audio is on, Dial never hears the call: no transcripts, recordings, or
summaries, and the built-in agent tools are inert. Your stack owns all of it.
