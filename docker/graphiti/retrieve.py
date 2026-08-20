"""OpenClaw patch for Graphiti search response provenance.

The upstream REST DTO drops the source and target entity UUIDs even though the
search layer already returns them. They are additive response fields and let
the PostgreSQL-backed evaluator distinguish a canonical entity match from a
mere lexical overlap.
"""

from datetime import datetime, timezone

from pydantic import BaseModel, Field

from graph_service.dto.common import Message


class SearchQuery(BaseModel):
    group_ids: list[str] | None = Field(None, description='The groups to search')
    query: str
    max_facts: int = Field(default=10, description='The maximum number of facts to retrieve')


class FactResult(BaseModel):
    uuid: str
    name: str
    fact: str
    valid_at: datetime | None
    invalid_at: datetime | None
    created_at: datetime
    expired_at: datetime | None
    source_node_uuid: str | None = None
    target_node_uuid: str | None = None

    class Config:
        json_encoders = {datetime: lambda value: value.astimezone(timezone.utc).isoformat()}


class SearchResults(BaseModel):
    facts: list[FactResult]


class GetMemoryRequest(BaseModel):
    group_id: str = Field(..., description='The group id of the memory to get')
    max_facts: int = Field(default=10, description='The maximum number of facts to retrieve')
    center_node_uuid: str | None = Field(None)
    messages: list[Message] = Field(..., description='Messages used to build the query')


class GetMemoryResponse(BaseModel):
    facts: list[FactResult] = Field(..., description='The facts returned by Graphiti')
