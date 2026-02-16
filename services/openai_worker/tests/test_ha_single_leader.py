from app.ha_lock import HALock


class _Clock:
    def __init__(self) -> None:
        self.current = 0.0

    def now(self) -> float:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += seconds


def test_ha_lock_allows_only_single_leader_until_lease_expires() -> None:
    clock = _Clock()
    lock = HALock(lease_seconds=10.0, now_fn=clock.now)

    assert lock.acquire("worker-a") is True
    assert lock.acquire("worker-b") is False

    clock.advance(11.0)
    assert lock.acquire("worker-b") is True
    assert lock.is_leader("worker-a") is False
    assert lock.is_leader("worker-b") is True
