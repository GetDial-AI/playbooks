"""Stupid-simple Dial Self-Hosted AUDIO server — Python.

In the "audio" variant, Dial pipes the raw call audio to your server over a
WebSocket (one per call, at ``wss://<this-server>/<call_id>``, signed with
``X-Dial-Signature``). This server verifies the signature and echoes the
caller's audio straight back — so the caller hears themselves. Press ``#`` to
hang up. It's the smallest possible conformant server; swap the echo for your
own speech-to-speech model or STT->LLM->TTS chain.

The SDK (``dial-sdk``) gives you the protocol models + ``parse_dial_audio_message``
/ ``serialize_server_audio_message``; you own the WebSocket loop
(https://docs.getdial.ai/api-reference/self-hosted-audio-protocol).

Env: PORT (default 8080), DIAL_SIGNING_SECRET (copy it from the dashboard).
"""

from __future__ import annotations

import asyncio
import http
import os

from dotenv import load_dotenv
from pydantic import ValidationError
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request

from dial_sdk import (
    parse_dial_audio_message,
    serialize_server_audio_message,
    verify_dial_signature,
)
from dial_sdk.self_hosted import PingPong
from dial_sdk.self_hosted_audio import ServerAudioMedia, ServerEndCall

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
    try:
        async for raw in ws:
            try:
                msg = parse_dial_audio_message(raw)
            except ValidationError:
                continue  # a malformed frame must not kill the call
            if msg.type == "call_connected":
                tag = " [reconnect]" if msg.reconnect else ""
                print(f"[{call_id}] call {msg.call_id} ({msg.direction}){tag}")
            elif msg.type == "media":
                # Echo the same audio back. A real agent would base64-decode
                # msg.payload, run its stack, and re-encode.
                await ws.send(serialize_server_audio_message(ServerAudioMedia(payload=msg.payload)))
            elif msg.type == "dtmf" and msg.digit == "#":
                await ws.send(serialize_server_audio_message(ServerEndCall()))
            elif msg.type == "ping_pong":
                await ws.send(serialize_server_audio_message(PingPong(type="ping_pong", timestamp=msg.timestamp)))
            elif msg.type == "call_ended":
                print(f"[{call_id}] ended: {msg.reason}")
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
