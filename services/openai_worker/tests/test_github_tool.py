import httpx
import pytest

from app.tools.github_tool import GitHubTool


def test_github_tool_lists_issues_via_api(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_request(method: str, url: str, **kwargs: object) -> httpx.Response:
        captured["method"] = method
        captured["url"] = url
        captured["params"] = kwargs.get("params")
        request = httpx.Request(method=method, url=url)
        return httpx.Response(
            200,
            request=request,
            json=[{"number": 7, "title": "Add worker tests"}],
        )

    monkeypatch.setattr(httpx, "request", fake_request)

    tool = GitHubTool(token="ghp_test")
    result = tool.execute(action="list_issues", owner="openclaw", repo="clawtest", state="open")

    assert result["status"] == "ok"
    assert result["tool"] == "safe_github"
    assert result["action"] == "list_issues"
    assert result["items"] == [{"number": 7, "title": "Add worker tests"}]
    assert captured["method"] == "GET"
    assert str(captured["url"]).endswith("/repos/openclaw/clawtest/issues")
    assert captured["params"] == {"state": "open", "per_page": 20, "page": 1}


def test_github_tool_requires_token_for_mutating_actions() -> None:
    tool = GitHubTool(token=None)

    with pytest.raises(PermissionError):
        tool.execute(
            action="create_issue",
            owner="openclaw",
            repo="clawtest",
            title="New issue",
            body="details",
        )


def test_github_tool_rejects_unsupported_action() -> None:
    tool = GitHubTool(token="ghp_test")

    with pytest.raises(ValueError):
        tool.execute(action="drop_database", owner="openclaw", repo="clawtest")
