// FOXSCAN — Proxy /ai/scans → PC ML (avec fallback mock)
// =======================================================
//
// Ce module ajoute les 4 routes /ai/scans* sur l'app Express :
//   POST /ai/scans                       upload scan complet
//   GET  /ai/scans/:id                   status polling
//   GET  /ai/scans/:id/output/:file      download outputs
//   POST /ai/scans/:id/cancel            annulation
//
// Mode MOCK (par défaut si FOXSCAN_ML_BACKEND_URL non configuré) :
//   - Stocke les uploads dans tmp/mock-scans/{scan_id}/
//   - Retourne 202 avec scan_id généré
//   - Simule un cycle queued → running → done en ~30 secondes
//   - Permet de valider le pipeline iPhone → Hostinger sans le PC
//
// Mode PROXY (FOXSCAN_ML_BACKEND_URL défini) :
//   - Forward vers le PC ML via Cloudflare Tunnel
//   - Ajoute X-Foxscan-Internal-Token + X-Foxscan-User-Id
//   - Stream pass-through pour gros uploads sans charger en RAM
//
// Auth : utilise `requireCurrentUser` (JWT Bearer) — passé en argument.
// Le proxy interne ajoute le token Hostinger ↔ PC en plus.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

// ============================================================================
// Config
// ============================================================================

function getConfig() {
  return {
    mlBackendUrl: (process.env.FOXSCAN_ML_BACKEND_URL || "").trim(),
    internalToken: (process.env.FOXSCAN_ML_INTERNAL_TOKEN || "").trim(),
    timeoutMs: parseInt(process.env.FOXSCAN_ML_TIMEOUT_MS || "600000", 10),
    mockStorageDir: path.join(__dirname, "..", "tmp", "mock-scans"),
  };
}

// ============================================================================
// Mock storage (utilisé si pas de PC ML configuré)
// ============================================================================

function ensureMockDir() {
  const { mockStorageDir } = getConfig();
  if (!fs.existsSync(mockStorageDir)) {
    fs.mkdirSync(mockStorageDir, { recursive: true });
  }
  return mockStorageDir;
}

function mockScanPath(scanId) {
  return path.join(ensureMockDir(), scanId);
}

function mockStateFile(scanId) {
  return path.join(mockScanPath(scanId), "_state.json");
}

function loadMockState(scanId) {
  try {
    const raw = fs.readFileSync(mockStateFile(scanId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveMockState(scanId, state) {
  const file = mockStateFile(scanId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
}

/// Génère un statut mock basé sur le temps écoulé depuis upload.
/// Cycle : queued (0-3s) → running (3-25s) → done (>= 25s).
function mockComputeStatus(scanId) {
  const state = loadMockState(scanId);
  if (!state) return null;
  const elapsed = (Date.now() - state.queuedAt) / 1000;
  if (state.cancelled) {
    return {
      scan_id: scanId,
      status: "cancelled",
      stage: null,
      progress: 0,
      estimated_seconds_remaining: null,
      queued_at: new Date(state.queuedAt).toISOString(),
      started_at: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      finished_at: new Date().toISOString(),
      outputs: null,
      error_message: "Cancelled by user",
    };
  }
  if (elapsed < 3) {
    return {
      scan_id: scanId,
      status: "queued",
      stage: "queued",
      progress: 0.05,
      estimated_seconds_remaining: 25,
      queued_at: new Date(state.queuedAt).toISOString(),
      started_at: null,
      finished_at: null,
      outputs: null,
      error_message: null,
    };
  }
  if (elapsed < 25) {
    const progress = Math.min(0.95, 0.05 + (elapsed - 3) / 22 * 0.9);
    const stages = ["vggt", "depth", "gsplat", "mesh", "defects"];
    const stageIdx = Math.min(stages.length - 1, Math.floor((elapsed - 3) / 4.4));
    return {
      scan_id: scanId,
      status: "running",
      stage: stages[stageIdx],
      progress,
      estimated_seconds_remaining: Math.max(1, Math.round(25 - elapsed)),
      queued_at: new Date(state.queuedAt).toISOString(),
      started_at: new Date(state.queuedAt + 3000).toISOString(),
      finished_at: null,
      outputs: null,
      error_message: null,
    };
  }
  // done
  return {
    scan_id: scanId,
    status: "done",
    stage: "done",
    progress: 1.0,
    estimated_seconds_remaining: 0,
    queued_at: new Date(state.queuedAt).toISOString(),
    started_at: new Date(state.queuedAt + 3000).toISOString(),
    finished_at: new Date(state.queuedAt + 25000).toISOString(),
    outputs: {
      edl_summary_json: `/ai/scans/${scanId}/output/edl_summary.json`,
      defects_json: `/ai/scans/${scanId}/output/defects.json`,
      furniture_json: `/ai/scans/${scanId}/output/furniture.json`,
      point_cloud: null,
      splat: null,
      mesh_usdz: null,
    },
    error_message: null,
  };
}

/// Génère un edl_summary.json mock avec quelques défauts factices.
function mockGenerateEdlSummary(scanId) {
  return {
    scan_id: scanId,
    generated_at: new Date().toISOString(),
    phase: 1,
    stats: {
      n_frames: 40,
      n_points_3d: 142000,
      n_gaussians: 38000,
      n_defects: 0,
      n_furniture_items: 0,
      state_score: 4.2,
    },
    defects: [],
    furniture: [],
    outputs: {},
    needs_review: true,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function generateScanId() {
  return "mock_" + crypto.randomBytes(8).toString("hex");
}

function logInfo(msg) {
  // eslint-disable-next-line no-console
  console.log(`[scansProxy] ${msg}`);
}

function logError(msg) {
  // eslint-disable-next-line no-console
  console.error(`[scansProxy] ${msg}`);
}

// ============================================================================
// Mock handlers
// ============================================================================

async function mockUpload(req, res) {
  const scanId = generateScanId();
  const state = {
    queuedAt: Date.now(),
    startedAt: null,
    userId: req._user?.id || "unknown",
    contentLength: parseInt(req.headers["content-length"] || "0", 10),
    contentType: req.headers["content-type"] || "",
    cancelled: false,
  };
  saveMockState(scanId, state);

  // On stocke un échantillon du multipart pour debug (max 2 Mo).
  // Permet à un dev de vérifier ce qui a été envoyé sans avoir le PC ML.
  const sampleFile = path.join(mockScanPath(scanId), "sample.bin");
  let bytesWritten = 0;
  const maxSample = 2 * 1024 * 1024;
  fs.mkdirSync(path.dirname(sampleFile), { recursive: true });
  const writeStream = fs.createWriteStream(sampleFile);

  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      if (bytesWritten < maxSample) {
        const remaining = maxSample - bytesWritten;
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        writeStream.write(slice);
        bytesWritten += slice.length;
      }
    });
    req.on("end", () => {
      writeStream.end();
      resolve();
    });
    req.on("error", (err) => {
      writeStream.end();
      reject(err);
    });
  });

  logInfo(
    `MOCK upload scan_id=${scanId} user=${state.userId} ` +
    `content-length=${state.contentLength} sample-written=${bytesWritten}`
  );

  res.status(202).json({
    scan_id: scanId,
    status: "queued",
  });
}

function mockGetStatus(req, res) {
  const { id } = req.params;
  const status = mockComputeStatus(id);
  if (!status) {
    return res.status(404).json({ ok: false, detail: "scan not found" });
  }
  res.json(status);
}

function mockGetOutput(req, res) {
  const { id, file } = req.params;
  const status = mockComputeStatus(id);
  if (!status) {
    return res.status(404).json({ ok: false, detail: "scan not found" });
  }
  if (status.status !== "done") {
    return res.status(409).json({ ok: false, detail: "scan not ready" });
  }
  if (file === "edl_summary.json") {
    res.json(mockGenerateEdlSummary(id));
    return;
  }
  if (file === "defects.json") {
    res.json([]);
    return;
  }
  if (file === "furniture.json") {
    res.json([]);
    return;
  }
  return res.status(404).json({ ok: false, detail: "output file not found in mock" });
}

function mockCancel(req, res) {
  const { id } = req.params;
  const state = loadMockState(id);
  if (!state) {
    return res.status(404).json({ ok: false, detail: "scan not found" });
  }
  state.cancelled = true;
  saveMockState(id, state);
  logInfo(`MOCK cancel scan_id=${id}`);
  res.json({ ok: true, scan_id: id, status: "cancelled" });
}

// ============================================================================
// Proxy handlers (forward to PC ML)
// ============================================================================

async function proxyUpload(req, res) {
  const { mlBackendUrl, internalToken, timeoutMs } = getConfig();
  const url = `${mlBackendUrl.replace(/\/$/, "")}/scans`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // V5.3 — On convertit le Node Readable en Web ReadableStream pour
    // compat fetch() natif Node 18+. Évite l'erreur "Body must be a
    // Web ReadableStream" sur certaines versions Node / undici.
    const webBody = Readable.toWeb(req);
    const upstreamRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": req.headers["content-type"] || "",
        "X-Foxscan-Internal-Token": internalToken,
        "X-Foxscan-User-Id": req._user?.id || "",
      },
      body: webBody,
      duplex: "half",
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await upstreamRes.text();
    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-length") return; // recalculé
      res.setHeader(k, v);
    });
    res.send(text);
  } catch (err) {
    clearTimeout(timer);
    logError(`proxy upload failed: ${err.message}`);
    if (err.name === "AbortError") {
      return res.status(504).json({ ok: false, detail: "Upload timeout (10 min)" });
    }
    return res.status(502).json({ ok: false, detail: `Backend unreachable: ${err.message}` });
  }
}

async function proxyGet(req, res, suffix) {
  const { mlBackendUrl, internalToken } = getConfig();
  const url = `${mlBackendUrl.replace(/\/$/, "")}${suffix}`;
  try {
    const upstreamRes = await fetch(url, {
      method: "GET",
      headers: {
        "X-Foxscan-Internal-Token": internalToken,
        "X-Foxscan-User-Id": req._user?.id || "",
        Accept: req.headers.accept || "*/*",
      },
    });
    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((v, k) => {
      if (k.toLowerCase() === "transfer-encoding") return;
      res.setHeader(k, v);
    });
    // Stream binary or JSON output to client
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    logError(`proxy get failed: ${err.message}`);
    return res.status(502).json({ ok: false, detail: `Backend unreachable: ${err.message}` });
  }
}

async function proxyCancel(req, res) {
  const { mlBackendUrl, internalToken } = getConfig();
  const url = `${mlBackendUrl.replace(/\/$/, "")}/scans/${req.params.id}/cancel`;
  try {
    const upstreamRes = await fetch(url, {
      method: "POST",
      headers: {
        "X-Foxscan-Internal-Token": internalToken,
        "X-Foxscan-User-Id": req._user?.id || "",
      },
    });
    const text = await upstreamRes.text();
    res.status(upstreamRes.status).send(text);
  } catch (err) {
    logError(`proxy cancel failed: ${err.message}`);
    return res.status(502).json({ ok: false, detail: `Backend unreachable: ${err.message}` });
  }
}

// ============================================================================
// Mount routes
// ============================================================================

/**
 * Monte les routes /ai/scans* sur l'app Express.
 * @param {express.Express} app - L'instance Express
 * @param {object} deps - { requireCurrentUser, requireActiveSubscription? }
 */
function mountScansRoutes(app, { requireCurrentUser, requireActiveSubscription }) {
  const middlewares = [requireCurrentUser];
  if (typeof requireActiveSubscription === "function") {
    middlewares.push(requireActiveSubscription);
  }

  // -------- POST /ai/scans --------
  app.post("/ai/scans", ...middlewares, async (req, res, next) => {
    try {
      const { mlBackendUrl, internalToken } = getConfig();
      if (mlBackendUrl && internalToken) {
        return await proxyUpload(req, res);
      }
      return await mockUpload(req, res);
    } catch (err) {
      return next(err);
    }
  });

  // -------- GET /ai/scans/:id --------
  app.get("/ai/scans/:id", ...middlewares, async (req, res, next) => {
    try {
      const { mlBackendUrl, internalToken } = getConfig();
      if (mlBackendUrl && internalToken) {
        return await proxyGet(req, res, `/scans/${req.params.id}`);
      }
      return mockGetStatus(req, res);
    } catch (err) {
      return next(err);
    }
  });

  // -------- GET /ai/scans/:id/output/:file --------
  app.get("/ai/scans/:id/output/:file", ...middlewares, async (req, res, next) => {
    try {
      const { mlBackendUrl, internalToken } = getConfig();
      if (mlBackendUrl && internalToken) {
        return await proxyGet(
          req, res,
          `/scans/${req.params.id}/output/${req.params.file}`
        );
      }
      return mockGetOutput(req, res);
    } catch (err) {
      return next(err);
    }
  });

  // -------- POST /ai/scans/:id/cancel --------
  app.post("/ai/scans/:id/cancel", ...middlewares, async (req, res, next) => {
    try {
      const { mlBackendUrl, internalToken } = getConfig();
      if (mlBackendUrl && internalToken) {
        return await proxyCancel(req, res);
      }
      return mockCancel(req, res);
    } catch (err) {
      return next(err);
    }
  });

  logInfo(
    "Routes /ai/scans* montées " +
    (getConfig().mlBackendUrl ? "(mode PROXY → PC ML)" : "(mode MOCK — pas de PC ML configuré)")
  );
}

module.exports = { mountScansRoutes };
