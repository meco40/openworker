from dataclasses import dataclass
from enum import StrEnum


class QueueDecisionCode(StrEnum):
    ACCEPTED = "accepted"
    REJECTED_BACKPRESSURE = "rejected_backpressure"
    REJECTED_INVALID_ATTEMPT = "rejected_invalid_attempt"


@dataclass(frozen=True)
class QueueDecision:
    code: QueueDecisionCode


class QueuePolicy:
    def __init__(self, max_inflight: int) -> None:
        if max_inflight < 1:
            raise ValueError("max_inflight must be >= 1")
        self.max_inflight = max_inflight

    def evaluate(self, queued: int, inflight: int, attempt: int) -> QueueDecision:
        if attempt < 0:
            return QueueDecision(QueueDecisionCode.REJECTED_INVALID_ATTEMPT)
        if queued < 0 or inflight < 0:
            return QueueDecision(QueueDecisionCode.REJECTED_INVALID_ATTEMPT)
        if inflight >= self.max_inflight:
            return QueueDecision(QueueDecisionCode.REJECTED_BACKPRESSURE)
        return QueueDecision(QueueDecisionCode.ACCEPTED)
