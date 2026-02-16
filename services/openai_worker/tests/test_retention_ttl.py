from app.retention import RetentionStore


class _Clock:
    def __init__(self) -> None:
        self.current = 0.0

    def now(self) -> float:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += seconds


def test_retention_prunes_expired_entries() -> None:
    clock = _Clock()
    store = RetentionStore(default_ttl_seconds=5.0, now_fn=clock.now)
    store.set("run-1", {"status": "completed"})

    assert store.get("run-1") == {"status": "completed"}
    clock.advance(6.0)

    deleted = store.prune_expired()

    assert deleted == ["run-1"]
    assert store.get("run-1") is None
