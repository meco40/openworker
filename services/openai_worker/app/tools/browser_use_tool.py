import asyncio
import importlib
import json
import re
from typing import Any

TOOL_NAME = "safe_browser_use"
DEFAULT_MAX_STEPS = 20
RISKY_TASK_PATTERN = re.compile(
    r"\b(rm\s+-rf|del\s+/f|delete|remove|format|drop\s+table|shutdown|wipe)\b",
    re.IGNORECASE,
)


class BrowserUseTool:
    name = TOOL_NAME

    def __init__(self, enabled: bool) -> None:
        self._enabled = enabled

    @staticmethod
    def _load_runtime() -> tuple[type[Any], type[Any] | None, type[Any]]:
        module = importlib.import_module("browser_use")
        agent_cls = getattr(module, "Agent", None)
        browser_cls = getattr(module, "Browser", None)
        llm_cls = getattr(module, "ChatBrowserUse", None)
        if agent_cls is None or llm_cls is None:
            raise RuntimeError("browser-use runtime missing Agent/ChatBrowserUse exports")
        return agent_cls, browser_cls, llm_cls

    @staticmethod
    def _extract_result(history: Any) -> str:
        if history is None:
            return ""

        for attr_name in ("final_result", "result", "output", "text"):
            attr = getattr(history, attr_name, None)
            if attr is None:
                continue
            value = attr() if callable(attr) else attr
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text

        if isinstance(history, str):
            return history

        try:
            return json.dumps(history, default=str)
        except Exception:
            return str(history)

    @staticmethod
    def _parse_max_steps(value: Any) -> int:
        if value is None:
            return DEFAULT_MAX_STEPS
        if isinstance(value, int):
            parsed = value
        elif isinstance(value, float):
            parsed = int(value)
        elif isinstance(value, str) and value.strip():
            parsed = int(value.strip())
        else:
            raise ValueError("max_steps must be an integer")
        return max(1, min(parsed, 200))

    @staticmethod
    def _parse_bool(value: Any, *, default: bool) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"1", "true", "yes", "on"}:
                return True
            if lowered in {"0", "false", "no", "off"}:
                return False
        raise ValueError("boolean flag must be true/false")

    @classmethod
    def approval_reason(cls, *, task: str | None, use_cloud: Any = None) -> str | None:
        cleaned_task = str(task or "").strip()
        if cleaned_task and RISKY_TASK_PATTERN.search(cleaned_task):
            return "task appears potentially destructive"
        try:
            cloud_enabled = cls._parse_bool(use_cloud, default=False)
        except ValueError:
            cloud_enabled = False
        if cloud_enabled:
            return "task requests browser-use cloud execution"
        return None

    @staticmethod
    async def _close_browser(browser: Any) -> None:
        if browser is None:
            return
        close_fn = getattr(browser, "close", None)
        if not callable(close_fn):
            return
        close_result = close_fn()
        if asyncio.iscoroutine(close_result):
            await close_result

    async def _run_task_async(
        self,
        *,
        task: str,
        max_steps: int,
        headless: bool,
        use_cloud: bool,
    ) -> tuple[str, str]:
        agent_cls, browser_cls, llm_cls = self._load_runtime()
        llm = llm_cls()

        browser = None
        if browser_cls is not None:
            try:
                browser = browser_cls(headless=headless, use_cloud=use_cloud)
            except TypeError:
                browser = browser_cls()

        agent_kwargs: dict[str, Any] = {"task": task, "llm": llm}
        if browser is not None:
            agent_kwargs["browser"] = browser

        agent = agent_cls(**agent_kwargs)

        try:
            history = await agent.run(max_steps=max_steps)
        finally:
            await self._close_browser(browser)

        return self._extract_result(history), history.__class__.__name__

    def execute(
        self,
        *,
        action: str,
        task: str | None = None,
        max_steps: Any = None,
        headless: Any = None,
        use_cloud: Any = None,
        approved: bool = False,
    ) -> dict[str, Any]:
        if not self._enabled:
            raise RuntimeError("browser-use tool is disabled")

        cleaned_action = str(action or "").strip().lower()
        if cleaned_action not in {"run_task", "run"}:
            raise ValueError(f"unsupported browser-use action: {action}")

        cleaned_task = str(task or "").strip()
        if not cleaned_task:
            raise ValueError("task is required for browser-use run actions")

        resolved_max_steps = self._parse_max_steps(max_steps)
        resolved_headless = self._parse_bool(headless, default=True)
        resolved_use_cloud = self._parse_bool(use_cloud, default=False)
        reason = self.approval_reason(task=cleaned_task, use_cloud=resolved_use_cloud)
        if reason and not approved:
            raise PermissionError(f"{reason}; explicit approval is required")

        try:
            result_text, history_type = asyncio.run(
                self._run_task_async(
                    task=cleaned_task,
                    max_steps=resolved_max_steps,
                    headless=resolved_headless,
                    use_cloud=resolved_use_cloud,
                )
            )
        except ImportError as exc:
            raise RuntimeError(
                "browser-use package is not installed. Install dependency 'browser-use' and run Playwright setup."
            ) from exc
        except RuntimeError as exc:
            message = str(exc).strip()
            if "browser-use runtime missing Agent/ChatBrowserUse exports" in message:
                raise RuntimeError(
                    "browser-use package is incompatible. Please upgrade to a version that exposes Agent and ChatBrowserUse."
                ) from exc
            raise

        return {
            "status": "ok",
            "tool": self.name,
            "action": cleaned_action,
            "task": cleaned_task,
            "max_steps": resolved_max_steps,
            "headless": resolved_headless,
            "use_cloud": resolved_use_cloud,
            "history_type": history_type,
            "result": result_text,
        }
