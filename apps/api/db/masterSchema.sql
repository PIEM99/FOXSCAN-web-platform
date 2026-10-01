-- ═══════════════════════════════════════════════════════════════════════════
-- FOXSCAN — MASTER DATABASE SCHEMA v1.0
-- ═══════════════════════════════════════════════════════════════════════════
-- Le master.db contient les données partagées entre toutes les organisations :
-- comptes (login), organizations (agences), memberships (qui appartient où),
-- sessions (refresh tokens), accès externes (locataires/propriétaires sur EDL),
-- et audit global (actions cross-org : login, billing, suspend).
--
-- Tout le reste (drafts, projects, reports, exports) vit dans des DB
-- séparées : orgs/<slug>.db — isolation parfaite par agence.
-- ═══════════════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;       -- Write-Ahead Logging : lectures concurrentes
PRAGMA synchronous = NORMAL;     -- Fsync à chaque commit, pas à chaque op (safe + rapide)
PRAGMA foreign_keys = ON;        -- Active les contraintes de clé étrangère
PRAGMA busy_timeout = 5000;      -- Attend jusqu'à 5s si la DB est locked

-- ─── USERS ─────────────────────────────────────────────────────────────────
-- Tous les comptes : agents d'agence (internal) ET locataires/propriétaires (external).
-- Un user "external" peut être membre d'aucune org et voir uniquement les EDL
-- où il est listé via edl_external_access.
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,                 -- usr_xxx
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL DEFAULT '',
  password_hash   TEXT,                              -- NULL si auth OAuth uniquement
  auth_provider   TEXT NOT NULL DEFAULT 'email',     -- 'email' | 'apple' | 'google'
  apple_sub       TEXT UNIQUE,                       -- sub Apple Sign In (si auth apple)
  google_sub      TEXT UNIQUE,                       -- sub Google Sign In
  user_type       TEXT NOT NULL DEFAULT 'internal',  -- 'internal' (agent) | 'external' (locataire/proprio)
  role            TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'superadmin' (équipe FOXSCAN)
  suspended       INTEGER NOT NULL DEFAULT 0,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  -- Trial / Subscription stockés ici (avant on les avait dans user direct, on garde par compat)
  trial_ends_at   TEXT,                              -- ISO datetime
  founders_account INTEGER NOT NULL DEFAULT 0,       -- Lifetime 200€
  metadata        TEXT,                              -- JSON pour champs custom flexibles
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_login_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_apple_sub ON users(apple_sub) WHERE apple_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_type ON users(user_type);

-- ─── ORGANIZATIONS ─────────────────────────────────────────────────────────
-- Une agence. La data métier (drafts/projects/reports) vit dans db_path.
CREATE TABLE IF NOT EXISTS organizations (
  id                    TEXT PRIMARY KEY,           -- org_xxx
  slug                  TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- 'regie-emery' (URL-safe, unique)
  name                  TEXT NOT NULL,              -- 'Régie Emery'
  db_path               TEXT NOT NULL UNIQUE,       -- 'orgs/org_xxx.db' (relatif à data/)
  plan                  TEXT NOT NULL DEFAULT 'trial',   -- 'trial' | 'starter' | 'pro' | 'enterprise' | 'lifetime'
  trial_ends_at         TEXT,
  subscription_status   TEXT,                       -- 'active' | 'past_due' | 'canceled' | 'inactive'
  subscription_price_cents INTEGER,
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  seats_allowed         INTEGER NOT NULL DEFAULT 3, -- max agents simultanés
  founders_account      INTEGER NOT NULL DEFAULT 0,
  -- Branding tenant portal (futur)
  logo_url              TEXT,
  primary_color         TEXT,
  -- Statut
  suspended             INTEGER NOT NULL DEFAULT 0,
  metadata              TEXT,                       -- JSON flexible
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orgs_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_orgs_stripe_customer ON organizations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ─── MEMBERSHIPS ───────────────────────────────────────────────────────────
-- Liaison user × org × rôle. Un user peut être dans plusieurs orgs (rare mais légal).
CREATE TABLE IF NOT EXISTS memberships (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'agent',         -- 'owner' | 'agent'
  invited_by  TEXT REFERENCES users(id),
  joined_at   TEXT NOT NULL,
  UNIQUE(user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);

-- ─── EDL EXTERNAL ACCESS ───────────────────────────────────────────────────
-- Lie un user externe (locataire/propriétaire) à des reports/projects spécifiques.
-- Permet le portail tenant : "vois tous tes EDL chez tes différentes agences".
CREATE TABLE IF NOT EXISTS edl_external_access (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- IDs dans la DB de l'org (les vrais reports/projects sont dans org's db_path)
  report_id   TEXT,
  project_id  TEXT,
  role        TEXT NOT NULL,                         -- 'tenant' | 'landlord' | 'cotenant'
  granted_at  TEXT NOT NULL,
  expires_at  TEXT,                                  -- access expiry (ex: 1 an post-EDL)
  granted_by  TEXT REFERENCES users(id)              -- l'agent qui a invité
);

CREATE INDEX IF NOT EXISTS idx_external_access_user ON edl_external_access(user_id);
CREATE INDEX IF NOT EXISTS idx_external_access_org ON edl_external_access(org_id);
CREATE INDEX IF NOT EXISTS idx_external_access_report ON edl_external_access(report_id) WHERE report_id IS NOT NULL;

-- ─── REFRESH TOKENS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              TEXT PRIMARY KEY,                  -- rt_xxx
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,                     -- sha256(token), jamais le token brut
  active_org_id   TEXT REFERENCES organizations(id), -- org sur laquelle l'user est actuellement
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT,
  user_agent      TEXT,
  ip_hint         TEXT                                -- 1er octet seulement pour confort (pas privacy-invasive)
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ─── PASSWORD RESET TOKENS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,                                  -- NULL si pas encore utilisé
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prt_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_prt_expires ON password_reset_tokens(expires_at);

-- ─── AUDIT GLOBAL ──────────────────────────────────────────────────────────
-- Actions cross-org : login, signup, suspend, billing, admin actions.
-- Les actions intra-org (création EDL, modif) vont dans la table audit de chaque org.
CREATE TABLE IF NOT EXISTS audit_global (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor_id    TEXT REFERENCES users(id),             -- qui a fait l'action (NULL si système)
  actor_email TEXT,                                  -- snapshot au moment de l'action
  org_id      TEXT REFERENCES organizations(id),     -- contexte org (optionnel)
  user_id     TEXT REFERENCES users(id),             -- cible de l'action (ex: suspendu)
  action      TEXT NOT NULL,                         -- 'user.login' | 'user.signup' | 'admin.suspend' | 'billing.subscribed' | ...
  details     TEXT                                   -- JSON arbitraire
);

CREATE INDEX IF NOT EXISTS idx_audit_global_ts ON audit_global(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_global_actor ON audit_global(actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_global_org ON audit_global(org_id, ts DESC) WHERE org_id IS NOT NULL;

-- ─── FOUNDERS WAITLIST ─────────────────────────────────────────────────────
-- Inscription publique à l'avantage spécial 200€ lifetime (premiers 20 utilisateurs)
CREATE TABLE IF NOT EXISTS founders_waitlist (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT,
  phone       TEXT,
  company     TEXT,
  role        TEXT,
  comment     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'invited' | 'paid' | 'rejected'
  position    INTEGER,                               -- ordre d'inscription
  created_at  TEXT NOT NULL,
  invited_at  TEXT,
  paid_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_founders_status ON founders_waitlist(status);

-- ─── PDF CUSTOMIZATION (par agence/organisation) ───────────────────────────
-- Stocke les overrides de l'agence pour les textes, couleurs, sections et
-- layout du PDF EDL généré par l'app iOS. Voir docs/PDF_CUSTOMIZATION_SPEC.md
-- pour le schéma JSON complet du payload.
CREATE TABLE IF NOT EXISTS agency_pdf_customizations (
  org_id      TEXT PRIMARY KEY,            -- = user.teamId ou user.id pour les solos
  payload     TEXT NOT NULL,                -- JSON complet (schéma PDFCustomization)
  revision    INTEGER NOT NULL DEFAULT 1,   -- incrémenté à chaque PUT
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by  TEXT,                          -- user.id qui a fait le dernier update
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pdf_custom_updated ON agency_pdf_customizations(updated_at);

-- ─── METADATA TABLE (schema versioning) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO _meta (key, value) VALUES
  ('schema_version', '1'),
  ('schema_applied_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
