//! Port of `src/server/skills/builtInSkills.ts`, with the manifests it imports from
//! `src/skills/<name>/index.ts`. Mirrors the seed rows, in the same order.
//!
//! Only the fields the seed stores are kept: `id`, `name`, `description`, `version`,
//! `category`, `functionName` and `tool`. The `handler` and `execute` parts of the
//! TypeScript objects are dispatch concerns (S8/S9) and are not part of the seed.
//!
//! `tool` is `SkillManifest.tool` from `src/shared/toolSchema.ts` as a JSON value. The
//! TypeScript union `SkillToolDefinition` is not modelled, because the stored value is
//! only read for its `name`. serde_json's `preserve_order` keeps the key order of the
//! TypeScript literals, so the stored text matches `JSON.stringify`.

use serde_json::{json, Value};

/// `SkillManifest` from `src/shared/toolSchema.ts`, reduced to the stored fields.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillManifest {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub version: &'static str,
    pub category: &'static str,
    pub function_name: &'static str,
    pub tool: Value,
}

/// `BuiltInSkillSeed`: a manifest and whether it starts installed.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltInSkillSeed {
    pub manifest: SkillManifest,
    pub installed_by_default: bool,
}

/// `BUILT_IN_SKILLS`, in the TypeScript order.
pub fn built_in_skills() -> Vec<BuiltInSkillSeed> {
    vec![
        // Core Extensions
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "browser",
                name: "Managed Browser",
                description: "CDP-gesteuerter Chromium Browser für Snapshots und Interaktionen.",
                version: "1.0.2",
                category: "Web",
                function_name: "browser_snapshot",
                tool: json!({
                    "name": "browser_snapshot",
                    "description": "Fetch and inspect a web page to return title, metadata and excerpt.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "url": { "type": "string", "description": "Target URL to inspect." },
                            "format": { "type": "string", "description": "png or jpeg" },
                            "quality": { "type": "number", "description": "0-100" }
                        },
                        "required": ["url"]
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "search",
                name: "Google Search",
                description: "Echtzeit-Webzugriff via Google Search Grounding.",
                version: "3.0.1",
                category: "Intelligence",
                function_name: "__built_in__",
                tool: json!({
                    "builtIn": true,
                    "providerConfig": { "gemini": { "googleSearch": {} } }
                }),
            },
            installed_by_default: true,
        },
        // Automation & Code
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "python-runtime",
                name: "Python Executor",
                description: "Lokale REPL für Data Science, Plotting und Logik.",
                version: "3.11.2",
                category: "Automation",
                function_name: "python_execute",
                tool: json!({
                    "name": "python_execute",
                    "description": "Execute Python code in a safe REPL environment for calculations or data analysis.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "code": { "type": "string", "description": "The Python source code to execute." }
                        },
                        "required": ["code"]
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "shell-access",
                name: "Shell",
                description: "Runs commands on the host in the workspace directory. Not sandboxed: commands run with the server user permissions. Unapproved commands require approval by default; set BETACLAW_EXEC_APPROVALS_REQUIRED=false to disable it.",
                version: "2.1.0",
                category: "Automation",
                function_name: "shell_execute",
                tool: json!({
                    "name": "shell_execute",
                    "description": "Run a shell command on the host in the workspace directory (PowerShell on Windows, /bin/sh elsewhere). Not sandboxed: runs with the server permissions.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": { "type": "string", "description": "The shell command to run (e.g., 'ls -la')." }
                        },
                        "required": ["command"]
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "playwright-cli",
                name: "Playwright CLI",
                description: "Run Playwright via CLI for browser tests, tracing, and debugging.",
                version: "1.0.0",
                category: "Automation",
                function_name: "playwright_cli",
                tool: json!({
                    "name": "playwright_cli",
                    "description": "Execute Playwright CLI commands (CLI-first), e.g. test runs, trace/report viewing, and codegen.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "args": {
                                "type": "array",
                                "description": "CLI tokens passed after \"playwright\" (for example [\"test\",\"--project=chromium\"]).",
                                "items": { "type": "string", "description": "One CLI token." }
                            },
                            "command": {
                                "type": "string",
                                "description": "Alternative to args: full argument string after \"playwright\" (for example \"test --headed\")."
                            }
                        },
                        "required": []
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "process-manager",
                name: "Process Manager",
                description: "Start and manage long-running background processes (servers, watchers, etc.) across multiple tool calls. Use this when shell_execute would block forever.",
                version: "1.0.0",
                category: "Automation",
                function_name: "process_manager",
                tool: json!({
                    "name": "process_manager",
                    "description": "Manage long-running background processes across tool calls.\n- start: spawn a process, returns id\n- poll / log: read buffered stdout+stderr output (non-blocking)\n- write: send text to stdin\n- kill: terminate a process\n- list: list all managed processes\n\nNOTE: Uses pipe stdio (no PTY). Interactive programs (vim, sudo with password, etc.) will not work.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["start", "poll", "log", "write", "kill", "list"],
                                "description": "The action to perform."
                            },
                            "command": { "type": "string", "description": "[start] The shell command to run." },
                            "id": { "type": "string", "description": "[poll, log, write, kill] The process id returned by start." },
                            "label": { "type": "string", "description": "[start] Human-readable label for the process (e.g. \"dev-server\")." },
                            "cwd": { "type": "string", "description": "[start] Working directory for the process." },
                            "text": { "type": "string", "description": "[write] Text to write to the process stdin." },
                            "bytes": { "type": "number", "description": "[poll, log] Maximum tail bytes to return from output buffer. Default: 4000." },
                            "signal": { "type": "string", "description": "[kill] Signal to send (default SIGTERM)." },
                            "start_timeout_ms": { "type": "number", "description": "[start] Milliseconds to wait for early crash detection before returning process id. Default: 2000." }
                        },
                        "required": ["action"]
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "subagents",
                name: "Subagents",
                description: "Spawn and manage delegated helper agents for complex tasks.",
                version: "1.0.0",
                category: "Automation",
                function_name: "subagents",
                tool: json!({
                    "name": "subagents",
                    "description": "Manage delegated helper agents: list, spawn, kill, steer, inspect logs or status.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "description": "Operation to execute.",
                                "enum": ["list", "spawn", "kill", "steer", "info", "log", "help", "profiles"]
                            },
                            "agentId": { "type": "string", "description": "Logical helper id/profile for spawn (example: researcher or qa)." },
                            "task": { "type": "string", "description": "Task text for spawn." },
                            "target": { "type": "string", "description": "Run target for kill/steer/info/log (run id, prefix, or #index)." },
                            "message": { "type": "string", "description": "Guidance text for steer." },
                            "model": { "type": "string", "description": "Optional model override for spawned run." }
                        },
                        "required": []
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "multi-tool-use-parallel",
                name: "Multi Tool Use Parallel",
                description: "Execute multiple independent tool calls in parallel and aggregate results.",
                version: "1.0.0",
                category: "Automation",
                function_name: "multi_tool_use_parallel",
                tool: json!({
                    "name": "multi_tool_use_parallel",
                    "description": "Run multiple tool calls in parallel.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "tool_uses": {
                                "type": "array",
                                "description": "List of tool call entries. Each entry can carry name/recipient_name plus args/parameters.",
                                "items": { "type": "object", "description": "Tool call entry object." }
                            }
                        },
                        "required": ["tool_uses"]
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "github-manager",
                name: "GitHub Connector",
                description: "Repo-Management, Pull Requests und Code-Reviews.",
                version: "1.5.0",
                category: "DevOps",
                function_name: "github_query",
                tool: json!({
                    "name": "github_query",
                    "description": "Interact with GitHub repositories to manage code, issues, and PRs.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "repo": { "type": "string", "description": "Target repository (e.g., 'facebook/react')" },
                            "action": {
                                "type": "string",
                                "description": "Action to perform",
                                "enum": ["list_issues", "list_pulls", "repo_info", "search_code"]
                            },
                            "query": { "type": "string", "description": "Search query if applicable" }
                        },
                        "required": ["repo", "action"]
                    }
                }),
            },
            installed_by_default: false,
        },
        // Data & Media
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "vision",
                name: "Live Vision",
                description: "Echtzeit-Analyse von Kamera-Feeds und Screen-Streams.",
                version: "2.4.0",
                category: "Media",
                function_name: "vision_analyze",
                tool: json!({
                    "name": "vision_analyze",
                    "description": "Analyze image input (URL or base64) for objects, text and scene context.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "focus": { "type": "string", "description": "Area of interest or specific object to look for." },
                            "imageUrl": { "type": "string", "description": "Public image URL to analyze." },
                            "imageBase64": { "type": "string", "description": "Base64 encoded image payload (without data URL prefix)." },
                            "mimeType": { "type": "string", "description": "Mime type for base64 payload, e.g. image/png." }
                        }
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "sql-bridge",
                name: "SQL Bridge",
                description: "Sicherer Read/Write Zugriff auf SQL-Datenbanken.",
                version: "2.0.1",
                category: "Data",
                function_name: "db_query",
                tool: json!({
                    "name": "db_query",
                    "description": "Execute a read-only SQL query against the connected database.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "Valid SQL SELECT statement." }
                        },
                        "required": ["query"]
                    }
                }),
            },
            installed_by_default: false,
        },
        // System
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "filesystem",
                name: "File Gateway",
                description: "Sandbox-Zugriff auf lokale Dateien und Downloads.",
                version: "0.9.8",
                category: "System",
                function_name: "file_read",
                tool: json!({
                    "name": "file_read",
                    "description": "Read the content of a file in the workspace sandbox safely.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Relative path to the file within the sandbox." }
                        },
                        "required": ["path"]
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "gateway-self-heal",
                name: "Gateway Self-Heal",
                description: "Allows the agent to inspect and restart the gateway server process. Owner-only. Use when recovering from corrupted state or memory growth.",
                version: "1.0.0",
                category: "System",
                function_name: "gateway_self_heal",
                tool: json!({
                    "name": "gateway_self_heal",
                    "description": "Inspect and restart the gateway server process (owner-only).\n- status: return current pid, uptime, memory usage\n- restart: schedule a graceful SIGTERM restart\n\nWARNING: restart will terminate the server — the user connection will drop temporarily.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["status", "restart"],
                                "description": "Action to perform."
                            },
                            "reason": { "type": "string", "description": "[restart] Human-readable reason for the restart." },
                            "delay_ms": { "type": "number", "description": "[restart] Milliseconds before sending SIGTERM. Default: 2000 (max 30000)." },
                            "force": { "type": "boolean", "description": "[restart] If true, sends SIGKILL instead of SIGTERM (use only when graceful shutdown fails)." }
                        },
                        "required": ["action"]
                    }
                }),
            },
            installed_by_default: false,
        },
        // Web & Network
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "web-search",
                name: "Web Search",
                description: "Sucht im Web via Brave Search API (mit DuckDuckGo-Fallback).",
                version: "1.0.0",
                category: "Intelligence",
                function_name: "web_search",
                tool: json!({
                    "name": "web_search",
                    "description": "Search the web for current information. Returns a list of results with titles, URLs, and snippets. Use for real-time information, news, documentation, or any topic that may have changed recently.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "The search query string." },
                            "count": { "type": "number", "description": "Number of results to return (1–20, default 5)." }
                        },
                        "required": ["query"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "web-fetch",
                name: "Web Fetch",
                description: "Lädt eine URL und gibt den bereinigten Textinhalt zurück.",
                version: "1.0.0",
                category: "Intelligence",
                function_name: "web_fetch",
                tool: json!({
                    "name": "web_fetch",
                    "description": "Fetch a public URL and return its cleaned text content. Useful for reading documentation, articles, APIs, or any webpage. HTML is converted to readable text. Not for private/internal URLs.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "url": { "type": "string", "description": "The full URL to fetch (must be a public HTTP/HTTPS URL)." },
                            "maxLength": { "type": "number", "description": "Maximum characters to return (default 8000, max 40000)." }
                        },
                        "required": ["url"]
                    }
                }),
            },
            installed_by_default: true,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "http-request",
                name: "HTTP Request",
                description: "Führt generische REST-API-Anfragen durch (GET, POST, PUT, PATCH, DELETE).",
                version: "1.0.0",
                category: "Automation",
                function_name: "http_request",
                tool: json!({
                    "name": "http_request",
                    "description": "Make an HTTP request to an external API. Supports GET, POST, PUT, PATCH, DELETE, HEAD. Can send JSON bodies and custom headers. Use for REST API calls, webhooks, or any HTTP interaction. Requires BETACLAW_HTTP_SKILL_ENABLED=true.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "url": { "type": "string", "description": "The full URL to call (must be a public HTTP/HTTPS endpoint)." },
                            "method": {
                                "type": "string",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                                "description": "HTTP method (default: GET)."
                            },
                            "headers": { "type": "object", "description": "Optional request headers as key-value pairs." },
                            "body": { "type": "object", "description": "Optional request body (object for JSON, string for raw)." }
                        },
                        "required": ["url"]
                    }
                }),
            },
            installed_by_default: false,
        },
        // Output
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "notifications",
                name: "Notifications",
                description: "Sendet Webhooks und E-Mails. Erfordert BETACLAW_NOTIFICATIONS_ENABLED=true.",
                version: "1.0.0",
                category: "Automation",
                function_name: "notifications",
                tool: json!({
                    "name": "notifications",
                    "description": "Send notifications via webhook or email. Use action=\"webhook_send\" to POST JSON to a URL, or action=\"email_send\" to send an email. Requires BETACLAW_NOTIFICATIONS_ENABLED=true environment variable.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["webhook_send", "email_send"],
                                "description": "The notification action to perform."
                            },
                            "url": { "type": "string", "description": "[webhook_send] The webhook URL to POST to." },
                            "payload": { "type": "object", "description": "[webhook_send] The JSON payload to send." },
                            "headers": { "type": "object", "description": "[webhook_send] Optional extra headers." },
                            "to": { "type": "string", "description": "[email_send] Recipient address or comma-separated list of addresses." },
                            "subject": { "type": "string", "description": "[email_send] Email subject line." },
                            "body": { "type": "string", "description": "[email_send] Plain-text email body." },
                            "from": { "type": "string", "description": "[email_send] Optional sender address (overrides SMTP_FROM)." }
                        },
                        "required": ["action"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "pdf-generate",
                name: "PDF Generate",
                description: "Wandelt HTML oder Markdown in eine PDF-Datei um.",
                version: "1.0.0",
                category: "Automation",
                function_name: "pdf_generate",
                tool: json!({
                    "name": "pdf_generate",
                    "description": "Convert HTML or Markdown content into a PDF file saved in the workspace output/ folder. Uses headless Chromium if available, falls back to wkhtmltopdf, or saves as HTML if no converter is installed.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "content": { "type": "string", "description": "The HTML or Markdown content to convert to PDF." },
                            "filename": { "type": "string", "description": "Output filename without extension (e.g. \"report\"). Default: \"document\"." }
                        },
                        "required": ["content"]
                    }
                }),
            },
            installed_by_default: false,
        },
        // Demo Compatibility (disabled by default to avoid extra tool overhead)
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "read",
                name: "Read (Compat)",
                description: "Demo-compat alias for safe file reads inside the workspace.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "read",
                tool: json!({
                    "name": "read",
                    "description": "Read file content by path with optional line-range paging.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Workspace-relative file path." },
                            "from": { "type": "number", "description": "Start line (1-based)." },
                            "lines": { "type": "number", "description": "Number of lines to read." },
                            "maxChars": { "type": "number", "description": "Maximum returned characters." }
                        },
                        "required": ["path"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "write",
                name: "Write (Compat)",
                description: "Demo-compat alias for writing files in the workspace.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "write",
                tool: json!({
                    "name": "write",
                    "description": "Write or append text to a workspace-relative file path.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Workspace-relative file path." },
                            "content": { "type": "string", "description": "File content to write." },
                            "append": { "type": "boolean", "description": "Append instead of overwrite when true." }
                        },
                        "required": ["path", "content"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "edit",
                name: "Edit (Compat)",
                description: "Demo-compat alias for text replacement and line-range edits.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "edit",
                tool: json!({
                    "name": "edit",
                    "description": "Edit a file by old/new text replacement or by line range.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Workspace-relative file path." },
                            "oldText": { "type": "string", "description": "Text to find." },
                            "newText": { "type": "string", "description": "Replacement text." },
                            "replaceAll": { "type": "boolean", "description": "Replace all matches when true." },
                            "from": { "type": "number", "description": "Start line for range replace." },
                            "to": { "type": "number", "description": "End line for range replace." }
                        },
                        "required": ["path"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "apply-patch",
                name: "Apply Patch (Compat)",
                description: "Demo-compat alias for unified diff patch application.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "apply_patch",
                tool: json!({
                    "name": "apply_patch",
                    "description": "Apply patch text in *** Begin Patch format.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "input": { "type": "string", "description": "Patch input in Begin/End Patch format." }
                        },
                        "required": ["input"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "exec",
                name: "Exec (Compat)",
                description: "Demo-compat alias for shell command execution.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "exec",
                tool: json!({
                    "name": "exec",
                    "description": "Alias of shell_execute for demo tool compatibility.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": { "type": "string", "description": "Shell command to execute." }
                        },
                        "required": ["command"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "process",
                name: "Process (Compat)",
                description: "Demo-compat alias for process_manager.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "process",
                tool: json!({
                    "name": "process",
                    "description": "Alias of process_manager for demo tool compatibility.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": { "type": "string", "description": "Process action (start, poll, log, write, kill, list)." },
                            "command": { "type": "string", "description": "Command to run for action=start." },
                            "id": { "type": "string", "description": "Managed process id for poll/log/write/kill." },
                            "text": { "type": "string", "description": "Input text for action=write." }
                        },
                        "required": ["action"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "memory-search",
                name: "Memory Search (Compat)",
                description: "Search MEMORY.md and memory/*.md snippets.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "memory_search",
                tool: json!({
                    "name": "memory_search",
                    "description": "Search memory markdown files by semantic token matching.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "Search query text." },
                            "maxResults": { "type": "number", "description": "Maximum number of hits." },
                            "minScore": { "type": "number", "description": "Minimum score between 0 and 1." }
                        },
                        "required": ["query"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "memory-get",
                name: "Memory Get (Compat)",
                description: "Read line ranges from MEMORY.md and memory/*.md.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "memory_get",
                tool: json!({
                    "name": "memory_get",
                    "description": "Read a snippet from memory markdown files.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Path to MEMORY.md or memory/*.md." },
                            "from": { "type": "number", "description": "Start line (1-based)." },
                            "lines": { "type": "number", "description": "Line count to read." }
                        },
                        "required": ["path"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "agents-list",
                name: "Agents List (Compat)",
                description: "List available agents for session targeting.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "agents_list",
                tool: json!({
                    "name": "agents_list",
                    "description": "List known agents.",
                    "parameters": { "type": "object", "properties": {} }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "sessions-list",
                name: "Sessions List (Compat)",
                description: "List sessions visible in BetaClaw integrated mode.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "sessions_list",
                tool: json!({
                    "name": "sessions_list",
                    "description": "List sessions with optional limit.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "limit": { "type": "number", "description": "Maximum number of sessions." }
                        }
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "sessions-history",
                name: "Sessions History (Compat)",
                description: "Read message history for a session.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "sessions_history",
                tool: json!({
                    "name": "sessions_history",
                    "description": "Read conversation history from a session id.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "sessionId": { "type": "string", "description": "Session id/key." }
                        },
                        "required": ["sessionId"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "sessions-send",
                name: "Sessions Send (Compat)",
                description: "Send a message to a target session.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "sessions_send",
                tool: json!({
                    "name": "sessions_send",
                    "description": "Send content to a session id/key.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "sessionId": { "type": "string", "description": "Target session id." },
                            "content": { "type": "string", "description": "Message content." }
                        },
                        "required": ["sessionId", "content"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "sessions-spawn",
                name: "Sessions Spawn (Compat)",
                description: "Create a new session and optionally dispatch a first task.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "sessions_spawn",
                tool: json!({
                    "name": "sessions_spawn",
                    "description": "Spawn/create a session with optional initial task.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "label": { "type": "string", "description": "Human-readable session label." },
                            "task": { "type": "string", "description": "Initial task/content to send." },
                            "channel": { "type": "string", "description": "Target channel (optional)." }
                        }
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "session-status",
                name: "Session Status (Compat)",
                description: "Resolve status for a session, optionally with history.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "session_status",
                tool: json!({
                    "name": "session_status",
                    "description": "Read session status by session id/key.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "sessionId": { "type": "string", "description": "Session id to inspect." },
                            "includeHistory": { "type": "boolean", "description": "Include message history." }
                        }
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "message",
                name: "Message (Compat)",
                description: "Demo-compat message send/read/delete tool wrapper.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "message",
                tool: json!({
                    "name": "message",
                    "description": "Send, read, or delete messages through integrated BetaClaw APIs.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": { "type": "string", "description": "Action: send, read, or delete." },
                            "to": { "type": "string", "description": "Target session key for send/read." },
                            "sessionKey": { "type": "string", "description": "Session key for send/read." },
                            "content": { "type": "string", "description": "Message content for send." },
                            "messageId": { "type": "string", "description": "Message id for delete." },
                            "conversationId": { "type": "string", "description": "Conversation id for delete." },
                            "limit": { "type": "number", "description": "History limit for read." }
                        },
                        "required": ["action"]
                    }
                }),
            },
            installed_by_default: false,
        },
        BuiltInSkillSeed {
            manifest: SkillManifest {
                id: "browser-tool",
                name: "Browser (Compat)",
                description: "Demo-compat browser tool wrapper for status and lightweight snapshot actions.",
                version: "1.0.0",
                category: "Compatibility",
                function_name: "browser",
                tool: json!({
                    "name": "browser",
                    "description": "Browser compatibility wrapper (status, snapshot/open, tabs, profiles).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": { "type": "string", "description": "Browser action." },
                            "url": { "type": "string", "description": "Target URL for open/snapshot." },
                            "targetUrl": { "type": "string", "description": "Alias target URL for open/snapshot." }
                        },
                        "required": ["action"]
                    }
                }),
            },
            installed_by_default: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_list_matches_the_typescript_order_and_defaults() {
        let seeds = built_in_skills();
        assert_eq!(seeds.len(), 34);
        let ids: Vec<&str> = seeds.iter().map(|seed| seed.manifest.id).collect();
        assert_eq!(&ids[..3], ["browser", "search", "python-runtime"]);
        assert_eq!(ids[33], "browser-tool");

        let installed: Vec<&str> = seeds
            .iter()
            .filter(|seed| seed.installed_by_default)
            .map(|seed| seed.manifest.id)
            .collect();
        assert_eq!(
            installed,
            [
                "browser",
                "search",
                "python-runtime",
                "shell-access",
                "playwright-cli",
                "process-manager",
                "subagents",
                "multi-tool-use-parallel",
                "vision",
                "filesystem",
                "web-fetch",
            ]
        );
    }

    #[test]
    fn tool_json_keeps_the_typescript_key_order() {
        let seeds = built_in_skills();
        let shell = seeds
            .iter()
            .find(|seed| seed.manifest.id == "shell-access")
            .expect("shell seeded");
        let text = serde_json::to_string(&shell.manifest.tool).expect("serialize");
        assert!(text.starts_with(r#"{"name":"shell_execute","description":"#));
        assert!(text.ends_with(r#""required":["command"]}}"#));
    }
}
