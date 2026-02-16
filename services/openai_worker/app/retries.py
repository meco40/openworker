from collections.abc import Callable
import time
from typing import TypeVar

T = TypeVar("T")


def exponential_backoff_delays(
    attempts: int,
    *,
    base_delay_seconds: float = 0.1,
    factor: float = 2.0,
    max_delay_seconds: float | None = None,
) -> tuple[float, ...]:
    if attempts < 1:
        raise ValueError("attempts must be >= 1")
    if base_delay_seconds <= 0:
        raise ValueError("base_delay_seconds must be > 0")
    if factor < 1:
        raise ValueError("factor must be >= 1")

    delays: list[float] = []
    for index in range(attempts):
        delay = base_delay_seconds * (factor ** index)
        if max_delay_seconds is not None:
            delay = min(delay, max_delay_seconds)
        delays.append(delay)
    return tuple(delays)


def retry_with_backoff(
    operation: Callable[[], T],
    *,
    max_attempts: int = 3,
    base_delay_seconds: float = 0.1,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> T:
    if max_attempts < 1:
        raise ValueError("max_attempts must be >= 1")

    attempt = 0
    while True:
        attempt += 1
        try:
            return operation()
        except Exception:
            if attempt >= max_attempts:
                raise
            sleep_fn(base_delay_seconds * (2 ** (attempt - 1)))
