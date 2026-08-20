# OpenClaw patch of the pinned zepai/graphiti server ingest router.
# Diff vs. upstream, two fixes:
# 1. `AsyncWorker` ran a single worker task, so every queued episode (across
#    every group/scope) was processed one at a time. This patch spawns
#    `settings.queue_workers` worker tasks (env `QUEUE_WORKERS`, default 4)
#    pulling from the same queue, so independent groups/episodes are
#    extracted concurrently instead of a full rebuild serializing behind one
#    worker. Episodes belonging to the same group can now interleave across
#    workers; Graphiti is a derived, rebuildable shadow projection here
#    (PostgreSQL remains the system of record), so this trade-off is
#    acceptable for the throughput it buys.
# 2. The upstream worker loop had no exception handling around `await job()`.
#    A single failed episode (LLM output-length overflow, an OpenRouter 402
#    credit rejection, etc.) propagated out of the loop and silently killed
#    that worker task forever; the queue then accepted new items but nothing
#    ever drained them again. Job failures are now caught and logged so one
#    bad episode does not stop the rest of the rebuild.
# Mounted over /app/graph_service/routers/ingest.py via docker-compose.graphiti.yml.
import asyncio
from contextlib import asynccontextmanager
from functools import partial

from fastapi import APIRouter, FastAPI, status
from graphiti_core.nodes import EpisodeType  # type: ignore
from graphiti_core.utils.maintenance.graph_data_operations import clear_data  # type: ignore

from graph_service.config import get_settings
from graph_service.dto import AddEntityNodeRequest, AddMessagesRequest, Message, Result
from graph_service.zep_graphiti import ZepGraphitiDep


class AsyncWorker:
    def __init__(self):
        self.queue = asyncio.Queue()
        self.tasks: list[asyncio.Task] = []
        self.active_jobs = 0
        self.completed_jobs = 0
        self.failed_jobs = 0

    async def worker(self):
        while True:
            try:
                print(f'Got a job: (size of remaining queue: {self.queue.qsize()})')
                job = await self.queue.get()
            except asyncio.CancelledError:
                break
            self.active_jobs += 1
            try:
                await job()
                self.completed_jobs += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - one bad episode must not kill the worker
                self.failed_jobs += 1
                print(f'Job failed, skipping episode and continuing: {exc}')
            finally:
                self.active_jobs -= 1
                self.queue.task_done()

    async def start(self):
        num_workers = max(1, get_settings().queue_workers)
        self.tasks = [asyncio.create_task(self.worker()) for _ in range(num_workers)]

    async def stop(self):
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            await task
        self.tasks = []
        while not self.queue.empty():
            self.queue.get_nowait()


async_worker = AsyncWorker()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await async_worker.start()
    yield
    await async_worker.stop()


router = APIRouter(lifespan=lifespan)


@router.get('/queue-status')
async def queue_status():
    return {
        'pending_jobs': async_worker.queue.qsize(),
        'active_jobs': async_worker.active_jobs,
        'completed_jobs': async_worker.completed_jobs,
        'failed_jobs': async_worker.failed_jobs,
        'workers': len(async_worker.tasks),
    }


@router.post('/messages', status_code=status.HTTP_202_ACCEPTED)
async def add_messages(
    request: AddMessagesRequest,
    graphiti: ZepGraphitiDep,
):
    async def add_messages_task(m: Message):
        await graphiti.add_episode(
            uuid=m.uuid,
            group_id=request.group_id,
            name=m.name,
            episode_body=f'{m.role or ""}({m.role_type}): {m.content}',
            reference_time=m.timestamp,
            source=EpisodeType.message,
            source_description=m.source_description,
        )

    for m in request.messages:
        await async_worker.queue.put(partial(add_messages_task, m))

    return Result(message='Messages added to processing queue', success=True)


@router.post('/entity-node', status_code=status.HTTP_201_CREATED)
async def add_entity_node(
    request: AddEntityNodeRequest,
    graphiti: ZepGraphitiDep,
):
    node = await graphiti.save_entity_node(
        uuid=request.uuid,
        group_id=request.group_id,
        name=request.name,
        summary=request.summary,
    )
    return node


@router.delete('/entity-edge/{uuid}', status_code=status.HTTP_200_OK)
async def delete_entity_edge(uuid: str, graphiti: ZepGraphitiDep):
    await graphiti.delete_entity_edge(uuid)
    return Result(message='Entity Edge deleted', success=True)


@router.delete('/group/{group_id}', status_code=status.HTTP_200_OK)
async def delete_group(group_id: str, graphiti: ZepGraphitiDep):
    await graphiti.delete_group(group_id)
    return Result(message='Group deleted', success=True)


@router.delete('/episode/{uuid}', status_code=status.HTTP_200_OK)
async def delete_episode(uuid: str, graphiti: ZepGraphitiDep):
    await graphiti.delete_episodic_node(uuid)
    return Result(message='Episode deleted', success=True)


@router.post('/clear', status_code=status.HTTP_200_OK)
async def clear(
    graphiti: ZepGraphitiDep,
):
    await clear_data(graphiti.driver)
    await graphiti.build_indices_and_constraints()
    return Result(message='Graph cleared', success=True)
