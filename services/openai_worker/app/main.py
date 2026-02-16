from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.approval import ApprovalManager
from app.runner import Runner

app = FastAPI(title="OpenAI Worker Sidecar")

_approvals = ApprovalManager()
_runner = Runner(approval_manager=_approvals)
_runs: dict[str, dict[str, Any]] = {}


class RunStartRequest(BaseModel):
    runId: str = Field(..., min_length=1)
    objective: str = Field(..., min_length=1)
    requireApproval: bool = False
    personaId: str | None = None
    preferredModelId: str | None = None
    modelHubProfileId: str | None = None
    enabledTools: list[str] = Field(default_factory=list)


class ApprovalResumeRequest(BaseModel):
    approved: bool
    payload: dict[str, Any] = Field(default_factory=dict)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/runs/start")
def start_run(request: RunStartRequest) -> dict[str, Any]:
    if request.runId in _runs:
        raise HTTPException(status_code=409, detail="run already exists")

    result = _runner.run(
        request.objective,
        require_approval=request.requireApproval,
        run_id=request.runId,
        preferred_model_id=request.preferredModelId,
        model_hub_profile_id=request.modelHubProfileId,
        enabled_tools=request.enabledTools,
    )
    _runs[request.runId] = {
        "run_id": request.runId,
        "objective": request.objective,
        "status": result["status"],
        "result": result,
    }
    return {"runId": request.runId, **result}


@app.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict[str, str]:
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")

    run["status"] = "cancelled"
    run["result"] = {"status": "cancelled", "output": "cancelled by user"}
    return {"runId": run_id, "status": "cancelled"}


@app.post("/approvals/{token}/resume")
def resume_approval(token: str, request: ApprovalResumeRequest) -> dict[str, Any]:
    try:
        approval = _approvals.resume(
            token,
            approved=request.approved,
            payload=request.payload,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="approval token not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    response: dict[str, Any] = {
        "token": token,
        "status": approval.status,
        "runId": approval.run_id,
    }

    run = _runs.get(approval.run_id)
    if run is not None and run["status"] == "paused":
        resumed = _runner.resume(
            run_id=approval.run_id,
            approved=request.approved,
            payload=request.payload,
            objective=str(run.get("objective") or ""),
        )
        run["status"] = resumed["status"]
        run["result"] = resumed
        response["run"] = resumed

    return response
