from pathlib import Path

import app.runner as runner_module
from app.runner import Runner


def test_safe_files_tool_write_creates_real_file(tmp_path: Path) -> None:
    target_file = tmp_path / "notes.txt"
    call_count = {"value": 0}

    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if call_count["value"] == 0:
            call_count["value"] += 1
            return {
                "text": "",
                "model": "gpt-4o-mini",
                "provider": "openai",
                "functionCalls": [
                    {
                        "name": "safe_files",
                        "args": {
                            "operation": "write",
                            "path": str(target_file),
                            "content": "Remember the milk",
                        },
                    }
                ],
            }

        call_count["value"] += 1
        return {
            "text": "file was written",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)

    result = runner.run("create a note file", enabled_tools=["safe_files"])

    assert result["status"] == "completed"
    assert target_file.exists()
    assert target_file.read_text(encoding="utf-8") == "Remember the milk"


def test_runner_executes_all_tools_when_enabled(monkeypatch) -> None:
    class FakeShell:
        def execute(self, command: str) -> dict[str, object]:
            return {"status": "ok", "tool": "safe_shell", "command": command}

    class FakeBrowser:
        def execute(self, action: str, url: str | None = None) -> dict[str, object]:
            return {"status": "ok", "tool": "safe_browser", "action": action, "url": url or ""}

    class FakeGitHub:
        def execute(self, **kwargs: object) -> dict[str, object]:
            return {"status": "ok", "tool": "safe_github", "action": kwargs.get("action")}

    class FakeMCP:
        def __init__(self, **kwargs: object) -> None:
            self.kwargs = kwargs

        def call(self, server: str, action: str, payload: dict[str, object]) -> dict[str, object]:
            return {"status": "ok", "tool": "safe_mcp", "server": server, "action": action}

    class FakeComputerUse:
        @staticmethod
        def is_destructive(action: str) -> bool:
            return False

        def __init__(self, enabled: bool) -> None:
            self.enabled = enabled

        def perform(self, action: str, approved: bool = False, **kwargs: object) -> dict[str, object]:
            return {"status": "ok", "tool": "safe_computer_use", "action": action, "approved": approved}

    monkeypatch.setattr(runner_module, "ShellTool", FakeShell)
    monkeypatch.setattr(runner_module, "BrowserTool", FakeBrowser)
    monkeypatch.setattr(runner_module, "GitHubTool", FakeGitHub)
    monkeypatch.setattr(runner_module, "MCPTool", FakeMCP)
    monkeypatch.setattr(runner_module, "ComputerUseTool", FakeComputerUse)

    call_count = {"value": 0}

    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if call_count["value"] == 0:
            call_count["value"] += 1
            return {
                "text": "",
                "model": "gpt-4o-mini",
                "provider": "openai",
                "functionCalls": [
                    {"name": "safe_shell", "args": {"command": "echo hi"}},
                    {"name": "safe_browser", "args": {"action": "fetch", "url": "https://example.com"}},
                    {"name": "safe_files", "args": {"operation": "write", "path": "notes.txt", "content": "x"}},
                    {"name": "safe_github", "args": {"action": "list_issues", "owner": "openclaw", "repo": "clawtest"}},
                    {"name": "safe_mcp", "args": {"server": "s1", "action": "ping", "payload": {}}},
                    {"name": "safe_computer_use", "args": {"action": "snapshot"}},
                ],
            }
        call_count["value"] += 1
        tool_result_messages = [
            message for message in messages if message["role"] == "assistant" and message["content"].startswith("TOOL_RESULT ")
        ]
        assert len(tool_result_messages) == 6
        return {
            "text": "all tools finished",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run(
        "run all tools",
        enabled_tools=["safe_shell", "safe_browser", "safe_files", "safe_github", "safe_mcp", "safe_computer_use"],
    )

    assert result["status"] == "completed"
    assert "all tools finished" in result["output"]
