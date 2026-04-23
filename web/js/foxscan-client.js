const API_BASE_KEY = "foxscan_api_base_url";
const DEFAULT_API_BASE = "https://api.foxscan.fr";

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

export async function signInWithAppleToken(idToken) {
  return request("/auth/apple", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
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
