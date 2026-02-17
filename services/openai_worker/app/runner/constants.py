import os
import re
from typing import Any

MAX_TOOL_TURNS = 8

RISKY_SHELL_PATTERN = re.compile(
    r"\brm\s+-rf\b|\bdel\s+/f\s+/s\s+/q\b|\bformat\b|\bshutdown\b|\breboot\b|\bpowershell\s+-enc\b|\breg\s+delete\b|\bsc\s+stop\b|\bdiskpart\b|\bbcdedit\b|\binvoke-expression\b|\biex\b",
    re.IGNORECASE,
)
RISKY_GITHUB_ACTIONS = {"delete_repo", "delete_branch", "force_push"}
RISKY_MCP_ACTION_PATTERN = re.compile(r"delete|drop|truncate|shutdown", re.IGNORECASE)
SAFE_MCP_SERVERS_ENV = "OPENAI_WORKER_ALLOWED_MCP_SERVERS"
BROWSER_USE_PRIMARY_TOOL = "safe_browser_use"
LEGACY_BROWSER_TOOL_NAMES = {"safe_browser", "safe_computer_use"}
DEFAULT_TOOL_APPROVAL_MODE = "ask_approve"
LEGACY_TOOL_APPROVAL_MODE = "__legacy__"
TOOL_APPROVAL_MODES = {"deny", "ask_approve", "approve_always"}

TOOL_DEFINITIONS: dict[str, dict[str, Any]] = {
    "safe_shell": {
        "type": "function",
        "function": {
            "name": "safe_shell",
            "description": "Execute a shell command in the isolated worker environment.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute."},
                },
                "required": ["command"],
            },
        },
    },
    "safe_browser": {
        "type": "function",
        "function": {
            "name": "safe_browser",
            "description": "Perform browser actions and capture page state.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "Browser action (open/click/extract)."},
                    "url": {"type": "string", "description": "Optional URL target."},
                    "max_links": {"type": "integer", "description": "Optional cap for extracted links."},
                },
                "required": ["action"],
            },
        },
    },
    "safe_browser_use": {
        "type": "function",
        "function": {
            "name": "safe_browser_use",
            "description": "Run browser-use autonomous browser tasks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "run_task or run."},
                    "task": {"type": "string", "description": "Natural-language browser task to execute."},
                    "max_steps": {"type": "integer", "description": "Maximum browser agent steps (1-200)."},
                    "headless": {"type": "boolean", "description": "Run browser headless (default: true)."},
                    "use_cloud": {"type": "boolean", "description": "Enable browser-use cloud browser (default: false)."},
                },
                "required": ["action", "task"],
            },
        },
    },
    "safe_files": {
        "type": "function",
        "function": {
            "name": "safe_files",
            "description": "Read and write files inside the worker workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {"type": "string", "description": "One of read/write."},
                    "path": {"type": "string", "description": "File path (workspace-relative or absolute)."},
                    "content": {"type": "string", "description": "Content for write operations."},
                },
                "required": ["operation", "path"],
            },
        },
    },
    "safe_github": {
        "type": "function",
        "function": {
            "name": "safe_github",
            "description": "Run GitHub repository actions via configured credentials.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "GitHub action name."},
                    "owner": {"type": "string", "description": "Repository owner."},
                    "repo": {"type": "string", "description": "Repository name."},
                    "issue_number": {"type": "integer", "description": "Issue number for get_issue."},
                    "pull_number": {"type": "integer", "description": "Pull request number for get_pull_request."},
                    "state": {"type": "string", "description": "Filter state for list actions."},
                    "query": {"type": "string", "description": "Search query for search_repositories."},
                    "title": {"type": "string", "description": "Issue title for create_issue."},
                    "body": {"type": "string", "description": "Issue body for create_issue."},
                    "labels": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Labels for create_issue.",
                    },
                    "per_page": {"type": "integer", "description": "Pagination page size."},
                    "page": {"type": "integer", "description": "Pagination page number."},
                },
                "required": ["action"],
            },
        },
    },
    "safe_mcp": {
        "type": "function",
        "function": {
            "name": "safe_mcp",
            "description": "Call an allowlisted MCP server action.",
            "parameters": {
                "type": "object",
                "properties": {
                    "server": {"type": "string", "description": "MCP server id."},
                    "action": {"type": "string", "description": "MCP action name."},
                    "payload": {"type": "object", "description": "MCP action payload."},
                },
                "required": ["server", "action"],
            },
        },
    },
    "safe_computer_use": {
        "type": "function",
        "function": {
            "name": "safe_computer_use",
            "description": "Use guarded computer actions in a remote session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "Computer-use action name."},
                    "url": {"type": "string", "description": "URL target for browser-backed actions."},
                    "seconds": {"type": "number", "description": "Wait duration in seconds for wait action."},
                    "text": {"type": "string", "description": "Text payload for typing actions."},
                    "key": {"type": "string", "description": "Key value for keyboard actions."},
                },
                "required": ["action"],
            },
        },
    },
}


def get_allowed_mcp_servers() -> set[str]:
    """Get the set of allowed MCP servers from environment variable."""
    raw = os.getenv(SAFE_MCP_SERVERS_ENV, "")
    return {item.strip() for item in raw.split(",") if item.strip()}
