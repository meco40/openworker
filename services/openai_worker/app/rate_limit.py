from collections import defaultdict, deque
from collections.abc import Callable
import time


class RateLimiter:
    def __init__(
        self,
        *,
        limit: int,
        window_seconds: float,
        now_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be > 0")
        self._limit = limit
        self._window_seconds = window_seconds
        self._now_fn = now_fn
        self._events: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, user_id: str) -> bool:
        now = self._now_fn()
        window_start = now - self._window_seconds
        events = self._events[user_id]

        while events and events[0] <= window_start:
            events.popleft()

        if len(events) >= self._limit:
            return False

        events.append(now)
        return True
