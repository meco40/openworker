from dataclasses import dataclass
from typing import Any, Callable

ModelExecutor = Callable[..., dict[str, Any]]


@dataclass
class PendingRunState:
    run_id: str
    objective: str
    messages: list[dict[str, str]]
    selected_model: str
    selected_profile: str
    resolved_tools: tuple[str, ...]
    function_calls: list[dict[str, Any]]
    call_index: int
    current_model_label: str
    tool_policy_default_mode: str
    tool_policy_by_name: dict[str, str]
    approve_always: bool = False
