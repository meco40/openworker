from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
import secrets


@dataclass
class ApprovalRequest:
    token: str
    run_id: str
    prompt: str
    status: str = "pending"
    approved: bool | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    resolved_at: datetime | None = None


class ApprovalManager:
    def __init__(self) -> None:
        self._requests: dict[str, ApprovalRequest] = {}

    def request(self, run_id: str, prompt: str) -> str:
        token = secrets.token_urlsafe(18)
        while token in self._requests:
            token = secrets.token_urlsafe(18)

        self._requests[token] = ApprovalRequest(
            token=token,
            run_id=run_id,
            prompt=prompt,
        )
        return token

    def get(self, token: str) -> ApprovalRequest | None:
        return self._requests.get(token)

    def resume(
        self,
        token: str,
        approved: bool,
        payload: dict[str, Any] | None = None,
    ) -> ApprovalRequest:
        request = self._requests.get(token)
        if request is None:
            raise KeyError(token)
        if request.status != "pending":
            raise ValueError(f"approval token {token} is already resolved")

        request.approved = approved
        request.status = "approved" if approved else "rejected"
        request.payload = dict(payload or {})
        request.resolved_at = datetime.now(timezone.utc)
        return request
