TOOL_NAME = "safe_shell"


class ShellTool:
    name = TOOL_NAME

    def execute(self, command: str) -> dict[str, str]:
        cleaned = command.strip()
        if not cleaned:
            raise ValueError("command is required")
        return {
            "status": "ok",
            "tool": self.name,
            "output": f"shell executed: {cleaned}",
        }
