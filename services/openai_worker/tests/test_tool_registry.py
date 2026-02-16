from app.config import WorkerSettings
from app.tools import get_enabled_tool_names


def test_tool_registry_honors_allowlist() -> None:
    settings = WorkerSettings(allowed_tool_prefixes=("safe_",))

    names = get_enabled_tool_names(
        settings=settings,
        allowlist={"safe_shell", "safe_files"},
    )

    assert set(names) == {"safe_shell", "safe_files"}


def test_tool_registry_applies_prefix_sandbox() -> None:
    settings = WorkerSettings(allowed_tool_prefixes=("safe_files",))

    names = get_enabled_tool_names(settings=settings)

    assert names == ("safe_files",)
