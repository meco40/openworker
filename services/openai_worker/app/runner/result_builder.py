from typing import Any


class ResultBuilder:
    """Builds result dictionaries for different run outcomes."""

    @staticmethod
    def completed(
        *,
        selected_profile: str,
        current_model_label: str,
        resolved_tools: tuple[str, ...],
        output: str,
    ) -> dict[str, Any]:
        return {
            "status": "completed",
            "engine": "model-hub-gateway",
            "model": current_model_label,
            "profileId": selected_profile,
            "enabledTools": list(resolved_tools),
            "output": f"[model-hub-gateway profile={selected_profile} model={current_model_label}] {output}",
        }

    @staticmethod
    def failed(
        *,
        selected_profile: str,
        current_model_label: str,
        resolved_tools: tuple[str, ...],
        message: str,
    ) -> dict[str, Any]:
        return {
            "status": "failed",
            "engine": "model-hub-gateway",
            "model": current_model_label,
            "profileId": selected_profile,
            "enabledTools": list(resolved_tools),
            "output": f"[model-hub-gateway profile={selected_profile} model={current_model_label}] {message}",
        }

    @staticmethod
    def paused(
        *,
        selected_profile: str,
        current_model_label: str,
        resolved_tools: tuple[str, ...],
        token: str,
    ) -> dict[str, Any]:
        return {
            "status": "paused",
            "engine": "model-hub-gateway",
            "model": current_model_label,
            "profileId": selected_profile,
            "enabledTools": list(resolved_tools),
            "output": None,
            "approval_token": token,
        }

    @staticmethod
    def paused_objective(require_approval: bool, run_id: str, cleaned_objective: str) -> dict[str, Any]:
        """Create a paused result waiting for objective approval."""
        from app.approval import ApprovalManager
        
        if require_approval:
            token = ApprovalManager().request(
                run_id=run_id,
                prompt=f"Approve objective: {cleaned_objective}",
            )
            return {
                "status": "paused",
                "output": None,
                "approval_token": token,
            }
        return {"status": "failed", "output": "objective is required"}
