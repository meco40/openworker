import json
import os
from typing import Any

import httpx


def _clean_message_list(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    cleaned: list[dict[str, str]] = []
    for message in messages:
        role = str(message.get("role") or "").strip().lower()
        content = str(message.get("content") or "")
        if role not in {"system", "user", "assistant"}:
            continue
        cleaned.append({"role": role, "content": content})
    return cleaned


def execute_with_modelhub_gateway(
    *,
    messages: list[dict[str, str]],
    run_id: str,
    model: str,
    profile_id: str = "p1",
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Execute a request through the ModelHub gateway."""
    gateway_url = os.getenv(
        "OPENAI_WORKER_MODELHUB_GATEWAY_URL",
        "http://127.0.0.1:3000/api/model-hub/gateway",
    ).strip()
    if not gateway_url:
        raise RuntimeError("OPENAI_WORKER_MODELHUB_GATEWAY_URL is empty")

    payload: dict[str, Any] = {
        "profileId": profile_id or "p1",
        "messages": _clean_message_list(messages),
        "max_tokens": 1200,
    }
    if model:
        payload["model"] = model
    if tools:
        payload["tools"] = tools

    try:
        response = httpx.post(gateway_url, json=payload, timeout=90)
    except Exception as exc:
        raise RuntimeError(f"ModelHub gateway request failed: {exc}") from exc

    if response.status_code >= 400:
        try:
            error_body = response.json()
            error_text = error_body.get("error") if isinstance(error_body, dict) else None
        except Exception:
            error_text = response.text
        raise RuntimeError(error_text or f"ModelHub gateway status {response.status_code}")

    body = response.json()
    if not isinstance(body, dict):
        raise RuntimeError("ModelHub gateway returned invalid JSON body")
    if not body.get("ok"):
        raise RuntimeError(str(body.get("error") or "ModelHub gateway dispatch failed"))

    text = str(body.get("text") or "")
    resolved_model = str(body.get("model") or model or "unknown").strip() or "unknown"
    provider = str(body.get("provider") or "unknown").strip() or "unknown"
    function_calls = body.get("functionCalls")
    if not isinstance(function_calls, list):
        function_calls = []

    return {
        "text": text,
        "model": resolved_model,
        "provider": provider,
        "functionCalls": function_calls,
        "runId": run_id,
    }
