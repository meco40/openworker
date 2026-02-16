import html
import os
import re
from typing import Any

import httpx

TOOL_NAME = "safe_browser"
DEFAULT_TIMEOUT_SEC = 15.0
DEFAULT_EXCERPT_CHARS = 1200
DEFAULT_MAX_LINKS = 50

TITLE_PATTERN = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
HREF_PATTERN = re.compile(r"""href=["']([^"'#]+)["']""", re.IGNORECASE)
TAG_PATTERN = re.compile(r"<[^>]+>")


def _normalize_text(value: str) -> str:
    collapsed = re.sub(r"\s+", " ", value).strip()
    return html.unescape(collapsed)


class BrowserTool:
    name = TOOL_NAME

    def __init__(self, timeout_seconds: float | None = None) -> None:
        raw = timeout_seconds
        if raw is None:
            raw = float(os.getenv("OPENAI_WORKER_BROWSER_TIMEOUT_SEC", str(DEFAULT_TIMEOUT_SEC)))
        self._timeout_seconds = max(0.5, float(raw))

    @staticmethod
    def _require_url(action: str, url: str | None) -> str:
        cleaned = (url or "").strip()
        if not cleaned:
            raise ValueError(f"url is required for action: {action}")
        return cleaned

    def _fetch(self, url: str) -> tuple[int, str, str]:
        try:
            response = httpx.get(
                url,
                follow_redirects=True,
                timeout=self._timeout_seconds,
                headers={"User-Agent": "openai-worker-safe-browser/1.0"},
            )
        except httpx.InvalidURL as exc:
            raise ValueError(f"invalid browser url: {url}") from exc
        except Exception as exc:
            raise RuntimeError(f"browser request failed: {exc}") from exc
        return response.status_code, str(response.url), response.text

    @staticmethod
    def _extract_title(doc: str) -> str:
        match = TITLE_PATTERN.search(doc)
        if not match:
            return ""
        return _normalize_text(match.group(1))

    @staticmethod
    def _extract_text(doc: str, excerpt_chars: int) -> str:
        without_tags = TAG_PATTERN.sub(" ", doc)
        text = _normalize_text(without_tags)
        return text[:excerpt_chars]

    @staticmethod
    def _extract_links(doc: str, max_links: int) -> list[str]:
        found: list[str] = []
        for href in HREF_PATTERN.findall(doc):
            normalized = href.strip()
            if not normalized:
                continue
            if normalized in found:
                continue
            found.append(normalized)
            if len(found) >= max_links:
                break
        return found

    def execute(
        self,
        action: str,
        url: str | None = None,
        max_links: int | None = None,
    ) -> dict[str, Any]:
        cleaned = action.strip().lower()
        if not cleaned:
            raise ValueError("action is required")

        excerpt_chars = int(os.getenv("OPENAI_WORKER_BROWSER_EXCERPT_CHARS", str(DEFAULT_EXCERPT_CHARS)))
        max_links_value = max_links if isinstance(max_links, int) else DEFAULT_MAX_LINKS
        max_links_value = max(1, min(max_links_value, 200))

        if cleaned in {"fetch", "open", "extract_links", "extract_text", "snapshot"}:
            target_url = self._require_url(cleaned, url)
            status_code, final_url, body = self._fetch(target_url)
            title = self._extract_title(body)
            text_excerpt = self._extract_text(body, excerpt_chars)

            if cleaned == "extract_links":
                return {
                    "status": "ok",
                    "tool": self.name,
                    "action": cleaned,
                    "url": final_url,
                    "status_code": status_code,
                    "links": self._extract_links(body, max_links_value),
                }

            return {
                "status": "ok",
                "tool": self.name,
                "action": cleaned,
                "url": final_url,
                "status_code": status_code,
                "title": title,
                "text_excerpt": text_excerpt,
            }

        raise ValueError(f"unsupported browser action: {action}")
