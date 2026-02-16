import pytest
from pydantic import ValidationError

from app.models import EventEnvelope


def make_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "eventId": "evt-1",
        "runId": "run-1",
        "taskId": "task-1",
        "type": "task.started",
        "seq": 1,
        "emittedAt": "2026-02-16T20:00:00Z",
        "attempt": 0,
        "signature": "sig",
        "keyId": "kid-1",
    }
    payload.update(overrides)
    return payload


def test_event_contract_accepts_required_fields() -> None:
    event = EventEnvelope(**make_payload())

    assert event.schemaVersion == 1
    assert event.eventId == "evt-1"
    assert event.runId == "run-1"


def test_event_contract_rejects_missing_required_field() -> None:
    payload = make_payload()
    payload.pop("keyId")

    with pytest.raises(ValidationError):
        EventEnvelope(**payload)
