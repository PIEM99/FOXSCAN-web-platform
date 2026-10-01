-- ═══════════════════════════════════════════════════════════════════════════
-- FOXSCAN — PER-ORGANIZATION DATABASE SCHEMA v1.0
-- ═══════════════════════════════════════════════════════════════════════════
-- Appliqué à chaque DB d'agence : orgs/<org_id>.db
-- Contient TOUTE la data métier d'une agence : drafts, projects, reports,
-- exports, properties, audit. Aucune référence vers d'autres orgs.
--
-- Les user_id (created_by, assigned_to) sont des références vers master.db.users
-- — pas de FK cross-DB possible en SQLite, on assume l'intégrité via le code.
-- ═══════════════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ─── DRAFTS (brouillons EDL créés sur web ou iOS) ──────────────────────────
CREATE TABLE IF NOT EXISTS drafts (
  id              TEXT PRIMARY KEY,                  -- dft_xxx
  -- Author/assignee : user_id de master.db
  created_by      TEXT NOT NULL,
  assigned_to     TEXT,                              -- l'agent qui doit faire la visite (peut être différent de created_by)
  -- Métadonnées bien
  address         TEXT NOT NULL DEFAULT '',
  property_type   TEXT,                              -- 'studio' | 'T1' | 'T2' | ... | 'maison' | 'local-commercial'
  edl_type        TEXT,                              -- 'entry' | 'exit' | 'inventory'
  scheduled_at    TEXT,                              -- ISO datetime
  -- Parties
  tenant_name     TEXT,
  tenant_email    TEXT,
  landlord_name   TEXT,
  -- Self-Prep (v6)
  self_prep_share_token_hash TEXT,                   -- sha256 du token magic link
  self_prep_token_issued_at  TEXT,
  self_prep_token_expires_at TEXT,
  self_prep_status           TEXT,                   -- 'none' | 'sent' | 'scanned' | 'validated'
  self_prep_scanned_at       TEXT,
  self_prep_validated_at     TEXT,
  self_prep_scan_data        TEXT,                   -- JSON rooms+photos
  self_prep_agent_annotations TEXT,                  -- JSON
  -- Free-form
  notes           TEXT,
  source          TEXT NOT NULL DEFAULT 'web',       -- 'web' | 'ios' | 'import'
  status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'in_progress' | 'exported' | 'archived'
  payload         TEXT,                              -- JSON pour fields legacy : additionalTenants[], etc.
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drafts_created_by ON drafts(created_by);
CREATE INDEX IF NOT EXISTS idx_drafts_assigned_to ON drafts(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drafts_scheduled_at ON drafts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_self_prep_hash ON drafts(self_prep_share_token_hash) WHERE self_prep_share_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC);

-- ─── PROJECTS (EDL en cours / finalisé synchronisé depuis iOS) ─────────────
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  -- Groupement entrée/sortie d'un même bien (pour les comparatifs)
  property_id       TEXT REFERENCES properties(id),
  -- Origin
  draft_id          TEXT,                            -- si vient d'un brouillon web
  origin            TEXT NOT NULL DEFAULT 'ios',     -- 'ios' | 'web' | 'import'
  created_by        TEXT NOT NULL,
  -- Métadonnées
  project_name      TEXT,
  address           TEXT NOT NULL DEFAULT '',
  inspection_type   TEXT,                            -- 'entry' | 'exit' | 'inventory'
  status            TEXT NOT NULL DEFAULT 'in_progress',  -- 'in_progress' | 'completed' | 'signed'
  -- Parties
  tenant_name       TEXT,
  additional_tenants TEXT,                           -- JSON [{name,email,...}]
  landlord_name     TEXT,
  -- Organisation
  is_archived       INTEGER NOT NULL DEFAULT 0,
  scheduled_at      TEXT,
  -- Payload complet (rétro-compat)
  payload           TEXT,                            -- JSON full du projet iOS
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_projects_property ON projects(property_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(is_archived);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);

-- ─── REPORTS (rapports d'inspection finalisés - inspectionReport.json) ─────
CREATE TABLE IF NOT EXISTS reports (
  id                TEXT PRIMARY KEY,                -- rep_xxx
  project_id        TEXT REFERENCES projects(id),
  -- Métadonnées dénormalisées pour requêtes rapides sans rejoindre
  address           TEXT,
  tenant_name       TEXT,
  inspection_type   TEXT,                            -- 'entry' | 'exit' | 'inventory'
  -- Statut
  is_finalized      INTEGER NOT NULL DEFAULT 0,
  finalized_at      TEXT,
  -- Liens fichiers
  pdf_path          TEXT,                            -- chemin relatif vers le PDF stocké
  bundle_path       TEXT,                            -- chemin vers le bundle (photos, USDZ, etc.)
  -- Contenu structuré
  payload           TEXT NOT NULL,                   -- JSON inspectionReport (rooms, comparisons, etc.)
  -- Comparatifs (dénormalisés pour la page Comparatifs/Travaux)
  comparison_summary TEXT,
  comparison_estimated_retention INTEGER,             -- en centimes pour éviter les flottants
  comparison_items_count INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_id);
CREATE INDEX IF NOT EXISTS idx_reports_finalized ON reports(is_finalized, finalized_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_comparison ON reports(comparison_items_count) WHERE comparison_items_count > 0;
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

-- ─── EXPORTS (fichiers uploadés : bundles, PDFs, photos) ───────────────────
CREATE TABLE IF NOT EXISTS exports (
  id              TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id),
  uploaded_by     TEXT NOT NULL,
  file_path       TEXT NOT NULL,                    -- chemin relatif vers le fichier
  file_name       TEXT,                              -- nom original
  file_type       TEXT,                              -- 'pdf' | 'bundle' | 'photo' | 'usdz'
  size_bytes      INTEGER,
  content_type    TEXT,
  -- Métadonnées bien (dénorm pour groupement)
  address         TEXT,
  tenant_name     TEXT,
  inspection_type TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exports_project ON exports(project_id);
CREATE INDEX IF NOT EXISTS idx_exports_uploaded_by ON exports(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_exports_type ON exports(file_type);
CREATE INDEX IF NOT EXISTS idx_exports_created ON exports(created_at DESC);

-- ─── PROPERTIES (biens groupés entrée+sortie même adresse) ─────────────────
CREATE TABLE IF NOT EXISTS properties (
  id              TEXT PRIMARY KEY,                 -- prop_xxx
  -- Métadonnées
  address         TEXT NOT NULL,
  tenant_name     TEXT,
  landlord_name   TEXT,
  property_type   TEXT,
  -- Compteurs (matérialisés pour rapidité de la page Projets)
  entry_count     INTEGER NOT NULL DEFAULT 0,
  exit_count      INTEGER NOT NULL DEFAULT 0,
  total_exports   INTEGER NOT NULL DEFAULT 0,
  -- Misc
  cover_image_url TEXT,
  metadata        TEXT,                              -- JSON
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_properties_address ON properties(address);
CREATE INDEX IF NOT EXISTS idx_properties_tenant ON properties(tenant_name) WHERE tenant_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_updated ON properties(updated_at DESC);

-- ─── AUDIT (intra-org) ─────────────────────────────────────────────────────
-- Actions sur les données métier : créer/modifier/supprimer EDL.
-- Les actions admin (suspend, billing, ...) vont dans master.audit_global.
CREATE TABLE IF NOT EXISTS audit (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor_id    TEXT NOT NULL,                         -- user_id depuis master
  actor_email TEXT,                                  -- snapshot
  action      TEXT NOT NULL,                         -- 'draft.create' | 'project.update' | ...
  entity_type TEXT,                                  -- 'draft' | 'project' | 'report' | 'export'
  entity_id   TEXT,
  details     TEXT                                   -- JSON
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit(actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit(entity_type, entity_id);

-- ─── METADATA ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO _meta (key, value) VALUES
  ('schema_version', '1'),
  ('schema_applied_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
