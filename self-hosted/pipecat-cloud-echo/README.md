# Dial Self-Hosted playbook — Pipecat Cloud echo

The smallest bot that proves Dial's **Pipecat Cloud** audio target end to end: it plays the
caller's audio straight back. No speech-to-text, LLM, or text-to-speech, so **no AI service
keys** — deploy it, point Dial at it, call your number, and you hear your own voice.

That one call exercises the whole path: Dial calls the agent's `/start` endpoint with your
Pipecat Cloud public key, connects with the single-use token it gets back, sends
`call_connected`, and audio flows both ways through `DialFrameSerializer`. Once the echo works,
replace the `Echo` processor in `bot.py` with your own pipeline, knowing the plumbing is right: the
transport and serializer stay exactly as they are. The [`pipecat-python`](../pipecat-python)
playbook shows a full speech-to-text → LLM → text-to-speech pipeline to borrow from.

## What's here

| File | What it does |
|---|---|
| [`bot.py`](./bot.py) | Pipecat Cloud entrypoint: reads `call_connected`, then echoes audio through `DialFrameSerializer`. |
| [`dial_serializer.py`](./dial_serializer.py) | Copy of [`../pipecat-python/dial_serializer.py`](../pipecat-python/dial_serializer.py) — keep them in sync. |
| [`pcc-deploy.toml`](./pcc-deploy.toml) | Agent `dial-echo` in `us-west`, token auth on, one warm agent. |
| [`Dockerfile`](./Dockerfile) | Pipecat's base image plus the two files above. |

Full contract: the
[self-hosted audio protocol](https://docs.getdial.ai/api-reference/self-hosted-audio-protocol/overview).
Setup reference: [Self-Hosted → Pipecat Cloud](https://docs.getdial.ai/documentation/platform/self-hosted#pipecat-cloud).

## Deploy it

Requires a [Pipecat Cloud](https://pipecat.daily.co) account and a Dial account with
[Self-Hosted access granted](https://docs.getdial.ai/documentation/platform/self-hosted#request-access).

```bash
uv tool install "pipecat-ai[cli]" --with pipecatcloud
pipecat cloud auth login
pipecat cloud deploy                  # builds in the cloud from this folder; no registry needed
pipecat cloud agent status dial-echo  # wait until it reports ready
```

Dial needs your Pipecat Cloud **public** key (`pk_…`) to start sessions. List the ones you
have, or create one (it's shown once — copy it straight into Dial):

```bash
pipecat cloud organizations keys list
pipecat cloud organizations keys create --name dial
```

> [!WARNING]
> **Treat the public key as a secret.** Despite the name, anyone who has it can start sessions
> on your agents, which Pipecat bills to you. Never share it, commit it, or put it in
> client-side code. Dial stores it encrypted and only shows it masked.

## Point Dial at it

On the [dashboard Self-Hosted page](https://getdial.ai/dashboard/self-hosted), open the
**audio** card, choose **Pipecat Cloud** as the target, and enter the agent name (`dial-echo`)
and the public key. Or over REST:

```bash
curl -X POST https://api.getdial.ai/v1/self-hosted \
  -H "Authorization: Bearer $DIAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "action": "activate", "config": { "type": "audio",
        "pipecatCloud": { "agentName": "dial-echo", "publicKey": "pk_..." },
        "audioInboundFormat": "mulaw_8000", "audioOutboundFormat": "mulaw_8000" } }'
```

`pipecatCloud` takes the place of `wsUrl`. Pipecat authenticates each connection with its
token, so there's no `X-Dial-Signature` to verify and no signing secret to copy.

`activate` routes **every** call on your account — inbound and outbound — at this agent.
`{"action": "disable"}` hands them back to Dial's managed agent.

## Try it

Call your Dial number. You should hear yourself, slightly delayed, for as long as you talk.
The agent's logs show each session's `/start` body and the call it opened:

```bash
pipecat cloud agent logs dial-echo
```

If the call ends as `failed` straight away, `/start` was refused: check the agent name, the
public key, and that the agent is deployed and ready.

## Why one warm agent

`pcc-deploy.toml` keeps `min_agents = 1`. With `0` the echo still works and costs nothing
while idle, which is fine for a quick smoke test, but each call after an idle spell waits on a
cold start: Pipecat accepts the socket before a bot is running to answer it, and the caller
hears **6–11 s of silence** after pickup (measured on live calls) before Dial reconnects to a
warm agent. Keep at least one warm agent for anything a real caller will hear.
