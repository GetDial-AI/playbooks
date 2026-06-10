"""
A tiny tool-calling agent wired to the `dial-langchain` tools.

The LLM is chosen from .env:

    LLM_PROVIDER=fake          # fake | openai | openrouter   (default: fake)
    LLM_MODEL=gpt-4o-mini      # model id (provider-specific)
    OPENAI_API_KEY=sk-...      # for provider=openai
    OPENROUTER_API_KEY=sk-or-..# for provider=openrouter
    OPENROUTER_BASE_URL=https://openrouter.ai/api/v1   # optional override

- provider=fake  -> a scripted FakeMessagesListChatModel that actually calls a
  (read-only) Dial tool, so you can exercise the whole loop with NO real LLM.
- provider=openai / openrouter -> a real ChatOpenAI that decides which tools to
  call. OpenRouter is just OpenAI's API with a different base_url.

Only DIAL_API_KEY + the LLM_* vars are read, all from .env.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from dial_langchain import DialToolkit

# valid arg keys per tool -- used to sanitize whatever the LLM proposes
TOOL_ARGS = {
    "list_numbers": [],
    "list_messages": ["number_id", "direction"],
    "list_calls": ["number_id", "direction"],
    "get_call": ["call_id"],
    "send_message": ["to", "from_number_id", "body", "channel"],
    "make_call": ["to", "from_number_id", "outbound_instruction", "language"],
    "set_number_properties": ["number_id", "inbound_instruction", "nickname"],
    "purchase_number": ["country", "area_code"],
}
READ_TOOLS = {"list_numbers", "list_messages", "list_calls", "get_call"}
WRITE_TOOLS = {"send_message", "make_call", "set_number_properties", "purchase_number"}


def provider() -> str:
    return (os.environ.get("LLM_PROVIDER") or "fake").strip().lower()


def model_name() -> str:
    return (os.environ.get("LLM_MODEL") or "").strip()


def agent_info() -> dict:
    p = provider()
    return {
        "provider": p,
        "model": model_name() or ("scripted-fake" if p == "fake" else "(unset)"),
        "is_fake": p == "fake",
    }


def _build_tools(api_key: str, allow_writes: bool) -> "dict[str, Any]":
    # Source every tool from the official toolkit, then gate by read/write.
    catalog = {t.name: t for t in DialToolkit(api_key=api_key).get_tools()}
    names = READ_TOOLS | (WRITE_TOOLS if allow_writes else set())
    return {n: t for n, t in catalog.items() if n in names}


def _build_llm():
    p = provider()
    if p == "fake":
        return None  # handled specially (scripted)
    from langchain_openai import ChatOpenAI

    model = model_name()
    if not model:
        raise RuntimeError("LLM_MODEL is required when LLM_PROVIDER is not 'fake'.")
    if p == "openrouter":
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise RuntimeError("OPENROUTER_API_KEY missing in .env")
        base = os.environ.get("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1"
        return ChatOpenAI(model=model, api_key=key, base_url=base, temperature=0)
    if p == "openai":
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY missing in .env")
        base = os.environ.get("OPENAI_BASE_URL")  # optional
        kwargs = {"model": model, "api_key": key, "temperature": 0}
        if base:
            kwargs["base_url"] = base
        return ChatOpenAI(**kwargs)
    raise RuntimeError(f"Unknown LLM_PROVIDER={p!r} (use fake | openai | openrouter)")


def _system_prompt(default_number, default_number_id, allow_writes) -> str:
    lines = [
        "You manage a Dial phone account through the provided tools.",
        "Phone numbers are E.164 (e.g. +14155550123).",
    ]
    if default_number_id:
        lines.append(
            f"The account's default number is {default_number} (id: {default_number_id}). "
            "Use that id as from_number_id unless told otherwise."
        )
    if not allow_writes:
        lines.append("Write actions (send SMS / place calls) are DISABLED for this run; only read/inspect.")
    return "\n".join(lines)


async def run_agent(
    *,
    user_input: str,
    api_key: str,
    allow_writes: bool,
    default_number: Optional[str],
    default_number_id: Optional[str],
    max_steps: Optional[int] = None,  # None = unlimited tool calls
) -> dict:
    tools = _build_tools(api_key, allow_writes)
    sys = _system_prompt(default_number, default_number_id, allow_writes)
    messages = [SystemMessage(sys), HumanMessage(user_input)]
    steps = []

    p = provider()
    if p == "fake":
        # Scripted: call a read-only tool, then summarize. Proves the loop offline.
        scripted = [
            AIMessage(content="", tool_calls=[{"name": "list_numbers", "args": {}, "id": "fake_1", "type": "tool_call"}]),
            AIMessage(content="(fake LLM) I ran the `list_numbers` tool -- its live result is shown in the step above. "
                              "Set LLM_PROVIDER=openai or openrouter in .env to use a real model that picks tools for you."),
        ]
        from langchain_core.language_models import FakeMessagesListChatModel
        llm = FakeMessagesListChatModel(responses=scripted)
        runnable = llm
    else:
        llm = _build_llm()
        runnable = llm.bind_tools(list(tools.values()))

    step = 0
    while max_steps is None or step < max_steps:
        ai = await runnable.ainvoke(messages)
        messages.append(ai)
        tool_calls = getattr(ai, "tool_calls", None) or []
        if not tool_calls:
            return {"output": ai.content or "(no output)", "steps": steps, "provider": p}
        for tc in tool_calls:
            name = tc["name"]
            raw_args = tc.get("args") or {}
            allowed = TOOL_ARGS.get(name)
            args = {k: v for k, v in raw_args.items() if allowed is None or k in allowed}
            if name in ("send_message", "make_call") and not args.get("from_number_id") and default_number_id:
                args["from_number_id"] = default_number_id
            tool = tools.get(name)
            if tool is None:
                result = f"Tool '{name}' is not available (writes disabled?)."
            else:
                try:
                    result = await tool.ainvoke(args)
                except Exception as e:
                    result = f"Error running {name}: {e}"
            steps.append({"tool": name, "args": args, "result": str(result)})
            messages.append(ToolMessage(content=str(result), tool_call_id=tc.get("id") or name))
        step += 1

    return {"output": "(stopped: reached max steps)", "steps": steps, "provider": p}
