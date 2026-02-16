from dataclasses import dataclass
from typing import Any
import time


@dataclass
class _RetainedItem:
    value: Any
    expires_at: float


class RetentionStore:
    def __init__(
        self,
        *,
        default_ttl_seconds: float,
        now_fn=time.monotonic,
    ) -> None:
        if default_ttl_seconds <= 0:
            raise ValueError("default_ttl_seconds must be > 0")
        self._default_ttl_seconds = default_ttl_seconds
        self._now_fn = now_fn
        self._items: dict[str, _RetainedItem] = {}

    def set(self, key: str, value: Any, ttl_seconds: float | None = None) -> None:
        ttl = ttl_seconds if ttl_seconds is not None else self._default_ttl_seconds
        if ttl <= 0:
            raise ValueError("ttl_seconds must be > 0")
        self._items[key] = _RetainedItem(
            value=value,
            expires_at=self._now_fn() + ttl,
        )

    def get(self, key: str) -> Any | None:
        item = self._items.get(key)
        if item is None:
            return None
        if item.expires_at <= self._now_fn():
            self._items.pop(key, None)
            return None
        return item.value

    def prune_expired(self) -> list[str]:
        now = self._now_fn()
        expired = sorted(
            [key for key, item in self._items.items() if item.expires_at <= now]
        )
        for key in expired:
            self._items.pop(key, None)
        return expired
