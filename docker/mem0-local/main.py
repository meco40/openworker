import logging
import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from mem0 import Memory

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
load_dotenv()


POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "postgres")
POSTGRES_PORT = os.environ.get("POSTGRES_PORT", "5432")
POSTGRES_DB = os.environ.get("POSTGRES_DB", "postgres")
POSTGRES_USER = os.environ.get("POSTGRES_USER", "postgres")
POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "postgres")
POSTGRES_COLLECTION_NAME = os.environ.get("POSTGRES_COLLECTION_NAME", "mem0")
HISTORY_DB_PATH = os.environ.get("HISTORY_DB_PATH", "/app/history/history.db")

MEM0_API_KEY = os.environ.get("MEM0_API_KEY", "").strip()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MEM0_ALLOW_ADMIN_ENDPOINTS = os.environ.get("MEM0_ALLOW_ADMIN_ENDPOINTS", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

MEM0_LLM_PROVIDER = os.environ.get("MEM0_LLM_PROVIDER", "gemini").strip().lower()
MEM0_LLM_MODEL = os.environ.get("MEM0_LLM_MODEL", "gemini-2.0-flash").strip()
MEM0_EMBEDDER_PROVIDER = os.environ.get("MEM0_EMBEDDER_PROVIDER", "gemini").strip().lower()
MEM0_EMBEDDER_MODEL = os.environ.get("MEM0_EMBEDDER_MODEL", "gemini-embedding-001").strip()
MEM0_EMBEDDING_DIMS = int(os.environ.get("MEM0_EMBEDDING_DIMS", "768").strip())

if not MEM0_API_KEY:
    raise RuntimeError("MEM0_API_KEY is required.")


def _build_llm_config() -> Dict[str, Any]:
    if MEM0_LLM_PROVIDER != "gemini":
        raise RuntimeError("Only MEM0_LLM_PROVIDER=gemini is supported in this setup.")
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is required for MEM0_LLM_PROVIDER=gemini.")
    return {
        "provider": "gemini",
        "config": {
            "api_key": GEMINI_API_KEY,
            "temperature": 0.2,
            "model": MEM0_LLM_MODEL,
        },
    }


def _build_embedder_config() -> Dict[str, Any]:
    if MEM0_EMBEDDER_PROVIDER != "gemini":
        raise RuntimeError("Only MEM0_EMBEDDER_PROVIDER=gemini is supported in this setup.")
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is required for MEM0_EMBEDDER_PROVIDER=gemini.")
    return {
        "provider": "gemini",
        "config": {
            "api_key": GEMINI_API_KEY,
            "model": MEM0_EMBEDDER_MODEL,
        },
    }


DEFAULT_CONFIG = {
    "version": "v1.1",
    "vector_store": {
        "provider": "pgvector",
        "config": {
            "host": POSTGRES_HOST,
            "port": int(POSTGRES_PORT),
            "dbname": POSTGRES_DB,
            "user": POSTGRES_USER,
            "password": POSTGRES_PASSWORD,
            "collection_name": POSTGRES_COLLECTION_NAME,
            "embedding_model_dims": MEM0_EMBEDDING_DIMS,
        },
    },
    "llm": _build_llm_config(),
    "embedder": _build_embedder_config(),
    "history_db_path": HISTORY_DB_PATH,
}

MEMORY_INSTANCE = Memory.from_config(DEFAULT_CONFIG)

app = FastAPI(
    title="Mem0 REST APIs",
    description="A REST API for managing and searching memories for AI agents and apps.",
    version="1.0.0",
)


def require_api_key(authorization: Optional[str] = Header(default=None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token.")
    token = authorization.split(" ", 1)[1].strip()
    if token != MEM0_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid bearer token.")


def require_admin_endpoints_enabled() -> None:
    if not MEM0_ALLOW_ADMIN_ENDPOINTS:
        raise HTTPException(status_code=403, detail="Admin endpoints are disabled.")


class Message(BaseModel):
    role: str = Field(..., description="Role of the message (user or assistant).")
    content: str = Field(..., description="Message content.")


class MemoryCreate(BaseModel):
    messages: List[Message] = Field(..., description="List of messages to store.")
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    infer: Optional[bool] = None


class SearchRequest(BaseModel):
    query: str = Field(..., description="Search query.")
    user_id: Optional[str] = None
    run_id: Optional[str] = None
    agent_id: Optional[str] = None
    filters: Optional[Dict[str, Any]] = None


@app.post("/configure", summary="Configure Mem0")
def set_config(
    config: Dict[str, Any],
    _: None = Depends(require_api_key),
    __: None = Depends(require_admin_endpoints_enabled),
):
    global MEMORY_INSTANCE
    MEMORY_INSTANCE = Memory.from_config(config)
    return {"message": "Configuration set successfully"}


@app.post("/memories", summary="Create memories")
def add_memory(memory_create: MemoryCreate, _: None = Depends(require_api_key)):
    if not any([memory_create.user_id, memory_create.agent_id, memory_create.run_id]):
        raise HTTPException(status_code=400, detail="At least one identifier (user_id, agent_id, run_id) is required.")

    params = {k: v for k, v in memory_create.model_dump().items() if v is not None and k != "messages"}
    try:
        response = MEMORY_INSTANCE.add(messages=[m.model_dump() for m in memory_create.messages], **params)
        return JSONResponse(content=response)
    except Exception as e:
        logging.exception("Error in add_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories", summary="Get memories")
def get_all_memories(
    user_id: Optional[str] = None,
    run_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    _: None = Depends(require_api_key),
):
    if not any([user_id, run_id, agent_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    try:
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        return MEMORY_INSTANCE.get_all(**params)
    except Exception as e:
        logging.exception("Error in get_all_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories/{memory_id}", summary="Get a memory")
def get_memory(memory_id: str, _: None = Depends(require_api_key)):
    try:
        return MEMORY_INSTANCE.get(memory_id)
    except Exception as e:
        logging.exception("Error in get_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search", summary="Search memories")
def search_memories(search_req: SearchRequest, _: None = Depends(require_api_key)):
    try:
        params = {k: v for k, v in search_req.model_dump().items() if v is not None and k != "query"}
        return MEMORY_INSTANCE.search(query=search_req.query, **params)
    except Exception as e:
        logging.exception("Error in search_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/memories/{memory_id}", summary="Update a memory")
def update_memory(memory_id: str, updated_memory: Dict[str, Any], _: None = Depends(require_api_key)):
    try:
        text = updated_memory.get("text")
        if not isinstance(text, str) or not text.strip():
            text = updated_memory.get("data")
        if not isinstance(text, str) or not text.strip():
            raise HTTPException(status_code=400, detail="Update payload requires non-empty text/data.")

        # Prefer richer signature if supported by installed mem0 version.
        update_kwargs: Dict[str, Any] = {
            "memory_id": memory_id,
            "data": text.strip(),
        }
        if isinstance(updated_memory.get("user_id"), str) and updated_memory["user_id"].strip():
            update_kwargs["user_id"] = updated_memory["user_id"].strip()
        if isinstance(updated_memory.get("agent_id"), str) and updated_memory["agent_id"].strip():
            update_kwargs["agent_id"] = updated_memory["agent_id"].strip()
        if isinstance(updated_memory.get("metadata"), dict):
            update_kwargs["metadata"] = updated_memory["metadata"]

        try:
            return MEMORY_INSTANCE.update(**update_kwargs)
        except TypeError:
            return MEMORY_INSTANCE.update(memory_id=memory_id, data=text.strip())
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("Error in update_memory:")
        if isinstance(e, AttributeError) and "'dict' object has no attribute 'replace'" in str(e):
            raise HTTPException(status_code=400, detail="Invalid update payload format.")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories/{memory_id}/history", summary="Get memory history")
def memory_history(memory_id: str, _: None = Depends(require_api_key)):
    try:
        return MEMORY_INSTANCE.history(memory_id=memory_id)
    except Exception as e:
        logging.exception("Error in memory_history:")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories/{memory_id}", summary="Delete a memory")
def delete_memory(memory_id: str, _: None = Depends(require_api_key)):
    try:
        MEMORY_INSTANCE.delete(memory_id=memory_id)
        return {"message": "Memory deleted successfully"}
    except Exception as e:
        logging.exception("Error in delete_memory:")
        if isinstance(e, AttributeError) and "'NoneType' object has no attribute 'payload'" in str(e):
            raise HTTPException(status_code=404, detail="Memory not found.")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories", summary="Delete all memories")
def delete_all_memories(
    user_id: Optional[str] = None,
    run_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    _: None = Depends(require_api_key),
):
    if not any([user_id, run_id, agent_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    try:
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        MEMORY_INSTANCE.delete_all(**params)
        return {"message": "All relevant memories deleted"}
    except Exception as e:
        logging.exception("Error in delete_all_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reset", summary="Reset all memories")
def reset_memory(
    _: None = Depends(require_api_key),
    __: None = Depends(require_admin_endpoints_enabled),
):
    try:
        MEMORY_INSTANCE.reset()
        return {"message": "All memories reset"}
    except Exception as e:
        logging.exception("Error in reset_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/", summary="Redirect to OpenAPI docs", include_in_schema=False)
def home():
    return RedirectResponse(url="/docs")
