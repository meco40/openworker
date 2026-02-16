import pytest

from app.tools.shell_tool import ShellTool


def test_shell_tool_executes_command_and_captures_output() -> None:
    tool = ShellTool()
    result = tool.execute("python -c \"print('hello-shell')\"")

    assert result["status"] == "ok"
    assert result["tool"] == "safe_shell"
    assert result["exit_code"] == 0
    assert "hello-shell" in result["stdout"]


def test_shell_tool_rejects_blocked_command() -> None:
    tool = ShellTool()

    with pytest.raises(PermissionError):
        tool.execute("shutdown /s /t 0")


def test_shell_tool_times_out_for_long_running_command() -> None:
    tool = ShellTool(timeout_seconds=0.05)

    with pytest.raises(TimeoutError):
        tool.execute("python -c \"import time; time.sleep(1)\"")
