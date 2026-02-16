from app.config import WorkerSettings, is_tool_allowed


def test_tool_sandbox_allows_configured_prefix() -> None:
    settings = WorkerSettings(allowed_tool_prefixes=("safe_",))

    assert is_tool_allowed("safe_read_file", settings=settings) is True


def test_tool_sandbox_rejects_unlisted_tools() -> None:
    settings = WorkerSettings(allowed_tool_prefixes=("safe_",))

    assert is_tool_allowed("exec_shell", settings=settings) is False
