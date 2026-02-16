import pytest

from app.approval import ApprovalManager


def test_approval_pause_resume_by_token() -> None:
    approvals = ApprovalManager()
    token = approvals.request(run_id="run-1", prompt="Approve deployment?")

    pending = approvals.get(token)
    assert pending is not None
    assert pending.status == "pending"

    resumed = approvals.resume(token, approved=True, payload={"by": "user-1"})

    assert resumed.status == "approved"
    assert resumed.payload == {"by": "user-1"}
    assert approvals.get(token) is resumed


def test_approval_resume_rejects_unknown_token() -> None:
    approvals = ApprovalManager()

    with pytest.raises(KeyError):
        approvals.resume("missing-token", approved=True)
