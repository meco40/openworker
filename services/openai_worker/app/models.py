from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

CURRENT_SCHEMA_VERSION = 1
PREVIOUS_SCHEMA_VERSION = 0

EventType = Literal[
    "task.started",
    "task.progress",
    "task.approval_required",
    "task.completed",
    "task.failed",
    "subagent.started",
    "subagent.progress",
    "subagent.completed",
    "subagent.failed",
]


def is_compatible_schema_version(
    version: int,
    current_version: int = CURRENT_SCHEMA_VERSION,
    previous_version: int = PREVIOUS_SCHEMA_VERSION,
) -> bool:
    return (
        isinstance(version, int)
        and previous_version <= version <= current_version
    )


class EventEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: int = Field(..., description="Event schema version.")
    eventId: str = Field(..., min_length=1)
    runId: str = Field(..., min_length=1)
    taskId: str = Field(..., min_length=1)
    type: EventType
    seq: int = Field(..., ge=1, description="Monotonic sequence per run.")
    emittedAt: datetime
    attempt: int = Field(..., ge=0)
    signature: str = Field(..., min_length=1)
    keyId: str = Field(..., min_length=1)

    @field_validator("schemaVersion")
    @classmethod
    def _check_schema_version(cls, value: int) -> int:
        if not is_compatible_schema_version(value):
            raise ValueError(
                f"Unsupported schemaVersion={value}. "
                f"Supported range: {PREVIOUS_SCHEMA_VERSION}..{CURRENT_SCHEMA_VERSION}"
            )
        return value
