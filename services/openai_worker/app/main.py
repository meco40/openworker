from fastapi import FastAPI

app = FastAPI(title="OpenAI Worker Sidecar")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
