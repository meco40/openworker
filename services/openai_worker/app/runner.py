import json
import os
import re
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from app.approval import ApprovalManager
from app.tools import get_enabled_tool_names
from app.tools.browser_tool import BrowserTool
from app.tools.computer_use_tool import ComputerUseTool
from app.tools.files_tool import FilesTool
from app.tools.github_tool import GitHubTool
from app.tools.mcp_tool import MCPTool
from app.tools.shell_tool import ShellTool

ModelExecutor = Callable[..., dict[str, Any]]

MAX_TOOL_TURNS = 8
RISKY_SHELL_PATTERN = re.compile(r"\brm\s+-rf\b|\bdel\s+/f\s+/q\b|powershell\s+-enc", re.IGNORECASE)
RISKY_GITHUB_ACTIONS = {"delete_repo", "delete_branch", "force_push"}
RISKY_MCP_ACTION_PATTERN = re.compile(r"delete|drop|truncate|shutdown", re.IGNORECASE)
SAFE_MCP_SERVERS_ENV = "OPENAI_WORKER_ALLOWED_MCP_SERVERS"

TOOL_DEFINITIONS: dict[str, dict[str, Any]] = {
    "safe_shell": {
        "type": "function",
        "function": {
            "name": "safe_shell",
            "description": "Execute a shell command in the isolated worker environment.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute."},
                },
                "required": ["command"],
            },
        },
    },
    "safe_browser": {
        "type": "function",
        "function": {
            "name": "safe_browser",
            "description": "Perform browser actions and capture page state.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "Browser action (open/click/extract)."},
                    "url": {"type": "string", "description": "Optional URL target."},
                    "max_links": {"type": "integer", "description": "Optional cap for extracted links."},
                },
                "required": ["action"],
            },
        },
    },
    "safe_files": {
        "type": "function",
        "function": {
            "name": "safe_files",
            "description": "Read and write files inside the worker workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {"type": "string", "description": "One of read/write."},
                    "path": {"type": "string", "description": "File path (workspace-relative or absolute)."},
                    "content": {"type": "string", "description": "Content for write operations."},
                },
                "required": ["operation", "path"],
            },
        },
    },
    "safe_github": {
        "type": "function",
        "function": {
            "name": "safe_github",
            "description": "Run GitHub repository actions via configured credentials.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "GitHub action name."},
                    "owner": {"type": "string", "description": "Repository owner."},
                    "repo": {"type": "string", "description": "Repository name."},
                    "issue_number": {"type": "integer", "description": "Issue number for get_issue."},
                    "pull_number": {"type": "integer", "description": "Pull request number for get_pull_request."},
                    "state": {"type": "string", "description": "Filter state for list actions."},
                    "query": {"type": "string", "description": "Search query for search_repositories."},
                    "title": {"type": "string", "description": "Issue title for create_issue."},
                    "body": {"type": "string", "description": "Issue body for create_issue."},
                    "labels": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Labels for create_issue.",
                    },
                    "per_page": {"type": "integer", "description": "Pagination page size."},
                    "page": {"type": "integer", "description": "Pagination page number."},
                },
                "required": ["action"],
            },
        },
    },
    "safe_mcp": {
        "type": "function",
        "function": {
            "name": "safe_mcp",
            "description": "Call an allowlisted MCP server action.",
            "parameters": {
                "type": "object",
                "properties": {
                    "server": {"type": "string", "description": "MCP server id."},
                    "action": {"type": "string", "description": "MCP action name."},
                    "payload": {"type": "object", "description": "MCP action payload."},
                },
                "required": ["server", "action"],
            },
        },
    },
    "safe_computer_use": {
        "type": "function",
        "function": {
            "name": "safe_computer_use",
            "description": "Use guarded computer actions in a remote session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "Computer-use action name."},
                    "url": {"type": "string", "description": "URL target for browser-backed actions."},
                    "seconds": {"type": "number", "description": "Wait duration in seconds for wait action."},
                    "text": {"type": "string", "description": "Text payload for typing actions."},
                    "key": {"type": "string", "description": "Key value for keyboard actions."},
                },
                "required": ["action"],
            },
        },
    },
}


def _clean_message_list(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    cleaned: list[dict[str, str]] = []
    for message in messages:
        role = str(message.get("role") or "").strip().lower()
        content = str(message.get("content") or "")
        if role not in {"system", "user", "assistant"}:
            continue
        cleaned.append({"role": role, "content": content})
    return cleaned


def execute_with_modelhub_gateway(
    *,
    messages: list[dict[str, str]],
    run_id: str,
    model: str,
    profile_id: str = "p1",
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    gateway_url = os.getenv(
        "OPENAI_WORKER_MODELHUB_GATEWAY_URL",
        "http://127.0.0.1:3000/api/model-hub/gateway",
    ).strip()
    if not gateway_url:
        raise RuntimeError("OPENAI_WORKER_MODELHUB_GATEWAY_URL is empty")

    payload: dict[str, Any] = {
        "profileId": profile_id or "p1",
        "messages": _clean_message_list(messages),
        "max_tokens": 1200,
    }
    if model:
        payload["model"] = model
    if tools:
        payload["tools"] = tools

    try:
        response = httpx.post(gateway_url, json=payload, timeout=90)
    except Exception as exc:
        raise RuntimeError(f"ModelHub gateway request failed: {exc}") from exc

    if response.status_code >= 400:
        try:
            error_body = response.json()
            error_text = error_body.get("error") if isinstance(error_body, dict) else None
        except Exception:
            error_text = response.text
        raise RuntimeError(error_text or f"ModelHub gateway status {response.status_code}")

    body = response.json()
    if not isinstance(body, dict):
        raise RuntimeError("ModelHub gateway returned invalid JSON body")
    if not body.get("ok"):
        raise RuntimeError(str(body.get("error") or "ModelHub gateway dispatch failed"))

    text = str(body.get("text") or "")
    resolved_model = str(body.get("model") or model or "unknown").strip() or "unknown"
    provider = str(body.get("provider") or "unknown").strip() or "unknown"
    function_calls = body.get("functionCalls")
    if not isinstance(function_calls, list):
        function_calls = []

    return {
        "text": text,
        "model": resolved_model,
        "provider": provider,
        "functionCalls": function_calls,
        "runId": run_id,
    }


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
    approve_always: bool = False


class Runner:
    def __init__(
        self,
        approval_manager: ApprovalManager | None = None,
        objective_executor: ModelExecutor | None = None,
    ) -> None:
        self._approvals = approval_manager or ApprovalManager()
        self._objective_executor = objective_executor or execute_with_modelhub_gateway
        self._pending_runs: dict[str, PendingRunState] = {}

    def _resolve_tools(self, enabled_tools: list[str] | None) -> tuple[str, ...]:
        tool_allowlist = {
            tool.strip()
            for tool in (enabled_tools or [])
            if isinstance(tool, str) and tool.strip()
        }
        return get_enabled_tool_names(allowlist=tool_allowlist)

    def _build_tool_definitions(self, resolved_tools: tuple[str, ...]) -> list[dict[str, Any]]:
        return [TOOL_DEFINITIONS[name] for name in resolved_tools if name in TOOL_DEFINITIONS]

    @staticmethod
    def _parse_function_call(raw_call: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        name = str(raw_call.get("name") or "").strip()
        args = raw_call.get("args")
        if isinstance(args, dict):
            return name, dict(args)
        if isinstance(args, str):
            try:
                parsed = json.loads(args)
                if isinstance(parsed, dict):
                    return name, parsed
            except Exception:
                return name, {"raw": args}
        return name, {}

    @staticmethod
    def _is_risky_tool_call(name: str, args: dict[str, Any]) -> str | None:
        if name == "safe_shell":
            command = str(args.get("command") or "")
            if RISKY_SHELL_PATTERN.search(command):
                return f"Approve risky shell command?\n\nTool: {name}\nCommand: {command}"
            return None

        if name == "safe_computer_use":
            action = str(args.get("action") or "")
            if ComputerUseTool.is_destructive(action):
                return f"Approve destructive computer-use action?\n\nTool: {name}\nAction: {action}"
            return None

        if name == "safe_github":
            action = str(args.get("action") or "").strip().lower()
            if action in RISKY_GITHUB_ACTIONS:
                return f"Approve risky GitHub action?\n\nTool: {name}\nAction: {action}"
            return None

        if name == "safe_mcp":
            action = str(args.get("action") or "")
            if RISKY_MCP_ACTION_PATTERN.search(action):
                return f"Approve risky MCP action?\n\nTool: {name}\nAction: {action}"
            return None

        return None

    @staticmethod
    def _format_tool_message(
        name: str,
        args: dict[str, Any],
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> str:
        payload: dict[str, Any] = {"tool": name, "args": args}
        if result is not None:
            payload["result"] = result
        if error is not None:
            payload["error"] = error
        return f"TOOL_RESULT {json.dumps(payload, ensure_ascii=False)}"

    @staticmethod
    def _allowed_mcp_servers() -> set[str]:
        raw = os.getenv(SAFE_MCP_SERVERS_ENV, "")
        return {item.strip() for item in raw.split(",") if item.strip()}

    def _execute_tool_call(
        self,
        *,
        name: str,
        args: dict[str, Any],
        resolved_tools: tuple[str, ...],
        approved: bool,
    ) -> dict[str, Any]:
        if name not in resolved_tools:
            raise PermissionError(f"tool {name} is not enabled for this run")

        if name == "safe_shell":
            return ShellTool().execute(command=str(args.get("command") or ""))
        if name == "safe_browser":
            return BrowserTool().execute(
                action=str(args.get("action") or ""),
                url=str(args.get("url") or "").strip() or None,
                max_links=int(args.get("max_links")) if isinstance(args.get("max_links"), int) else None,
            )
        if name == "safe_files":
            return FilesTool().execute(
                operation=str(args.get("operation") or ""),
                path=str(args.get("path") or ""),
                content=str(args.get("content") or "") if args.get("content") is not None else None,
            )
        if name == "safe_github":
            extra_args = dict(args)
            extra_args.pop("action", None)
            extra_args.pop("owner", None)
            extra_args.pop("repo", None)
            return GitHubTool().execute(
                action=str(args.get("action") or ""),
                owner=str(args.get("owner") or ""),
                repo=str(args.get("repo") or ""),
                **extra_args,
            )
        if name == "safe_mcp":
            payload = args.get("payload")
            return MCPTool(allowed_servers=self._allowed_mcp_servers()).call(
                server=str(args.get("server") or ""),
                action=str(args.get("action") or ""),
                payload=payload if isinstance(payload, dict) else {},
            )
        if name == "safe_computer_use":
            extra_args = dict(args)
            extra_args.pop("action", None)
            return ComputerUseTool(enabled=True).perform(
                action=str(args.get("action") or ""),
                approved=approved,
                **extra_args,
            )

        raise ValueError(f"unsupported tool call: {name}")

    def _execute_function_calls_until_pause(
        self,
        *,
        run_id: str,
        messages: list[dict[str, str]],
        function_calls: list[dict[str, Any]],
        start_index: int,
        resolved_tools: tuple[str, ...],
        approve_always: bool,
        approved_index: int | None,
    ) -> tuple[int, str | None]:
        for index in range(start_index, len(function_calls)):
            raw_call = function_calls[index]
            if not isinstance(raw_call, dict):
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._format_tool_message(
                            "unknown",
                            {},
                            error="function call payload is not an object",
                        ),
                    }
                )
                continue

            name, args = self._parse_function_call(raw_call)
            if not name:
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._format_tool_message(
                            "unknown",
                            args,
                            error="function call name is empty",
                        ),
                    }
                )
                continue

            is_call_approved = approve_always or approved_index == index
            approval_prompt = self._is_risky_tool_call(name, args)
            if approval_prompt and not is_call_approved:
                token = self._approvals.request(run_id=run_id, prompt=approval_prompt)
                return index, token

            try:
                result = self._execute_tool_call(
                    name=name,
                    args=args,
                    resolved_tools=resolved_tools,
                    approved=is_call_approved,
                )
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._format_tool_message(name, args, result=result),
                    }
                )
            except Exception as exc:
                messages.append(
                    {
                        "role": "assistant",
                        "content": self._format_tool_message(name, args, error=str(exc)),
                    }
                )

        return len(function_calls), None

    @staticmethod
    def _latest_assistant_text(messages: list[dict[str, str]]) -> str:
        for message in reversed(messages):
            if message.get("role") != "assistant":
                continue
            content = str(message.get("content") or "").strip()
            if content and not content.startswith("TOOL_RESULT "):
                return content
        return ""

    def _completed_result(
        self,
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

    def _failed_result(
        self,
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

    def _paused_result(
        self,
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

    def _run_tool_loop(
        self,
        *,
        run_id: str,
        objective: str,
        messages: list[dict[str, str]],
        selected_model: str,
        selected_profile: str,
        resolved_tools: tuple[str, ...],
        approve_always: bool,
        initial_calls: list[dict[str, Any]] | None = None,
        initial_call_index: int = 0,
        current_model_label: str = "auto",
    ) -> dict[str, Any]:
        tool_defs = self._build_tool_definitions(resolved_tools)
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
                    self._pending_runs.pop(run_id, None)
                    return self._failed_result(
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
                    final_text = text or self._latest_assistant_text(messages)
                    self._pending_runs.pop(run_id, None)
                    if final_text:
                        return self._completed_result(
                            selected_profile=selected_profile,
                            current_model_label=model_label,
                            resolved_tools=resolved_tools,
                            output=final_text,
                        )
                    return self._failed_result(
                        selected_profile=selected_profile,
                        current_model_label=model_label,
                        resolved_tools=resolved_tools,
                        message="model returned neither text nor function calls",
                    )

            next_index, token = self._execute_function_calls_until_pause(
                run_id=run_id,
                messages=messages,
                function_calls=pending_calls or [],
                start_index=pending_call_index,
                resolved_tools=resolved_tools,
                approve_always=approve_always,
                approved_index=None,
            )
            if token:
                self._pending_runs[run_id] = PendingRunState(
                    run_id=run_id,
                    objective=objective,
                    messages=list(messages),
                    selected_model=selected_model,
                    selected_profile=selected_profile,
                    resolved_tools=resolved_tools,
                    function_calls=list(pending_calls or []),
                    call_index=next_index,
                    current_model_label=model_label,
                    approve_always=approve_always,
                )
                return self._paused_result(
                    selected_profile=selected_profile,
                    current_model_label=model_label,
                    resolved_tools=resolved_tools,
                    token=token,
                )

            pending_calls = None
            pending_call_index = 0

        self._pending_runs.pop(run_id, None)
        return self._failed_result(
            selected_profile=selected_profile,
            current_model_label=model_label,
            resolved_tools=resolved_tools,
            message="tool orchestration exceeded maximum turns",
        )

    def run(
        self,
        objective: str,
        *,
        require_approval: bool = False,
        run_id: str = "run-local",
        preferred_model_id: str | None = None,
        model_hub_profile_id: str | None = None,
        enabled_tools: list[str] | None = None,
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

        selected_model = (preferred_model_id or "").strip()
        selected_profile = (
            model_hub_profile_id
            or os.getenv("OPENAI_WORKER_MODEL_HUB_PROFILE")
            or "p1"
        ).strip()
        if not selected_profile:
            selected_profile = "p1"

        resolved_tools = self._resolve_tools(enabled_tools)
        messages = [{"role": "user", "content": cleaned_objective}]
        return self._run_tool_loop(
            run_id=run_id,
            objective=cleaned_objective,
            messages=messages,
            selected_model=selected_model,
            selected_profile=selected_profile,
            resolved_tools=resolved_tools,
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
        state = self._pending_runs.get(run_id)
        if state is None:
            if not approved:
                return {"status": "failed", "output": "approval rejected"}
            if objective:
                return self.run(objective, run_id=run_id, require_approval=False)
            return {"status": "failed", "output": "no pending approval state"}

        if not approved:
            self._pending_runs.pop(run_id, None)
            return self._failed_result(
                selected_profile=state.selected_profile,
                current_model_label=state.current_model_label,
                resolved_tools=state.resolved_tools,
                message="approval rejected",
            )

        approve_always = state.approve_always or bool((payload or {}).get("approveAlways"))

        next_index, token = self._execute_function_calls_until_pause(
            run_id=run_id,
            messages=state.messages,
            function_calls=state.function_calls,
            start_index=state.call_index,
            resolved_tools=state.resolved_tools,
            approve_always=approve_always,
            approved_index=state.call_index,
        )

        if token:
            state.call_index = next_index
            state.approve_always = approve_always
            self._pending_runs[run_id] = state
            return self._paused_result(
                selected_profile=state.selected_profile,
                current_model_label=state.current_model_label,
                resolved_tools=state.resolved_tools,
                token=token,
            )

        self._pending_runs.pop(run_id, None)
        return self._run_tool_loop(
            run_id=run_id,
            objective=state.objective,
            messages=state.messages,
            selected_model=state.selected_model,
            selected_profile=state.selected_profile,
            resolved_tools=state.resolved_tools,
            approve_always=approve_always,
            current_model_label=state.current_model_label,
        )
