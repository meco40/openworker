import copy
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

MEM0_LLM_PROVIDER = os.environ.get("MEM0_LLM_PROVIDER", "").strip().lower()
MEM0_LLM_MODEL = os.environ.get("MEM0_LLM_MODEL", "").strip()
MEM0_LLM_API_KEY = os.environ.get("MEM0_LLM_API_KEY", "").strip()
MEM0_LLM_BASE_URL = os.environ.get("MEM0_LLM_BASE_URL", "").strip()
MEM0_EMBEDDER_PROVIDER = os.environ.get("MEM0_EMBEDDER_PROVIDER", "").strip().lower()
MEM0_EMBEDDER_MODEL = os.environ.get("MEM0_EMBEDDER_MODEL", "").strip()
MEM0_EMBEDDER_API_KEY = os.environ.get("MEM0_EMBEDDER_API_KEY", "").strip()
MEM0_EMBEDDER_BASE_URL = os.environ.get("MEM0_EMBEDDER_BASE_URL", "").strip()

if not MEM0_API_KEY:
    raise RuntimeError("MEM0_API_KEY is required.")


def _parse_positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        parsed = int(raw)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


MEM0_EMBEDDING_DIMS = _parse_positive_int("MEM0_EMBEDDING_DIMS", 768)


BASE_CONFIG_TEMPLATE = {
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
    "history_db_path": HISTORY_DB_PATH,
}


def _is_component_ready(component: Any) -> bool:
    if not isinstance(component, dict):
        return False
    provider = str(component.get("provider", "")).strip()
    return bool(provider)


def _is_config_ready(config: Dict[str, Any]) -> bool:
    return _is_component_ready(config.get("llm")) and _is_component_ready(config.get("embedder"))


def _build_bootstrap_component(
    provider: str,
    model: str,
    explicit_api_key: str,
    base_url: str,
    *,
    include_temperature: bool,
) -> Optional[Dict[str, Any]]:
    if not provider or not model:
        return None

    api_key = explicit_api_key or (GEMINI_API_KEY if provider == "gemini" else "")
    config: Dict[str, Any] = {"model": model}
    if api_key:
        config["api_key"] = api_key
    if base_url:
        config["openai_base_url"] = base_url
    if include_temperature:
        config["temperature"] = 0.2

    return {"provider": provider, "config": config}


def _build_bootstrap_config() -> Dict[str, Any]:
    config = copy.deepcopy(BASE_CONFIG_TEMPLATE)
    llm = _build_bootstrap_component(
        MEM0_LLM_PROVIDER,
        MEM0_LLM_MODEL,
        MEM0_LLM_API_KEY,
        MEM0_LLM_BASE_URL,
        include_temperature=True,
    )
    embedder = _build_bootstrap_component(
        MEM0_EMBEDDER_PROVIDER,
        MEM0_EMBEDDER_MODEL,
        MEM0_EMBEDDER_API_KEY,
        MEM0_EMBEDDER_BASE_URL,
        include_temperature=False,
    )
    if llm is not None:
        config["llm"] = llm
    if embedder is not None:
        config["embedder"] = embedder
    return config


CURRENT_CONFIG = _build_bootstrap_config()
MEMORY_INSTANCE: Optional[Memory] = None
if _is_config_ready(CURRENT_CONFIG):
    try:
        MEMORY_INSTANCE = Memory.from_config(CURRENT_CONFIG)
    except Exception:
        MEMORY_INSTANCE = None
        logging.exception("Invalid bootstrap config. Starting Mem0 runtime as unconfigured.")
else:
    logging.warning("Mem0 runtime starts unconfigured. Waiting for Model Hub sync via admin endpoints.")

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


class LlmConfigUpdate(BaseModel):
    llm: Dict[str, Any] = Field(..., description="LLM configuration payload.")


class EmbedderConfigUpdate(BaseModel):
    embedder: Dict[str, Any] = Field(..., description="Embedder configuration payload.")
    embedding_model_dims: Optional[int] = Field(
        default=None,
        description="Optional vector dimension override for pgvector collection.",
    )


def _swap_memory_config(next_config: Dict[str, Any]) -> bool:
    global MEMORY_INSTANCE
    global CURRENT_CONFIG
    if _is_config_ready(next_config):
        MEMORY_INSTANCE = Memory.from_config(next_config)
    else:
        MEMORY_INSTANCE = None
    CURRENT_CONFIG = next_config
    return MEMORY_INSTANCE is not None


def _require_memory_instance() -> Memory:
    if MEMORY_INSTANCE is None:
        raise HTTPException(
            status_code=503,
            detail="Mem0 runtime is not configured. Set llm + embedder via Model Hub sync.",
        )
    return MEMORY_INSTANCE


@app.post("/configure", summary="Configure Mem0")
def set_config(
    config: Dict[str, Any],
    _: None = Depends(require_api_key),
    __: None = Depends(require_admin_endpoints_enabled),
):
    next_config = copy.deepcopy(BASE_CONFIG_TEMPLATE)
    if isinstance(config, dict):
        next_config.update(config)
    ready = _swap_memory_config(next_config)
    return {"message": "Configuration set successfully", "ready": ready}


@app.post("/configure/llm", summary="Update llm configuration")
def set_llm_config(
    payload: LlmConfigUpdate,
    _: None = Depends(require_api_key),
    __: None = Depends(require_admin_endpoints_enabled),
):
    if not isinstance(payload.llm, dict):
        raise HTTPException(status_code=400, detail="llm must be an object.")

    provider = str(payload.llm.get("provider", "")).strip()
    if not provider:
        raise HTTPException(status_code=400, detail="llm.provider is required.")

    config_obj = payload.llm.get("config")
    if config_obj is not None and not isinstance(config_obj, dict):
        raise HTTPException(status_code=400, detail="llm.config must be an object when provided.")

    next_config = copy.deepcopy(CURRENT_CONFIG)
    next_config["llm"] = {
        "provider": provider,
        "config": config_obj or {},
    }

    try:
        ready = _swap_memory_config(next_config)
    except Exception as e:
        logging.exception("Error in set_llm_config:")
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "message": "LLM configuration updated successfully",
        "llm_provider": provider,
        "ready": ready,
    }


@app.post("/configure/embedder", summary="Update embedder configuration")
def set_embedder_config(
    payload: EmbedderConfigUpdate,
    _: None = Depends(require_api_key),
    __: None = Depends(require_admin_endpoints_enabled),
):
    if not isinstance(payload.embedder, dict):
        raise HTTPException(status_code=400, detail="embedder must be an object.")

    provider = str(payload.embedder.get("provider", "")).strip()
    if not provider:
        raise HTTPException(status_code=400, detail="embedder.provider is required.")

    config_obj = payload.embedder.get("config")
    if config_obj is not None and not isinstance(config_obj, dict):
        raise HTTPException(status_code=400, detail="embedder.config must be an object when provided.")

    next_config = copy.deepcopy(CURRENT_CONFIG)
    next_config["embedder"] = {
        "provider": provider,
        "config": config_obj or {},
    }
    if payload.embedding_model_dims is not None:
        if payload.embedding_model_dims <= 0:
            raise HTTPException(status_code=400, detail="embedding_model_dims must be a positive integer.")
        vector_store = next_config.setdefault("vector_store", {})
        vector_store_config = vector_store.setdefault("config", {})
        vector_store_config["embedding_model_dims"] = int(payload.embedding_model_dims)

    try:
        ready = _swap_memory_config(next_config)
    except Exception as e:
        logging.exception("Error in set_embedder_config:")
        raise HTTPException(status_code=500, detail=str(e))

    current_dims = (
        next_config.get("vector_store", {}).get("config", {}).get("embedding_model_dims", None)
    )
    return {
        "message": "Embedder configuration updated successfully",
        "embedder_provider": provider,
        "embedding_model_dims": current_dims,
        "ready": ready,
    }


@app.post("/memories", summary="Create memories")
def add_memory(memory_create: MemoryCreate, _: None = Depends(require_api_key)):
    if not any([memory_create.user_id, memory_create.agent_id, memory_create.run_id]):
        raise HTTPException(status_code=400, detail="At least one identifier (user_id, agent_id, run_id) is required.")

    params = {k: v for k, v in memory_create.model_dump().items() if v is not None and k != "messages"}
    try:
        memory = _require_memory_instance()
        response = memory.add(messages=[m.model_dump() for m in memory_create.messages], **params)
        return JSONResponse(content=response)
    except HTTPException:
        raise
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
        memory = _require_memory_instance()
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        return memory.get_all(**params)
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("Error in get_all_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories/{memory_id}", summary="Get a memory")
def get_memory(memory_id: str, _: None = Depends(require_api_key)):
    try:
        memory = _require_memory_instance()
        return memory.get(memory_id)
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("Error in get_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search", summary="Search memories")
def search_memories(search_req: SearchRequest, _: None = Depends(require_api_key)):
    try:
        memory = _require_memory_instance()
        params = {k: v for k, v in search_req.model_dump().items() if v is not None and k != "query"}
        return memory.search(query=search_req.query, **params)
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("Error in search_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/memories/{memory_id}", summary="Update a memory")
def update_memory(memory_id: str, updated_memory: Dict[str, Any], _: None = Depends(require_api_key)):
    try:
        memory = _require_memory_instance()
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
            return memory.update(**update_kwargs)
        except TypeError:
            return memory.update(memory_id=memory_id, data=text.strip())
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
        memory = _require_memory_instance()
        return memory.history(memory_id=memory_id)
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("Error in memory_history:")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories/{memory_id}", summary="Delete a memory")
def delete_memory(memory_id: str, _: None = Depends(require_api_key)):
    try:
        memory = _require_memory_instance()
        memory.delete(memory_id=memory_id)
        return {"message": "Memory deleted successfully"}
    except HTTPException:
        raise
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
        memory = _require_memory_instance()
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        memory.delete_all(**params)
        return {"message": "All relevant memories deleted"}
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("Error in delete_all_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reset", summary="Reset all memories")
def reset_memory(
    _: None = Depends(require_api_key),
    __: None = Depends(require_admin_endpoints_enabled),
):
    try:
        memory = _require_memory_instance()
        memory.reset()
        return {"message": "All memories reset"}
    except HTTPException:
        raise
    except Exception as e:
        logging.exception("Error in reset_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/", summary="Redirect to OpenAPI docs", include_in_schema=False)
def home():
    return RedirectResponse(url="/docs")
