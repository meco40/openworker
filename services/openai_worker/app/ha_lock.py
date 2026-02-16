from collections.abc import Callable
import time


class HALock:
    def __init__(
        self,
        *,
        lease_seconds: float,
        now_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        if lease_seconds <= 0:
            raise ValueError("lease_seconds must be > 0")
        self._lease_seconds = lease_seconds
        self._now_fn = now_fn
        self._owner_id: str | None = None
        self._lease_until = 0.0

    def acquire(self, owner_id: str) -> bool:
        now = self._now_fn()
        expired = now >= self._lease_until
        if self._owner_id is None or expired or self._owner_id == owner_id:
            self._owner_id = owner_id
            self._lease_until = now + self._lease_seconds
            return True
        return False

    def is_leader(self, owner_id: str) -> bool:
        return (
            self._owner_id == owner_id
            and self._now_fn() < self._lease_until
        )

    def release(self, owner_id: str) -> bool:
        if self._owner_id != owner_id:
            return False
        self._owner_id = None
        self._lease_until = 0.0
        return True
