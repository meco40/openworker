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
def resume_approval(token: str, request: ApprovalResumeRequest) -> dict[str, str]:
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

    run = _runs.get(approval.run_id)
    if run is not None and run["status"] == "paused":
        if request.approved:
            resumed = _runner.run(
                run["objective"],
                require_approval=False,
                run_id=approval.run_id,
            )
            run["status"] = resumed["status"]
            run["result"] = resumed
        else:
            run["status"] = "failed"
            run["result"] = {
                "status": "failed",
                "output": "approval rejected",
            }

    return {"token": token, "status": approval.status, "runId": approval.run_id}
