"""Reference Self-Hosted server for Dial — Python port of the openai-node playbook.

Dial opens one WebSocket per call to ``wss://<this-server>/<call_id>``, signed
with ``X-Dial-Signature``. This server verifies the signature, then drives the
conversation with the OpenAI SDK — streaming tokens back as ``response`` frames.

The focus is **transcript interrupts**: when a newer ``response_required``
arrives (the caller spoke again), we abort the in-flight OpenAI stream and
answer the new turn, so the agent never talks over the user. See
https://docs.getdial.ai/documentation/platform/self-hosted.

It speaks the Self-hosted protocol via ``dial-sdk`` (pydantic schemas +
``verify_dial_signature``).

Env: PORT (default 8080), OPENAI_API_KEY, OPENAI_MODEL (default gpt-4o-mini),
     DIAL_SIGNING_SECRET (shown once when you enable Self-Hosted).
"""

from __future__ import annotations

import asyncio
import http
import json
import os
import sys

from dotenv import load_dotenv
from openai import AsyncOpenAI
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request

from dial_sdk import (
    CallConnected,
    PingPong,
    ReminderRequired,
    Response,
    ResponseRequired,
    TranscriptItem,
    parse_dial_message,
    serialize_server_message,
    verify_dial_signature,
)

load_dotenv()

PORT = int(os.environ.get("PORT", "8080"))
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
SIGNING_SECRET = os.environ.get("DIAL_SIGNING_SECRET")

openai = AsyncOpenAI()

# Used until `call_connected` arrives with Dial's per-call instruction (the
# system_prompt — your outbound/inbound instruction plus Dial's general context
# like the current time and the voice's gender).
DEFAULT_PROMPT = (
    "You are a friendly, concise voice agent on a phone call. "
    "Keep replies short and natural."
)

# Appended to the active system prompt so the model knows it can hang up.
END_CALL_HINT = (
    "When the conversation is finished or the caller wants to hang up, call the "
    "end_call tool with a brief, natural farewell instead of replying with text."
)

# OpenAI function tools live *inside* this server. The Dial protocol abstracts
# tools away — there's no tool channel on the wire — so when the model calls
# end_call we simply send a `response` with `end_call: true`, which tells Dial
# to hang up after the farewell is spoken.
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "end_call",
            "description": (
                "End the phone call. Use when the task is complete, the caller "
                "says goodbye, or the conversation has naturally concluded."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "farewell": {
                        "type": "string",
                        "description": "A short, natural goodbye to say before hanging up.",
                    },
                },
                "required": ["farewell"],
            },
        },
    },
]


def _call_id_from_path(path: str) -> str:
    """Extract the trailing `<call_id>` segment from the request path."""
    return path.split("?", 1)[0].strip("/").split("/")[-1]


def _to_messages(instruction: str, transcript: list[TranscriptItem]) -> list[dict]:
    """Map the Dial transcript to OpenAI chat messages under the system prompt."""
    return [
        {"role": "system", "content": f"{instruction}\n\n{END_CALL_HINT}"},
        *(
            {
                "role": "assistant" if t.role == "agent" else "user",
                "content": t.content,
            }
            for t in transcript
        ),
    ]


def authorize(connection: ServerConnection, request: Request):
    """Authorize at handshake time: confirm the connection is genuinely from Dial.

    Returns an HTTP 401 response to reject, or ``None`` to accept and proceed to
    the WebSocket handler.
    """
    call_id = _call_id_from_path(request.path)
    signature = request.headers.get("x-dial-signature")
    if not call_id or not signature or not verify_dial_signature(
        SIGNING_SECRET, signature, call_id
    ):
        return connection.respond(http.HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
    return None


class CallSession:
    """One Dial call: keeps a single in-flight OpenAI stream and the active prompt."""

    def __init__(self, ws: ServerConnection, call_id: str) -> None:
        self.ws = ws
        self.call_id = call_id
        self.in_flight: asyncio.Task | None = None  # the current OpenAI stream
        self.system_instruction = DEFAULT_PROMPT  # replaced by call_connected.instruction

    def cancel_in_flight(self) -> None:
        if self.in_flight and not self.in_flight.done():
            self.in_flight.cancel()
        self.in_flight = None

    async def answer(self, response_id: int, transcript: list[TranscriptItem]) -> None:
        stream = None
        try:
            stream = await openai.chat.completions.create(
                model=MODEL,
                messages=_to_messages(self.system_instruction, transcript),
                stream=True,
                tools=TOOLS,
                tool_choice="auto",
            )
            tool_name = ""
            tool_args = ""
            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta is None:
                    continue
                if delta.content:
                    await self.ws.send(
                        serialize_server_message(
                            Response(
                                type="response",
                                response_id=response_id,
                                content=delta.content,
                                content_complete=False,
                            )
                        )
                    )
                if delta.tool_calls:
                    call = delta.tool_calls[0].function
                    if call and call.name:
                        tool_name = call.name
                    if call and call.arguments:
                        tool_args += call.arguments

            if tool_name == "end_call":
                # Map the model's tool call to the protocol's end_call: speak the
                # farewell, then Dial hangs up.
                farewell = "Thanks for calling — goodbye!"
                try:
                    args = json.loads(tool_args or "{}")
                    if isinstance(args.get("farewell"), str) and args["farewell"].strip():
                        farewell = args["farewell"]
                except json.JSONDecodeError:
                    pass  # keep the default farewell
                await self.ws.send(
                    serialize_server_message(
                        Response(
                            type="response",
                            response_id=response_id,
                            content=farewell,
                            content_complete=True,
                            end_call=True,
                        )
                    )
                )
            else:
                await self.ws.send(
                    serialize_server_message(
                        Response(
                            type="response",
                            response_id=response_id,
                            content="",
                            content_complete=True,
                        )
                    )
                )
        except asyncio.CancelledError:
            raise  # expected on interrupt — superseded by a newer turn
        except ConnectionClosed:
            pass  # the call hung up mid-reply
        except Exception as err:  # noqa: BLE001
            print(f"[{self.call_id}] openai error: {err}", file=sys.stderr)
        finally:
            if stream is not None:
                try:
                    await stream.close()
                except Exception:  # noqa: BLE001
                    pass

    async def on_message(self, raw) -> None:
        try:
            msg = parse_dial_message(raw)
        except Exception:  # noqa: BLE001
            return  # ignore frames we don't recognize

        # Print every message arriving from Dial (already debounced/deduped by Dial).
        print(f"[{self.call_id}] <- {msg.type} {msg.model_dump_json()}")

        if isinstance(msg, CallConnected):
            # Sent on connect (and reconnect). Use Dial's per-call instruction
            # (system_prompt + general context) as the system prompt; falls back
            # to DEFAULT_PROMPT when absent.
            if msg.instruction:
                self.system_instruction = msg.instruction
        elif isinstance(msg, PingPong):
            # Keepalive: echo it straight back so Dial knows we're alive.
            await self.ws.send(
                serialize_server_message(PingPong(type="ping_pong", timestamp=msg.timestamp))
            )
        elif isinstance(msg, (ResponseRequired, ReminderRequired)):
            # Interrupt focus: a new turn supersedes any response still streaming.
            self.cancel_in_flight()
            self.in_flight = asyncio.create_task(self.answer(msg.response_id, msg.transcript))


async def handle_call(ws: ServerConnection) -> None:
    call_id = _call_id_from_path(ws.request.path)
    print(f"[{call_id}] connected")
    session = CallSession(ws, call_id)
    try:
        async for raw in ws:
            await session.on_message(raw)
    except ConnectionClosed:
        pass
    finally:
        session.cancel_in_flight()
        print(f"[{call_id}] closed")


async def main() -> None:
    if not SIGNING_SECRET:
        raise SystemExit("DIAL_SIGNING_SECRET is required")
    async with serve(handle_call, "0.0.0.0", PORT, process_request=authorize):
        print(f"Self-Hosted playbook server listening on :{PORT}")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
