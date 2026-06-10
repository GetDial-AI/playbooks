"""Thin async wrapper around dial-sdk + a live event hub.

Responsibilities:
  * own a single long-lived DialClient
  * expose call/SMS/list helpers that return JSON-serialisable dicts
  * run a background loop that consumes the SDK's live EventsConnection
    (message.received / call.ended / call.transcribed) and fans each event
    out to every connected dashboard via an in-memory pub/sub hub.
"""
from __future__ import annotations

import asyncio
import dataclasses
import enum
from typing import Any

from dial_sdk import (
    DialClient,
    DialConfig,
    MakeCallParams,
    SendMessageParams,
)

# Events we surface to the UI. Anything else from the stream (keepalives,
# ping/pong, unknown future types) is ignored.
UI_EVENT_TYPES = {"message.received", "call.ended", "call.transcribed"}


def jsonable(obj: Any) -> Any:
    """Recursively convert SDK dataclasses / enums into JSON-friendly data.

    Also normalises the SDK's ``from_`` field back to ``from`` for the UI.
    """
    if isinstance(obj, enum.Enum):
        return obj.value
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        out: dict[str, Any] = {}
        for k, v in vars(obj).items():
            key = "from" if k == "from_" else k
            out[key] = jsonable(v)
        return out
    if isinstance(obj, dict):
        return {("from" if k == "from_" else k): jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonable(v) for v in obj]
    return obj


def normalize_event(ev: Any) -> dict[str, Any] | None:
    """Turn a raw stream event into a flat dict, or None if it should be dropped."""
    if not isinstance(ev, dict):
        return None
    etype = ev.get("type")
    if etype not in UI_EVENT_TYPES:
        return None
    data = jsonable(ev.get("data") or {})
    return {
        "id": ev.get("id"),
        "type": etype,
        "createdAt": ev.get("createdAt"),
        "relatedObject": jsonable(ev.get("relatedObject")),
        "data": data,
    }


class EventHub:
    """In-memory pub/sub with a small replay buffer for late subscribers."""

    def __init__(self, history: int = 200) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._history: list[dict] = []
        self._max = history

    def publish(self, event: dict) -> None:
        self._history.append(event)
        if len(self._history) > self._max:
            self._history = self._history[-self._max :]
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:  # pragma: no cover - defensive
                pass

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def recent(self) -> list[dict]:
        return list(self._history)


class DialService:
    def __init__(self, settings) -> None:
        self._settings = settings
        self._client = DialClient(DialConfig(api_key=settings.api_key, base_url=settings.base_url))
        self.hub = EventHub()
        self.numbers: list[dict] = []
        self.default_number_id: str | None = settings.number_id
        self._events_task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    # ---- lifecycle ---------------------------------------------------------
    async def start(self) -> None:
        await self._client.__aenter__()
        # Best-effort initial number fetch — a slow/transient API call must not
        # block the dashboard from booting. /api/numbers refreshes on demand.
        for attempt in range(3):
            try:
                await self.refresh_numbers()
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    print(f"[dial] initial list_numbers failed ({e}); will load lazily.")
                else:
                    await asyncio.sleep(1.5)
        self._events_task = asyncio.create_task(self._events_loop(), name="dial-events")

    async def stop(self) -> None:
        self._stop.set()
        if self._events_task:
            self._events_task.cancel()
            try:
                await self._events_task
            except (asyncio.CancelledError, Exception):
                pass
        await self._client.__aexit__(None, None, None)

    # ---- numbers -----------------------------------------------------------
    async def refresh_numbers(self) -> list[dict]:
        nums = await self._client.list_numbers()
        self.numbers = [jsonable(n) for n in nums]
        if not self.default_number_id and self.numbers:
            self.default_number_id = self.numbers[0]["id"]
        return self.numbers

    def _resolve_from(self, from_number_id: str | None) -> str:
        nid = from_number_id or self.default_number_id
        if not nid:
            raise ValueError("No sending number available. Provision a number in Dial first.")
        return nid

    # ---- actions -----------------------------------------------------------
    async def send_sms(self, to: str, body: str, from_number_id: str | None = None) -> dict:
        msg = await self._client.send_message(
            SendMessageParams(
                to=to,
                from_number_id=self._resolve_from(from_number_id),
                body=body,
                channel="sms",
            )
        )
        return jsonable(msg)

    async def place_call(
        self,
        to: str,
        outbound_instruction: str,
        language: str | None = None,
        from_number_id: str | None = None,
    ) -> dict:
        call = await self._client.make_call(
            MakeCallParams(
                to=to,
                from_number_id=self._resolve_from(from_number_id),
                outbound_instruction=outbound_instruction,
                language=language,
            )
        )
        return jsonable(call)

    async def get_call(self, call_id: str) -> dict:
        return jsonable(await self._client.get_call(call_id))

    async def list_calls(self, direction: str | None = None) -> list[dict]:
        calls = await self._client.list_calls(direction=direction)
        return [jsonable(c) for c in calls]

    async def list_messages(self, direction: str | None = None) -> list[dict]:
        msgs = await self._client.list_messages(direction=direction)
        return [jsonable(m) for m in msgs]

    # ---- live events -------------------------------------------------------
    async def _events_loop(self) -> None:
        """Keep an EventsConnection open; reconnect with backoff on failure."""
        backoff = 1
        while not self._stop.is_set():
            conn = self._client.new_events_connection()
            try:
                await conn.open()
                self.hub.publish({"type": "_status", "data": {"connected": True}})
                backoff = 1
                async for raw in conn:
                    norm = normalize_event(raw)
                    if norm:
                        self.hub.publish(norm)
            except asyncio.CancelledError:
                await self._safe_close(conn)
                raise
            except Exception as e:  # noqa: BLE001 - surface + reconnect
                self.hub.publish({"type": "_status", "data": {"connected": False, "error": str(e)}})
            finally:
                await self._safe_close(conn)
            if self._stop.is_set():
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    @staticmethod
    async def _safe_close(conn) -> None:
        try:
            await conn.close()
        except Exception:  # noqa: BLE001
            pass
