# BetaClaw patch of the pinned zepai/graphiti server module.
# Diff vs. upstream: `get_graphiti` applies `settings.max_tokens` to the LLM
# client (env `MAX_TOKENS`) so larger extraction payloads are not truncated.
# Mounted over /app/graph_service/zep_graphiti.py via docker-compose.graphiti.yml.
import logging
import json
import os
from json import JSONDecodeError
from datetime import datetime
from typing import Annotated

from fastapi import Depends, HTTPException
from graphiti_core import Graphiti  # type: ignore
from graphiti_core.edges import EntityEdge  # type: ignore
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig  # type: ignore
from graphiti_core.errors import EdgeNotFoundError, GroupsEdgesNotFoundError, NodeNotFoundError
from graphiti_core.llm_client import LLMClient, LLMConfig, OpenAIClient  # type: ignore
from graphiti_core.nodes import EntityNode, EpisodicNode  # type: ignore
from graphiti_core.utils.bulk_utils import add_nodes_and_edges_bulk  # type: ignore
from pydantic import BaseModel

from graph_service.config import ZepEnvDep
from graph_service.dto import FactResult

logger = logging.getLogger(__name__)


class OpenRouterEmbedder(OpenAIEmbedder):
    """OpenAI-compatible embedder with NVIDIA's required float encoding."""

    async def create(self, input_data):
        result = await self.client.embeddings.create(
            input=input_data,
            model=self.config.embedding_model,
            encoding_format='float',
        )
        return result.data[0].embedding[: self.config.embedding_dim]

    async def create_batch(self, input_data_list):
        # DashScope text-embedding-v4 rejects batches larger than 10 items
        # (400 InternalError.Algo.InvalidParameter), so chunk the batch.
        embeddings = []
        for i in range(0, len(input_data_list), 10):
            chunk = input_data_list[i : i + 10]
            result = await self.client.embeddings.create(
                input=chunk,
                model=self.config.embedding_model,
                encoding_format='float',
            )
            embeddings.extend(
                embedding.embedding[: self.config.embedding_dim] for embedding in result.data
            )
        return embeddings


def _decode_json_content(content: str) -> object:
    """Decode strict JSON while tolerating common model presentation wrappers."""
    value = content.strip()
    if value.startswith('```'):
        lines = value.splitlines()
        if lines and lines[0].strip().startswith('```'):
            lines = lines[1:]
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        value = '\n'.join(lines).strip()

    try:
        return json.loads(value)
    except JSONDecodeError:
        # Some providers prepend a short explanation despite JSON mode. Decode
        # the first complete object/array without changing its contents.
        decoder = json.JSONDecoder()
        for index, char in enumerate(value):
            if char not in '{[':
                continue
            try:
                parsed, _ = decoder.raw_decode(value[index:])
                return parsed
            except JSONDecodeError:
                continue
        raise


def _coerce_int(value: object) -> int | None:
    """Convert numeric JSON values while rejecting names/objects as indexes."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _normalize_entity_name(value: object) -> str:
    if not isinstance(value, str):
        return ''
    return ' '.join(value.strip().strip('"').split()).casefold()


def _entity_index_by_name(messages: object) -> dict[str, int]:
    """Read Graphiti's numbered ENTITIES prompt section for name-based edges."""
    if not isinstance(messages, list):
        return {}
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get('content')
        if not isinstance(content, str) or '<ENTITIES>' not in content:
            continue
        try:
            entity_json = content.split('<ENTITIES>', 1)[1].split('</ENTITIES>', 1)[0].strip()
            entities = json.loads(entity_json)
        except (JSONDecodeError, IndexError):
            continue
        if not isinstance(entities, list):
            continue
        result: dict[str, int] = {}
        for fallback_index, entity in enumerate(entities):
            if not isinstance(entity, dict):
                continue
            index = _coerce_int(entity.get('id'))
            if index is None:
                index = fallback_index
            name = _normalize_entity_name(entity.get('name'))
            if name:
                result[name] = index
        return result
    return {}


def _normalize_structured_payload(
    payload: object,
    response_model: type[BaseModel],
    messages: object = None,
    known_entity_indexes: dict[str, int] | None = None,
    known_entity_count: int | None = None,
) -> object:
    """Repair only known wrapper/key-shape drift from non-strict JSON providers."""
    model_name = response_model.__name__
    entity_indexes = known_entity_indexes or _entity_index_by_name(messages)

    # Some OpenCode responses wrap the actual object in an `answer` envelope.
    # Unwrap only when that value is itself an object; no content is changed.
    if isinstance(payload, dict) and isinstance(payload.get('answer'), dict):
        payload = payload['answer']

    # Graphiti creates dynamic models for node/edge attributes. Their schema
    # requires a summary even when the model has no summary to add. An empty
    # value preserves the existing summary instead of inventing one.
    if model_name.startswith('EntityAttributes_') and isinstance(payload, dict):
        payload = {'summary': '', **payload} if 'summary' not in payload else payload

    if model_name == 'ExtractedEntities':
        items = payload
        if isinstance(payload, dict):
            items = payload.get(
                'extracted_entities',
                payload.get('entities', payload.get('entity', payload if 'name' in payload else None)),
            )
            if items is None:
                # Nemotron may group entities under typed keys such as
                # ``speaker_entity`` instead of returning one list wrapper.
                if any(key in payload for key in ('name', 'entity', 'entity_name', 'entity_id')):
                    items = payload
                else:
                    items = [
                        value
                        for value in payload.values()
                        if isinstance(value, dict)
                        and any(
                            key in value for key in ('name', 'entity', 'entity_name', 'entity_id')
                        )
                    ]
            if isinstance(items, dict):
                items = [items]
        if isinstance(items, list):
            normalized = []
            for item in items:
                if isinstance(item, dict) and 'name' not in item and 'entity' in item:
                    item = {**item, 'name': item['entity']}
                if isinstance(item, dict) and 'name' not in item and 'entity_name' in item:
                    item = {**item, 'name': item['entity_name']}
                if isinstance(item, dict) and 'name' not in item and 'entity_id' in item:
                    item = {**item, 'name': item['entity_id']}
                normalized.append(item)
            return {'extracted_entities': normalized}

    if model_name == 'ExtractedEdges':
        items = payload
        if isinstance(payload, dict):
            items = payload.get(
                'edges',
                payload.get(
                    'relations',
                    payload.get(
                        'facts',
                        payload.get(
                            'extracted_facts',
                            payload.get(
                                'extracted_triples',
                                payload.get('fact_triples', payload.get('triples')),
                            ),
                        ),
                    ),
                ),
            )
            if items is None and (
                'source_entity_id' in payload
                or 'source' in payload
                or 'source_id' in payload
                or 'subject_id' in payload
                or 'object_id' in payload
                or 'subject' in payload
                or 'object' in payload
            ):
                items = [payload]
        if isinstance(items, dict):
            items = [items]
        if isinstance(items, list):
            normalized = []
            for item in items:
                if not isinstance(item, dict):
                    normalized.append(item)
                    continue
                source = item.get(
                    'source_entity_id',
                    item.get(
                        'source', item.get('source_id', item.get('subject_id', item.get('subject')))
                    ),
                )
                target = item.get(
                    'target_entity_id',
                    item.get(
                        'target', item.get('target_id', item.get('object_id', item.get('object')))
                    ),
                )
                if _coerce_int(source) is None and item.get('subject_name') is not None:
                    source = item['subject_name']
                if _coerce_int(target) is None and item.get('object_name') is not None:
                    target = item['object_name']
                source_index = _coerce_int(source)
                target_index = _coerce_int(target)
                uses_one_based_aliases = (
                    ('subject_id' in item or 'object_id' in item)
                    and source_index is not None
                    and target_index is not None
                    and source_index >= 1
                    and target_index >= 1
                )
                if source_index is None:
                    source_index = entity_indexes.get(_normalize_entity_name(source))
                if target_index is None:
                    target_index = entity_indexes.get(_normalize_entity_name(target))
                if uses_one_based_aliases:
                    # The alternate subject/object schema numbers the entities
                    # from 1, while graphiti_core indexes its entity list from 0.
                    source_index -= 1
                    target_index -= 1
                if source_index is not None and _normalize_entity_name(source):
                    entity_indexes.setdefault(_normalize_entity_name(source), source_index)
                # Some providers omit the ENTITIES section in the follow-up
                # prompt and return only subject/object names. Preserve their
                # edge instead of losing a semantically complete fact.
                if source_index is None and known_entity_count is None and _normalize_entity_name(source):
                    source_key = _normalize_entity_name(source)
                    source_index = entity_indexes.setdefault(source_key, len(entity_indexes))
                if target_index is None and known_entity_count is None and _normalize_entity_name(target):
                    target_key = _normalize_entity_name(target)
                    target_index = entity_indexes.setdefault(target_key, len(entity_indexes))
                if (
                    source_index is None
                    or target_index is None
                    or (
                        known_entity_count is not None
                        and (
                            source_index < 0
                            or target_index < 0
                            or source_index >= known_entity_count
                            or target_index >= known_entity_count
                        )
                    )
                ):
                    logger.warning(
                        'Dropping extracted edge outside the current entity list: %s (entity_count=%s)',
                        item,
                        known_entity_count,
                    )
                    continue
                relation = item.get(
                    'relation_type',
                    item.get('relation', item.get('predicate', item.get('name', 'RELATED_TO'))),
                )
                fact = item.get(
                    'fact',
                    item.get(
                        'fact_text', item.get('description', item.get('text', relation))
                    ),
                )
                normalized.append(
                    {
                        **item,
                        'relation_type': relation,
                        'source_entity_id': source_index,
                        'target_entity_id': target_index,
                        'fact': fact,
                    }
                )
            return {'edges': normalized}

    if model_name == 'EdgeDuplicate' and isinstance(payload, dict):
        duplicate_fact_id = _coerce_int(
            payload.get('duplicate_fact_id', payload.get('duplicate_idx', -1))
        )
        contradicted_facts = [
            fact_id
            for value in payload.get('contradicted_facts', [])
            if (fact_id := _coerce_int(value)) is not None
        ]
        return {
            **payload,
            'duplicate_fact_id': -1 if duplicate_fact_id is None else duplicate_fact_id,
            'contradicted_facts': contradicted_facts,
            'fact_type': payload.get('fact_type') or 'DEFAULT',
        }

    if model_name == 'NodeResolutions':
        items = payload
        if isinstance(payload, dict):
            items = payload.get('entity_resolutions', payload.get('resolutions', payload.get('duplicates')))
            if items is None and 'id' in payload and 'name' in payload:
                items = [payload]
        if isinstance(items, dict):
            items = [items]
        if isinstance(items, list):
            normalized = []
            for item in items:
                if isinstance(item, dict):
                    normalized.append(
                        {
                            **item,
                            'duplicate_idx': item.get('duplicate_idx', -1),
                            'additional_duplicates': item.get('additional_duplicates', []),
                        }
                    )
                else:
                    normalized.append(item)
            return {'entity_resolutions': normalized}

    return payload


class RobustOpenAIClient(OpenAIClient):
    """OpenAI client tolerant of presentation-only JSON drift from Graphiti models."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._entity_indexes: dict[str, int] = {}
        self._entity_count: int | None = None

    async def _create_structured_completion(
        self, model, messages, temperature, max_tokens, response_model
    ):
        # The provider advertises JSON mode but does not consistently honor
        # OpenAI's beta.parse schema. Fetch the normal message and validate it
        # locally after the narrow normalizer above.
        return await self.client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={'type': 'json_object'},
        )

    def _handle_structured_response(self, response, response_model, messages=None):
        content = response.choices[0].message.content or '{}'
        payload = _decode_json_content(content)
        normalized = _normalize_structured_payload(
            payload,
            response_model,
            messages,
            self._entity_indexes,
            self._entity_count,
        )
        result = response_model.model_validate(normalized).model_dump()
        if response_model.__name__ == 'ExtractedEntities':
            extracted_entities = result.get('extracted_entities', [])
            self._entity_count = len(extracted_entities)
            self._entity_indexes = {
                name: index
                for index, item in enumerate(extracted_entities)
                if (name := _normalize_entity_name(item.get('name')))
            }
        elif response_model.__name__ == 'ExtractedEdges':
            # Entity indexes are local to one extraction request. Keeping them
            # across episodes lets a later edge refer to a previous episode's
            # larger entity list and crash graphiti_core with IndexError.
            self._entity_indexes = {}
            self._entity_count = None
        return result

    async def _generate_response(
        self, messages, response_model=None, max_tokens=16384, model_size=None
    ):
        # Keep the upstream flow but pass the response model to the custom
        # handler, which is the only place where validation is relaxed.
        openai_messages = self._convert_messages_to_openai_format(messages)
        model = self._get_model_for_size(model_size) if model_size is not None else self.model
        if response_model:
            response = await self._create_structured_completion(
                model=model,
                messages=openai_messages,
                temperature=self.temperature,
                max_tokens=max_tokens or self.max_tokens,
                response_model=response_model,
            )
            return self._handle_structured_response(response, response_model, openai_messages)
        response = await self._create_completion(
            model=model,
            messages=openai_messages,
            temperature=self.temperature,
            max_tokens=max_tokens or self.max_tokens,
        )
        return self._handle_json_response(response)


class LocalQwenClient(RobustOpenAIClient):
    """OpenAI-compatible client with Ollama's Qwen thinking disabled.

    Ollama's OpenAI-compatible endpoint does not reliably translate
    ``reasoning_effort='none'`` into the native Qwen/Ollama ``think`` option.
    The nested ``options.think=false`` field is forwarded through the SDK's
    ``extra_body`` hook and prevents the structured Graphiti prompts from
    consuming the complete output budget with hidden reasoning.
    """

    async def generate_response(
        self, messages, response_model=None, max_tokens=None, model_size=None
    ):
        # graphiti_core hard-codes 16384 for edge extraction. That is safe for
        # hosted providers but makes a local Qwen worker spend minutes on
        # hidden/retry output. Keep the local path bounded while leaving the
        # external OpenAIClient path untouched.
        try:
            configured_limit = int(os.getenv('OLLAMA_GRAPHITI_MAX_TOKENS', '4096'))
        except ValueError:
            configured_limit = 4096
        local_limit = max(512, configured_limit)
        requested = self.max_tokens if max_tokens is None else max_tokens
        bounded = min(requested, local_limit)
        kwargs = {'response_model': response_model, 'max_tokens': bounded}
        if model_size is not None:
            kwargs['model_size'] = model_size
        return await super().generate_response(messages, **kwargs)

    async def _create_structured_completion(
        self, model, messages, temperature, max_tokens, response_model
    ):
        return await self.client.beta.chat.completions.parse(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_model,
            reasoning_effort='none',
            extra_body={'options': {'think': False}},
        )

    async def _create_completion(
        self, model, messages, temperature, max_tokens, response_model=None
    ):
        return await self.client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={'type': 'json_object'},
            reasoning_effort='none',
            extra_body={'options': {'think': False}},
        )


class ZepGraphiti(Graphiti):
    def __init__(
        self,
        uri: str,
        user: str,
        password: str,
        llm_client: LLMClient | None = None,
        embedder: OpenAIEmbedder | None = None,
    ):
        super().__init__(uri, user, password, llm_client, embedder)

    async def add_episode(self, **kwargs):
        """Create deterministic episodes before Graphiti's UUID lookup.

        The pinned graphiti_core release calls ``get_by_uuid`` whenever a UUID
        is supplied and raises when the episode is new. Seeding the node first
        preserves the public UUID contract, lets the normal extraction path
        run unchanged, and makes retries/rebuilds idempotent.
        """
        uuid = kwargs.get('uuid')
        if uuid:
            try:
                await EpisodicNode.get_by_uuid(self.driver, uuid)
            except NodeNotFoundError:
                episode = EpisodicNode(
                    uuid=uuid,
                    name=kwargs.get('name', ''),
                    group_id=kwargs.get('group_id', ''),
                    source=kwargs.get('source'),
                    source_description=kwargs.get('source_description', ''),
                    content=kwargs.get('episode_body', ''),
                    valid_at=kwargs.get('reference_time'),
                )
                await episode.save(self.driver)
        return await super().add_episode(**kwargs)

    async def save_entity_node(self, name: str, uuid: str, group_id: str, summary: str = ''):
        new_node = EntityNode(
            name=name,
            uuid=uuid,
            group_id=group_id,
            summary=summary,
        )
        await new_node.generate_name_embedding(self.embedder)
        await new_node.save(self.driver)
        return new_node

    async def save_entity_edge(
        self,
        *,
        uuid: str,
        group_id: str,
        source_node_uuid: str,
        target_node_uuid: str,
        name: str,
        fact: str,
        created_at: datetime,
        valid_at: datetime | None = None,
        invalid_at: datetime | None = None,
        attributes: dict[str, object] | None = None,
    ):
        """Persist a canonical structured edge without LLM extraction."""
        try:
            await EntityNode.get_by_uuid(self.driver, source_node_uuid)
            await EntityNode.get_by_uuid(self.driver, target_node_uuid)
        except NodeNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

        edge = EntityEdge(
            uuid=uuid,
            group_id=group_id,
            source_node_uuid=source_node_uuid,
            target_node_uuid=target_node_uuid,
            created_at=created_at,
            name=name,
            fact=fact,
            valid_at=valid_at,
            invalid_at=invalid_at,
            attributes=attributes or {},
        )
        await edge.generate_embedding(self.embedder)
        await add_nodes_and_edges_bulk(self.driver, [], [], [], [edge], self.embedder)
        return edge

    async def get_entity_edge(self, uuid: str):
        try:
            edge = await EntityEdge.get_by_uuid(self.driver, uuid)
            return edge
        except EdgeNotFoundError as e:
            raise HTTPException(status_code=404, detail=e.message) from e

    async def delete_group(self, group_id: str):
        try:
            edges = await EntityEdge.get_by_group_ids(self.driver, [group_id])
        except GroupsEdgesNotFoundError:
            logger.warning(f'No edges found for group {group_id}')
            edges = []

        nodes = await EntityNode.get_by_group_ids(self.driver, [group_id])

        episodes = await EpisodicNode.get_by_group_ids(self.driver, [group_id])

        for edge in edges:
            await edge.delete(self.driver)

        for node in nodes:
            await node.delete(self.driver)

        for episode in episodes:
            await episode.delete(self.driver)

    async def delete_entity_edge(self, uuid: str):
        try:
            edge = await EntityEdge.get_by_uuid(self.driver, uuid)
            await edge.delete(self.driver)
        except EdgeNotFoundError as e:
            raise HTTPException(status_code=404, detail=e.message) from e

    async def delete_episodic_node(self, uuid: str):
        try:
            episode = await EpisodicNode.get_by_uuid(self.driver, uuid)
            await episode.delete(self.driver)
        except NodeNotFoundError as e:
            raise HTTPException(status_code=404, detail=e.message) from e


async def get_graphiti(settings: ZepEnvDep):
    embedder = OpenRouterEmbedder(
        config=OpenAIEmbedderConfig(
            embedding_model=settings.embedding_model_name or 'text-embedding-3-small',
            embedding_dim=settings.embedding_dim,
            api_key=settings.embedding_api_key or settings.openai_api_key,
            base_url=settings.embedding_base_url or settings.openai_base_url,
        )
    )
    llm_client_class = (
        LocalQwenClient
        if settings.openai_base_url and '11434' in settings.openai_base_url
        else RobustOpenAIClient
    )
    llm_client = llm_client_class(
        config=LLMConfig(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            model=settings.model_name,
            max_tokens=settings.max_tokens,
            # Upstream defaults the small model to `gpt-4.1-nano`, which does
            # not exist on non-OpenAI providers and fails with 404.
            small_model=settings.small_model_name or settings.model_name,
        ),
        max_tokens=settings.max_tokens,
    )
    client = ZepGraphiti(
        uri=settings.neo4j_uri,
        user=settings.neo4j_user,
        password=settings.neo4j_password,
        llm_client=llm_client,
        embedder=embedder,
    )

    try:
        yield client
    finally:
        await client.close()


async def initialize_graphiti(settings: ZepEnvDep):
    client = ZepGraphiti(
        uri=settings.neo4j_uri,
        user=settings.neo4j_user,
        password=settings.neo4j_password,
    )
    await client.build_indices_and_constraints()


def get_fact_result_from_edge(edge: EntityEdge):
    return FactResult(
        uuid=edge.uuid,
        name=edge.name,
        fact=edge.fact,
        valid_at=edge.valid_at,
        invalid_at=edge.invalid_at,
        created_at=edge.created_at,
        expired_at=edge.expired_at,
        source_node_uuid=edge.source_node_uuid,
        target_node_uuid=edge.target_node_uuid,
    )


ZepGraphitiDep = Annotated[ZepGraphiti, Depends(get_graphiti)]
