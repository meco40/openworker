import os
from pathlib import Path
from typing import Any

TOOL_NAME = "safe_files"
FILES_ROOT_ENV = "OPENAI_WORKER_FILES_ROOT"


class FilesTool:
    name = TOOL_NAME

    def __init__(self, files_root: str | None = None) -> None:
        root_value = (files_root or os.getenv(FILES_ROOT_ENV, "")).strip()
        self._files_root = Path(root_value).resolve() if root_value else None

    def _resolve_path(self, value: str) -> Path:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("path is required")

        candidate = Path(cleaned).expanduser()
        if not candidate.is_absolute():
            base = self._files_root or Path.cwd()
            candidate = base / candidate

        resolved = candidate.resolve()
        if self._files_root is None:
            return resolved

        try:
            resolved.relative_to(self._files_root)
        except ValueError as exc:
            raise PermissionError(f"path is outside allowed files root: {resolved}") from exc
        return resolved

    def execute(
        self,
        operation: str,
        path: str,
        content: str | None = None,
    ) -> dict[str, Any]:
        cleaned_operation = operation.strip().lower()
        if not cleaned_operation:
            raise ValueError("operation is required")

        resolved_path = self._resolve_path(path)

        if cleaned_operation == "read":
            if not resolved_path.exists() or not resolved_path.is_file():
                raise FileNotFoundError(f"file not found: {resolved_path}")
            text = resolved_path.read_text(encoding="utf-8")
            return {
                "status": "ok",
                "tool": self.name,
                "operation": "read",
                "path": str(resolved_path),
                "content": text,
            }

        if cleaned_operation == "write":
            payload = content or ""
            resolved_path.parent.mkdir(parents=True, exist_ok=True)
            resolved_path.write_text(payload, encoding="utf-8")
            return {
                "status": "ok",
                "tool": self.name,
                "operation": "write",
                "path": str(resolved_path),
                "bytes": len(payload.encode("utf-8")),
            }

        raise ValueError(f"unsupported operation: {operation}")
