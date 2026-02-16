from collections import defaultdict
from dataclasses import dataclass, field
from enum import StrEnum

from app.models import EventEnvelope


class EventStoreCode(StrEnum):
    ACCEPTED = "accepted"
    DUPLICATE_EVENT_ID = "duplicate_event_id"
    REJECTED_OUT_OF_ORDER = "rejected_out_of_order"


@dataclass(frozen=True)
class EventStoreResult:
    code: EventStoreCode


@dataclass
class _RunEventState:
    last_seq: int = 0
    seen_event_ids: set[str] = field(default_factory=set)


class EventStore:
    def __init__(self) -> None:
        self._run_state: dict[str, _RunEventState] = {}
        self._events_by_run: dict[str, list[EventEnvelope]] = defaultdict(list)

    def append(self, event: EventEnvelope) -> EventStoreResult:
        state = self._run_state.setdefault(event.runId, _RunEventState())

        if event.eventId in state.seen_event_ids:
            return EventStoreResult(EventStoreCode.DUPLICATE_EVENT_ID)
        if event.seq <= state.last_seq:
            return EventStoreResult(EventStoreCode.REJECTED_OUT_OF_ORDER)

        state.seen_event_ids.add(event.eventId)
        state.last_seq = event.seq
        self._events_by_run[event.runId].append(event)
        return EventStoreResult(EventStoreCode.ACCEPTED)

    def events_for_run(self, run_id: str) -> tuple[EventEnvelope, ...]:
        return tuple(self._events_by_run.get(run_id, ()))

    def last_seq(self, run_id: str) -> int:
        state = self._run_state.get(run_id)
        return state.last_seq if state else 0
