const cors = require("cors");
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { jwtVerify, createRemoteJWKSet } = require("jose");

function readEnvFromDotenv(key) {
  const dotenvPath = path.join(__dirname, ".env");
  if (!fs.existsSync(dotenvPath)) return "";
  const lines = fs.readFileSync(dotenvPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sepIndex = trimmed.indexOf("=");
    if (sepIndex <= 0) continue;
    const k = trimmed.slice(0, sepIndex).trim();
    if (k !== key) continue;
    const value = trimmed.slice(sepIndex + 1).trim();
    return value.replace(/^['"]|['"]$/g, "");
  }
  return "";
}

// Charge toutes les variables du .env dans process.env (sans override)
// Hostinger Passenger ne le fait pas automatiquement.
function loadDotenvIntoProcess() {
  const dotenvPath = path.join(__dirname, ".env");
  if (!fs.existsSync(dotenvPath)) return;
  const lines = fs.readFileSync(dotenvPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sepIndex = trimmed.indexOf("=");
    if (sepIndex <= 0) continue;
    const key = trimmed.slice(0, sepIndex).trim();
    if (!key || process.env[key] !== undefined) continue;
    const value = trimmed.slice(sepIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
}
loadDotenvIntoProcess();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

// ── Static files (public_html) ────────────────────────────────────────────────
// Sur Hostinger, Passenger route toutes les requêtes vers ce Node → on sert
// nous-mêmes les fichiers statiques. On tente plusieurs chemins possibles
// car la racine FTP et la racine du domaine peuvent varier.
const staticCandidates = [
  process.env.FOXSCAN_STATIC_DIR,
  "/home/u630423897/domains/foxscan.fr/public_html",
  "/home/u630423897/public_html",
  path.resolve(__dirname, "..", "..", "public_html"),
  path.resolve(__dirname, "..", "public_html"),
].filter(Boolean);

const servedStaticRoots = [];
for (const dir of staticCandidates) {
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      app.use(express.static(dir, { extensions: ["html"], index: "index.html", fallthrough: true }));
      servedStaticRoots.push(dir);
    }
  } catch (_) { /* ignore */ }
}
console.log("[static] Serving from:", servedStaticRoots);

// Diagnostic: liste ce que le serveur voit sur le disque
app.get("/debug/files", (req, res) => {
  const report = {};
  for (const dir of staticCandidates) {
    try {
      report[dir] = fs.existsSync(dir)
        ? { exists: true, entries: fs.readdirSync(dir).slice(0, 50) }
        : { exists: false };
    } catch (e) {
      report[dir] = { error: String(e) };
    }
  }
  res.json({ cwd: process.cwd(), __dirname, served: servedStaticRoots, candidates: report });
});

const settings = {
  port: Number(process.env.PORT || 8000),
  dbPath: process.env.FOXSCAN_DB_PATH || path.join(__dirname, "data", "store.json"),
  jwtSecret: process.env.JWT_SECRET || "change-me",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || "change-me",
  openaiApiKey: process.env.OPENAI_API_KEY || readEnvFromDotenv("OPENAI_API_KEY") || "",
  accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS || 900),
  refreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS || 60 * 60 * 24 * 30),
  requireActiveSubscription:
    String(process.env.DASHBOARD_REQUIRE_ACTIVE_SUBSCRIPTION || "true").toLowerCase() === "true",
  defaultSubscriptionStatus: process.env.DEFAULT_SUBSCRIPTION_STATUS || "active",
};

function nowIso() {
  return new Date().toISOString();
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readStore() {
  ensureDir(path.dirname(settings.dbPath));
  if (!fs.existsSync(settings.dbPath)) {
    const empty = {
      users: [],
      refreshTokens: [],
      projects: [],
      reports: [],
      exports: [],
      auditEvents: [],
    };
    fs.writeFileSync(settings.dbPath, JSON.stringify(empty, null, 2));
    return empty;
  }

  const raw = fs.readFileSync(settings.dbPath, "utf-8");
  const parsed = JSON.parse(raw);
  return {
    users: parsed.users || [],
    refreshTokens: parsed.refreshTokens || [],
    projects: parsed.projects || [],
    reports: parsed.reports || [],
    exports: parsed.exports || [],
    auditEvents: parsed.auditEvents || [],
  };
}

function writeStore(store) {
  ensureDir(path.dirname(settings.dbPath));
  fs.writeFileSync(settings.dbPath, JSON.stringify(store, null, 2));
}

function base64UrlEncode(input) {
  const buff = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf-8");
  return buff
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input) {
  const padLen = (4 - (input.length % 4)) % 4;
  const padded = input + "=".repeat(padLen);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const sig = crypto.createHmac("sha256", secret).update(data).digest();
  return `${data}.${base64UrlEncode(sig)}`;
}

function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    const err = new Error("Malformed token");
    err.status = 401;
    throw err;
  }

  const [head, body, sig] = parts;
  const data = `${head}.${body}`;
  const expectedSig = base64UrlEncode(crypto.createHmac("sha256", secret).update(data).digest());

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    const err = new Error("Invalid token signature");
    err.status = 401;
    throw err;
  }

  const payload = JSON.parse(base64UrlDecode(body).toString("utf-8"));
  if (payload.exp && Number(payload.exp) < nowTs()) {
    const err = new Error("Token expired");
    err.status = 401;
    throw err;
  }

  return payload;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password, salt) {
  return crypto
    .createHash("sha256")
    .update(salt + password + (process.env.PASSWORD_PEPPER || "foxscan-pepper"))
    .digest("hex");
}

function findOrCreateUserFromEmail(store, { email, passwordHash, name }) {
  let user = store.users.find((u) => u.email === email && u.authProvider === "email") || null;
  const ts = nowIso();

  if (user) {
    return { user, created: false };
  }

  user = {
    id: `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    authProvider: "email",
    email,
    passwordHash,
    passwordSalt: crypto.randomBytes(16).toString("hex"),
    name: name || email.split("@")[0],
    agencyID: null,
    subscriptionStatus: settings.defaultSubscriptionStatus,
    createdAt: ts,
    updatedAt: ts,
  };

  store.users.push(user);
  return { user, created: true };
}

function decodeUnverifiedAppleClaims(idToken) {
  if (!idToken) return {};
  const parts = idToken.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(base64UrlDecode(parts[1]).toString("utf-8"));
  } catch {
    return {};
  }
}

// ── OAuth providers : vérification JWT via JWKS distants ─────────────────────
// Apple : https://appleid.apple.com/auth/keys
// Google : https://www.googleapis.com/oauth2/v3/certs
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function appleAudiences() {
  return [
    process.env.APPLE_WEB_CLIENT_ID, // ex: "fr.foxscan.web" (Services ID web)
    process.env.APPLE_BUNDLE_ID,     // ex: "PE.FOXSCAN" (Bundle ID iOS)
  ].filter(Boolean);
}

async function verifyAppleIdToken(idToken) {
  if (!idToken) {
    const err = new Error("idToken is required");
    err.status = 400;
    throw err;
  }
  const audiences = appleAudiences();
  if (audiences.length === 0) {
    const err = new Error("Apple Sign In not configured (APPLE_WEB_CLIENT_ID/APPLE_BUNDLE_ID)");
    err.status = 503;
    throw err;
  }
  try {
    const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: audiences,
    });
    return payload;
  } catch (e) {
    const err = new Error(`Invalid Apple ID token: ${e.code || e.message || "verification failed"}`);
    err.status = 401;
    throw err;
  }
}

async function verifyGoogleIdToken(idToken) {
  if (!idToken) {
    const err = new Error("idToken is required");
    err.status = 400;
    throw err;
  }
  const audience = process.env.GOOGLE_CLIENT_ID;
  if (!audience) {
    const err = new Error("Google Sign In not configured (GOOGLE_CLIENT_ID)");
    err.status = 503;
    throw err;
  }
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience,
    });
    return payload;
  } catch (e) {
    const err = new Error(`Invalid Google ID token: ${e.code || e.message || "verification failed"}`);
    err.status = 401;
    throw err;
  }
}

function findUserById(store, userID) {
  return store.users.find((u) => u.id === userID) || null;
}

function findOrCreateUserFromApple(store, { appleSub, email, name, agencyID, subscriptionActive }) {
  let user = store.users.find((u) => u.appleSub === appleSub) || null;
  const ts = nowIso();

  if (user) {
    user.email = email || user.email;
    user.name = name || user.name;
    user.agencyID = agencyID || user.agencyID || null;
    if (typeof subscriptionActive === "boolean") {
      user.subscriptionStatus = subscriptionActive ? "active" : "inactive";
    }
    user.updatedAt = ts;
    return user;
  }

  user = {
    id: `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    authProvider: "apple",
    appleSub,
    email: email || "",
    name: name || "Utilisateur FOXSCAN",
    agencyID: agencyID || null,
    subscriptionStatus:
      typeof subscriptionActive === "boolean"
        ? subscriptionActive
          ? "active"
          : "inactive"
        : settings.defaultSubscriptionStatus,
    createdAt: ts,
    updatedAt: ts,
  };

  store.users.push(user);
  return user;
}

function findOrCreateUserFromGoogle(store, { googleSub, email, name, picture, agencyID }) {
  // 1) Match d'abord par googleSub (identifiant stable Google)
  // 2) Fallback : match par email vérifié (pour fusionner un compte existant)
  let user =
    store.users.find((u) => u.googleSub === googleSub) ||
    (email ? store.users.find((u) => u.email === email && !u.googleSub) : null) ||
    null;

  const ts = nowIso();

  if (user) {
    user.googleSub = googleSub;
    user.email = email || user.email;
    user.name = name || user.name;
    user.picture = picture || user.picture;
    user.agencyID = agencyID || user.agencyID || null;
    user.updatedAt = ts;
    return user;
  }

  user = {
    id: `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    authProvider: "google",
    googleSub,
    email: email || "",
    name: name || (email ? email.split("@")[0] : "Utilisateur FOXSCAN"),
    picture: picture || null,
    agencyID: agencyID || null,
    subscriptionStatus: settings.defaultSubscriptionStatus,
    createdAt: ts,
    updatedAt: ts,
  };

  store.users.push(user);
  return user;
}

function issueTokensForUser(store, user) {
  const iat = nowTs();

  const accessPayload = {
    iss: "foxscan-api",
    sub: user.id,
    type: "access",
    iat,
    exp: iat + settings.accessTtlSeconds,
    agency_id: user.agencyID,
    subscription_status: user.subscriptionStatus,
    jti: crypto.randomBytes(8).toString("hex"),
  };

  const refreshPayload = {
    iss: "foxscan-api",
    sub: user.id,
    type: "refresh",
    iat,
    exp: iat + settings.refreshTtlSeconds,
    jti: crypto.randomBytes(16).toString("hex"),
  };

  const accessToken = signJwt(accessPayload, settings.jwtSecret);
  const refreshToken = signJwt(refreshPayload, settings.jwtRefreshSecret);

  store.refreshTokens.push({
    id: `rt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    userID: user.id,
    tokenHash: hashToken(refreshToken),
    expiresAt: refreshPayload.exp,
    revokedAt: null,
    createdAt: iat,
  });

  return {
    ok: true,
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      agencyID: user.agencyID,
      subscriptionActive: user.subscriptionStatus === "active",
    },
  };
}

function authHeaderToken(req) {
  const header = req.header("authorization") || "";
  if (!header.startsWith("Bearer ")) {
    const err = new Error("Missing or invalid Authorization header");
    err.status = 401;
    throw err;
  }
  return header.slice(7).trim();
}

function requireCurrentUser(req, res, next) {
  try {
    const store = readStore();
    const token = authHeaderToken(req);
    const payload = verifyJwt(token, settings.jwtSecret);

    if (payload.type !== "access") {
      return res.status(401).json({ ok: false, detail: "Invalid access token type" });
    }

    const user = findUserById(store, String(payload.sub || ""));
    if (!user) {
      return res.status(401).json({ ok: false, detail: "User not found" });
    }

    req._store = store;
    req._user = user;
    return next();
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, detail: err.message || "Unauthorized" });
  }
}

function maybeCurrentUser(req) {
  try {
    const store = readStore();
    const token = authHeaderToken(req);
    const payload = verifyJwt(token, settings.jwtSecret);
    if (payload.type !== "access") return { store, user: null };
    return { store, user: findUserById(store, String(payload.sub || "")) };
  } catch {
    return { store: readStore(), user: null };
  }
}

function ensureDashboardAllowed(user) {
  if (settings.requireActiveSubscription && user.subscriptionStatus !== "active") {
    const err = new Error("Subscription inactive");
    err.status = 403;
    throw err;
  }
}

function upsertByID(items, id, payload) {
  const idx = items.findIndex((x) => x.id === id);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...payload };
    return items[idx];
  }
  items.push({ id, ...payload });
  return items[items.length - 1];
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonObjectFromText(text) {
  if (!text || typeof text !== "string") return null;
  const direct = parseJsonSafe(text);
  if (direct && typeof direct === "object") return direct;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return parseJsonSafe(text.slice(start, end + 1));
}

function normalizeOpenAIOutputText(responseBody) {
  if (typeof responseBody?.output_text === "string" && responseBody.output_text.trim()) {
    return responseBody.output_text;
  }

  const chunks = [];
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

async function callOpenAIResponses(payload) {
  if (!settings.openaiApiKey) {
    const err = new Error("OPENAI_API_KEY is not configured on server");
    err.status = 503;
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await resp.text();
    const json = parseJsonSafe(raw);
    if (!resp.ok) {
      const err = new Error(json?.error?.message || `OpenAI upstream error (${resp.status})`);
      err.status = resp.status === 429 ? 429 : 502;
      throw err;
    }
    if (!json) {
      const err = new Error("OpenAI upstream returned non-JSON response");
      err.status = 502;
      throw err;
    }
    return json;
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error("OpenAI request timeout");
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "foxscan-api-node" });
});

app.get("/ai/health", (req, res) => {
  res.json({
    ok: true,
    service: "foxscan-ai",
    configured: Boolean(settings.openaiApiKey),
  });
});

app.post("/ai/responses", requireCurrentUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.input) {
      return res.status(400).json({ ok: false, error: "invalid_request", detail: "input is required" });
    }

    const payload = {
      model: body.model || "gpt-4.1-mini",
      input: body.input,
      instructions: body.instructions,
      temperature: body.temperature,
      max_output_tokens: body.max_output_tokens,
      response_format: body.response_format,
    };

    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const upstream = await callOpenAIResponses(payload);
    const outputText = normalizeOpenAIOutputText(upstream);
    const outputJson = extractJsonObjectFromText(outputText);

    return res.json({
      ok: true,
      id: upstream.id || null,
      model: upstream.model || payload.model,
      output_text: outputText || "",
      output_json: outputJson || null,
      usage: {
        input_tokens: upstream?.usage?.input_tokens || 0,
        output_tokens: upstream?.usage?.output_tokens || 0,
        total_tokens: upstream?.usage?.total_tokens || 0,
      },
      raw: {
        status: upstream.status || null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

app.post("/ai/vision-ocr", requireCurrentUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const prompt = body.prompt || "Extrais le texte OCR et les champs d'etat des lieux en JSON.";
    const imageBase64 = body.image_base64;
    const mimeType = body.mime_type || "image/jpeg";

    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res
        .status(400)
        .json({ ok: false, error: "invalid_request", detail: "image_base64 is required" });
    }

    const imageDataUrl = imageBase64.startsWith("data:")
      ? imageBase64
      : `data:${mimeType};base64,${imageBase64}`;

    const inputText = `${prompt}
Retourne strictement un JSON avec:
{
  "text": "texte OCR brut",
  "fields": {
    "piece": "",
    "etat_murs": "",
    "sol": "",
    "plafond": "",
    "equipements": "",
    "observations": ""
  },
  "confidence": 0.0
}`;

    const upstream = await callOpenAIResponses({
      model: body.model || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: inputText },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
      temperature: 0.1,
      max_output_tokens: body.max_output_tokens || 900,
    });

    const outputText = normalizeOpenAIOutputText(upstream);
    const parsed = extractJsonObjectFromText(outputText) || {};

    return res.json({
      ok: true,
      text: String(parsed.text || outputText || "").trim(),
      fields: typeof parsed.fields === "object" && parsed.fields ? parsed.fields : {},
      confidence:
        typeof parsed.confidence === "number"
          ? parsed.confidence
          : typeof body.default_confidence === "number"
            ? body.default_confidence
            : 0.8,
      usage: {
        input_tokens: upstream?.usage?.input_tokens || 0,
        output_tokens: upstream?.usage?.output_tokens || 0,
        total_tokens: upstream?.usage?.total_tokens || 0,
      },
    });
  } catch (err) {
    return next(err);
  }
});

app.post("/auth/email/register", (req, res) => {
  const body = req.body || {};
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const name = (body.display_name || body.name || "").trim();

  if (!email || !password) {
    return res.status(400).json({ ok: false, detail: "email and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, detail: "password must be at least 6 characters" });
  }

  const store = readStore();
  const existing = store.users.find((u) => u.email === email && u.authProvider === "email");
  if (existing) {
    return res.status(409).json({ ok: false, detail: "email already registered" });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);

  const user = {
    id: `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    authProvider: "email",
    email,
    passwordHash,
    passwordSalt: salt,
    name: name || email.split("@")[0],
    agencyID: null,
    subscriptionStatus: settings.defaultSubscriptionStatus,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  store.users.push(user);
  const response = issueTokensForUser(store, user);
  writeStore(store);
  res.json(response);
});

app.post("/auth/email/login", (req, res) => {
  const body = req.body || {};
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return res.status(400).json({ ok: false, detail: "email and password are required" });
  }

  const store = readStore();
  const user = store.users.find((u) => u.email === email && u.authProvider === "email");

  if (!user || !user.passwordHash || !user.passwordSalt) {
    return res.status(401).json({ ok: false, detail: "Invalid email or password" });
  }

  const hash = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) {
    return res.status(401).json({ ok: false, detail: "Invalid email or password" });
  }

  const response = issueTokensForUser(store, user);
  writeStore(store);
  res.json(response);
});

app.post("/auth/apple", async (req, res) => {
  try {
    const body = req.body || {};
    const idToken = body.idToken || body.identityToken || null;

    let claims;
    if (body.demoMode === true && !idToken) {
      // Mode démo (tests E2E uniquement) : aucune vérif JWT
      claims = {
        sub: `demo_sub_${crypto.randomBytes(4).toString("hex")}`,
        email: "",
      };
    } else {
      // Production : vraie vérification du JWT via JWKS Apple
      // (signature, issuer, audience, exp tous validés)
      claims = await verifyAppleIdToken(idToken);
    }

    const store = readStore();
    const appleSub = String(claims.sub || "");
    const email = String(claims.email || "");

    // Apple n'envoie le "name" QUE lors de la 1ère connexion, dans le body (pas le JWT)
    let displayName = "";
    if (body.user && typeof body.user === "object" && body.user.name) {
      const first = body.user.name.firstName || "";
      const last = body.user.name.lastName || "";
      displayName = `${first} ${last}`.trim();
    } else if (typeof body.name === "string") {
      displayName = body.name.trim();
    }
    if (!displayName) {
      displayName = email ? email.split("@")[0] : "Utilisateur FOXSCAN";
    }

    const user = findOrCreateUserFromApple(store, {
      appleSub,
      email,
      name: displayName,
      agencyID: body.agencyID || null,
      subscriptionActive:
        typeof body.subscriptionActive === "boolean" ? body.subscriptionActive : undefined,
    });

    const response = issueTokensForUser(store, user);
    writeStore(store);
    res.json(response);
  } catch (err) {
    console.error("[/auth/apple]", err.message);
    return res.status(err.status || 500).json({ ok: false, detail: err.message || "Apple sign-in failed" });
  }
});

app.post("/auth/google", async (req, res) => {
  try {
    const body = req.body || {};
    // GIS envoie un champ "credential" (id_token JWT) dans son callback
    const idToken = body.idToken || body.credential || null;

    const claims = await verifyGoogleIdToken(idToken);

    if (claims.email_verified !== true) {
      return res.status(401).json({ ok: false, detail: "Google account email not verified" });
    }

    const store = readStore();
    const googleSub = String(claims.sub || "");
    const email = String(claims.email || "");
    const name = String(claims.name || (email ? email.split("@")[0] : "Utilisateur FOXSCAN"));
    const picture = claims.picture || null;

    const user = findOrCreateUserFromGoogle(store, {
      googleSub,
      email,
      name,
      picture,
      agencyID: body.agencyID || null,
    });

    const response = issueTokensForUser(store, user);
    writeStore(store);
    res.json(response);
  } catch (err) {
    console.error("[/auth/google]", err.message);
    return res.status(err.status || 500).json({ ok: false, detail: err.message || "Google sign-in failed" });
  }
});

app.post("/auth/refresh", (req, res) => {
  const body = req.body || {};
  if (!body.refreshToken) {
    return res.status(400).json({ ok: false, detail: "refreshToken is required" });
  }

  const store = readStore();

  let payload;
  try {
    payload = verifyJwt(body.refreshToken, settings.jwtRefreshSecret);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, detail: err.message || "Invalid refresh token" });
  }

  if (payload.type !== "refresh") {
    return res.status(401).json({ ok: false, detail: "Invalid refresh token type" });
  }

  const tokenHash = hashToken(body.refreshToken);
  const tokenRow = store.refreshTokens.find((t) => t.tokenHash === tokenHash && !t.revokedAt);
  if (!tokenRow) {
    return res.status(401).json({ ok: false, detail: "Refresh token not recognized" });
  }

  if (Number(tokenRow.expiresAt) < nowTs()) {
    return res.status(401).json({ ok: false, detail: "Refresh token expired" });
  }

  tokenRow.revokedAt = nowTs();
  const user = findUserById(store, String(payload.sub || ""));
  if (!user) {
    return res.status(401).json({ ok: false, detail: "User not found" });
  }

  const response = issueTokensForUser(store, user);
  writeStore(store);
  res.json(response);
});

app.post("/auth/logout", requireCurrentUser, (req, res) => {
  const body = req.body || {};
  const store = req._store;
  const user = req._user;

  if (body.refreshToken) {
    const h = hashToken(body.refreshToken);
    store.refreshTokens.forEach((t) => {
      if (t.tokenHash === h) t.revokedAt = nowTs();
    });
  } else {
    store.refreshTokens.forEach((t) => {
      if (t.userID === user.id) t.revokedAt = nowTs();
    });
  }

  writeStore(store);
  res.json({ ok: true, message: `Logged out ${user.id}` });
});

app.post("/subscriptions/status", requireCurrentUser, (req, res) => {
  const body = req.body || {};
  const store = req._store;
  const current = req._user;

  if (typeof body.subscriptionActive !== "boolean") {
    return res.status(400).json({ ok: false, detail: "subscriptionActive is required" });
  }

  const targetUserID = body.userID || current.id;
  if (targetUserID !== current.id && !body.appleSub) {
    return res.status(403).json({ ok: false, detail: "Forbidden subscription update target" });
  }

  let target = null;
  if (body.appleSub) target = store.users.find((u) => u.appleSub === body.appleSub) || null;
  if (!target) target = store.users.find((u) => u.id === targetUserID) || null;

  if (!target) {
    return res.status(404).json({ ok: false, detail: "User not found" });
  }

  target.subscriptionStatus = body.subscriptionActive ? "active" : "inactive";
  target.updatedAt = nowIso();
  writeStore(store);

  res.json({
    ok: true,
    id: target.id,
    message: "Subscription status updated",
    subscriptionActive: target.subscriptionStatus === "active",
  });
});

app.get("/dashboard/session", requireCurrentUser, (req, res) => {
  const user = req._user;
  try {
    ensureDashboardAllowed(user);
  } catch (err) {
    return res.status(err.status || 403).json({ ok: false, detail: err.message });
  }

  res.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      agencyID: user.agencyID,
      subscriptionActive: user.subscriptionStatus === "active",
    },
  });
});

app.get("/projects", requireCurrentUser, (req, res) => {
  const user = req._user;
  try {
    ensureDashboardAllowed(user);
  } catch (err) {
    return res.status(err.status || 403).json({ ok: false, detail: err.message });
  }

  const store = req._store;
  const items = store.projects
    .filter((p) => p.userID === user.id)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .map((p) => ({
      id: p.id,
      name: p.projectName || "Projet",
      address: p.address || "-",
      status: p.status || "in_progress",
      updatedAt: p.updatedAt || nowIso(),
    }));

  res.json({ ok: true, items });
});

app.get("/reports", requireCurrentUser, (req, res) => {
  const user = req._user;
  try {
    ensureDashboardAllowed(user);
  } catch (err) {
    return res.status(err.status || 403).json({ ok: false, detail: err.message });
  }

  const store = req._store;
  const items = store.reports
    .filter((r) => r.userID === user.id)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((r) => ({
      id: r.id,
      projectID: r.projectID || "",
      projectName: r.projectName || "-",
      fileName: r.fileName || `${r.id}.pdf`,
      createdAt: r.createdAt || nowIso(),
    }));

  res.json({ ok: true, items });
});

app.get("/models", requireCurrentUser, (req, res) => {
  const user = req._user;
  try {
    ensureDashboardAllowed(user);
  } catch (err) {
    return res.status(err.status || 403).json({ ok: false, detail: err.message });
  }

  res.json({ ok: true, items: [] });
});

// ─── ADMIN ROUTES ────────────────────────────────────────────────────────────

function requireAdminKey(req, res) {
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.body?.adminKey || req.header("x-admin-key") || "";
  if (!adminKey || provided !== adminKey) {
    res.status(403).json({ ok: false, detail: "Forbidden" });
    return false;
  }
  return true;
}

app.get("/admin/users", (req, res) => {
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.header("x-admin-key") || "";
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }

  const store = readStore();
  const users = store.users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    authProvider: u.authProvider || "apple",
    subscriptionActive: u.subscriptionStatus === "active",
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }));

  res.json({ ok: true, users, total: users.length });
});

app.patch("/admin/users/:userId/subscription", (req, res) => {
  const body = req.body || {};
  if (!requireAdminKey(req, res)) return;

  const store = readStore();
  const user = store.users.find((u) => u.id === req.params.userId);
  if (!user) return res.status(404).json({ ok: false, detail: "User not found" });

  if (typeof body.subscriptionActive !== "boolean") {
    return res.status(400).json({ ok: false, detail: "subscriptionActive (boolean) is required" });
  }

  user.subscriptionStatus = body.subscriptionActive ? "active" : "inactive";
  user.updatedAt = nowIso();
  writeStore(store);

  res.json({
    ok: true,
    id: user.id,
    subscriptionActive: user.subscriptionStatus === "active",
  });
});

// Admin: activer tous les users (dev/beta seulement)
app.post("/admin/activate-all-users", (req, res) => {
  const body = req.body || {};
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  if (!adminKey || body.adminKey !== adminKey) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }
  const store = readStore();
  let count = 0;
  store.users.forEach((u) => {
    if (u.subscriptionStatus !== "active") {
      u.subscriptionStatus = "active";
      u.updatedAt = nowIso();
      count++;
    }
  });
  writeStore(store);
  res.json({ ok: true, activated: count, total: store.users.length });
});

app.post("/inspections/sync", (req, res) => {
  const body = req.body || {};
  const { store, user } = maybeCurrentUser(req);

  const userID = user?.id || body.actorUserID || "ios_anonymous";
  const projectID = body.projectID || `proj_${crypto.randomBytes(4).toString("hex")}`;
  const reportID = body.reportID || `rep_${crypto.randomBytes(4).toString("hex")}`;

  upsertByID(store.projects, projectID, {
    userID,
    projectName: body.projectName || "Nouveau projet",
    updatedAt: body.updatedAt || nowIso(),
    status: "in_progress",
    address: "Adresse synchronisée depuis iOS",
    payload: body,
    updatedAtDb: nowIso(),
    createdAt: nowIso(),
  });

  upsertByID(store.reports, reportID, {
    userID,
    projectID,
    projectName: body.projectName || "Nouveau projet",
    fileName: `${reportID}.pdf`,
    createdAt: body.updatedAt || nowIso(),
    payload: body.report || {},
    createdAtDb: nowIso(),
  });

  writeStore(store);
  res.json({ ok: true, id: reportID, message: "Inspection synchronized" });
});

app.post("/exports", (req, res) => {
  const body = req.body || {};
  const { store, user } = maybeCurrentUser(req);

  const exportID = `exp_${crypto.randomBytes(4).toString("hex")}`;
  const userID = user?.id || body.createdByUserID || "ios_anonymous";

  store.exports.push({
    id: exportID,
    userID,
    projectID: body.projectID || null,
    reportID: body.reportID || null,
    createdByUserID: body.createdByUserID || null,
    createdAt: body.createdAt || nowIso(),
    kind: body.kind || null,
    fileName: body.fileName || null,
    contentHash: body.contentHash || null,
    payload: body,
    createdAtDb: nowIso(),
  });

  if (body.reportID) {
    upsertByID(store.reports, body.reportID, {
      userID,
      projectID: body.projectID || "",
      projectName: "Projet exporté",
      fileName: body.fileName || `${body.reportID}.pdf`,
      createdAt: body.createdAt || nowIso(),
      payload: body,
      createdAtDb: nowIso(),
    });
  }

  writeStore(store);
  res.json({ ok: true, id: exportID, message: "Export registered" });
});

app.post("/audit-events", (req, res) => {
  const body = req.body || {};
  const { store, user } = maybeCurrentUser(req);

  const eventID = `aud_${crypto.randomBytes(4).toString("hex")}`;
  store.auditEvents.push({
    id: eventID,
    userID: user?.id || body.actorUserID || null,
    eventType: body.type || null,
    actorUserID: body.actorUserID || null,
    projectID: body.projectID || null,
    reportID: body.reportID || null,
    payload: body,
    createdAtDb: nowIso(),
  });

  writeStore(store);
  res.json({ ok: true, id: eventID, message: "Audit event recorded" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ ok: false, detail: err.message || "Internal server error" });
});

app.listen(settings.port, () => {
  console.log(`FOXSCAN API Node running on :${settings.port}`);
});
