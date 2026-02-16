from typing import Any

from app.approval import ApprovalManager


class Runner:
    def __init__(self, approval_manager: ApprovalManager | None = None) -> None:
        self._approvals = approval_manager or ApprovalManager()

    def run(
        self,
        objective: str,
        *,
        require_approval: bool = False,
        run_id: str = "run-local",
    ) -> dict[str, Any]:
        cleaned_objective = objective.strip()
        if not cleaned_objective:
            return {"status": "failed", "output": "objective is required"}

        if require_approval:
            token = self._approvals.request(
                run_id=run_id,
                prompt=f"Approve objective: {cleaned_objective}",
            )
            return {
                "status": "paused",
                "output": None,
                "approval_token": token,
            }

        return {
            "status": "completed",
            "output": f"Executed objective: {cleaned_objective}",
        }
