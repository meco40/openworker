import os
from typing import Any

import httpx

TOOL_NAME = "safe_github"
DEFAULT_TIMEOUT_SEC = 20.0
BASE_URL = "https://api.github.com"
MUTATING_ACTIONS = {"create_issue"}
READ_ACTIONS = {
    "get_repo",
    "list_issues",
    "get_issue",
    "list_pull_requests",
    "get_pull_request",
    "list_commits",
    "search_repositories",
}
SUPPORTED_ACTIONS = READ_ACTIONS | MUTATING_ACTIONS


def _as_positive_int(value: Any, default_value: int, min_value: int = 1, max_value: int = 100) -> int:
    try:
        parsed = int(value)
    except Exception:
        return default_value
    return max(min_value, min(max_value, parsed))


class GitHubTool:
    name = TOOL_NAME

    def __init__(self, token: str | None = None, timeout_seconds: float | None = None) -> None:
        self._token = (token if token is not None else os.getenv("GITHUB_TOKEN", "")).strip()
        raw_timeout = timeout_seconds if timeout_seconds is not None else float(
            os.getenv("OPENAI_WORKER_GITHUB_TIMEOUT_SEC", str(DEFAULT_TIMEOUT_SEC))
        )
        self._timeout_seconds = max(1.0, float(raw_timeout))

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "openai-worker-safe-github/1.0",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = httpx.request(
            method,
            url,
            headers=self._headers(),
            params=params,
            json=json_payload,
            timeout=self._timeout_seconds,
        )
        if response.status_code >= 400:
            body = ""
            try:
                body = str(response.json())
            except Exception:
                body = response.text
            raise RuntimeError(f"github api error {response.status_code}: {body}")

        parsed: Any
        try:
            parsed = response.json()
        except Exception:
            parsed = {"raw": response.text}

        return {
            "status_code": response.status_code,
            "payload": parsed,
        }

    def _require_repo(self, owner: str, repo: str) -> tuple[str, str]:
        cleaned_owner = owner.strip()
        cleaned_repo = repo.strip()
        if not cleaned_owner or not cleaned_repo:
            raise ValueError("owner and repo are required")
        return cleaned_owner, cleaned_repo

    def execute(
        self,
        action: str,
        owner: str,
        repo: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        cleaned_action = action.strip().lower()
        if not cleaned_action:
            raise ValueError("action is required")
        if cleaned_action not in SUPPORTED_ACTIONS:
            raise ValueError(f"unsupported github action: {action}")

        if cleaned_action in MUTATING_ACTIONS and not self._token:
            raise PermissionError("github token is required for mutating actions")

        if cleaned_action == "search_repositories":
            query = str(kwargs.get("query") or "").strip() or f"{owner.strip()}/{repo.strip()}"
            response = self._request(
                "GET",
                f"{BASE_URL}/search/repositories",
                params={"q": query, "per_page": _as_positive_int(kwargs.get("per_page"), 10)},
            )
            payload = response["payload"]
            if not isinstance(payload, dict):
                payload = {}
            items = payload.get("items")
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned_action,
                "status_code": response["status_code"],
                "items": items if isinstance(items, list) else [],
            }

        cleaned_owner, cleaned_repo = self._require_repo(owner, repo)
        repo_base = f"{BASE_URL}/repos/{cleaned_owner}/{cleaned_repo}"

        if cleaned_action == "get_repo":
            response = self._request("GET", repo_base)
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned_action,
                "owner": cleaned_owner,
                "repo": cleaned_repo,
                "status_code": response["status_code"],
                "item": response["payload"],
            }

        if cleaned_action == "list_issues":
            params = {
                "state": str(kwargs.get("state") or "open"),
                "per_page": _as_positive_int(kwargs.get("per_page"), 20),
                "page": _as_positive_int(kwargs.get("page"), 1, min_value=1, max_value=10_000),
            }
            response = self._request("GET", f"{repo_base}/issues", params=params)
            payload = response["payload"]
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned_action,
                "owner": cleaned_owner,
                "repo": cleaned_repo,
                "status_code": response["status_code"],
                "items": payload if isinstance(payload, list) else [],
            }

        if cleaned_action == "get_issue":
            issue_number = _as_positive_int(kwargs.get("issue_number"), 0, min_value=1, max_value=10_000_000)
            if issue_number <= 0:
                raise ValueError("issue_number is required for get_issue")
            response = self._request("GET", f"{repo_base}/issues/{issue_number}")
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned_action,
                "owner": cleaned_owner,
                "repo": cleaned_repo,
                "status_code": response["status_code"],
                "item": response["payload"],
            }

        if cleaned_action == "list_pull_requests":
            params = {
                "state": str(kwargs.get("state") or "open"),
                "per_page": _as_positive_int(kwargs.get("per_page"), 20),
                "page": _as_positive_int(kwargs.get("page"), 1, min_value=1, max_value=10_000),
            }
            response = self._request("GET", f"{repo_base}/pulls", params=params)
            payload = response["payload"]
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned_action,
                "owner": cleaned_owner,
                "repo": cleaned_repo,
                "status_code": response["status_code"],
                "items": payload if isinstance(payload, list) else [],
            }

        if cleaned_action == "get_pull_request":
            pull_number = _as_positive_int(kwargs.get("pull_number"), 0, min_value=1, max_value=10_000_000)
            if pull_number <= 0:
                raise ValueError("pull_number is required for get_pull_request")
            response = self._request("GET", f"{repo_base}/pulls/{pull_number}")
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned_action,
                "owner": cleaned_owner,
                "repo": cleaned_repo,
                "status_code": response["status_code"],
                "item": response["payload"],
            }

        if cleaned_action == "list_commits":
            params = {
                "per_page": _as_positive_int(kwargs.get("per_page"), 20),
                "page": _as_positive_int(kwargs.get("page"), 1, min_value=1, max_value=10_000),
            }
            response = self._request("GET", f"{repo_base}/commits", params=params)
            payload = response["payload"]
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned_action,
                "owner": cleaned_owner,
                "repo": cleaned_repo,
                "status_code": response["status_code"],
                "items": payload if isinstance(payload, list) else [],
            }

        if cleaned_action == "create_issue":
            title = str(kwargs.get("title") or "").strip()
            body = str(kwargs.get("body") or "").strip()
            if not title:
                raise ValueError("title is required for create_issue")
            payload: dict[str, Any] = {"title": title}
            if body:
                payload["body"] = body
            labels = kwargs.get("labels")
            if isinstance(labels, list):
                payload["labels"] = [str(label) for label in labels if str(label).strip()]
            response = self._request("POST", f"{repo_base}/issues", json_payload=payload)
            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned_action,
                "owner": cleaned_owner,
                "repo": cleaned_repo,
                "status_code": response["status_code"],
                "item": response["payload"],
            }

        raise ValueError(f"unsupported github action: {action}")
