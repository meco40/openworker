from app.event_store import EventStore, EventStoreCode
from app.models import EventEnvelope


def make_event(event_id: str, seq: int, run_id: str = "run-1") -> EventEnvelope:
    return EventEnvelope(
        schemaVersion=1,
        eventId=event_id,
        runId=run_id,
        taskId="task-1",
        type="task.progress",
        seq=seq,
        emittedAt="2026-02-16T20:00:00Z",
        attempt=0,
        signature="sig",
        keyId="kid-1",
    )


def test_event_store_deduplicates_event_id() -> None:
    store = EventStore()
    first = store.append(make_event(event_id="evt-1", seq=1))
    second = store.append(make_event(event_id="evt-1", seq=1))

    assert first.code is EventStoreCode.ACCEPTED
    assert second.code is EventStoreCode.DUPLICATE_EVENT_ID
    assert len(store.events_for_run("run-1")) == 1


def test_event_store_rejects_non_monotonic_sequence() -> None:
    store = EventStore()
    store.append(make_event(event_id="evt-1", seq=2))
    out_of_order = store.append(make_event(event_id="evt-2", seq=2))

    assert out_of_order.code is EventStoreCode.REJECTED_OUT_OF_ORDER
