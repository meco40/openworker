import os
import re
import subprocess
from typing import Any

TOOL_NAME = "safe_shell"
DEFAULT_TIMEOUT_SEC = 20.0
DEFAULT_MAX_OUTPUT_BYTES = 40_000

BLOCKED_PATTERNS = [
    re.compile(r"\brm\s+-rf\s+/\b", re.IGNORECASE),
    re.compile(r"\bshutdown\b", re.IGNORECASE),
    re.compile(r"\breboot\b", re.IGNORECASE),
    re.compile(r"\bmkfs\b", re.IGNORECASE),
    re.compile(r"\bformat\s+[a-z]:", re.IGNORECASE),
]


def _truncate_text(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return value
    clipped = encoded[:max_bytes].decode("utf-8", errors="ignore")
    return f"{clipped}\n...[truncated]"


class ShellTool:
    name = TOOL_NAME

    def __init__(
        self,
        timeout_seconds: float | None = None,
        max_output_bytes: int | None = None,
    ) -> None:
        timeout_raw = timeout_seconds
        if timeout_raw is None:
            timeout_raw = float(os.getenv("OPENAI_WORKER_SHELL_TIMEOUT_SEC", str(DEFAULT_TIMEOUT_SEC)))
        self._timeout_seconds = max(0.05, float(timeout_raw))

        output_raw = max_output_bytes
        if output_raw is None:
            output_raw = int(os.getenv("OPENAI_WORKER_SHELL_MAX_OUTPUT_BYTES", str(DEFAULT_MAX_OUTPUT_BYTES)))
        self._max_output_bytes = max(1024, int(output_raw))

    @staticmethod
    def _validate_command(command: str) -> str:
        cleaned = command.strip()
        if not cleaned:
            raise ValueError("command is required")
        for pattern in BLOCKED_PATTERNS:
            if pattern.search(cleaned):
                raise PermissionError(f"blocked command pattern: {pattern.pattern}")
        return cleaned

    def execute(self, command: str) -> dict[str, Any]:
        cleaned = self._validate_command(command)
        try:
            completed = subprocess.run(
                cleaned,
                shell=True,
                capture_output=True,
                text=True,
                timeout=self._timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                f"shell command timed out after {self._timeout_seconds:.2f}s"
            ) from exc

        stdout = _truncate_text(completed.stdout or "", self._max_output_bytes)
        stderr = _truncate_text(completed.stderr or "", self._max_output_bytes)

        return {
            "status": "ok" if completed.returncode == 0 else "error",
            "tool": self.name,
            "command": cleaned,
            "exit_code": int(completed.returncode),
            "stdout": stdout,
            "stderr": stderr,
        }
