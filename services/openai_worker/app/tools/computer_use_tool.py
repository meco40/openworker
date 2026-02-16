TOOL_NAME = "safe_computer_use"

DESTRUCTIVE_ACTIONS = {
    "delete",
    "delete_file",
    "format",
    "shutdown",
}


class ComputerUseTool:
    name = TOOL_NAME

    def __init__(self, enabled: bool) -> None:
        self._enabled = enabled

    @staticmethod
    def is_destructive(action: str) -> bool:
        lowered = action.strip().lower()
        return lowered in DESTRUCTIVE_ACTIONS or lowered.startswith("delete_")

    def perform(self, action: str, approved: bool = False) -> dict[str, str]:
        cleaned = action.strip()
        if not self._enabled:
            raise RuntimeError("computer use tool is disabled")
        if not cleaned:
            raise ValueError("action is required")
        if self.is_destructive(cleaned) and not approved:
            raise PermissionError("destructive action requires explicit approval")
        return {
            "status": "ok",
            "tool": self.name,
            "action": cleaned,
        }
