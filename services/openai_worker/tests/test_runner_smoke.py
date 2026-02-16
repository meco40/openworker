from app.approval import ApprovalManager
from app.runner import Runner


def test_runner_executes_objective() -> None:
    runner = Runner()

    result = runner.run("write a summary")

    assert result["status"] == "completed"
    assert "write a summary" in result["output"]


def test_runner_can_request_approval() -> None:
    approval = ApprovalManager()
    runner = Runner(approval_manager=approval)

    result = runner.run("delete prod db", require_approval=True)

    assert result["status"] == "paused"
    token = result["approval_token"]
    pending = approval.get(token)
    assert pending is not None
    assert pending.status == "pending"
