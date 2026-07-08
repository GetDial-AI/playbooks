"""Stupid-simple Dial Self-Hosted AUDIO server — Python.

In the "audio" variant, Dial pipes the raw call audio to your server over a
WebSocket (one per call, at ``wss://<this-server>/<call_id>``, signed with
``X-Dial-Signature``). This server verifies the signature and echoes the
caller's audio straight back — so the caller hears themselves. Press ``#`` to
hang up. It's the smallest possible conformant server; swap the echo for your
own speech-to-speech model or STT->LLM->TTS chain.

Speaks the Self-hosted audio protocol via ``dial-sdk``'s ``AudioPipeSession``
(https://docs.getdial.ai/api-reference/self-hosted-audio-protocol).

Env: PORT (default 8080), DIAL_SIGNING_SECRET (copy it from the dashboard).
"""

from __future__ import annotations

import asyncio
import http
import os

from dotenv import load_dotenv
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request

from dial_sdk import AudioPipeSession, verify_dial_signature

load_dotenv()

PORT = int(os.environ.get("PORT", "8080"))
SIGNING_SECRET = os.environ.get("DIAL_SIGNING_SECRET", "")


def _call_id_from_path(path: str) -> str:
    return path.rstrip("/").rsplit("/", 1)[-1]


def authorize(connection: ServerConnection, request: Request):
    """Reject at handshake unless the X-Dial-Signature is valid."""
    call_id = _call_id_from_path(request.path)
    signature = request.headers.get("x-dial-signature")
    if not call_id or not signature or not verify_dial_signature(SIGNING_SECRET, signature, call_id):
        return connection.respond(http.HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
    return None


async def handle_call(ws: ServerConnection) -> None:
    call_id = _call_id_from_path(ws.request.path)

    async def on_connected(info):
        tag = " [reconnect]" if info.reconnect else ""
        print(f"[{call_id}] call {info.call_id} ({info.direction}){tag}")

    session = AudioPipeSession(
        ws.send,
        on_call_connected=on_connected,
        on_media=lambda audio, seq: session.send_media(audio),  # echo
        on_dtmf=lambda digit: session.end_call() if digit == "#" else None,
        on_call_ended=lambda reason: print(f"[{call_id}] ended: {reason}"),
    )
    try:
        async for raw in ws:
            await session.dispatch(raw)
    except ConnectionClosed:
        pass
    finally:
        print(f"[{call_id}] closed")


async def main() -> None:
    if not SIGNING_SECRET:
        raise SystemExit("DIAL_SIGNING_SECRET is required")
    async with serve(handle_call, "0.0.0.0", PORT, process_request=authorize):
        print(f"audio echo server listening on :{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
