from app.approval import ApprovalManager
from app.runner import Runner


def test_runner_executes_objective() -> None:
    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        assert run_id == "run-local"
        assert profile_id == "p1"
        assert messages[-1]["content"] == "write a summary"
        assert isinstance(tools, list)
        return {
            "text": "Agent output for: write a summary",
            "model": "gemini-2.5-flash",
            "provider": "gemini",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)

    result = runner.run("write a summary")

    assert result["status"] == "completed"
    assert "write a summary" in result["output"]
    assert result["engine"] == "model-hub-gateway"
    assert result["model"] == "gemini:gemini-2.5-flash"


def test_runner_returns_failed_status_when_sdk_executor_raises() -> None:
    def failing_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        raise RuntimeError("model hub unavailable")

    runner = Runner(objective_executor=failing_executor)
    result = runner.run("write a summary")

    assert result["status"] == "failed"
    assert "model hub unavailable" in result["output"]
    assert result["engine"] == "model-hub-gateway"


def test_runner_uses_preferred_model_id_when_provided() -> None:
    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        assert model == "gpt-4o-mini"
        assert profile_id == "team-a"
        return {
            "text": "ok",
            "model": model,
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run(
        "write a summary",
        preferred_model_id="gpt-4o-mini",
        model_hub_profile_id="team-a",
    )

    assert result["status"] == "completed"
    assert result["model"] == "openai:gpt-4o-mini"


def test_runner_uses_provided_messages_context() -> None:
    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        assert messages == [
            {"role": "system", "content": "You are precise."},
            {"role": "assistant", "content": "How can I help?"},
            {"role": "user", "content": "Find notes.md"},
        ]
        return {
            "text": "done",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run(
        "Find notes.md",
        messages=[
            {"role": "system", "content": "You are precise."},
            {"role": "assistant", "content": "How can I help?"},
            {"role": "user", "content": "Find notes.md"},
            {"role": "invalid", "content": "drop me"},
        ],
    )

    assert result["status"] == "completed"
    assert "done" in result["output"]


def test_runner_can_request_approval() -> None:
    approval = ApprovalManager()
    runner = Runner(approval_manager=approval)

    result = runner.run("delete prod db", require_approval=True)

    assert result["status"] == "paused"
    token = result["approval_token"]
    pending = approval.get(token)
    assert pending is not None
    assert pending.status == "pending"


def test_runner_disables_all_tools_when_allowlist_is_empty() -> None:
    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        assert tools == []
        return {
            "text": "ok",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run("write a summary", enabled_tools=[])

    assert result["status"] == "completed"
    assert result["enabledTools"] == []


def test_runner_filters_enabled_tools_by_allowlist() -> None:
    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        tool_names = [
            str((item.get("function") or {}).get("name"))
            for item in (tools or [])
            if isinstance(item, dict)
        ]
        assert tool_names == ["safe_browser"]
        return {
            "text": "ok",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run("write a summary", enabled_tools=["safe_browser"])

    assert result["status"] == "completed"
    assert result["enabledTools"] == ["safe_browser"]


def test_runner_prefers_browser_use_over_legacy_browser_tools() -> None:
    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        tool_names = [
            str((item.get("function") or {}).get("name"))
            for item in (tools or [])
            if isinstance(item, dict)
        ]
        assert tool_names == ["safe_browser_use"]
        return {
            "text": "ok",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run(
        "open browser task",
        enabled_tools=["safe_browser", "safe_computer_use", "safe_browser_use"],
    )

    assert result["status"] == "completed"
    assert result["enabledTools"] == ["safe_browser_use"]


def test_runner_executes_tool_calls_until_final_answer() -> None:
    calls = {"count": 0}

    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if calls["count"] == 0:
            calls["count"] += 1
            return {
                "text": "",
                "model": "gpt-4o-mini",
                "provider": "openai",
                "functionCalls": [{"name": "safe_shell", "args": {"command": "echo hello"}}],
            }

        calls["count"] += 1
        assert any(
            message["role"] == "assistant" and message["content"].startswith("TOOL_RESULT ")
            for message in messages
        )
        return {
            "text": "all done",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run("say hello", enabled_tools=["safe_shell"])

    assert result["status"] == "completed"
    assert "all done" in result["output"]
    assert calls["count"] == 2


def test_runner_pauses_and_resumes_for_risky_tool_calls() -> None:
    approval = ApprovalManager()
    calls = {"count": 0}

    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if calls["count"] == 0:
            calls["count"] += 1
            return {
                "text": "",
                "model": "gpt-4o-mini",
                "provider": "openai",
                "functionCalls": [{"name": "safe_shell", "args": {"command": "rm -rf /tmp/demo"}}],
            }

        calls["count"] += 1
        assert any(
            message["role"] == "assistant" and message["content"].startswith("TOOL_RESULT ")
            for message in messages
        )
        return {
            "text": "approved and completed",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(approval_manager=approval, objective_executor=fake_executor)

    paused = runner.run("cleanup", enabled_tools=["safe_shell"])
    assert paused["status"] == "paused"

    token = str(paused["approval_token"])
    pending = approval.get(token)
    assert pending is not None
    assert pending.status == "pending"

    approval.resume(token, approved=True)
    resumed = runner.resume(run_id="run-local", approved=True)

    assert resumed["status"] == "completed"
    assert "approved and completed" in resumed["output"]


def test_runner_pauses_and_resumes_for_risky_browser_use_calls() -> None:
    approval = ApprovalManager()
    calls = {"count": 0}

    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if calls["count"] == 0:
            calls["count"] += 1
            return {
                "text": "",
                "model": "gpt-4o-mini",
                "provider": "openai",
                "functionCalls": [
                    {"name": "safe_browser_use", "args": {"action": "run_task", "task": "Delete all files"}}
                ],
            }

        calls["count"] += 1
        assert any(
            message["role"] == "assistant" and message["content"].startswith("TOOL_RESULT ")
            for message in messages
        )
        return {
            "text": "approved browser-use task completed",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(approval_manager=approval, objective_executor=fake_executor)

    paused = runner.run("run risky browser task", enabled_tools=["safe_browser_use"])
    assert paused["status"] == "paused"

    token = str(paused["approval_token"])
    pending = approval.get(token)
    assert pending is not None
    assert pending.status == "pending"

    approval.resume(token, approved=True)
    resumed = runner.resume(run_id="run-local", approved=True)

    assert resumed["status"] == "completed"
    assert "approved browser-use task completed" in resumed["output"]


def test_runner_blocks_tool_call_when_policy_is_deny() -> None:
    calls = {"count": 0}

    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if calls["count"] == 0:
            calls["count"] += 1
            return {
                "text": "",
                "model": "gpt-4o-mini",
                "provider": "openai",
                "functionCalls": [{"name": "safe_shell", "args": {"command": "echo hi"}}],
            }

        calls["count"] += 1
        assert any(
            '"error": "tool call blocked by security policy (deny)"' in message["content"]
            for message in messages
            if message["role"] == "assistant" and message["content"].startswith("TOOL_RESULT ")
        )
        return {
            "text": "policy blocked the call",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run(
        "run command",
        enabled_tools=["safe_shell"],
        tool_approval_policy={
            "defaultMode": "ask_approve",
            "byFunctionName": {"safe_shell": "deny"},
        },
    )

    assert result["status"] == "completed"
    assert "policy blocked the call" in result["output"]


def test_runner_auto_approves_tool_call_when_policy_is_approve_always() -> None:
    calls = {"count": 0}

    def fake_executor(
        *,
        messages: list[dict[str, str]],
        run_id: str,
        model: str,
        profile_id: str,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if calls["count"] == 0:
            calls["count"] += 1
            return {
                "text": "",
                "model": "gpt-4o-mini",
                "provider": "openai",
                "functionCalls": [{"name": "safe_shell", "args": {"command": "echo hi"}}],
            }

        calls["count"] += 1
        assert any(
            '"tool": "safe_shell"' in message["content"] and '"command": "echo hi"' in message["content"]
            for message in messages
            if message["role"] == "assistant" and message["content"].startswith("TOOL_RESULT ")
        )
        return {
            "text": "auto-approved",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    runner = Runner(objective_executor=fake_executor)
    result = runner.run(
        "run command",
        enabled_tools=["safe_shell"],
        tool_approval_policy={
            "defaultMode": "ask_approve",
            "byFunctionName": {"safe_shell": "approve_always"},
        },
    )

    assert result["status"] == "completed"
    assert "auto-approved" in result["output"]
