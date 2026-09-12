"""FastAPI host for the Pipecat bot — one WebSocket per Dial call.

Dial opens ``wss://<your-host>/ws/<call_id>`` for every call, signed with
``X-Dial-Signature``. This server verifies that signature, reads the
``call_connected`` frame that always opens the connection, and hands the socket
to :func:`bot.run_bot`.

``call_connected`` has to be read here, before the pipeline exists, because it
carries the audio formats the serializer must speak and the sample rates the
pipeline runs at — neither is renegotiable in-band.

Env: PORT (default 8080), DIAL_SIGNING_SECRET, plus the service keys bot.py needs.
"""

from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from loguru import logger
from pydantic import ValidationError

from dial_sdk import parse_dial_audio_message, verify_dial_signature

from bot import run_bot

load_dotenv()

PORT = int(os.environ.get("PORT", "8080"))
SIGNING_SECRET = os.environ.get("DIAL_SIGNING_SECRET", "")

# WebSocket close codes.
POLICY_VIOLATION = 1008
UNSUPPORTED_DATA = 1003

app = FastAPI()


@app.websocket("/ws/{call_id}")
async def dial_call(websocket: WebSocket, call_id: str):
    """Serve one Dial call.

    Configure Self-Hosted with ``wss://<your-host>/ws`` — Dial appends the call
    id to the path itself.
    """
    signature = websocket.headers.get("x-dial-signature", "")
    if not verify_dial_signature(SIGNING_SECRET, signature, call_id):
        # Closing before accepting refuses the upgrade outright.
        logger.warning(f"[{call_id}] rejected: bad or missing X-Dial-Signature")
        await websocket.close(code=POLICY_VIOLATION)
        return

    await websocket.accept()

    try:
        first = parse_dial_audio_message(await websocket.receive_text())
    except ValidationError:
        logger.warning(f"[{call_id}] rejected: unparseable opening frame")
        await websocket.close(code=UNSUPPORTED_DATA)
        return

    if first.type != "call_connected":
        logger.warning(f"[{call_id}] rejected: expected call_connected, got {first.type}")
        await websocket.close(code=UNSUPPORTED_DATA)
        return

    await run_bot(websocket, first)


if __name__ == "__main__":
    if not SIGNING_SECRET:
        raise SystemExit("DIAL_SIGNING_SECRET is required")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
