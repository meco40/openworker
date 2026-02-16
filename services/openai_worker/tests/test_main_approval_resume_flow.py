from fastapi.testclient import TestClient

import app.main as main_module


def test_resume_endpoint_returns_resumed_run_payload() -> None:
    original_executor = main_module._runner._objective_executor
    main_module._runs.clear()
    main_module._approvals._requests.clear()
    main_module._runner._pending_runs.clear()

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
                "functionCalls": [{"name": "safe_shell", "args": {"command": "rm -rf /tmp/x"}}],
            }

        call_count["value"] += 1
        return {
            "text": "approval flow finished",
            "model": "gpt-4o-mini",
            "provider": "openai",
            "functionCalls": [],
        }

    main_module._runner._objective_executor = fake_executor

    try:
        client = TestClient(main_module.app)

        start_response = client.post(
            "/runs/start",
            json={
                "runId": "run-main-resume",
                "objective": "cleanup",
                "enabledTools": ["safe_shell"],
            },
        )
        assert start_response.status_code == 200
        start_payload = start_response.json()
        assert start_payload["status"] == "paused"
        token = str(start_payload["approval_token"])

        resume_response = client.post(
            f"/approvals/{token}/resume",
            json={"approved": True, "payload": {}},
        )
        assert resume_response.status_code == 200
        resume_payload = resume_response.json()

        assert resume_payload["status"] == "approved"
        assert resume_payload["runId"] == "run-main-resume"
        assert resume_payload["run"]["status"] == "completed"
        assert "approval flow finished" in resume_payload["run"]["output"]
    finally:
        main_module._runner._objective_executor = original_executor
        main_module._runs.clear()
        main_module._approvals._requests.clear()
        main_module._runner._pending_runs.clear()
