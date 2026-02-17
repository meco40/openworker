import os
from typing import Any

from app.approval import ApprovalManager

from .approval_checker import ApprovalChecker
from .constants import MAX_TOOL_TURNS
from .gateway import execute_with_modelhub_gateway
from .result_builder import ResultBuilder
from .state_manager import StateManager
from .tool_executor import ToolExecutor
from .tool_policy import ToolPolicy
from .tool_resolver import ToolResolver
from .types import ModelExecutor, PendingRunState


class Runner:
    """Main runner class that orchestrates tool execution with approval management."""

    def __init__(
        self,
        approval_manager: ApprovalManager | None = None,
        objective_executor: ModelExecutor | None = None,
    ) -> None:
        self._approvals = approval_manager or ApprovalManager()
        self._objective_executor = objective_executor or execute_with_modelhub_gateway
        self._state_manager = StateManager(self._approvals)
        self._result_builder = ResultBuilder()
        self._tool_resolver = ToolResolver()
        self._tool_policy = ToolPolicy()
        self._approval_checker = ApprovalChecker()
        self._tool_executor = ToolExecutor()

    def run(
        self,
        objective: str,
        *,
        require_approval: bool = False,
        run_id: str = "run-local",
        preferred_model_id: str | None = None,
        model_hub_profile_id: str | None = None,
        enabled_tools: list[str] | None = None,
        messages: list[dict[str, str]] | None = None,
        tool_approval_policy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Start a new run with the given objective."""
        cleaned_objective = objective.strip()
        if not cleaned_objective:
            return {"status": "failed", "output": "objective is required"}

        if require_approval:
            return ResultBuilder.paused_objective(
                require_approval=True,
                run_id=run_id,
                cleaned_objective=cleaned_objective,
            )

        selected_model = (preferred_model_id or "").strip()
        selected_profile = (
            model_hub_profile_id
            or os.getenv("OPENAI_WORKER_MODEL_HUB_PROFILE")
            or "p1"
        ).strip()
        if not selected_profile:
            selected_profile = "p1"

        resolved_tools = self._tool_resolver.resolve_tools(enabled_tools)
        tool_policy_default_mode, tool_policy_by_name = self._tool_policy.normalize(
            tool_approval_policy,
            resolved_tools,
        )
        
        # Clean and prepare messages
        from .gateway import _clean_message_list
        context_messages = _clean_message_list(messages or [])
        if not context_messages:
            context_messages = [{"role": "user", "content": cleaned_objective}]
        
        return self._run_tool_loop(
            run_id=run_id,
            objective=cleaned_objective,
            messages=context_messages,
            selected_model=selected_model,
            selected_profile=selected_profile,
            resolved_tools=resolved_tools,
            tool_policy_default_mode=tool_policy_default_mode,
            tool_policy_by_name=tool_policy_by_name,
            approve_always=False,
            current_model_label=selected_model or "auto",
        )

    def resume(
        self,
        *,
        run_id: str,
        approved: bool,
        payload: dict[str, Any] | None = None,
        objective: str | None = None,
    ) -> dict[str, Any]:
        """Resume a paused run after approval."""
        state = self._state_manager.get_state(run_id)
        if state is None:
            if not approved:
                return {"status": "failed", "output": "approval rejected"}
            if objective:
                return self.run(objective, run_id=run_id, require_approval=False)
            return {"status": "failed", "output": "no pending approval state"}

        if not approved:
            self._state_manager.pop_state(run_id)
            return self._result_builder.failed(
                selected_profile=state.selected_profile,
                current_model_label=state.current_model_label,
                resolved_tools=state.resolved_tools,
                message="approval rejected",
            )

        approve_always = state.approve_always or bool((payload or {}).get("approveAlways"))

        next_index, token = self._state_manager.execute_function_calls_until_pause(
            run_id=run_id,
            messages=state.messages,
            function_calls=state.function_calls,
            start_index=state.call_index,
            resolved_tools=state.resolved_tools,
            tool_policy_default_mode=state.tool_policy_default_mode,
            tool_policy_by_name=state.tool_policy_by_name,
            approve_always=approve_always,
            approved_index=state.call_index,
        )

        if token:
            state.call_index = next_index
            state.approve_always = approve_always
            self._state_manager.set_state(run_id, state)
            return self._result_builder.paused(
                selected_profile=state.selected_profile,
                current_model_label=state.current_model_label,
                resolved_tools=state.resolved_tools,
                token=token,
            )

        self._state_manager.pop_state(run_id)
        return self._run_tool_loop(
            run_id=run_id,
            objective=state.objective,
            messages=state.messages,
            selected_model=state.selected_model,
            selected_profile=state.selected_profile,
            resolved_tools=state.resolved_tools,
            tool_policy_default_mode=state.tool_policy_default_mode,
            tool_policy_by_name=state.tool_policy_by_name,
            approve_always=approve_always,
            current_model_label=state.current_model_label,
        )

    def _run_tool_loop(
        self,
        *,
        run_id: str,
        objective: str,
        messages: list[dict[str, str]],
        selected_model: str,
        selected_profile: str,
        resolved_tools: tuple[str, ...],
        tool_policy_default_mode: str,
        tool_policy_by_name: dict[str, str],
        approve_always: bool,
        initial_calls: list[dict[str, Any]] | None = None,
        initial_call_index: int = 0,
        current_model_label: str = "auto",
    ) -> dict[str, Any]:
        """Main tool execution loop."""
        tool_defs = self._tool_resolver.build_tool_definitions(resolved_tools)
        pending_calls = initial_calls
        pending_call_index = initial_call_index
        model_label = current_model_label

        for _ in range(MAX_TOOL_TURNS):
            if pending_calls is None:
                try:
                    response = self._objective_executor(
                        messages=messages,
                        run_id=run_id,
                        model=selected_model,
                        profile_id=selected_profile,
                        tools=tool_defs,
                    )
                except Exception as exc:
                    self._state_manager.pop_state(run_id)
                    return self._result_builder.failed(
                        selected_profile=selected_profile,
                        current_model_label=selected_model or "auto",
                        resolved_tools=resolved_tools,
                        message=str(exc),
                    )

                text = str(response.get("text") or "").strip()
                response_model = str(response.get("model") or selected_model or "unknown").strip() or "unknown"
                response_provider = str(response.get("provider") or "unknown").strip() or "unknown"
                model_label = f"{response_provider}:{response_model}"
                if text:
                    messages.append({"role": "assistant", "content": text})

                raw_calls = response.get("functionCalls")
                if isinstance(raw_calls, list) and raw_calls:
                    pending_calls = [call for call in raw_calls if isinstance(call, dict)]
                    pending_call_index = 0
                else:
                    final_text = text or self._state_manager.get_latest_assistant_text(messages)
                    self._state_manager.pop_state(run_id)
                    if final_text:
                        return self._result_builder.completed(
                            selected_profile=selected_profile,
                            current_model_label=model_label,
                            resolved_tools=resolved_tools,
                            output=final_text,
                        )
                    return self._result_builder.failed(
                        selected_profile=selected_profile,
                        current_model_label=model_label,
                        resolved_tools=resolved_tools,
                        message="model returned neither text nor function calls",
                    )

            next_index, token = self._state_manager.execute_function_calls_until_pause(
                run_id=run_id,
                messages=messages,
                function_calls=pending_calls or [],
                start_index=pending_call_index,
                resolved_tools=resolved_tools,
                tool_policy_default_mode=tool_policy_default_mode,
                tool_policy_by_name=tool_policy_by_name,
                approve_always=approve_always,
                approved_index=None,
            )
            if token:
                self._state_manager.set_state(
                    run_id,
                    PendingRunState(
                        run_id=run_id,
                        objective=objective,
                        messages=list(messages),
                        selected_model=selected_model,
                        selected_profile=selected_profile,
                        resolved_tools=resolved_tools,
                        function_calls=list(pending_calls or []),
                        call_index=next_index,
                        current_model_label=model_label,
                        tool_policy_default_mode=tool_policy_default_mode,
                        tool_policy_by_name=dict(tool_policy_by_name),
                        approve_always=approve_always,
                    ),
                )
                return self._result_builder.paused(
                    selected_profile=selected_profile,
                    current_model_label=model_label,
                    resolved_tools=resolved_tools,
                    token=token,
                )

            pending_calls = None
            pending_call_index = 0

        self._state_manager.pop_state(run_id)
        return self._result_builder.failed(
            selected_profile=selected_profile,
            current_model_label=model_label,
            resolved_tools=resolved_tools,
            message="tool orchestration exceeded maximum turns",
        )
