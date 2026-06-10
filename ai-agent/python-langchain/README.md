# Dial LangChain playbook — AI agent + dashboard

A web dashboard built on the [`dial-langchain`](https://pypi.org/project/dial-langchain/)
Python library. It shows how to drive Dial from a **LangChain tool-calling agent** — with a
pluggable LLM — alongside a classic dashboard for the same actions.

- 🧠 **LangChain agent** — type a natural-language instruction; the agent decides which
  `dial-langchain` tools to call (`list_numbers`, `list_messages`, `list_calls`, `get_call`,
  and, when enabled, `send_message` / `make_call` / `set_number_properties` / `purchase_number`).
- 🔌 **Pluggable LLM via `.env`** — run a **fake offline model** (no key, no cost) to test the
  whole loop, or inject a real **OpenAI / OpenRouter** model + model id.
- 🗣️ **Place AI voice calls** and 💬 **send SMS** from your Dial number.
- 📥 **Inbox + call history** — inbound SMS auto-refresh; click any call for its full transcript.

Built with **FastAPI** + a dependency-free vanilla-JS frontend. The agent itself is a small,
readable tool-calling loop in [`agent.py`](./agent.py) — no extra agent framework required.

## Run it

The Dial API key and LLM config are read **only** from `.env`:

```bash
cp .env.example .env        # then put your sk_live_... key in DIAL_API_KEY
./run.sh                    # creates a venv, installs deps, starts on :8000
```

Open http://localhost:8000

No `run.sh`? `python -m venv .venv && .venv/bin/pip install -r requirements.txt`, then
`.venv/bin/uvicorn server:app --reload`.

Get a key by signing up at [getdial.ai](https://getdial.ai).

## Choosing the LLM

Set these in `.env`:

```
LLM_PROVIDER=fake          # fake | openai | openrouter   (default: fake)
LLM_MODEL=gpt-4o-mini

# provider=openai
OPENAI_API_KEY=sk-...

# provider=openrouter  (model e.g. anthropic/claude-3.5-sonnet)
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

- **`fake`** — a scripted `FakeMessagesListChatModel` that actually invokes the read-only
  `list_numbers` tool, so you can exercise the agent loop offline with no key.
- **`openai` / `openrouter`** — a real `ChatOpenAI` that picks tools on its own. OpenRouter is
  the same OpenAI API with a different `base_url`.

The **"Allow write actions"** checkbox controls whether `send_message` / `make_call` / etc. are
exposed to the agent — **off by default**, so an LLM can't text or call anyone unless you opt in.

## API surface

| Method | Path                | Purpose                                          |
|--------|---------------------|--------------------------------------------------|
| GET    | `/`                 | Dashboard UI                                     |
| GET    | `/api/status`       | Default number + number count (from the API)     |
| GET    | `/api/numbers`      | Your provisioned numbers                         |
| GET    | `/api/messages`     | Message history (`?direction=`, `?number_id=`)   |
| GET    | `/api/calls`        | Call history (`?direction=`, `?number_id=`)      |
| GET    | `/api/calls/{id}`   | Single call + transcript                         |
| POST   | `/api/send`         | Send an SMS `{to, body, from_number_id?}`        |
| POST   | `/api/call`         | Place a call `{to, outbound_instruction, ...}`   |
| GET    | `/api/agent/info`   | Active LLM provider + model                       |
| POST   | `/api/agent`        | Run the agent `{input, allow_writes}`            |

## Files

```
server.py          FastAPI app: dashboard routes + agent endpoints
agent.py           LangChain tool-calling loop; LLM factory (fake/openai/openrouter)
requirements.txt   dependencies
run.sh             one-command launcher (venv + install + uvicorn)
static/            index.html dashboard, app.js, styles.css
```

## Notes

- **Write actions go through the official `dial-langchain` tools**; read views use the
  underlying `dial_sdk.DialClient` for structured data (message bodies, timestamps, transcripts).
- The Dial API key is **never** sent to the browser. Phone numbers are **E.164** (`+14155550123`).
