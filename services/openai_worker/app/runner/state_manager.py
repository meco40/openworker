from typing import Any

from app.approval import ApprovalManager

from .approval_checker import ApprovalChecker
from .constants import LEGACY_TOOL_APPROVAL_MODE, MAX_TOOL_TURNS
from .tool_executor import ToolExecutor
from .tool_policy import ToolPolicy
from .types import PendingRunState


class StateManager:
    """Manages pending run states and executes function calls."""

    def __init__(
        self,
        approvals: ApprovalManager,
    ) -> None:
        self._approvals = approvals
        self._pending_runs: dict[str, PendingRunState] = {}
        self._approval_checker = ApprovalChecker()
        self._tool_executor = ToolExecutor()

    def get_state(self, run_id: str) -> PendingRunState | None:
        """Get a pending run state by ID."""
        return self._pending_runs.get(run_id)

    def set_state(self, run_id: str, state: PendingRunState) -> None:
        """Set a pending run state."""
        self._pending_runs[run_id] = state

    def pop_state(self, run_id: str) -> PendingRunState | None:
        """Remove and return a pending run state."""
        return self._pending_runs.pop(run_id, None)

    def execute_function_calls_until_pause(
        self,
        *,
        run_id: str,
        messages: list[dict[str, str]],
        function_calls: list[dict[str, Any]],
        start_index: int,
        resolved_tools: tuple[str, ...],
        tool_policy_default_mode: str,
        tool_policy_by_name: dict[str, str],
        approve_always: bool,
        approved_index: int | None,
    ) -> tuple[int, str | None]:
        """Execute function calls until a pause (approval needed) or completion.
        
        Returns (next_index, approval_token). If approval_token is not None,
        execution should pause and wait for approval.
        """
        for index in range(start_index, len(function_calls)):
            raw_call = function_calls[index]
            if not isinstance(raw_call, dict):
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._approval_checker.format_tool_message(
                            "unknown",
                            {},
                            error="function call payload is not an object",
                        ),
                    }
                )
                continue

            name, args = self._approval_checker.parse_function_call(raw_call)
            if not name:
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._approval_checker.format_tool_message(
                            "unknown",
                            args,
                            error="function call name is empty",
                        ),
                    }
                )
                continue

            policy_mode = tool_policy_by_name.get(name, tool_policy_default_mode)

            if policy_mode == LEGACY_TOOL_APPROVAL_MODE:
                is_call_approved = approve_always or approved_index == index
                approval_prompt = self._approval_checker.is_risky_tool_call(name, args)
                if approval_prompt and not is_call_approved:
                    token = self._approvals.request(run_id=run_id, prompt=approval_prompt)
                    return index, token
            elif policy_mode == "deny":
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._approval_checker.format_tool_message(
                            name,
                            args,
                            error="tool call blocked by security policy (deny)",
                        ),
                    }
                )
                continue
            else:
                is_call_approved = (
                    approve_always
                    or approved_index == index
                    or policy_mode == "approve_always"
                )
                approval_prompt = self._approval_checker.is_risky_tool_call(name, args)

                if policy_mode == "ask_approve" and not is_call_approved:
                    if not approval_prompt:
                        import json
                        approval_prompt = (
                            f"Approve tool action?\n\nTool: {name}\nArgs: "
                            f"{json.dumps(args, ensure_ascii=False)}"
                        )
                    token = self._approvals.request(run_id=run_id, prompt=approval_prompt)
                    return index, token

            try:
                result = self._tool_executor.execute_tool_call(
                    name=name,
                    args=args,
                    resolved_tools=resolved_tools,
                    approved=is_call_approved,
                )
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._approval_checker.format_tool_message(name, args, result=result),
                    }
                )
            except Exception as exc:
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._approval_checker.format_tool_message(name, args, error=str(exc)),
                    }
                )

        return len(function_calls), None

    def get_latest_assistant_text(self, messages: list[dict[str, str]]) -> str:
        """Get the latest assistant message text (excluding tool results)."""
        for message in reversed(messages):
            if message.get("role") != "assistant":
                continue
            content = str(message.get("content") or "").strip()
            if content and not content.startswith("TOOL_RESULT "):
                return content
        return ""
