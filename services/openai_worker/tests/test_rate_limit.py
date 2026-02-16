from app.rate_limit import RateLimiter


class _Clock:
    def __init__(self) -> None:
        self.current = 0.0

    def now(self) -> float:
        return self.current

    def advance(self, seconds: float) -> None:
        self.current += seconds


def test_rate_limit_enforces_window() -> None:
    clock = _Clock()
    limiter = RateLimiter(limit=2, window_seconds=10.0, now_fn=clock.now)

    assert limiter.allow("user-1") is True
    assert limiter.allow("user-1") is True
    assert limiter.allow("user-1") is False

    clock.advance(11.0)
    assert limiter.allow("user-1") is True


def test_rate_limit_is_scoped_per_user() -> None:
    clock = _Clock()
    limiter = RateLimiter(limit=1, window_seconds=60.0, now_fn=clock.now)

    assert limiter.allow("user-a") is True
    assert limiter.allow("user-a") is False
    assert limiter.allow("user-b") is True
