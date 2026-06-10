"""FastAPI dashboard for the Dial SDK — place AI voice calls + send/receive SMS."""
from __future__ import annotations

import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import Request
from pydantic import BaseModel, field_validator

from config import load_settings
from dial_service import DialService

BASE_DIR = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

E164 = re.compile(r"^\+[1-9]\d{1,14}$")


def _valid_e164(v: str) -> str:
    v = (v or "").strip().replace(" ", "").replace("-", "")
    if not E164.match(v):
        raise ValueError("Phone number must be E.164, e.g. +14155550123")
    return v


class SmsRequest(BaseModel):
    to: str
    body: str
    from_number_id: str | None = None

    @field_validator("to")
    @classmethod
    def _to(cls, v: str) -> str:
        return _valid_e164(v)

    @field_validator("body")
    @classmethod
    def _body(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("Message body cannot be empty")
        return v


class CallRequest(BaseModel):
    to: str
    instruction: str
    language: str | None = None
    from_number_id: str | None = None

    @field_validator("to")
    @classmethod
    def _to(cls, v: str) -> str:
        return _valid_e164(v)

    @field_validator("instruction")
    @classmethod
    def _instr(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("Call instruction cannot be empty")
        return v


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings()
    service = DialService(settings)
    await service.start()
    app.state.service = service
    try:
        yield
    finally:
        await service.stop()


app = FastAPI(title="Dial Dashboard", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


def svc(app: FastAPI) -> DialService:
    return app.state.service


# ---- pages -----------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    service = svc(request.app)
    default = next((n for n in service.numbers if n["id"] == service.default_number_id), None)
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "numbers": service.numbers,
            "default_number": default,
        },
    )


# ---- REST ------------------------------------------------------------------
@app.get("/api/numbers")
async def api_numbers(request: Request):
    return {"numbers": await svc(request.app).refresh_numbers(),
            "default_number_id": svc(request.app).default_number_id}


@app.get("/api/messages")
async def api_messages(request: Request, direction: str | None = None):
    return {"messages": await svc(request.app).list_messages(direction=direction)}


@app.get("/api/calls")
async def api_calls(request: Request, direction: str | None = None):
    return {"calls": await svc(request.app).list_calls(direction=direction)}


@app.get("/api/calls/{call_id}")
async def api_call(request: Request, call_id: str):
    try:
        return {"call": await svc(request.app).get_call(call_id)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/sms")
async def api_send_sms(request: Request, req: SmsRequest):
    try:
        msg = await svc(request.app).send_sms(req.to, req.body, req.from_number_id)
        return {"ok": True, "message": msg}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/call")
async def api_place_call(request: Request, req: CallRequest):
    try:
        call = await svc(request.app).place_call(
            req.to, req.instruction, req.language, req.from_number_id
        )
        return {"ok": True, "call": call}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))


# ---- live events websocket -------------------------------------------------
@app.websocket("/ws")
async def ws_events(websocket: WebSocket):
    await websocket.accept()
    service = svc(websocket.app)
    q = service.hub.subscribe()
    try:
        # replay recent events so a fresh dashboard isn't empty
        for ev in service.hub.recent():
            await websocket.send_json({"kind": "history", "event": ev})
        while True:
            ev = await q.get()
            await websocket.send_json({"kind": "live", "event": ev})
    except WebSocketDisconnect:
        pass
    finally:
        service.hub.unsubscribe(q)
