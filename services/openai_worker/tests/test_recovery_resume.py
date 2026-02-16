from datetime import datetime, timedelta, timezone

from app.recovery import mark_stale_runs
from app.state_store import StateStore


def test_recovery_marks_stale_runs_and_keeps_checkpoint_for_resume() -> None:
    store = StateStore()
    now = datetime(2026, 2, 16, 20, 0, tzinfo=timezone.utc)

    store.save_checkpoint(
        run_id="run-stale",
        seq=3,
        state={"phase": "executing"},
        updated_at=now - timedelta(minutes=10),
    )
    store.save_checkpoint(
        run_id="run-fresh",
        seq=4,
        state={"phase": "executing"},
        updated_at=now,
    )

    stale_runs = mark_stale_runs(store, now=now, stale_after=timedelta(minutes=5))

    stale_checkpoint = store.load_checkpoint("run-stale")
    fresh_checkpoint = store.load_checkpoint("run-fresh")

    assert stale_runs == ["run-stale"]
    assert stale_checkpoint is not None
    assert stale_checkpoint.is_stale is True
    assert stale_checkpoint.seq == 3
    assert fresh_checkpoint is not None
    assert fresh_checkpoint.is_stale is False
