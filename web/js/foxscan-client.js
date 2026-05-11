const API_BASE_KEY = "foxscan_api_base_url";
const DEFAULT_API_BASE = "https://foxscan.fr";

export const SESSION_KEYS = {
  auth: "foxscan_auth",
  token: "foxscan_token",
  refreshToken: "foxscan_refresh_token",
  name: "foxscan_name",
  email: "foxscan_email",
  userId: "foxscan_user_id",
  agencyId: "foxscan_agency_id",
  subscriptionActive: "foxscan_subscription_active",
};

export function getApiBaseUrl() {
  const qsBase = new URLSearchParams(window.location.search).get("api");
  if (qsBase) {
    localStorage.setItem(API_BASE_KEY, qsBase);
    return qsBase;
  }
  return localStorage.getItem(API_BASE_KEY) || DEFAULT_API_BASE;
}

export function setApiBaseUrl(url) {
  if (url) localStorage.setItem(API_BASE_KEY, url);
}

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getAuthHeaders(extraHeaders = {}) {
  const token = localStorage.getItem(SESSION_KEYS.token);
  const headers = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function rawRequest(path, options = {}) {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers: getAuthHeaders(options.headers || {}),
  });

  const bodyText = await response.text();
  const body = parseJsonSafe(bodyText);
  return { response, body };
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem(SESSION_KEYS.refreshToken);
  if (!refreshToken) return false;

  const { response, body } = await fetch(`${getApiBaseUrl()}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  }).then(async (res) => {
    const txt = await res.text();
    return { response: res, body: parseJsonSafe(txt) };
  });

  if (!response.ok || !body) {
    clearSession();
    return false;
  }

  persistSession(body);
  return true;
}

export async function request(path, options = {}, retryOn401 = true) {
  const { response, body } = await rawRequest(path, options);

  if (response.status === 401 && retryOn401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return request(path, options, false);
    }
  }

  if (!response.ok) {
    const message = (body && (body.message || body.detail)) || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = body;
    throw error;
  }

  return body;
}

export async function signInWithAppleToken(idToken, extra = {}) {
  return request("/auth/apple", {
    method: "POST",
    body: JSON.stringify({ idToken, ...extra }),
  }, false);
}

export async function signInWithGoogleToken(idToken, extra = {}) {
  return request("/auth/google", {
    method: "POST",
    body: JSON.stringify({ idToken, ...extra }),
  }, false);
}

export async function signInWithEmail(email, password) {
  return request("/auth/email/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }, false);
}

export async function registerWithEmail(email, password, displayName) {
  return request("/auth/email/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name: displayName }),
  }, false);
}

export async function dashboardSession() {
  return request("/dashboard/session", { method: "GET" });
}

export async function fetchProjects() {
  return request("/projects", { method: "GET" });
}

export async function fetchReports() {
  return request("/reports", { method: "GET" });
}

export async function fetchModels() {
  return request("/models", { method: "GET" });
}

export async function fetchExports() {
  return request("/exports", { method: "GET" });
}

export async function fetchProperties() {
  return request("/properties", { method: "GET" });
}

// Liste des fichiers contenus dans un export (utile pour les bundles JSON
// qui contiennent PDF, photos, USDZ embarqués en base64)
export async function fetchExportContents(exportID) {
  return request(`/exports/${encodeURIComponent(exportID)}/contents`, { method: "GET" });
}

// Construit une URL authentifiée vers un fichier extrait d'un bundle.
// Comme le navigateur ne peut pas envoyer de header Authorization sur un
// <iframe src="..."> ou <img src="...">, on récupère le blob via fetch
// et on génère un blob URL local.
export async function getExportFileBlobURL(exportID, fileIndex) {
  const token = localStorage.getItem(SESSION_KEYS.token);
  if (!token) throw new Error("Not authenticated");
  const url = `${getApiBaseUrl()}/exports/${encodeURIComponent(exportID)}/file/${encodeURIComponent(fileIndex)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return { blobUrl: URL.createObjectURL(blob), contentType: blob.type, size: blob.size };
}

// Génère et télécharge un PDF reconstruit côté serveur depuis les données
// du bundle (utile quand l'app iOS n'a pas embarqué de PDF).
export async function getGeneratedPDFBlobURL(exportID) {
  const token = localStorage.getItem(SESSION_KEYS.token);
  if (!token) throw new Error("Not authenticated");
  const url = `${getApiBaseUrl()}/exports/${encodeURIComponent(exportID)}/generated-pdf`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errBody.slice(0, 100)}`);
  }
  const blob = await response.blob();
  return { blobUrl: URL.createObjectURL(blob), contentType: "application/pdf", size: blob.size };
}

// ── Nouvelles routes /api/projects/* (extraction sur disque) ────────────────

// Liste tous les projets EXTRAITS de l'utilisateur (issus de bundles JSON
// uploadés et décortiqués sur disque). Différent de fetchProjects() qui
// utilise l'ancien endpoint /projects pour la sync iOS.
// V5 — accepte `includeArchived` pour masquer les projets archivés.
export async function fetchExtractedProjects({ includeArchived = true } = {}) {
  const qs = includeArchived ? "" : "?includeArchived=false";
  return request(`/api/projects${qs}`, { method: "GET" });
}

export async function fetchProjectFiles(projectID) {
  return request(`/api/projects/${encodeURIComponent(projectID)}/files`, { method: "GET" });
}

export async function fetchProjectMeta(projectID) {
  return request(`/api/projects/${encodeURIComponent(projectID)}`, { method: "GET" });
}

// V5 — Récupère le rapport d'EDL complet (inspectionReport.json) du projet.
// Contient les `comparisonItems`, `roomConditions`, `meters`, etc. — utilisé
// par les onglets « Comparatifs » et « Travaux » du dashboard.
export async function fetchProjectInspection(projectID) {
  return request(`/api/projects/${encodeURIComponent(projectID)}/inspection`, { method: "GET" });
}

// Récupère le PDF intelligent (natif si dispo, sinon généré côté serveur)
// pour un projet extrait. Retourne un blob URL utilisable dans <iframe>.
export async function getProjectPDFBlobURL(projectID) {
  const token = localStorage.getItem(SESSION_KEYS.token);
  if (!token) throw new Error("Not authenticated");
  const url = `${getApiBaseUrl()}/api/projects/${encodeURIComponent(projectID)}/report.pdf`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errBody.slice(0, 100)}`);
  }
  const blob = await response.blob();
  const source = response.headers.get("X-FOXSCAN-PDF-Source") || "unknown";
  return { blobUrl: URL.createObjectURL(blob), contentType: "application/pdf", size: blob.size, source };
}

// Sert un fichier individuel d'un projet extrait (ex: photo, USDZ, plan).
export async function getProjectFileBlobURL(projectID, filePath) {
  const token = localStorage.getItem(SESSION_KEYS.token);
  if (!token) throw new Error("Not authenticated");
  const url = `${getApiBaseUrl()}/api/projects/${encodeURIComponent(projectID)}/files/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return { blobUrl: URL.createObjectURL(blob), contentType: blob.type, size: blob.size };
}

export async function deleteExport(exportID) {
  return request(`/exports/${encodeURIComponent(exportID)}`, { method: "DELETE" });
}

// ── BROUILLONS (drafts) ──────────────────────────────────────────────────
// Un brouillon créé sur le dashboard web est ouvrable dans l'app iOS via
// deep link `foxscan://draft/<id>` (le handler iOS pré-remplit le formulaire
// EDL avec les infos du brouillon).
export async function fetchDrafts() {
  return request("/drafts", { method: "GET" });
}
export async function fetchDraft(draftID) {
  return request(`/drafts/${encodeURIComponent(draftID)}`, { method: "GET" });
}
export async function createDraft(payload) {
  return request("/drafts", { method: "POST", body: JSON.stringify(payload) });
}
export async function updateDraft(draftID, payload) {
  return request(`/drafts/${encodeURIComponent(draftID)}`, { method: "PATCH", body: JSON.stringify(payload) });
}
export async function deleteDraft(draftID) {
  return request(`/drafts/${encodeURIComponent(draftID)}`, { method: "DELETE" });
}

// Télécharge un fichier d'export en utilisant le Bearer token (sans transit du serveur tiers).
// downloadPath ressemble à "/exports/files/usr_xxx/exp_xxx_filename.bin"
export async function downloadExportFile(downloadPath, suggestedName) {
  const token = localStorage.getItem(SESSION_KEYS.token);
  if (!token) throw new Error("Not authenticated");
  const url = `${getApiBaseUrl()}${downloadPath}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Download failed (${response.status}): ${text.slice(0, 120)}`);
  }
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = suggestedName || downloadPath.split("/").pop() || "export.bin";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export async function logoutApi() {
  const refreshToken = localStorage.getItem(SESSION_KEYS.refreshToken) || null;
  try {
    await request(
      "/auth/logout",
      {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      },
      false,
    );
  } catch {
    // No-op.
  }
}

export function persistSession(authPayload) {
  const accessToken = authPayload?.accessToken || authPayload?.token || "";
  const refreshToken = authPayload?.refreshToken || "";
  const user = authPayload?.user || {};

  if (accessToken) localStorage.setItem(SESSION_KEYS.token, accessToken);
  if (refreshToken) localStorage.setItem(SESSION_KEYS.refreshToken, refreshToken);
  if (user.id) localStorage.setItem(SESSION_KEYS.userId, user.id);
  if (user.name) localStorage.setItem(SESSION_KEYS.name, user.name);
  if (user.email) localStorage.setItem(SESSION_KEYS.email, user.email);
  if (user.agencyID) localStorage.setItem(SESSION_KEYS.agencyId, user.agencyID);
  if (typeof user.subscriptionActive === "boolean") {
    localStorage.setItem(SESSION_KEYS.subscriptionActive, user.subscriptionActive ? "1" : "0");
  }
  localStorage.setItem(SESSION_KEYS.auth, "1");
}

export function clearSession() {
  Object.values(SESSION_KEYS).forEach((key) => localStorage.removeItem(key));
}

export function getSessionUser() {
  return {
    id: localStorage.getItem(SESSION_KEYS.userId) || "",
    name: localStorage.getItem(SESSION_KEYS.name) || "Utilisateur",
    email: localStorage.getItem(SESSION_KEYS.email) || "",
    agencyID: localStorage.getItem(SESSION_KEYS.agencyId) || "",
    subscriptionActive: localStorage.getItem(SESSION_KEYS.subscriptionActive) === "1",
    isAuthed: localStorage.getItem(SESSION_KEYS.auth) === "1",
  };
}
