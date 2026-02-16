from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class RunCheckpoint:
    run_id: str
    seq: int
    state: dict[str, Any] = field(default_factory=dict)
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    is_stale: bool = False


class StateStore:
    def __init__(self) -> None:
        self._checkpoints: dict[str, RunCheckpoint] = {}

    def save_checkpoint(
        self,
        run_id: str,
        seq: int,
        state: dict[str, Any],
        updated_at: datetime | None = None,
    ) -> RunCheckpoint:
        checkpoint = RunCheckpoint(
            run_id=run_id,
            seq=seq,
            state=dict(state),
            updated_at=updated_at or datetime.now(timezone.utc),
            is_stale=False,
        )
        self._checkpoints[run_id] = checkpoint
        return checkpoint

    def load_checkpoint(self, run_id: str) -> RunCheckpoint | None:
        return self._checkpoints.get(run_id)

    def all_checkpoints(self) -> tuple[RunCheckpoint, ...]:
        return tuple(self._checkpoints.values())

    def mark_stale(self, run_id: str) -> bool:
        checkpoint = self._checkpoints.get(run_id)
        if checkpoint is None:
            return False
        checkpoint.is_stale = True
        return True
