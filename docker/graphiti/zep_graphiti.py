# OpenClaw patch of the pinned zepai/graphiti server module.
# Diff vs. upstream: `get_graphiti` applies `settings.max_tokens` to the LLM
# client (env `MAX_TOKENS`) so larger extraction payloads are not truncated.
# Mounted over /app/graph_service/zep_graphiti.py via docker-compose.graphiti.yml.
import logging
from typing import Annotated

from fastapi import Depends, HTTPException
from graphiti_core import Graphiti  # type: ignore
from graphiti_core.edges import EntityEdge  # type: ignore
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig  # type: ignore
from graphiti_core.errors import EdgeNotFoundError, GroupsEdgesNotFoundError, NodeNotFoundError
from graphiti_core.llm_client import LLMClient, LLMConfig, OpenAIClient  # type: ignore
from graphiti_core.nodes import EntityNode, EpisodicNode  # type: ignore

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


class LocalQwenClient(OpenAIClient):
    """OpenAI-compatible client with Ollama's Qwen thinking disabled."""

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
            api_key=settings.openai_api_key,
            base_url=settings.embedding_base_url or settings.openai_base_url,
        )
    )
    llm_client_class = (
        LocalQwenClient
        if settings.openai_base_url and '11434' in settings.openai_base_url
        else OpenAIClient
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
