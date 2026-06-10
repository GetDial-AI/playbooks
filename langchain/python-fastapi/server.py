"""
Dial Dashboard — a small FastAPI webapp on top of the `dial-langchain` library.

- WRITE actions (send SMS, place AI voice call) go through the official
  `dial-langchain` tools (SendMessageTool, MakeCallTool, ...).
- READ views (numbers, inbox, call history + transcripts) use the underlying
  `dial_sdk.DialClient` that dial-langchain depends on, because it returns
  structured objects (bodies, timestamps, transcripts) instead of display strings.

The Dial API key is the ONLY thing loaded — from a local `.env` file
(DIAL_API_KEY=sk_live_...) — and it is NEVER sent to the browser.
"""

from __future__ import annotations

import os
import pathlib
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from dial_sdk import DialClient, DialConfig
from dial_langchain import MakeCallTool, SendMessageTool

# ── Auth: the ONLY thing we load is DIAL_API_KEY from .env ────────────────────

load_dotenv(pathlib.Path(__file__).parent / ".env")

API_KEY: Optional[str] = os.environ.get("DIAL_API_KEY")
if not API_KEY:
    raise RuntimeError("DIAL_API_KEY is missing. Add it to .env (DIAL_API_KEY=sk_live_...).")

# Default "from" number is discovered from the API, not from any local file.
_DEFAULT_NUMBER_ID: Optional[str] = None


def _client() -> DialClient:
    return DialClient(DialConfig(api_key=API_KEY))


def _tool_kwargs() -> dict:
    return {"api_key": API_KEY}


async def _default_number_id() -> Optional[str]:
    """Lazily resolve a fallback 'from' number id from the account."""
    global _DEFAULT_NUMBER_ID
    if _DEFAULT_NUMBER_ID:
        return _DEFAULT_NUMBER_ID
    c = _client()
    try:
        nums = await c.list_numbers()
        if nums:
            _DEFAULT_NUMBER_ID = nums[0].id
    finally:
        await c.close()
    return _DEFAULT_NUMBER_ID


# ── Serialization helpers ─────────────────────────────────────────────────────

def _num_json(n: Any) -> dict:
    return {
        "id": n.id,
        "number": n.number,
        "country": n.country,
        "nickname": n.nickname,
        "capabilities": (n.capabilities or "").split(",") if isinstance(n.capabilities, str) else n.capabilities,
        "inbound_instruction": n.inbound_instruction,
        "created_at": n.created_at,
    }


def _msg_json(m: Any) -> dict:
    return {
        "id": m.id,
        "from": m.from_,
        "to": m.to,
        "body": m.body,
        "direction": m.direction,
        "channel": m.channel,
        "status": m.status,
        "phone_number_id": m.phone_number_id,
        "created_at": m.created_at,
    }


def _call_json(c: Any) -> dict:
    status = c.status
    label = None
    if isinstance(status, dict):
        label = status.get("label") or status.get("state")
    return {
        "id": c.id,
        "from": c.from_,
        "to": c.to,
        "direction": c.direction,
        "duration": int(c.duration) if c.duration not in (None, "None") else None,
        "status": label or str(status),
        "termination_type": c.termination_type,
        "transcript": c.transcript,
        "instruction": c.instruction,
        "created_at": c.created_at,
        "call_started_at": c.call_started_at,
        "terminated_at": c.terminated_at,
    }


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Dial Dashboard")

STATIC_DIR = pathlib.Path(__file__).parent / "static"


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
async def status():
    # Everything here is derived from the API using the key; nothing local is read.
    c = _client()
    try:
        nums = await c.list_numbers()
    finally:
        await c.close()
    first = nums[0] if nums else None
    return {
        "default_number": first.number if first else None,
        "default_number_id": first.id if first else None,
        "number_count": len(nums),
    }


@app.get("/api/numbers")
async def numbers():
    c = _client()
    try:
        nums = await c.list_numbers()
        return {"numbers": [_num_json(n) for n in nums]}
    finally:
        await c.close()


@app.get("/api/messages")
async def messages(direction: Optional[str] = None, number_id: Optional[str] = None):
    c = _client()
    try:
        msgs = await c.list_messages(number_id=number_id, direction=direction)
        out = [_msg_json(m) for m in msgs]
        out.sort(key=lambda m: m["created_at"] or "", reverse=True)
        return {"messages": out}
    finally:
        await c.close()


@app.get("/api/calls")
async def calls(direction: Optional[str] = None, number_id: Optional[str] = None):
    c = _client()
    try:
        cs = await c.list_calls(number_id=number_id, direction=direction)
        out = [_call_json(x) for x in cs]
        out.sort(key=lambda x: x["created_at"] or "", reverse=True)
        return {"calls": out}
    finally:
        await c.close()


@app.get("/api/calls/{call_id}")
async def call_detail(call_id: str):
    c = _client()
    try:
        call = await c.get_call(call_id)
        return {"call": _call_json(call)}
    finally:
        await c.close()


# ── Write actions: routed through dial-langchain tools ────────────────────────

class SendPayload(BaseModel):
    to: str
    body: str
    from_number_id: Optional[str] = None
    channel: str = "sms"


class CallPayload(BaseModel):
    to: str
    outbound_instruction: str
    from_number_id: Optional[str] = None
    language: Optional[str] = None


def _e164(v: str) -> str:
    v = v.strip().replace(" ", "").replace("-", "")
    if not v.startswith("+") or not v[1:].isdigit():
        raise HTTPException(400, f"Phone number must be E.164 (e.g. +14155550123), got: {v!r}")
    return v


@app.post("/api/send")
async def send_sms(p: SendPayload):
    to = _e164(p.to)
    if not p.body.strip():
        raise HTTPException(400, "Message body is required")
    from_id = p.from_number_id or await _default_number_id()
    if not from_id:
        raise HTTPException(400, "No from_number_id available")
    tool = SendMessageTool(**_tool_kwargs())
    try:
        result = await tool.arun(
            {"to": to, "from_number_id": from_id, "body": p.body, "channel": p.channel}
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Dial error: {e}")
    return {"ok": True, "result": result}


@app.post("/api/call")
async def make_call(p: CallPayload):
    to = _e164(p.to)
    if not p.outbound_instruction.strip():
        raise HTTPException(400, "An outbound instruction (what the AI should say/do) is required")
    from_id = p.from_number_id or await _default_number_id()
    if not from_id:
        raise HTTPException(400, "No from_number_id available")
    tool = MakeCallTool(**_tool_kwargs())
    args = {"to": to, "from_number_id": from_id, "outbound_instruction": p.outbound_instruction}
    if p.language:
        args["language"] = p.language
    try:
        result = await tool.arun(args)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Dial error: {e}")
    return {"ok": True, "result": result}


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ── AI agent (LangChain) endpoints ────────────────────────────────────────────
import agent as _agent


@app.get("/api/agent/info")
async def get_agent_info():
    return _agent.agent_info()


class AgentPayload(BaseModel):
    input: str
    allow_writes: bool = False


@app.post("/api/agent")
async def agent_run(p: AgentPayload):
    if not p.input.strip():
        raise HTTPException(400, "input is required")
    c = _client()
    try:
        nums = await c.list_numbers()
    finally:
        await c.close()
    first = nums[0] if nums else None
    try:
        result = await _agent.run_agent(
            user_input=p.input,
            api_key=API_KEY,
            allow_writes=p.allow_writes,
            default_number=first.number if first else None,
            default_number_id=first.id if first else None,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Agent error: {e}")
    return result
