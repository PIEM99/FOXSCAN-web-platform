from fastapi import FastAPI

app = FastAPI(title="FOXSCAN API", version="0.1.0")


@app.get("/health")
def health():
    return {"ok": True, "service": "foxscan-api"}


@app.post("/inspections/sync")
def inspections_sync():
    return {"ok": True}


@app.post("/exports")
def exports():
    return {"ok": True}


@app.post("/audit-events")
def audit_events():
    return {"ok": True}

