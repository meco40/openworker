from datetime import datetime, timedelta, timezone

from app.state_store import StateStore


def mark_stale_runs(
    state_store: StateStore,
    now: datetime | None = None,
    stale_after: timedelta = timedelta(minutes=5),
) -> list[str]:
    if stale_after < timedelta(0):
        raise ValueError("stale_after must be non-negative")

    reference_time = now or datetime.now(timezone.utc)
    stale_cutoff = reference_time - stale_after
    stale_runs: list[str] = []

    for checkpoint in state_store.all_checkpoints():
        if checkpoint.updated_at <= stale_cutoff:
            state_store.mark_stale(checkpoint.run_id)
            stale_runs.append(checkpoint.run_id)

    stale_runs.sort()
    return stale_runs
