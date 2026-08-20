# OpenClaw patch of the pinned zepai/graphiti server config.
# Diff vs. upstream: adds the `max_tokens` setting (env `MAX_TOKENS`) so the
# LLM output budget can be raised for larger extraction payloads, and a
# `queue_workers` setting (env `QUEUE_WORKERS`) consumed by the patched
# ingest.py to process the message queue concurrently instead of serially.
# Also adds `small_model_name` (env `SMALL_MODEL_NAME`) so the small-model
# fallback (upstream default `gpt-4.1-nano`) can run on the configured
# OpenAI-compatible provider; empty/unset falls back to `model_name`.
# `queue_job_timeout_seconds` prevents one provider call from holding the
# rebuild queue indefinitely.
# Mounted over /app/graph_service/config.py via docker-compose.graphiti.yml.
from functools import lru_cache
from typing import Annotated

from fastapi import Depends
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict  # type: ignore


class Settings(BaseSettings):
    openai_api_key: str
    embedding_api_key: str | None = Field(None)
    openai_base_url: str | None = Field(None)
    embedding_base_url: str | None = Field(None)
    model_name: str | None = Field(None)
    small_model_name: str | None = Field(None)
    embedding_model_name: str | None = Field(None)
    embedding_dim: int = Field(2048, ge=1)
    neo4j_uri: str
    neo4j_user: str
    neo4j_password: str
    max_tokens: int = Field(16384, ge=1)
    queue_workers: int = Field(4, ge=1, le=16)
    queue_job_timeout_seconds: int = Field(300, ge=10, le=3600)

    model_config = SettingsConfigDict(env_file='.env', extra='ignore')


@lru_cache
def get_settings():
    return Settings()  # type: ignore[call-arg]


ZepEnvDep = Annotated[Settings, Depends(get_settings)]
