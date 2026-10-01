// ═══════════════════════════════════════════════════════════════════════════
// FOXSCAN — DB LAYER (better-sqlite3 multi-tenant)
// ═══════════════════════════════════════════════════════════════════════════
//
// Architecture :
//   - master.db (1 fichier)          — users, organizations, memberships, sessions
//   - orgs/<orgId>.db (N fichiers)   — drafts, projects, reports, exports par agence
//
// Exposé :
//   const { master, orgDb, openOrgDb, listOrgs } = require('./db');
//
// Tout est synchrone (better-sqlite3) → pas de callbacks/promises à gérer
// dans le code appelant. C'est INTENTIONNEL : Node monothread, donc sérialiser
// les writes sur l'event loop est en fait safe et plus prédictible que d'avoir
// du code "async" partout.
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Racine data (overridable par env)
const DATA_DIR = process.env.FOXSCAN_DATA_DIR ||
  path.join(__dirname, "..", "data");
const MASTER_DB_PATH = path.join(DATA_DIR, "master.db");
const ORGS_DIR = path.join(DATA_DIR, "orgs");

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
ensureDir(DATA_DIR);
ensureDir(ORGS_DIR);

// ─── Schemas ──────────────────────────────────────────────────────────────
const MASTER_SCHEMA = fs.readFileSync(path.join(__dirname, "masterSchema.sql"), "utf-8");
const ORG_SCHEMA = fs.readFileSync(path.join(__dirname, "orgSchema.sql"), "utf-8");

// ─── Master DB singleton ──────────────────────────────────────────────────
let _master = null;

function openMaster() {
  if (_master) return _master;
  const db = new Database(MASTER_DB_PATH);
  db.exec(MASTER_SCHEMA);
  _master = db;
  return db;
}

// ─── Org DB pool (LRU cache : max 50 DBs ouvertes simultanément) ──────────
const ORG_DB_CACHE = new Map();   // orgId → { db, lastUsed }
const ORG_DB_CACHE_MAX = 50;

function openOrgDb(orgId) {
  if (!orgId || typeof orgId !== "string") {
    throw new Error("openOrgDb: orgId requis");
  }
  const cached = ORG_DB_CACHE.get(orgId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.db;
  }
  // Évict si cache plein
  if (ORG_DB_CACHE.size >= ORG_DB_CACHE_MAX) {
    let oldestId = null, oldestTs = Infinity;
    for (const [id, entry] of ORG_DB_CACHE) {
      if (entry.lastUsed < oldestTs) { oldestTs = entry.lastUsed; oldestId = id; }
    }
    if (oldestId) {
      try { ORG_DB_CACHE.get(oldestId).db.close(); } catch {}
      ORG_DB_CACHE.delete(oldestId);
    }
  }
  // Récupère db_path depuis master
  const master = openMaster();
  const org = master.prepare("SELECT db_path FROM organizations WHERE id = ?").get(orgId);
  if (!org) throw new Error(`openOrgDb: organisation ${orgId} introuvable`);
  const absPath = path.isAbsolute(org.db_path) ? org.db_path : path.join(DATA_DIR, org.db_path);
  ensureDir(path.dirname(absPath));
  const db = new Database(absPath);
  db.exec(ORG_SCHEMA);
  ORG_DB_CACHE.set(orgId, { db, lastUsed: Date.now() });
  return db;
}

// ─── Helpers utilitaires ──────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "org";
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

// ─── Operations master ────────────────────────────────────────────────────
function createUser({
  email, name = "", passwordHash = null,
  authProvider = "email", appleSub = null, googleSub = null,
  userType = "internal", role = "user",
  trialEndsAt = null, foundersAccount = false,
}) {
  const db = openMaster();
  const id = genId("usr");
  const ts = nowIso();
  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, auth_provider, apple_sub, google_sub,
                       user_type, role, trial_ends_at, founders_account, created_at, updated_at)
    VALUES (@id, @email, @name, @passwordHash, @authProvider, @appleSub, @googleSub,
            @userType, @role, @trialEndsAt, @foundersAccount, @ts, @ts)
  `).run({
    id, email: email.toLowerCase(), name, passwordHash, authProvider, appleSub, googleSub,
    userType, role,
    trialEndsAt,
    foundersAccount: foundersAccount ? 1 : 0,
    ts,
  });
  return findUserById(id);
}

function findUserById(id) {
  return openMaster().prepare("SELECT * FROM users WHERE id = ?").get(id);
}
function findUserByEmail(email) {
  return openMaster().prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
}
function findUserByAppleSub(sub) {
  return openMaster().prepare("SELECT * FROM users WHERE apple_sub = ?").get(sub);
}
function findUserByGoogleSub(sub) {
  return openMaster().prepare("SELECT * FROM users WHERE google_sub = ?").get(sub);
}

function createOrganization({
  name, slug = null, plan = "trial", trialEndsAt = null,
  seatsAllowed = 3, foundersAccount = false,
}) {
  const db = openMaster();
  const id = genId("org");
  // Slug auto si non fourni, avec dédup en cas de collision
  let baseSlug = slug ? slugify(slug) : slugify(name);
  let finalSlug = baseSlug;
  let i = 2;
  while (db.prepare("SELECT 1 FROM organizations WHERE slug = ?").get(finalSlug)) {
    finalSlug = `${baseSlug}-${i++}`;
  }
  const dbPath = `orgs/${id}.db`;
  const ts = nowIso();
  db.prepare(`
    INSERT INTO organizations (id, slug, name, db_path, plan, trial_ends_at, seats_allowed,
                                founders_account, created_at, updated_at)
    VALUES (@id, @slug, @name, @dbPath, @plan, @trialEndsAt, @seatsAllowed, @foundersAccount, @ts, @ts)
  `).run({
    id, slug: finalSlug, name, dbPath, plan,
    trialEndsAt,
    seatsAllowed,
    foundersAccount: foundersAccount ? 1 : 0,
    ts,
  });
  // Force la création immédiate du fichier .db
  openOrgDb(id);
  return findOrgById(id);
}

function findOrgById(id) {
  return openMaster().prepare("SELECT * FROM organizations WHERE id = ?").get(id);
}
function findOrgBySlug(slug) {
  return openMaster().prepare("SELECT * FROM organizations WHERE slug = ? COLLATE NOCASE").get(slug);
}
function listOrgs() {
  return openMaster().prepare("SELECT * FROM organizations ORDER BY created_at DESC").all();
}

function addMembership({ userId, orgId, role = "agent", invitedBy = null }) {
  const db = openMaster();
  const id = genId("mem");
  const ts = nowIso();
  db.prepare(`
    INSERT INTO memberships (id, user_id, org_id, role, invited_by, joined_at)
    VALUES (@id, @userId, @orgId, @role, @invitedBy, @ts)
    ON CONFLICT(user_id, org_id) DO UPDATE SET role = @role
  `).run({ id, userId, orgId, role, invitedBy, ts });
  return db.prepare("SELECT * FROM memberships WHERE user_id = ? AND org_id = ?").get(userId, orgId);
}

function getUserMemberships(userId) {
  return openMaster().prepare(`
    SELECT m.*, o.name AS org_name, o.slug AS org_slug
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ?
    ORDER BY m.joined_at DESC
  `).all(userId);
}

function getOrgMembers(orgId) {
  return openMaster().prepare(`
    SELECT m.*, u.email, u.name, u.auth_provider, u.last_login_at
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ?
    ORDER BY m.role DESC, m.joined_at ASC
  `).all(orgId);
}

function getUserExternalAccess(userId) {
  return openMaster().prepare(`
    SELECT ea.*, o.name AS org_name, o.slug AS org_slug
    FROM edl_external_access ea
    JOIN organizations o ON o.id = ea.org_id
    WHERE ea.user_id = ?
    ORDER BY ea.granted_at DESC
  `).all(userId);
}

function audit({ actorId = null, actorEmail = null, orgId = null, userId = null, action, details = null }) {
  const db = openMaster();
  db.prepare(`
    INSERT INTO audit_global (id, ts, actor_id, actor_email, org_id, user_id, action, details)
    VALUES (@id, @ts, @actorId, @actorEmail, @orgId, @userId, @action, @details)
  `).run({
    id: genId("aud"),
    ts: nowIso(),
    actorId, actorEmail, orgId, userId, action,
    details: details ? (typeof details === "string" ? details : JSON.stringify(details)) : null,
  });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────
function closeAll() {
  for (const { db } of ORG_DB_CACHE.values()) {
    try { db.close(); } catch {}
  }
  ORG_DB_CACHE.clear();
  if (_master) { try { _master.close(); } catch {} _master = null; }
}

// ─── Public API ───────────────────────────────────────────────────────────
module.exports = {
  // Paths
  DATA_DIR, MASTER_DB_PATH, ORGS_DIR,
  // Low-level
  openMaster, openOrgDb, closeAll,
  // Helpers
  nowIso, genId, slugify, sha256,
  // Users
  createUser, findUserById, findUserByEmail, findUserByAppleSub, findUserByGoogleSub,
  // Orgs
  createOrganization, findOrgById, findOrgBySlug, listOrgs,
  // Memberships
  addMembership, getUserMemberships, getOrgMembers,
  // External access
  getUserExternalAccess,
  // Audit
  audit,
};
