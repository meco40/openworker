from app.config import WorkerSettings, is_tool_allowed
from app.tools.browser_tool import TOOL_NAME as BROWSER_TOOL_NAME
from app.tools.browser_use_tool import TOOL_NAME as BROWSER_USE_TOOL_NAME
from app.tools.computer_use_tool import TOOL_NAME as COMPUTER_USE_TOOL_NAME
from app.tools.files_tool import TOOL_NAME as FILES_TOOL_NAME
from app.tools.github_tool import TOOL_NAME as GITHUB_TOOL_NAME
from app.tools.mcp_tool import TOOL_NAME as MCP_TOOL_NAME
from app.tools.shell_tool import TOOL_NAME as SHELL_TOOL_NAME

ALL_TOOL_NAMES: tuple[str, ...] = (
    SHELL_TOOL_NAME,
    BROWSER_TOOL_NAME,
    BROWSER_USE_TOOL_NAME,
    FILES_TOOL_NAME,
    GITHUB_TOOL_NAME,
    MCP_TOOL_NAME,
    COMPUTER_USE_TOOL_NAME,
)


def get_enabled_tool_names(
    *,
    settings: WorkerSettings | None = None,
    allowlist: set[str] | None = None,
) -> tuple[str, ...]:
    names: list[str] = []
    for name in ALL_TOOL_NAMES:
        if allowlist is not None and name not in allowlist:
            continue
        if is_tool_allowed(name, settings=settings):
            names.append(name)
    return tuple(names)
