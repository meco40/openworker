from app.queue_policy import QueueDecisionCode, QueuePolicy


def test_queue_policy_rejects_on_backpressure() -> None:
    policy = QueuePolicy(max_inflight=2)

    accepted = policy.evaluate(queued=0, inflight=1, attempt=0)
    rejected = policy.evaluate(queued=0, inflight=2, attempt=0)

    assert accepted.code is QueueDecisionCode.ACCEPTED
    assert rejected.code is QueueDecisionCode.REJECTED_BACKPRESSURE


def test_queue_policy_rejects_invalid_attempt() -> None:
    policy = QueuePolicy(max_inflight=2)

    rejected = policy.evaluate(queued=0, inflight=0, attempt=-1)

    assert rejected.code is QueueDecisionCode.REJECTED_INVALID_ATTEMPT
