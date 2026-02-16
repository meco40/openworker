from collections import defaultdict


class Telemetry:
    def __init__(self) -> None:
        self._counters: dict[str, int] = defaultdict(int)

    def increment(self, name: str, value: int = 1) -> None:
        if value < 0:
            raise ValueError("Telemetry increments must be non-negative")
        self._counters[name] += value

    def get_counter(self, name: str) -> int:
        return self._counters[name]
