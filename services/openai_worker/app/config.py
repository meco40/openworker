import os
from dataclasses import dataclass

from app.models import CURRENT_SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION


@dataclass(frozen=True)
class WorkerSettings:
    schema_current_version: int = CURRENT_SCHEMA_VERSION
    schema_previous_version: int = PREVIOUS_SCHEMA_VERSION
    max_inflight: int = 16
    allowed_tool_prefixes: tuple[str, ...] = ("safe_",)


def get_settings() -> WorkerSettings:
    prefixes_raw = os.getenv("OPENAI_WORKER_ALLOWED_TOOL_PREFIXES")
    prefixes = (
        tuple(p.strip() for p in prefixes_raw.split(",") if p.strip())
        if prefixes_raw
        else ("safe_",)
    )

    max_inflight = int(os.getenv("OPENAI_WORKER_MAX_INFLIGHT", "16"))
    return WorkerSettings(
        max_inflight=max_inflight,
        allowed_tool_prefixes=prefixes,
    )


def is_tool_allowed(tool_name: str, settings: WorkerSettings | None = None) -> bool:
    active_settings = settings or get_settings()
    return any(tool_name.startswith(prefix) for prefix in active_settings.allowed_tool_prefixes)
