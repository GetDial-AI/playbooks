"""Configuration — the Dial API key is sourced ONLY from the environment (.env)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load .env that sits next to this file, regardless of the process CWD.
load_dotenv(Path(__file__).resolve().parent / ".env")


@dataclass(frozen=True)
class Settings:
    api_key: str
    base_url: str
    number_id: str | None  # explicit default sending number id, optional


def load_settings() -> Settings:
    api_key = os.environ.get("DIAL_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "DIAL_API_KEY is not set. Put it in dial-python-example/.env:\n"
            "    DIAL_API_KEY=sk_live_..."
        )
    base_url = os.environ.get("DIAL_BASE_URL", "https://getdial.ai").strip()
    number_id = os.environ.get("DIAL_NUMBER_ID", "").strip() or None
    return Settings(api_key=api_key, base_url=base_url, number_id=number_id)
