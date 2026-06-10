# Dial Playbooks

Runnable reference implementations for building on [Dial](https://getdial.ai) — give your
software a real phone number to **send & receive SMS** and **place AI-driven voice calls**.
You can call the Dial API directly, bring your own LLM over a WebSocket, or drive everything
from an **LLM agent** using the [`dial-langchain`](https://pypi.org/project/dial-langchain/) tools.

Each playbook is a **self-contained example in its own directory** — clone the repo,
drop in your Dial API key, and run it.

## Playbooks

Playbooks are grouped by category (`<category>/<stack>`). Pick the one closest to what
you're building.

### SMS &amp; Voice

Send and receive SMS, and place AI-driven voice calls with the Dial SDK.

| Playbook | Language | What it shows |
|---|---|---|
| [`sms-and-voice/python-fastapi`](./sms-and-voice/python-fastapi) | Python (FastAPI) | A web dashboard that places AI voice calls, sends SMS, and streams inbound SMS/call events live over a WebSocket |

### Self-Hosted

Bring your own LLM over a WebSocket — see the
[Self-Hosted docs](https://docs.getdial.ai/documentation/platform/self-hosted) and the
[protocol reference](https://docs.getdial.ai/api-reference/self-hosted-protocol).

| Playbook | Language | What it shows |
|---|---|---|
| [`self-hosted/openai-node`](./self-hosted/openai-node) | Node.js | Driving calls with the OpenAI SDK, focused on transcript interrupts |
| [`self-hosted/openai-python`](./self-hosted/openai-python) | Python | The same, in Python — driving calls with the OpenAI SDK over the `dial-sdk` protocol types, focused on transcript interrupts |

### AI Agent

Drive Dial from a [LangChain](https://www.langchain.com/) agent using the
[`dial-langchain`](https://pypi.org/project/dial-langchain/) tools, with a pluggable LLM.

| Playbook | Language | What it shows |
|---|---|---|
| [`ai-agent/python-langchain`](./ai-agent/python-langchain) | Python (LangChain) | A tool-calling agent over the `dial-langchain` tools — a fake offline LLM or a real OpenAI/OpenRouter model via `.env` — plus a dashboard for SMS, AI voice calls, inbox, and transcripts |

## Running a playbook

Each directory is standalone, with its own README and setup steps. The general shape:

1. `cd <category>/<stack>`
2. Copy `.env.example` to `.env` and add your Dial API key (`sk_live_...`).
3. Follow that playbook's README to install dependencies and run.

Don't have a key yet? Sign up at [getdial.ai](https://getdial.ai) to get one and
provision a phone number.

## Adding a playbook

New playbooks are welcome — the repo is designed to grow. To add one:

1. **Choose a category.** Reuse an existing top-level folder (`sms-and-voice/`,
   `self-hosted/`, …) or create a new one named after the Dial capability or use case
   you're demonstrating.
2. **Create `<category>/<stack>/`** containing a self-contained example. `<stack>`
   names the language/framework — e.g. `python-fastapi`, `openai-node`, `node-next`.
3. **Include a `README.md`** (what it shows, how to set up, how to run) and a
   **`.env.example`** with placeholder values.
4. **List it** by adding a row to the matching category table above — or a new
   category section if you created one.
5. **Open a PR.**

### Conventions

- **Self-contained.** One runnable example per directory; no shared build or root
  package. A reader should be able to `cd` in and run it from the README alone.
- **Naming:** `<category>/<stack>` — category = the Dial capability or use case,
  stack = the language/framework.
- **Secrets only via `.env`.** `.env` is gitignored repo-wide; commit a
  `.env.example` with placeholders and **never** a real key.
- **E.164 phone numbers** everywhere (`+14155550123`).
- **Keep it minimal.** Show the one idea clearly; link to the
  [docs](https://docs.getdial.ai) for the rest.
