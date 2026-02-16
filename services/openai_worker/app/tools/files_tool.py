TOOL_NAME = "safe_files"


class FilesTool:
    name = TOOL_NAME

    def execute(
        self,
        operation: str,
        path: str,
        content: str | None = None,
    ) -> dict[str, str]:
        cleaned_operation = operation.strip().lower()
        cleaned_path = path.strip()
        if not cleaned_operation:
            raise ValueError("operation is required")
        if not cleaned_path:
            raise ValueError("path is required")

        if cleaned_operation == "read":
            return {
                "status": "ok",
                "tool": self.name,
                "operation": "read",
                "path": cleaned_path,
            }
        if cleaned_operation == "write":
            return {
                "status": "ok",
                "tool": self.name,
                "operation": "write",
                "path": cleaned_path,
                "bytes": str(len(content or "")),
            }
        raise ValueError(f"unsupported operation: {operation}")
