TOOL_NAME = "safe_github"


class GitHubTool:
    name = TOOL_NAME

    def execute(
        self,
        action: str,
        owner: str,
        repo: str,
    ) -> dict[str, str]:
        cleaned_action = action.strip()
        if not cleaned_action:
            raise ValueError("action is required")
        if not owner.strip() or not repo.strip():
            raise ValueError("owner and repo are required")
        return {
            "status": "ok",
            "tool": self.name,
            "action": cleaned_action,
            "owner": owner.strip(),
            "repo": repo.strip(),
        }
