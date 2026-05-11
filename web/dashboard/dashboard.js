import {
  clearSession,
  dashboardSession,
  deleteExport,
  downloadExportFile,
  fetchExportContents,
  fetchExports,
  fetchExtractedProjects,
  fetchModels,
  fetchProjectFiles,
  fetchProjectInspection,
  fetchProperties,
  getApiBaseUrl,
  getExportFileBlobURL,
  getGeneratedPDFBlobURL,
  getProjectFileBlobURL,
  getProjectPDFBlobURL,
  getSessionUser,
  logoutApi,
} from "../js/foxscan-client.js";

// ── State global ──────────────────────────────────────────────────────────────
let allExports = [];     // (legacy) tous les uploads bruts
let allBiens = [];       // pour onglet "Mes biens" (= GET /properties)
let allProjects = [];    // pour onglets "Projets / Rapports / Photos / 3D" (= GET /api/projects + files)
                         //   format: [{ projectID, name, extractedAt, filesCount, totalSize, files: [{path,sizeBytes,mimeType}] }, ...]
// V5 — Toggle d'affichage des projets archivés. Par défaut, on les masque
// pour ne pas polluer les listes. L'utilisateur peut activer le toggle
// dans la barre d'outils pour les voir.
let showArchivedProjects = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(text = "") {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function formatRelativeDate(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `il y a ${days} j`;
  return formatDate(isoString);
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1) return "0 B";
  const units = ["B", "Ko", "Mo", "Go"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(val >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function showToast(message, isError = false) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3500);
}

function exportKindMeta(kind, fileName = "") {
  const lower = (fileName || "").toLowerCase();
  if (kind === "inspectionPDF" || lower.endsWith(".pdf")) {
    return { icon: "📄", cls: "pdf", label: "PDF" };
  }
  if (kind === "mediaArchive" || lower.endsWith(".usdz") || lower.endsWith(".zip")) {
    return { icon: lower.endsWith(".usdz") ? "🧊" : "🗂️", cls: "media",
             label: lower.endsWith(".usdz") ? "Modèle 3D" : "Archive" };
  }
  if (kind === "inspectionBundle" || lower.endsWith(".json")) {
    return { icon: "📦", cls: "bundle", label: "Sauvegarde complète" };
  }
  return { icon: "📁", cls: "unknown", label: kind || "Fichier" };
}

// Cache du contenu des bundles (évite re-fetch à chaque render)
const _bundleContentsCache = new Map(); // exportID → { pdfs, images, usdz, json }

async function loadBundleContentSummary(exportID) {
  if (_bundleContentsCache.has(exportID)) return _bundleContentsCache.get(exportID);
  try {
    const data = await fetchExportContents(exportID);
    const summary = { pdfs: 0, images: 0, usdz: 0, json: 0, binary: 0, total: 0 };
    for (const f of data.files || []) {
      if (summary[f.kind + "s"] !== undefined) summary[f.kind + "s"]++;
      else summary[f.kind]++;
      summary.total++;
    }
    _bundleContentsCache.set(exportID, summary);
    return summary;
  } catch {
    return null;
  }
}

// Met à jour les labels des bundles dans le DOM en arrière-plan
async function decorateBundlesAsync() {
  const items = document.querySelectorAll('.bundle-summary[data-export-id]');
  for (const el of items) {
    const id = el.dataset.exportId;
    if (el.dataset.loaded === "1") continue;
    const summary = await loadBundleContentSummary(id);
    if (!summary) continue;
    const parts = [];
    if (summary.pdfs) parts.push(`📄 ${summary.pdfs} PDF`);
    if (summary.images) parts.push(`🖼 ${summary.images} photo${summary.images > 1 ? "s" : ""}`);
    if (summary.usdz) parts.push(`🧊 ${summary.usdz} modèle 3D`);
    if (summary.json) parts.push(`📝 ${summary.json} rapport`);
    if (parts.length === 0) continue;
    el.textContent = "📦 Contient : " + parts.join(" · ");
    el.dataset.loaded = "1";
    el.style.display = "block";
  }
}

function inspectionTypeLabel(t) {
  switch (t) {
    case "entry": return "🟢 Entrée";
    case "exit":  return "🟠 Sortie";
    case "inventory": return "🟣 Inventaire";
    default: return "⚪ Autre";
  }
}

// Détermine l'état d'avancement d'un bien
function bienStatus(bien) {
  const e = bien.counts?.entry || 0;
  const x = bien.counts?.exit || 0;
  if (e > 0 && x > 0) return "ready";        // prêt à comparer
  if (e > 0 && x === 0) return "awaiting";   // en attente de sortie
  if (e === 0 && x > 0) return "orphan";     // sortie sans entrée
  return "solo";                              // que des inventaires/autres
}

function bienStatusLabel(status) {
  switch (status) {
    case "ready":    return "🔵 Prêt à comparer";
    case "awaiting": return "🟢 En attente de sortie";
    case "orphan":   return "🟠 Sortie sans entrée";
    default:         return "⚪ En cours";
  }
}

// ── BANDEAU STATUT COMPTE (essai 7j / illimité / expiré) ──────────────────
// Affiche un bandeau coloré au-dessus du dashboard selon le statut :
//   trial (≥4j restants) : orange "X jours d'essai gratuit"
//   trial (≤3j)          : rouge clignotant "Plus que X jours - paie 200€"
//   expired              : rouge "Essai expiré, paie 200€ pour débloquer"
//   lifetime             : vert "Compte illimité à vie ✓"
//   subscription         : pas de bandeau (compte payant standard)
function renderTrialBanner(user) {
  const root = document.getElementById("trial-banner");
  if (!root || !user) return;

  const status = user.accessStatus || "trial";
  const days = Number(user.trialDaysRemaining) || 0;
  const trialEnd = user.trialEndsAt ? new Date(user.trialEndsAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) : "";

  if (status === "lifetime") {
    root.style.display = "";
    root.className = "trial-banner is-lifetime";
    root.innerHTML = `
      <div class="trial-banner-icon">✓</div>
      <div class="trial-banner-content">
        <div class="trial-banner-title">Compte illimité à vie</div>
        <div class="trial-banner-sub">Vous faites partie des founders FOXSCAN. Accès complet à toutes les fonctionnalités, sans limite de durée. Mises à jour incluses à vie.</div>
      </div>
    `;
    return;
  }

  if (status === "subscription") {
    // Compte avec abonnement Stripe actif → on cache le bandeau (UX épurée)
    root.style.display = "none";
    return;
  }

  if (status === "expired") {
    root.style.display = "";
    root.className = "trial-banner is-expired";
    root.innerHTML = `
      <div class="trial-banner-icon">⚠</div>
      <div class="trial-banner-content">
        <div class="trial-banner-title">Essai gratuit expiré</div>
        <div class="trial-banner-sub">Votre période d'essai de 7 jours est terminée. Pour continuer à utiliser FOXSCAN, débloquez votre accès à vie pour <strong>200 €</strong> (paiement unique, mises à jour à vie incluses).</div>
      </div>
      <a href="../index.html#pricing" class="trial-banner-cta">Débloquer pour 200€ →</a>
    `;
    return;
  }

  // Trial actif (4-7 jours OU 1-3 jours)
  const isWarning = days <= 3;
  root.style.display = "";
  root.className = "trial-banner " + (isWarning ? "is-trial-warning" : "is-trial");
  if (isWarning) {
    root.innerHTML = `
      <div class="trial-banner-icon">⏱</div>
      <div class="trial-banner-content">
        <div class="trial-banner-title">Plus que ${days} jour${days > 1 ? "s" : ""} dans votre essai gratuit</div>
        <div class="trial-banner-sub">L'essai expire le <strong>${trialEnd}</strong>. Débloquez votre accès <strong>à vie pour 200 €</strong> dès maintenant et soutenez le lancement de FOXSCAN.</div>
      </div>
      <a href="../index.html#pricing" class="trial-banner-cta">Passer en illimité 200€ →</a>
    `;
  } else {
    root.innerHTML = `
      <div class="trial-banner-icon">🎁</div>
      <div class="trial-banner-content">
        <div class="trial-banner-title">${days} jours d'essai gratuit restants</div>
        <div class="trial-banner-sub">Vous êtes en essai gratuit jusqu'au <strong>${trialEnd}</strong>. Profitez-en pour explorer toutes les fonctionnalités. Pour bloquer votre accès à vie : <strong>200 € paiement unique</strong> (Avantage Spécial 20 premiers).</div>
      </div>
      <a href="../index.html#pricing" class="trial-banner-cta">Voir l'offre 200€ →</a>
    `;
  }
}

// ── User header ───────────────────────────────────────────────────────────────
function setUserHeader(user) {
  const initial = (user?.name || "U").charAt(0).toUpperCase();
  document.getElementById("userAvatar").textContent = initial;
  document.getElementById("userName").textContent = user?.name || "—";
  const firstName = (user?.name || "").split(" ")[0] || "";
  document.getElementById("welcomeTitle").textContent =
    firstName ? `Bonjour, ${firstName} 👋` : "Bonjour 👋";
}

// ── MES BIENS (vue principale) ────────────────────────────────────────────────
function updateBiensStats() {
  const total = allBiens.length;
  const totalEntry = allBiens.reduce((s, b) => s + (b.counts?.entry || 0), 0);
  const totalExit = allBiens.reduce((s, b) => s + (b.counts?.exit || 0), 0);
  const ready = allBiens.filter((b) => bienStatus(b) === "ready").length;

  document.getElementById("bienTotal").textContent = String(total);
  document.getElementById("bienEntry").textContent = String(totalEntry);
  document.getElementById("bienExit").textContent = String(totalExit);
  document.getElementById("bienCompare").textContent = String(ready);
}

function filterBiens() {
  const q = (document.getElementById("bienSearch")?.value || "").toLowerCase();
  const statusFilter = document.getElementById("bienStatus")?.value || "";
  return allBiens.filter((b) => {
    if (statusFilter && bienStatus(b) !== statusFilter) return false;
    if (q) {
      const hay = `${b.address || ""} ${b.tenantName || ""} ${b.propertyID}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

window.renderBiens = function renderBiens() {
  const root = document.getElementById("biens-list");

  if (!allBiens.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <p>Aucun bien immobilier enregistré pour le moment.<br>Depuis l'app FOXSCAN, lance un EDL en précisant l'adresse du bien — il apparaîtra ici.</p>
        <button class="btn-ghost" onclick="openApp()">Ouvrir l'app</button>
      </div>
    `;
    return;
  }

  const filtered = filterBiens();
  if (!filtered.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>Aucun bien ne correspond à ta recherche.</p>
      </div>
    `;
    return;
  }

  root.innerHTML = filtered.map((b) => {
    const status = bienStatus(b);
    const e = b.counts?.entry || 0;
    const x = b.counts?.exit || 0;
    const inv = b.counts?.inventory || 0;
    const canCompare = e > 0 && x > 0;

    return `
      <div class="bien-card" data-prop="${escapeHtml(b.propertyID)}">
        <div class="bien-header" onclick="showBienDetail('${escapeHtml(b.propertyID)}')">
          <div class="bien-icon">🏠</div>
          <div class="bien-header-title-wrap">
            <div class="bien-address">${escapeHtml(b.address || "Adresse non précisée")}</div>
            <div class="bien-tenant">
              ${b.tenantName ? `👤 ${escapeHtml(b.tenantName)}` : "<em style='color:var(--text3)'>Pas de locataire renseigné</em>"}
              <span style="margin-left:auto;color:var(--text3);font-size:11px">Dernière activité ${formatRelativeDate(b.lastSeenAt)}</span>
            </div>
            <div class="bien-click-hint">→ Cliquez pour voir tous les détails</div>
          </div>
          <span class="bien-status ${status}">${bienStatusLabel(status)}</span>
        </div>

        <div class="bien-counts">
          <div class="count-pill">
            <div class="count-icon entry">🟢</div>
            <div>
              <div class="count-label">Entrée</div>
              <div class="count-value">${e}</div>
            </div>
          </div>
          <div class="count-pill">
            <div class="count-icon exit">🟠</div>
            <div>
              <div class="count-label">Sortie</div>
              <div class="count-value">${x}</div>
            </div>
          </div>
          <div class="count-pill">
            <div class="count-icon inv">🟣</div>
            <div>
              <div class="count-label">Inventaire/Autre</div>
              <div class="count-value">${inv + (b.counts?.other || 0)}</div>
            </div>
          </div>
        </div>

        <div class="bien-actions">
          <button class="btn-mobile" onclick="event.stopPropagation();openExitEDLModal('${escapeHtml(b.propertyID)}')" title="Envoyer ce bien sur l'iPhone pour l'EDL de sortie">
            📱 EDL de sortie sur iPhone
          </button>
          <button class="btn-compare" onclick="event.stopPropagation();openComparison('${escapeHtml(b.propertyID)}')" ${canCompare ? "" : "disabled title='Il faut au moins 1 EDL d entrée et 1 EDL de sortie pour comparer'"}>
            ${canCompare ? "🔄 Comparer" : "🔄 Indispo"}
          </button>
          <button class="btn-secondary toggle" onclick="event.stopPropagation();toggleBienFiles('${escapeHtml(b.propertyID)}')">${b.exports.length} fichier${b.exports.length > 1 ? "s" : ""}</button>
        </div>

        <div class="bien-files">
          ${b.exports.map((e) => {
            const meta = exportKindMeta(e.kind, e.fileName);
            const isBundle = e.kind === "inspectionBundle" || (e.fileName || "").toLowerCase().endsWith(".json");
            return `
              <div class="export-item" style="cursor:pointer;${isBundle ? 'background:linear-gradient(90deg,#FFF5E5 0%,#FFFFFF 60%);border-left:3px solid #FF9F0A;padding-left:14px' : ''}" onclick="openViewer('${e.id}')" title="Cliquez pour visualiser">
                <div class="export-icon ${meta.cls}">${meta.icon}</div>
                <div class="export-info">
                  <div class="export-name" title="${escapeHtml(e.fileName)}">${escapeHtml(e.fileName)}</div>
                  <div class="export-meta">
                    <span>${inspectionTypeLabel(e.inspectionType)}</span>
                    <span>•</span>
                    <span>${meta.label}</span>
                    <span>•</span>
                    <span>${formatBytes(e.sizeBytes)}</span>
                    <span>•</span>
                    <span>${formatDate(e.inspectionDate || e.createdAt)}</span>
                  </div>
                  ${isBundle ? `<div class="bundle-summary" data-export-id="${e.id}" style="display:none;font-size:11px;color:#7A4A00;font-weight:600;margin-top:4px"></div>` : ''}
                </div>
                <div class="export-actions">
                  ${isBundle ? `<button class="btn-icon" style="background:#0071E3;color:white;border-color:#0071E3;width:auto;padding:0 12px;font-weight:700" title="Visualiser le contenu (photos + 3D)" onclick="event.stopPropagation();openViewer('${e.id}')">👁 Voir</button>` : `<button class="btn-icon" title="Visualiser" onclick="event.stopPropagation();openViewer('${e.id}')">👁</button>`}
                  <button class="btn-icon" title="Télécharger" onclick="event.stopPropagation();handleDownload('${e.id}')">⬇</button>
                  <button class="btn-icon danger" title="Supprimer" onclick="event.stopPropagation();handleDelete('${e.id}')">🗑</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }).join("");
  // Décompte des contenus de bundles en arrière-plan
  setTimeout(() => decorateBundlesAsync(), 200);
};

window.toggleBienFiles = function toggleBienFiles(propertyID) {
  const card = document.querySelector(`.bien-card[data-prop="${propertyID}"]`);
  if (card) {
    card.classList.toggle("expanded");
    // Décompte du contenu des bundles dès qu'on ouvre la liste
    if (card.classList.contains("expanded")) decorateBundlesAsync();
  }
};

window.openComparison = function openComparison(propertyID) {
  window.location.href = `comparison.html?propertyID=${encodeURIComponent(propertyID)}`;
};

// ── MODALES ───────────────────────────────────────────────────────────────────
window.closeModal = function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("show");
};

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("show");
}

// ── MODALE : Détail d'un bien (vue complète au clic sur la carte) ────────────
window.showBienDetail = function showBienDetail(propertyID) {
  const b = allBiens.find((x) => x.propertyID === propertyID);
  if (!b) return;
  const status = bienStatus(b);
  const e = b.counts?.entry || 0;
  const x = b.counts?.exit || 0;
  const totalSize = b.exports.reduce((s, ex) => s + (ex.sizeBytes || 0), 0);
  const canCompare = e > 0 && x > 0;

  document.getElementById("modalBienTitle").textContent = b.address || "Bien immobilier";
  document.getElementById("modalBienBody").innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid var(--bg2)">
      <div style="width:54px;height:54px;border-radius:14px;background:linear-gradient(135deg,var(--blue),#6E40C9);display:flex;align-items:center;justify-content:center;font-size:26px;color:white;flex-shrink:0">🏠</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:18px;font-weight:700;margin-bottom:4px">${escapeHtml(b.address || "Adresse non précisée")}</div>
        <div style="font-size:13px;color:var(--text2)">
          ${b.tenantName ? `👤 ${escapeHtml(b.tenantName)}` : "<em>Pas de locataire renseigné</em>"} ·
          <span class="bien-status ${status}" style="font-size:11px">${bienStatusLabel(status)}</span>
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
      <div style="padding:14px;background:var(--bg2);border-radius:10px;text-align:center">
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin-bottom:4px">Entrées</div>
        <div style="font-size:22px;font-weight:700;color:var(--green)">${e}</div>
      </div>
      <div style="padding:14px;background:var(--bg2);border-radius:10px;text-align:center">
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin-bottom:4px">Sorties</div>
        <div style="font-size:22px;font-weight:700;color:var(--orange)">${x}</div>
      </div>
      <div style="padding:14px;background:var(--bg2);border-radius:10px;text-align:center">
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin-bottom:4px">Fichiers</div>
        <div style="font-size:22px;font-weight:700">${b.exports.length}</div>
      </div>
      <div style="padding:14px;background:var(--bg2);border-radius:10px;text-align:center">
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin-bottom:4px">Espace</div>
        <div style="font-size:22px;font-weight:700">${formatBytes(totalSize)}</div>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
      <button class="btn-mobile" onclick="closeModal('modalBien');openExitEDLModal('${escapeHtml(b.propertyID)}')" style="flex:1;min-width:200px">
        📱 Préparer EDL de sortie sur iPhone
      </button>
      <button class="btn-compare" onclick="closeModal('modalBien');openComparison('${escapeHtml(b.propertyID)}')" ${canCompare ? "" : "disabled"} style="flex:1;min-width:160px">
        ${canCompare ? "🔄 Comparer entrée/sortie" : "🔄 Comparaison indispo"}
      </button>
    </div>

    <!-- Sections preview directes (PDF + Photos + 3D) du 1er bundle extrait -->
    <div id="bienPreviewSections-${escapeHtml(b.propertyID)}"></div>

    <div style="margin-top:18px;padding:14px 16px;background:var(--bg2);border-radius:10px;font-size:12px;color:var(--text2);line-height:1.5">
      💡 Pour gérer tous les rapports, photos et modèles 3D de ce bien, utilisez les onglets
      <strong>Rapports</strong>, <strong>Photos</strong> et <strong>Modèles 3D</strong> du dashboard.
    </div>
  `;
  openModal("modalBien");
  // Charger les preview directes (PDF + photos + 3D) pour le 1er bundle extrait du bien
  loadBienPreviewSections(b);
};

// Affiche directement le PDF + photos + 3D du 1er bundle extrait du bien,
// sans avoir besoin d'ouvrir le viewer séparé.
async function loadBienPreviewSections(bien) {
  const container = document.getElementById(`bienPreviewSections-${bien.propertyID}`);
  if (!container) return;

  // Trouver le 1er export de ce bien qui a été extrait
  const extractedExp = bien.exports.find((e) => e.extractedProjectID);
  if (!extractedExp) {
    container.innerHTML = `
      <div style="background:var(--bg2);border-radius:12px;padding:18px;color:var(--text2);font-size:13px;text-align:center">
        💡 Pour voir le PDF, les photos et le modèle 3D directement ici, votre app doit envoyer un bundle JSON
        complet (avec <code>inspection_report.json</code>). Les fichiers ci-dessous restent téléchargeables.
      </div>
    `;
    return;
  }

  const projectID = extractedExp.extractedProjectID;
  container.innerHTML = `<div style="text-align:center;color:var(--text2);padding:40px">⏳ Chargement du contenu…</div>`;

  try {
    const data = await fetchProjectFiles(projectID);
    const files = data.files || [];
    const photos = files.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f.path));
    const usdz = files.filter((f) => /\.usdz$/i.test(f.path));

    // Section 1 : PDF (toujours dispo grâce au generator de fallback)
    const pdfHTML = `
      <div style="background:#fff;border:1px solid var(--bg3);border-radius:14px;padding:16px;margin-bottom:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;background:#FFEFEE;color:#D92B20;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px">📄</div>
            <div>
              <div style="font-weight:700">Rapport PDF</div>
              <div style="font-size:11px;color:var(--text2)" id="pdfSourceLabel-${projectID}">Chargement…</div>
            </div>
          </div>
          <button class="btn-ghost" onclick="downloadProjectPDF('${projectID}')">⬇ Télécharger</button>
        </div>
        <div id="pdfFrame-${projectID}" style="height:520px;border-radius:8px;overflow:hidden;background:#F5F5F7;display:flex;align-items:center;justify-content:center;color:var(--text2)">
          ⏳ Chargement du PDF…
        </div>
      </div>
    `;

    // Section 2 : Photos (grille de thumbnails)
    let photosHTML = "";
    if (photos.length > 0) {
      photosHTML = `
        <div style="background:#fff;border:1px solid var(--bg3);border-radius:14px;padding:16px;margin-bottom:18px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
            <div style="width:36px;height:36px;background:#EBF4FF;color:#0062c4;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px">🖼</div>
            <div>
              <div style="font-weight:700">Photos de l'état des lieux</div>
              <div style="font-size:11px;color:var(--text2)">${photos.length} photo${photos.length > 1 ? "s" : ""} prise${photos.length > 1 ? "s" : ""} pendant l'inspection</div>
            </div>
          </div>
          <div id="photosGrid-${projectID}" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px"></div>
        </div>
      `;
    }

    // Section 3 : Modèle 3D
    let usdzHTML = "";
    if (usdz.length > 0) {
      usdzHTML = `
        <div style="background:#fff;border:1px solid var(--bg3);border-radius:14px;padding:16px;margin-bottom:18px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:36px;height:36px;background:#F6EEFE;color:#7B2CBF;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px">🧊</div>
              <div>
                <div style="font-weight:700">Modèle 3D LiDAR</div>
                <div style="font-size:11px;color:var(--text2)">${usdz.length} scan${usdz.length > 1 ? "s" : ""} 3D · format USDZ</div>
              </div>
            </div>
            <div style="display:flex;gap:6px">
              ${usdz.map((u, i) => `<button class="btn-ghost" onclick="downloadProjectFile('${projectID}','${escapeHtml(u.path)}')">⬇ Scan ${i+1}</button>`).join("")}
            </div>
          </div>
          <div style="margin-top:10px;padding:10px;background:#F6EEFE;border-radius:8px;font-size:12px;color:#7B2CBF">
            💡 Pour visualiser en 3D : téléchargez et ouvrez avec <strong>Aperçu</strong> (Mac) ou <strong>Safari</strong> (iPhone).
          </div>
        </div>
      `;
    }

    container.innerHTML = pdfHTML + photosHTML + usdzHTML;

    // Charger le PDF en async
    try {
      const { blobUrl, source, size } = await getProjectPDFBlobURL(projectID);
      _viewerCurrentBlobs.push(blobUrl);
      document.getElementById(`pdfFrame-${projectID}`).innerHTML = `<iframe src="${blobUrl}" style="width:100%;height:100%;border:0"></iframe>`;
      const sourceLabel = source === "native"
        ? `📱 PDF original de l'app FOXSCAN (${formatBytes(size)})`
        : `⚙️ PDF généré côté serveur (${formatBytes(size)})`;
      document.getElementById(`pdfSourceLabel-${projectID}`).textContent = sourceLabel;
    } catch (err) {
      document.getElementById(`pdfFrame-${projectID}`).innerHTML = `<div style="text-align:center;color:var(--red);padding:40px">❌ ${escapeHtml(err.message)}</div>`;
    }

    // Charger les thumbnails des photos en async
    if (photos.length > 0) {
      const grid = document.getElementById(`photosGrid-${projectID}`);
      for (const photo of photos) {
        const thumb = document.createElement("div");
        thumb.style.cssText = "aspect-ratio:1;background:var(--bg2);border-radius:8px;overflow:hidden;cursor:pointer;position:relative";
        thumb.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:24px">⏳</div>`;
        thumb.title = photo.path.split("/").pop();
        grid.appendChild(thumb);
        // Charger la photo
        getProjectFileBlobURL(projectID, photo.path).then(({ blobUrl }) => {
          _viewerCurrentBlobs.push(blobUrl);
          thumb.innerHTML = `<img src="${blobUrl}" style="width:100%;height:100%;object-fit:cover" alt="${escapeHtml(photo.path)}"/>`;
          thumb.onclick = () => openLightbox(blobUrl, photo.path);
        }).catch(() => {
          thumb.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--red);font-size:18px">❌</div>`;
        });
      }
    }
  } catch (err) {
    container.innerHTML = `<div style="background:#FFEFEE;border:1px solid #FF3B30;color:#D92B20;border-radius:10px;padding:14px;font-size:13px">❌ ${escapeHtml(err.message || "Erreur")}</div>`;
  }
}

// Lightbox photo plein écran (clic sur thumbnail)
window.openLightbox = function openLightbox(blobUrl, fileName) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out";
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `
    <img src="${blobUrl}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.5)" alt="${escapeHtml(fileName)}"/>
    <button style="position:absolute;top:18px;right:18px;width:40px;height:40px;border-radius:50%;background:#fff;border:none;font-size:22px;cursor:pointer">×</button>
  `;
  document.body.appendChild(overlay);
};

window.downloadProjectPDF = async function downloadProjectPDF(projectID) {
  try {
    const { blobUrl } = await getProjectPDFBlobURL(projectID);
    const a = document.createElement("a"); a.href = blobUrl; a.download = "EDL_rapport.pdf"; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } catch (err) { showToast("Erreur : " + err.message, true); }
};

window.downloadProjectFile = async function downloadProjectFile(projectID, filePath) {
  try {
    const { blobUrl } = await getProjectFileBlobURL(projectID, filePath);
    const a = document.createElement("a"); a.href = blobUrl; a.download = filePath.split("/").pop(); document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } catch (err) { showToast("Erreur : " + err.message, true); }
};

// ── MODALE : QR code pour préparer EDL de sortie sur iPhone ──────────────────
window.openExitEDLModal = function openExitEDLModal(propertyID) {
  const b = allBiens.find((x) => x.propertyID === propertyID);
  if (!b) return;
  // Deep link FOXSCAN qui ouvre l'app et pré-remplit l'EDL de sortie
  // Format : foxscan://prepare-exit?propertyID=...&address=...&tenant=...
  const params = new URLSearchParams({
    propertyID: b.propertyID,
    address: b.address || "",
    tenant: b.tenantName || "",
  });
  const deepLink = `foxscan://prepare-exit?${params.toString()}`;
  // Universal Link de fallback (au cas où le deep link ne marche pas, ouvre une page web qui redirige)
  const universalLink = `https://foxscan.fr/open?${params.toString()}`;

  // QR code via api.qrserver.com (gratuit, sans clé)
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=${encodeURIComponent(deepLink)}`;
  document.getElementById("qrImg").src = qrUrl;
  document.getElementById("qrLink").value = deepLink;
  document.getElementById("qrBienInfo").innerHTML = `
    <div style="font-weight:700;color:var(--text);margin-bottom:4px">🏠 ${escapeHtml(b.address || "Bien")}</div>
    ${b.tenantName ? `<div style="color:var(--text2)">👤 ${escapeHtml(b.tenantName)}</div>` : ""}
    <div style="color:var(--text3);font-size:12px;margin-top:4px">${b.counts?.entry || 0} entrée(s) déjà enregistrée(s)</div>
  `;
  openModal("modalQR");
};

window.copyQRLink = function copyQRLink() {
  const input = document.getElementById("qrLink");
  input.select();
  input.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(input.value).then(
    () => showToast("✓ Lien copié dans le presse-papier"),
    () => { document.execCommand("copy"); showToast("✓ Lien copié"); }
  );
};

// ── MODALE : Viewer du bundle (PDF, photos, USDZ) ────────────────────────────
let _viewerCurrentBlobs = []; // pour révoquer les blob URLs au close

window.openViewer = async function openViewer(exportID) {
  const allFiles = [...allExports, ...allBiens.flatMap((b) => b.exports)];
  const exp = allFiles.find((e) => e.id === exportID);
  if (!exp) { showToast("Fichier introuvable", true); return; }

  // ✅ Si l'export est un bundle qui a déjà été extrait sur disque, utiliser
  // les nouvelles routes /api/projects/* (PDF natif servi directement, plus
  // rapide et plus propre que le parsing base64 à la volée)
  if (exp.extractedProjectID) {
    return openViewerNative(exp.extractedProjectID, exp.fileName);
  }

  document.getElementById("modalViewerTitle").textContent = exp.fileName || "Fichier";
  document.getElementById("viewerFileList").innerHTML = '<div style="color:var(--text2);padding:14px;font-size:13px;text-align:center">⏳ Chargement…</div>';
  document.getElementById("viewerStage").innerHTML = `
    <div class="viewer-loading">
      <div class="viewer-loading-spinner"></div>
      <div>Décodage du fichier…</div>
    </div>
  `;
  openModal("modalViewer");

  try {
    const data = await fetchExportContents(exportID);
    const files = data.files || [];

    // Trier les fichiers : PDF en haut, puis images, USDZ, JSON, autres
    const order = { pdf: 0, image: 1, usdz: 2, json: 3, binary: 4 };
    files.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

    // Construire la sidebar
    const groups = { pdf: [], image: [], usdz: [], json: [], binary: [] };
    files.forEach((f) => (groups[f.kind] || groups.binary).push(f));

    const sectionTitle = (k) => ({
      pdf: "📄 Documents PDF",
      image: "🖼 Photos",
      usdz: "🧊 Modèles 3D",
      json: "📝 Données JSON",
      binary: "📁 Autres fichiers",
    })[k];

    let sidebarHTML = "";
    if (data.isBundle) {
      sidebarHTML += `
        <div class="viewer-bundle-info">
          <strong>📦 Sauvegarde complète</strong>
          <small>${files.length} fichier${files.length > 1 ? "s" : ""}${data.exportedAt ? ` · ${formatDate(data.exportedAt)}` : ""}</small>
        </div>
      `;
      // ENTRÉE SPÉCIALE : PDF généré côté serveur depuis le inspection_report.json
      sidebarHTML += `<div class="viewer-section-title">📄 Rapport PDF (généré à partir des données)</div>`;
      sidebarHTML += `
        <a class="viewer-file-item" data-idx="generated-pdf" data-kind="pdf" onclick="viewerSelectGeneratedPDF('${exportID}')" style="background:linear-gradient(90deg,#FFF0EE,#FFFFFF);border-left:3px solid #FF3B30">
          <div class="viewer-file-icon pdf">📄</div>
          <div class="viewer-file-name">EDL_rapport.pdf</div>
          <div class="viewer-file-meta" style="color:#FF3B30;font-weight:700">⚡ généré</div>
        </a>
      `;
    }
    for (const k of ["pdf", "image", "usdz", "json", "binary"]) {
      if (!groups[k].length) continue;
      sidebarHTML += `<div class="viewer-section-title">${sectionTitle(k)} (${groups[k].length})</div>`;
      sidebarHTML += groups[k].map((f) => `
        <a class="viewer-file-item" data-idx="${f.index}" data-kind="${f.kind}" onclick="viewerSelectFile('${exportID}', ${f.index}, '${escapeHtml(f.path)}', '${f.kind}')">
          <div class="viewer-file-icon ${f.kind}">${({pdf:"📄",image:"🖼",usdz:"🧊",json:"📝"}[f.kind]||"📁")}</div>
          <div class="viewer-file-name" title="${escapeHtml(f.path)}">${escapeHtml(f.path.split("/").pop())}</div>
          <div class="viewer-file-meta">${formatBytes(f.sizeBytes)}</div>
        </a>
      `).join("");
    }

    if (!files.length) {
      sidebarHTML = '<div style="color:var(--text2);padding:24px 14px;text-align:center;font-size:13px">Aucun fichier dans ce bundle.</div>';
    }
    document.getElementById("viewerFileList").innerHTML = sidebarHTML;

    // Auto-sélectionne en priorité : PDF généré (pour les bundles) > PDF embarqué > image > USDZ
    if (data.isBundle) {
      window.viewerSelectGeneratedPDF(exportID);
    } else {
      const first = groups.pdf[0] || groups.image[0] || groups.usdz[0] || files[0];
      if (first) {
        window.viewerSelectFile(exportID, first.index, first.path, first.kind);
      } else {
        document.getElementById("viewerStage").innerHTML = `
          <div class="viewer-empty">
            <div style="font-size:48px;opacity:.3">⚠️</div>
            <p>Ce fichier ne contient rien d'affichable.</p>
          </div>
        `;
      }
    }
  } catch (err) {
    console.error(err);
    showToast("Erreur lors du chargement : " + (err.message || ""), true);
    document.getElementById("viewerStage").innerHTML = `
      <div class="viewer-empty">
        <div style="font-size:48px;opacity:.3">❌</div>
        <p>${escapeHtml(err.message || "Erreur de chargement")}</p>
      </div>
    `;
  }
};

// ── VIEWER NATIF : utilise /api/projects/<id>/* pour les bundles extraits ──
// Plus performant : pas de décodage base64 côté client, le PDF est servi
// directement par le serveur avec le bon Content-Type.
window.openViewerNative = async function openViewerNative(projectID, originalFileName) {
  document.getElementById("modalViewerTitle").textContent = originalFileName || "Projet";
  document.getElementById("viewerFileList").innerHTML = '<div style="color:var(--text2);padding:14px;font-size:13px;text-align:center">⏳ Chargement…</div>';
  document.getElementById("viewerStage").innerHTML = `
    <div class="viewer-loading">
      <div class="viewer-loading-spinner"></div>
      <div>Chargement du PDF…</div>
    </div>
  `;
  openModal("modalViewer");

  try {
    const data = await fetchProjectFiles(projectID);
    const files = data.files || [];

    // Tri par type
    const groups = { pdf: [], image: [], usdz: [], json: [], binary: [] };
    files.forEach((f) => {
      const lower = f.path.toLowerCase();
      if (lower.endsWith(".pdf")) groups.pdf.push(f);
      else if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) groups.image.push(f);
      else if (lower.endsWith(".usdz")) groups.usdz.push(f);
      else if (lower.endsWith(".json")) groups.json.push(f);
      else groups.binary.push(f);
    });

    const sectionTitle = (k) => ({ pdf: "📄 PDF", image: "🖼 Photos", usdz: "🧊 Modèles 3D", json: "📝 Données", binary: "📁 Autres" })[k];
    let sidebarHTML = `
      <div class="viewer-bundle-info">
        <strong>📦 Projet extrait</strong>
        <small>${files.length} fichier${files.length > 1 ? "s" : ""}</small>
      </div>
    `;
    // Bouton spécial : PDF intelligent (natif si dispo, sinon généré)
    sidebarHTML += `<div class="viewer-section-title">📄 Rapport EDL</div>`;
    sidebarHTML += `
      <a class="viewer-file-item active" data-key="pdf-smart" onclick="viewerSelectProjectPDF('${projectID}')" style="background:linear-gradient(90deg,#FFF0EE,#FFFFFF);border-left:3px solid #FF3B30">
        <div class="viewer-file-icon pdf">📄</div>
        <div class="viewer-file-name">EDL_rapport.pdf</div>
        <div class="viewer-file-meta" style="color:#FF3B30;font-weight:700">⚡ auto</div>
      </a>
    `;
    for (const k of ["image", "usdz", "json", "binary"]) {
      if (!groups[k].length) continue;
      sidebarHTML += `<div class="viewer-section-title">${sectionTitle(k)} (${groups[k].length})</div>`;
      sidebarHTML += groups[k].map((f) => `
        <a class="viewer-file-item" data-path="${escapeHtml(f.path)}" onclick="viewerSelectProjectFile('${projectID}', '${escapeHtml(f.path)}', '${k}')">
          <div class="viewer-file-icon ${k}">${({pdf:"📄",image:"🖼",usdz:"🧊",json:"📝"}[k]||"📁")}</div>
          <div class="viewer-file-name" title="${escapeHtml(f.path)}">${escapeHtml(f.path.split("/").pop())}</div>
          <div class="viewer-file-meta">${formatBytes(f.sizeBytes)}</div>
        </a>
      `).join("");
    }
    document.getElementById("viewerFileList").innerHTML = sidebarHTML;

    // Auto-charge le PDF intelligent en premier
    window.viewerSelectProjectPDF(projectID);
  } catch (err) {
    console.error(err);
    document.getElementById("viewerStage").innerHTML = `
      <div class="viewer-empty">
        <div style="font-size:48px;opacity:.3">❌</div>
        <p>${escapeHtml(err.message || "Erreur de chargement")}</p>
      </div>
    `;
  }
};

window.viewerSelectProjectPDF = async function viewerSelectProjectPDF(projectID) {
  document.querySelectorAll(".viewer-file-item").forEach((el) => el.classList.remove("active"));
  const item = document.querySelector(`.viewer-file-item[data-key="pdf-smart"]`);
  if (item) item.classList.add("active");

  const stage = document.getElementById("viewerStage");
  stage.innerHTML = `
    <div class="viewer-loading">
      <div class="viewer-loading-spinner"></div>
      <div>Chargement du rapport PDF…</div>
    </div>
  `;
  try {
    const { blobUrl, source, size } = await getProjectPDFBlobURL(projectID);
    _viewerCurrentBlobs.push(blobUrl);
    const sourceLabel = source === "native" ? "📱 PDF original (app FOXSCAN)" : "⚙️ PDF généré côté serveur";
    stage.innerHTML = `
      <div class="viewer-toolbar">
        <span style="color:#fff;font-size:11px;font-weight:600;background:rgba(255,255,255,.1);padding:6px 10px;border-radius:6px">${sourceLabel}</span>
        <button class="viewer-tool" onclick="downloadBlob('${blobUrl}','EDL_rapport.pdf')">⬇ Télécharger</button>
      </div>
      <iframe class="viewer-pdf" src="${blobUrl}" title="EDL"></iframe>
    `;
    showToast(`✓ PDF chargé (${formatBytes(size)} · ${source})`);
  } catch (err) {
    stage.innerHTML = `<div class="viewer-empty"><div style="font-size:48px;opacity:.3">❌</div><p>${escapeHtml(err.message)}</p></div>`;
  }
};

window.viewerSelectProjectFile = async function viewerSelectProjectFile(projectID, filePath, kind) {
  document.querySelectorAll(".viewer-file-item").forEach((el) => el.classList.remove("active"));
  const item = document.querySelector(`.viewer-file-item[data-path="${filePath}"]`);
  if (item) item.classList.add("active");

  const stage = document.getElementById("viewerStage");
  stage.innerHTML = `<div class="viewer-loading"><div class="viewer-loading-spinner"></div><div>Chargement…</div></div>`;
  try {
    const { blobUrl, contentType, size } = await getProjectFileBlobURL(projectID, filePath);
    _viewerCurrentBlobs.push(blobUrl);
    const fileName = filePath.split("/").pop();
    const toolbar = `<div class="viewer-toolbar"><button class="viewer-tool" onclick="downloadBlob('${blobUrl}','${escapeHtml(fileName)}')">⬇ Télécharger</button></div>`;

    if (kind === "image" || contentType.startsWith("image/")) {
      stage.innerHTML = toolbar + `<img class="viewer-image" src="${blobUrl}" alt="${escapeHtml(fileName)}"/>`;
    } else if (kind === "usdz") {
      stage.innerHTML = toolbar + `
        <div style="padding:24px;text-align:center;color:#fff;max-width:520px">
          <div style="font-size:48px;margin-bottom:14px">🧊</div>
          <p style="margin-bottom:18px">Modèle 3D <strong>${escapeHtml(fileName)}</strong></p>
          <p style="font-size:13px;opacity:.7;margin-bottom:18px">Pour la vue 3D : ouvrez sur iPhone Safari ou avec Aperçu (macOS).</p>
          <button class="viewer-tool" style="background:rgba(255,255,255,.15);padding:12px 22px" onclick="downloadBlob('${blobUrl}','${escapeHtml(fileName)}')">⬇ Télécharger</button>
        </div>
      `;
    } else if (kind === "json" || contentType === "application/json") {
      const text = await (await fetch(blobUrl)).text();
      let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      stage.innerHTML = toolbar + `<pre style="margin:0;padding:24px;color:#A8DADC;background:#1D1D1F;font-family:Menlo,monospace;font-size:12px;white-space:pre-wrap;width:100%;height:100%;overflow:auto">${escapeHtml(pretty.slice(0, 100000))}</pre>`;
    } else if (kind === "pdf" || contentType === "application/pdf") {
      stage.innerHTML = toolbar + `<iframe class="viewer-pdf" src="${blobUrl}"></iframe>`;
    } else {
      stage.innerHTML = toolbar + `<div class="viewer-empty"><div style="font-size:48px">📁</div><p>Format non prévisualisable</p></div>`;
    }
  } catch (err) {
    stage.innerHTML = `<div class="viewer-empty"><div style="font-size:48px;opacity:.3">❌</div><p>${escapeHtml(err.message)}</p></div>`;
  }
};

window.viewerSelectFile = async function viewerSelectFile(exportID, fileIndex, filePath, kind) {
  // Highlight l'item sélectionné dans la sidebar
  document.querySelectorAll(".viewer-file-item").forEach((el) => el.classList.remove("active"));
  const item = document.querySelector(`.viewer-file-item[data-idx="${fileIndex}"]`);
  if (item) item.classList.add("active");

  const stage = document.getElementById("viewerStage");
  stage.innerHTML = `
    <div class="viewer-loading">
      <div class="viewer-loading-spinner"></div>
      <div>Téléchargement de ${escapeHtml(filePath.split("/").pop())}…</div>
    </div>
  `;

  try {
    const { blobUrl, contentType, size } = await getExportFileBlobURL(exportID, fileIndex);
    _viewerCurrentBlobs.push(blobUrl);

    const fileName = filePath.split("/").pop();
    const toolbar = `
      <div class="viewer-toolbar">
        <button class="viewer-tool" onclick="downloadBlob('${blobUrl}','${escapeHtml(fileName)}')">⬇ Télécharger</button>
      </div>
    `;

    if (kind === "pdf" || contentType === "application/pdf") {
      stage.innerHTML = toolbar + `<iframe class="viewer-pdf" src="${blobUrl}" title="${escapeHtml(fileName)}"></iframe>`;
    } else if (kind === "image" || contentType.startsWith("image/")) {
      stage.innerHTML = toolbar + `<img class="viewer-image" src="${blobUrl}" alt="${escapeHtml(fileName)}"/>`;
    } else if (kind === "usdz") {
      // model-viewer (Google) : supporte USDZ nativement sur Safari, GLB sur autres
      stage.innerHTML = toolbar + `
        <div style="padding:24px;text-align:center;color:#fff;max-width:520px">
          <div style="font-size:48px;margin-bottom:14px">🧊</div>
          <p style="margin-bottom:18px;line-height:1.6">Le modèle 3D <strong>${escapeHtml(fileName)}</strong> est un fichier USDZ (format Apple).</p>
          <p style="font-size:13px;opacity:.7;margin-bottom:18px">Pour le visualiser en 3D : ouvrez le lien sur un iPhone (Safari) ou téléchargez et ouvrez avec Aperçu sur Mac.</p>
          <button class="viewer-tool" style="background:rgba(255,255,255,.15);padding:12px 22px;font-size:14px" onclick="downloadBlob('${blobUrl}','${escapeHtml(fileName)}')">⬇ Télécharger le modèle 3D</button>
        </div>
      `;
    } else if (kind === "json") {
      // Affiche le JSON formatté
      const text = await (await fetch(blobUrl)).text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      stage.innerHTML = toolbar + `
        <pre style="margin:0;padding:24px;color:#A8DADC;background:#1D1D1F;font-family:Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;width:100%;height:100%;overflow:auto">${escapeHtml(pretty.slice(0, 100000))}${pretty.length > 100000 ? "\n\n[... tronqué, " + (pretty.length - 100000) + " chars en plus ...]" : ""}</pre>
      `;
    } else {
      stage.innerHTML = toolbar + `
        <div class="viewer-empty">
          <div style="font-size:48px;opacity:.3">📁</div>
          <p>Format non prévisualisable</p>
          <button class="viewer-tool" style="background:rgba(255,255,255,.15);margin-top:14px;padding:10px 20px" onclick="downloadBlob('${blobUrl}','${escapeHtml(fileName)}')">⬇ Télécharger</button>
        </div>
      `;
    }
  } catch (err) {
    console.error(err);
    stage.innerHTML = `
      <div class="viewer-empty">
        <div style="font-size:48px;opacity:.3">❌</div>
        <p>${escapeHtml(err.message || "Erreur de chargement")}</p>
      </div>
    `;
  }
};

window.viewerSelectGeneratedPDF = async function viewerSelectGeneratedPDF(exportID) {
  document.querySelectorAll(".viewer-file-item").forEach((el) => el.classList.remove("active"));
  const item = document.querySelector(`.viewer-file-item[data-idx="generated-pdf"]`);
  if (item) item.classList.add("active");

  const stage = document.getElementById("viewerStage");
  stage.innerHTML = `
    <div class="viewer-loading">
      <div class="viewer-loading-spinner"></div>
      <div>Génération du PDF à partir du rapport…</div>
      <div style="opacity:.6;font-size:12px;margin-top:6px">Cela prend quelques secondes</div>
    </div>
  `;

  try {
    const { blobUrl, size } = await getGeneratedPDFBlobURL(exportID);
    _viewerCurrentBlobs.push(blobUrl);
    const fileName = "EDL_rapport.pdf";
    const toolbar = `
      <div class="viewer-toolbar">
        <button class="viewer-tool" onclick="downloadBlob('${blobUrl}','${fileName}')">⬇ Télécharger</button>
      </div>
    `;
    stage.innerHTML = toolbar + `<iframe class="viewer-pdf" src="${blobUrl}" title="${fileName}"></iframe>`;
    showToast(`✓ PDF généré (${formatBytes(size)})`);
  } catch (err) {
    console.error(err);
    stage.innerHTML = `
      <div class="viewer-empty">
        <div style="font-size:48px;opacity:.3">❌</div>
        <p>Échec de la génération du PDF</p>
        <p style="font-size:13px;opacity:.7;max-width:400px;margin:14px auto 0">${escapeHtml(err.message || "")}</p>
      </div>
    `;
  }
};

window.downloadBlob = function downloadBlob(blobUrl, fileName) {
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

// Fermer les modales avec Échap
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay.show").forEach((m) => m.classList.remove("show"));
    // Révoquer les blob URLs du viewer pour libérer la RAM
    _viewerCurrentBlobs.forEach((u) => URL.revokeObjectURL(u));
    _viewerCurrentBlobs = [];
  }
});

// ── TOUS LES EXPORTS (vue secondaire) ─────────────────────────────────────────
function updateExportsStats() {
  const total = allExports.length;
  const totalSize = allExports.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
  const projectIds = new Set(allExports.map((e) => e.projectID).filter(Boolean));
  const last = allExports[0]?.createdAt;

  document.getElementById("expTotal").textContent = String(total);
  document.getElementById("expSize").textContent = formatBytes(totalSize);
  document.getElementById("expProjects").textContent = String(projectIds.size);
  document.getElementById("expLast").textContent = last ? formatRelativeDate(last) : "—";
}

function filterExports() {
  const q = (document.getElementById("expSearch")?.value || "").toLowerCase();
  const kind = document.getElementById("expKind")?.value || "";
  return allExports.filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (q) {
      const hay = `${e.fileName || ""} ${e.projectName || ""} ${e.projectID || ""} ${e.propertyAddress || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function groupExportsByProject(exports) {
  const groups = new Map();
  for (const e of exports) {
    const key = e.propertyID || e.projectID || "__no_key__";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: e.propertyAddress || e.projectName || (e.projectID ? `Projet ${e.projectID.slice(0, 8)}` : "Sans projet"),
        items: [],
        totalSize: 0,
        latestDate: null,
      });
    }
    const g = groups.get(key);
    g.items.push(e);
    g.totalSize += e.sizeBytes || 0;
    if (!g.latestDate || new Date(e.createdAt) > new Date(g.latestDate)) {
      g.latestDate = e.createdAt;
    }
  }
  return Array.from(groups.values()).sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate));
}

window.renderExports = function renderExports() {
  const root = document.getElementById("exports-list");
  if (!allExports.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📤</div>
        <p>Aucun export pour le moment.</p>
      </div>
    `;
    return;
  }
  const filtered = filterExports();
  if (!filtered.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>Aucun résultat.</p></div>`;
    return;
  }

  const groups = groupExportsByProject(filtered);
  root.innerHTML = groups.map((g, idx) => `
    <div class="project-group ${idx === 0 ? "open" : ""}" data-key="${escapeHtml(g.key)}">
      <div class="project-group-header" onclick="toggleProjectGroup(this)">
        <div>
          <div class="project-group-title">
            <div class="project-group-icon">📐</div>
            <div>
              <div>${escapeHtml(g.title)}</div>
              <div class="project-group-meta">${g.items.length} fichier${g.items.length > 1 ? "s" : ""} • ${formatBytes(g.totalSize)} • dernier ${formatRelativeDate(g.latestDate)}</div>
            </div>
          </div>
        </div>
        <span class="chevron">▶</span>
      </div>
      <div class="project-group-body">
        ${g.items.map((e) => {
          const meta = exportKindMeta(e.kind, e.fileName);
          const isBundle = e.kind === "inspectionBundle" || (e.fileName || "").toLowerCase().endsWith(".json");
          return `
            <div class="export-item" style="cursor:pointer;${isBundle ? 'background:linear-gradient(90deg,#FFF5E5 0%,#FFFFFF 60%);border-left:3px solid #FF9F0A;padding-left:14px' : ''}" onclick="openViewer('${e.id}')" title="Cliquez pour visualiser">
              <div class="export-icon ${meta.cls}">${meta.icon}</div>
              <div class="export-info">
                <div class="export-name" title="${escapeHtml(e.fileName)}">${escapeHtml(e.fileName)}</div>
                <div class="export-meta">
                  <span>${inspectionTypeLabel(e.inspectionType)}</span>
                  <span>•</span>
                  <span>${meta.label}</span>
                  <span>•</span>
                  <span>${formatBytes(e.sizeBytes)}</span>
                  <span>•</span>
                  <span>${formatDate(e.createdAt)}</span>
                </div>
                ${isBundle ? `<div class="bundle-summary" data-export-id="${e.id}" style="display:none;font-size:11px;color:#7A4A00;font-weight:600;margin-top:4px"></div>` : ''}
              </div>
              <div class="export-actions">
                ${isBundle ? `<button class="btn-icon" style="background:#0071E3;color:white;border-color:#0071E3;width:auto;padding:0 12px;font-weight:700" title="Visualiser le contenu (photos + 3D)" onclick="event.stopPropagation();openViewer('${e.id}')">👁 Voir</button>` : `<button class="btn-icon" title="Visualiser" onclick="event.stopPropagation();openViewer('${e.id}')">👁</button>`}
                <button class="btn-icon" title="Télécharger" onclick="event.stopPropagation();handleDownload('${e.id}')">⬇</button>
                <button class="btn-icon danger" title="Supprimer" onclick="event.stopPropagation();handleDelete('${e.id}')">🗑</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `).join("");
  // Décompter les contenus des bundles affichés
  setTimeout(() => decorateBundlesAsync(), 100);
};

window.toggleProjectGroup = function toggleProjectGroup(headerEl) {
  const group = headerEl.closest(".project-group");
  if (group) group.classList.toggle("open");
};

window.handleDownload = async function handleDownload(exportID) {
  const exp = allExports.find((e) => e.id === exportID)
            || allBiens.flatMap((b) => b.exports.map((e) => ({ ...e, downloadPath: e.downloadPath }))).find((e) => e.id === exportID);
  if (!exp || !exp.downloadPath) {
    showToast("Fichier introuvable", true);
    return;
  }
  try {
    showToast(`Téléchargement de ${exp.fileName}…`);
    await downloadExportFile(exp.downloadPath, exp.fileName);
  } catch (err) {
    console.error("Download error:", err);
    showToast(`Erreur : ${err.message || "téléchargement impossible"}`, true);
  }
};

window.handleDelete = async function handleDelete(exportID) {
  const all = [...allExports, ...allBiens.flatMap((b) => b.exports)];
  const exp = all.find((e) => e.id === exportID);
  if (!exp) return;
  if (!confirm(`Supprimer "${exp.fileName}" ?\n\nLe fichier sera effacé définitivement du serveur.`)) return;
  try {
    await deleteExport(exportID);
    allExports = allExports.filter((e) => e.id !== exportID);
    // Reload pour refléter dans /properties aussi
    await reloadAll();
    showToast(`"${exp.fileName}" supprimé`);
  } catch (err) {
    console.error("Delete error:", err);
    showToast(`Erreur : ${err.message || "suppression impossible"}`, true);
  }
};

// ── Modèles 3D ────────────────────────────────────────────────────────────────
function renderModels(models) {
  const root = document.getElementById("modeles-list");
  if (!models.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧊</div>
        <p>Aucun modèle 3D disponible pour ce compte.</p>
        <button class="btn-ghost" onclick="openApp()">Ouvrir l'app</button>
      </div>
    `;
    return;
  }
  root.innerHTML = `<div class="models-grid">${models.map((model) => `
    <article class="model-card">
      <div class="model-thumb">🧊</div>
      <div class="model-info">
        <h4>${escapeHtml(model.label || model.projectName || "Modèle 3D")}</h4>
        <p>MAJ ${formatDate(model.updatedAt)}</p>
      </div>
    </article>
  `).join("")}</div>`;
}

// ── Stats globales (haut du dashboard) ────────────────────────────────────────
function applyStats(biens, exports, projects) {
  document.getElementById("statProjets").textContent = String(biens.length);
  // Compte tous les PDFs trouvés dans les projets extraits
  const pdfCount = projects.reduce((s, p) => s + p.files.filter(f => /\.pdf$/i.test(f.path)).length, 0);
  document.getElementById("statRapports").textContent = String(pdfCount);
  // Compte tous les modèles 3D
  const usdzCount = projects.reduce((s, p) => s + p.files.filter(f => /\.usdz$/i.test(f.path)).length, 0);
  document.getElementById("statModeles").textContent = String(usdzCount);
}

// ── ONGLET MES PROJETS ─────────────────────────────────────────────────────
function renderProjectsTab() {
  const root = document.getElementById("projets-list");
  if (!root) return;

  const total = allProjects.length;
  const totalFiles = allProjects.reduce((s, p) => s + p.files.length, 0);
  const totalSize = allProjects.reduce((s, p) => s + p.files.reduce((s2, f) => s2 + (f.sizeBytes || 0), 0), 0);
  const last = allProjects.map(p => p.extractedAt).filter(Boolean).sort().pop();

  document.getElementById("projTotal").textContent = String(total);
  document.getElementById("projFiles").textContent = String(totalFiles);
  document.getElementById("projSize").textContent = formatBytes(totalSize);
  document.getElementById("projLast").textContent = last ? formatRelativeDate(last) : "—";

  if (!total) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <p>Aucun projet pour le moment.<br>Depuis l'app FOXSCAN, exportez une sauvegarde — elle sera automatiquement extraite ici.</p>
      </div>
    `;
    return;
  }

  root.innerHTML = allProjects.map((p) => {
    const pdfs = p.files.filter(f => /\.pdf$/i.test(f.path));
    const photos = p.files.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f.path));
    const usdz = p.files.filter(f => /\.usdz$/i.test(f.path));
    const size = p.files.reduce((s, f) => s + (f.sizeBytes || 0), 0);
    return `
      <div class="bien-card" style="cursor:pointer" onclick="openProjectViewer('${escapeHtml(p.projectID)}','${escapeHtml(p.name || '')}')">
        <div class="bien-header" style="cursor:pointer">
          <div class="bien-icon" style="background:linear-gradient(135deg,#FF9F0A,#FF6B00)">📦</div>
          <div class="bien-header-title-wrap">
            <div class="bien-address">${escapeHtml(p.name || p.projectID)}</div>
            <div class="bien-tenant">
              ${pdfs.length} PDF · ${photos.length} photos · ${usdz.length} 3D
              <span style="margin-left:auto;color:var(--text3);font-size:11px">${formatRelativeDate(p.extractedAt)} · ${formatBytes(size)}</span>
            </div>
          </div>
          <span class="bien-status ready">${p.files.length} fichier${p.files.length > 1 ? "s" : ""}</span>
        </div>
        <div class="bien-counts">
          <div class="count-pill"><div class="count-icon" style="background:#FFEFEE;color:#D92B20">📄</div><div><div class="count-label">PDF</div><div class="count-value">${pdfs.length}</div></div></div>
          <div class="count-pill"><div class="count-icon" style="background:#EBF4FF;color:#0062c4">🖼</div><div><div class="count-label">Photos</div><div class="count-value">${photos.length}</div></div></div>
          <div class="count-pill"><div class="count-icon" style="background:#F6EEFE;color:#7B2CBF">🧊</div><div><div class="count-label">3D LiDAR</div><div class="count-value">${usdz.length}</div></div></div>
        </div>
      </div>
    `;
  }).join("");
}

window.openProjectViewer = function openProjectViewer(projectID, name) {
  // Ouvre la modale viewer en mode "natif" (utilise /api/projects/*)
  return openViewerNative(projectID, name || projectID);
};

// ── ONGLET RAPPORTS (tous les PDFs) ──────────────────────────────────────────
function renderRapportsTab() {
  const root = document.getElementById("rapports-list");
  if (!root) return;

  // Construire la liste plate de tous les PDFs trouvés dans les projets
  const allPDFs = [];
  for (const p of allProjects) {
    // PDF natif s'il existe
    const native = p.files.find(f => /^inspection_report\.pdf$/i.test(f.path));
    if (native) {
      allPDFs.push({ projectID: p.projectID, projectName: p.name, source: "native", path: native.path, sizeBytes: native.sizeBytes, date: p.extractedAt });
    }
    // Autres PDFs additionnels
    for (const pdf of p.files) {
      if (/\.pdf$/i.test(pdf.path) && pdf.path !== native?.path) {
        allPDFs.push({ projectID: p.projectID, projectName: p.name, source: "additional", path: pdf.path, sizeBytes: pdf.sizeBytes, date: p.extractedAt });
      }
    }
    // PDF généré côté serveur (toujours dispo)
    allPDFs.push({ projectID: p.projectID, projectName: p.name, source: "generated", path: "_generated.pdf", sizeBytes: 0, date: p.extractedAt });
  }

  if (!allPDFs.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">📄</div><p>Aucun rapport PDF disponible.</p></div>`;
    return;
  }

  root.innerHTML = allPDFs.map((pdf) => {
    const isNative = pdf.source === "native";
    const isGenerated = pdf.source === "generated";
    const badge = isNative
      ? `<span style="background:#EDFAF1;color:#1A7A35;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700">📱 ORIGINAL APP</span>`
      : isGenerated
      ? `<span style="background:#FFF5E5;color:#7A4A00;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700">⚙️ GÉNÉRÉ AUTO</span>`
      : `<span style="background:#EBF4FF;color:#0062c4;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700">📄 ADDITIONNEL</span>`;
    const action = isGenerated
      ? `viewGeneratedReport('${escapeHtml(pdf.projectID)}','${escapeHtml(pdf.projectName)}')`
      : `viewProjectFile('${escapeHtml(pdf.projectID)}','${escapeHtml(pdf.path)}','${escapeHtml(pdf.projectName)}')`;
    return `
      <div class="export-item" style="cursor:pointer;background:#fff;border-radius:10px;margin-bottom:8px;border:1px solid var(--bg3)" onclick="${action}">
        <div class="export-icon pdf">📄</div>
        <div class="export-info">
          <div class="export-name">${escapeHtml(isGenerated ? "Rapport EDL (régénéré)" : pdf.path.split("/").pop())} ${badge}</div>
          <div class="export-meta">
            <span>📦 ${escapeHtml(pdf.projectName || pdf.projectID)}</span>
            ${!isGenerated ? `<span>•</span><span>${formatBytes(pdf.sizeBytes)}</span>` : ""}
            <span>•</span>
            <span>${formatRelativeDate(pdf.date)}</span>
          </div>
        </div>
        <div class="export-actions">
          <button class="btn-icon" style="background:#0071E3;color:white;border-color:#0071E3;width:auto;padding:0 12px;font-weight:700" onclick="event.stopPropagation();${action}">👁 Voir</button>
        </div>
      </div>
    `;
  }).join("");
}

window.viewProjectFile = function viewProjectFile(projectID, filePath, projectName) {
  openViewerNative(projectID, projectName || projectID);
  // Sélectionne automatiquement le fichier après ouverture
  setTimeout(() => {
    const ext = filePath.split(".").pop().toLowerCase();
    const kind = ext === "pdf" ? "pdf" : (["jpg","jpeg","png","webp"].includes(ext) ? "image" : "binary");
    if (window.viewerSelectProjectFile) window.viewerSelectProjectFile(projectID, filePath, kind);
  }, 200);
};

window.viewGeneratedReport = function viewGeneratedReport(projectID, projectName) {
  openViewerNative(projectID, projectName || projectID);
  // Le PDF généré est sélectionné par défaut dans openViewerNative
};

// ── ONGLET PHOTOS (galerie globale par projet) ──────────────────────────────
function renderPhotosTab() {
  const root = document.getElementById("photos-list");
  if (!root) return;

  // Pour chaque projet, lister ses photos
  const projectsWithPhotos = allProjects
    .map(p => ({
      ...p,
      photos: p.files.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f.path)),
    }))
    .filter(p => p.photos.length > 0);

  if (!projectsWithPhotos.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">🖼</div><p>Aucune photo disponible.</p></div>`;
    return;
  }

  root.innerHTML = projectsWithPhotos.map((p) => `
    <div class="bien-card" style="margin-bottom:16px">
      <div class="bien-header" style="cursor:default">
        <div class="bien-icon" style="background:linear-gradient(135deg,#0071E3,#5856D6)">🖼</div>
        <div class="bien-header-title-wrap">
          <div class="bien-address">${escapeHtml(p.name || p.projectID)}</div>
          <div class="bien-tenant">${p.photos.length} photo${p.photos.length > 1 ? "s" : ""} · ${formatRelativeDate(p.extractedAt)}</div>
        </div>
      </div>
      <div style="padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px" id="photoGrid-${escapeHtml(p.projectID)}"></div>
    </div>
  `).join("");

  // Charger les thumbnails en lazy
  for (const p of projectsWithPhotos) {
    const grid = document.getElementById(`photoGrid-${p.projectID}`);
    if (!grid) continue;
    for (const photo of p.photos) {
      const thumb = document.createElement("div");
      thumb.style.cssText = "aspect-ratio:1;background:var(--bg2);border-radius:8px;overflow:hidden;cursor:pointer;position:relative";
      thumb.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:24px">⏳</div>`;
      thumb.title = photo.path.split("/").pop();
      grid.appendChild(thumb);
      getProjectFileBlobURL(p.projectID, photo.path).then(({ blobUrl }) => {
        _viewerCurrentBlobs.push(blobUrl);
        thumb.innerHTML = `<img src="${blobUrl}" style="width:100%;height:100%;object-fit:cover" loading="lazy" alt=""/>`;
        thumb.onclick = () => openLightbox(blobUrl, photo.path);
      }).catch(() => {
        thumb.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--red);font-size:18px">❌</div>`;
      });
    }
  }
}

// ── ONGLET MODÈLES 3D (USDZ extraits) ───────────────────────────────────────
function renderModeles3DTab(legacyModels = []) {
  const root = document.getElementById("modeles-list");
  if (!root) return;

  // Liste tous les USDZ de tous les projets extraits
  const allUSDZ = [];
  for (const p of allProjects) {
    for (const f of p.files) {
      if (/\.usdz$/i.test(f.path)) {
        allUSDZ.push({ projectID: p.projectID, projectName: p.name, path: f.path, sizeBytes: f.sizeBytes, date: p.extractedAt });
      }
    }
  }

  if (!allUSDZ.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧊</div>
        <p>Aucun modèle 3D LiDAR pour le moment.<br>Lancez un scan dans l'app FOXSCAN pour générer un USDZ.</p>
      </div>
    `;
    return;
  }

  root.innerHTML = `<div class="models-grid">${allUSDZ.map((m, i) => `
    <article class="model-card" onclick="downloadProjectFile('${escapeHtml(m.projectID)}','${escapeHtml(m.path)}')">
      <div class="model-thumb" style="background:linear-gradient(135deg,#F6EEFE,#EBF4FF);font-size:48px">🧊</div>
      <div class="model-info">
        <h4>${escapeHtml(m.projectName || m.projectID)}</h4>
        <p>${escapeHtml(m.path.split("/").pop())}<br><small>${formatBytes(m.sizeBytes)} · ${formatDate(m.date)}</small></p>
      </div>
    </article>
  `).join("")}</div>
  <div style="padding:16px 20px;background:var(--bg2);border-radius:10px;margin-top:14px;font-size:13px;color:var(--text2);line-height:1.5">
    💡 <strong>Visualisation 3D</strong> : cliquez sur un modèle pour le télécharger. Ouvrez-le ensuite avec :
    <ul style="margin:6px 0 0 22px;padding:0">
      <li><strong>Mac</strong> : double-clic → s'ouvre dans Aperçu (vue 3D interactive)</li>
      <li><strong>iPhone</strong> : Safari → tap sur le fichier → mode AR Quick Look (réalité augmentée)</li>
      <li><strong>PC Windows</strong> : nécessite une visionneuse USDZ tierce (par ex. <a href="https://3dviewer.net" target="_blank">3dviewer.net</a>)</li>
    </ul>
  </div>`;
}

// ── ONGLET COMPTE ────────────────────────────────────────────────────────────
function renderAccount(user, biens, exports) {
  if (!user) return;

  // Profil
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? "—"; };
  setText("acctName", user.name || "—");
  setText("acctEmail", user.email || "—");
  setText("acctID", user.id || "—");

  // Provider de connexion (déduit de l'email)
  let provider = "Email";
  let providerIcon = "📧";
  if (user.email && user.email.includes("@privaterelay.appleid.com")) { provider = "Sign in with Apple"; providerIcon = "🍎"; }
  else if (user.googleSub) { provider = "Sign in with Google"; providerIcon = "🔵"; }
  setText("acctProvider", `${providerIcon} ${provider}`);

  // Date d'inscription : extraite du JWT ou du backend (à défaut, "Récemment")
  setText("acctSince", "Compte actif");

  // Statut abonnement
  const subActive = user.subscriptionActive !== false;
  const subEl = document.getElementById("acctSubStatus");
  if (subEl) {
    subEl.innerHTML = subActive
      ? '<span style="color:var(--green)">✓ Actif</span>'
      : '<span style="color:var(--orange)">⚠ Inactif</span>';
  }

  // Mot de passe (selon provider)
  const pwdEl = document.getElementById("acctPwdStatus");
  if (pwdEl) {
    pwdEl.textContent = provider === "Email" ? "Configuré" : "Géré par " + provider.replace("Sign in with ", "");
  }

  // Stats usage
  const totalEntry = biens.reduce((s, b) => s + (b.counts?.entry || 0), 0);
  const totalExit = biens.reduce((s, b) => s + (b.counts?.exit || 0), 0);
  const totalSize = exports.reduce((s, e) => s + (e.sizeBytes || 0), 0);
  setText("acctBienCount", String(biens.length));
  setText("acctEntryCount", String(totalEntry));
  setText("acctExitCount", String(totalExit));
  setText("acctStorage", formatBytes(totalSize));
}

window.requestDataExport = function requestDataExport() {
  const subject = encodeURIComponent("Demande RGPD - Export de mes données");
  const body = encodeURIComponent(`Bonjour,\n\nJe souhaite recevoir une copie de toutes mes données personnelles stockées par FOXSCAN.\n\nMon adresse email de compte : [à compléter]\n\nMerci.`);
  window.location.href = `mailto:contact@trufox.fr?subject=${subject}&body=${body}`;
};

window.confirmDeleteAccount = function confirmDeleteAccount() {
  const confirmed = confirm(
    "⚠ Suppression définitive du compte\n\n" +
    "Cette action supprimera définitivement :\n" +
    "• Votre compte FOXSCAN\n" +
    "• Tous vos biens et états des lieux\n" +
    "• Tous vos fichiers exportés\n\n" +
    "(Les factures sont conservées 10 ans pour obligation légale)\n\n" +
    "Êtes-vous sûr ? Cette action est irréversible."
  );
  if (!confirmed) return;
  const subject = encodeURIComponent("Demande RGPD - Suppression de mon compte");
  const body = encodeURIComponent(`Bonjour,\n\nJe demande la suppression définitive de mon compte FOXSCAN et de toutes mes données associées.\n\nMon adresse email de compte : [à compléter]\n\nMerci.`);
  window.location.href = `mailto:contact@trufox.fr?subject=${subject}&body=${body}`;
};

function setStatus(message) {
  const status = document.getElementById("api-status");
  if (status) status.textContent = message;
}

function showSubscriptionBlocked() {
  setStatus("Abonnement inactif. Active un abonnement dans l'app FOXSCAN pour accéder au dashboard.");
  document.getElementById("biens-list").innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🔒</div>
      <p>Accès dashboard bloqué : abonnement inactif.<br>Active ton offre depuis l'app iOS FOXSCAN.</p>
      <button class="btn-ghost" onclick="openApp()">Gérer l'abonnement dans l'app</button>
    </div>
  `;
}

// ── Reload ────────────────────────────────────────────────────────────────────
async function reloadAll() {
  const [propsData, exportsData, modelsData, projsData] = await Promise.all([
    fetchProperties().catch(() => ({ items: [] })),
    fetchExports().catch(() => ({ items: [] })),
    fetchModels().catch(() => ({ items: [] })),
    fetchExtractedProjects().catch(() => ({ items: [] })),
  ]);

  allBiens = propsData?.items || [];
  allExports = exportsData?.items || [];
  const legacyModels = modelsData?.items || [];

  // V5 — Filtre côté serveur si l'utilisateur a masqué les archivés.
  // Le toggle UI (Mes projets > « Voir les archivés ») permet de bascule.
  // Note : `fetchExtractedProjects` reçoit toujours TOUS les projets, et
  // on filtre côté client en relisant `showArchivedProjects`. Évite un
  // re-fetch à chaque toggle.
  const projectsRaw = (projsData?.items || []).filter((p) =>
    showArchivedProjects ? true : p.isArchived !== true
  );
  allProjects = await Promise.all(projectsRaw.map(async (p) => {
    const [filesData, inspectionData] = await Promise.all([
      fetchProjectFiles(p.projectID).catch(() => ({ files: [] })),
      fetchProjectInspection(p.projectID).catch(() => ({ inspectionReport: null })),
    ]);
    return {
      ...p,
      files: filesData?.files || [],
      inspectionReport: inspectionData?.inspectionReport || null,
    };
  }));

  // Onglets
  updateBiensStats();
  renderBiens();
  renderProjectsTab();
  renderRapportsTab();
  renderPhotosTab();
  renderComparatifsTab();
  renderTravauxTab();
  renderModeles3DTab(legacyModels);
  updateExportsStats();
  renderExports();
  applyStats(allBiens, allExports, allProjects);

  const sessionUser = getSessionUser();
  renderAccount(sessionUser, allBiens, allExports);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  const localUser = getSessionUser();
  if (!localUser.isAuthed) {
    window.location.href = "../login.html";
    return;
  }

  setUserHeader(localUser);

  try {
    const session = await dashboardSession();
    setUserHeader(session?.user || localUser);
    setStatus(`Connecté à ${getApiBaseUrl()}`);
    renderTrialBanner(session?.user);

    await reloadAll();
  } catch (error) {
    console.error("Dashboard bootstrap error:", error);
    if (error?.status === 403) { showSubscriptionBlocked(); return; }
    if (error?.status === 401) { clearSession(); window.location.href = "../login.html"; return; }
    setStatus(`Connexion API impossible (${getApiBaseUrl()})`);
  }
}

window.showTab = function showTab(tab, tabButton) {
  document.querySelectorAll(".tab-content").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach((el) => el.classList.remove("active"));
  document.getElementById(`tab-${tab}`).classList.add("active");
  tabButton.classList.add("active");
};

window.logout = function logout() {
  // 1) Fire-and-forget l'appel API : on ne bloque pas la UI si le serveur est lent/down
  try { logoutApi().catch(() => {}); } catch {}
  // 2) On clear la session locale immédiatement
  try { clearSession(); } catch {}
  // 3) Et on redirige tout de suite (avant que /auth/logout ne réponde)
  window.location.href = "../login.html";
  return false;
};

// Backup binding via addEventListener au cas où onclick="logout()" ne se déclencherait pas
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".btn-logout").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      window.logout();
    });
  });
});

window.openApp = function openApp() {
  window.location.href = "foxscan://new-scan";
  setTimeout(() => {
    window.location.href = "https://apps.apple.com/app/foxscan";
  }, 1500);
};

// V5 — Toggle d'affichage des projets archivés.
// Re-rend tous les onglets dépendants des projets pour refléter le filtre.
window.toggleArchivedProjects = function toggleArchivedProjects() {
  showArchivedProjects = !showArchivedProjects;
  const btn = document.getElementById("toggleArchivedBtn");
  if (btn) btn.textContent = showArchivedProjects ? "🗂 Masquer les archivés" : "🗂 Voir les archivés";
  // Re-fetch + re-render
  reloadAll();
};

// ═════════════════════════════════════════════════════════════════════════════
// V5 — ONGLET « COMPARATIFS » (entrée vs sortie, pièce par pièce)
// ═════════════════════════════════════════════════════════════════════════════

/// Pour chaque projet qui a un `inspectionReport` avec `comparisonItems` ou
/// au moins un item avec une différence entry/exit, on affiche une card.
function renderComparatifsTab() {
  const root = document.getElementById("comparatifs-list");
  if (!root) return;

  const projectsWithComparison = allProjects
    .map((p) => {
      const report = p.inspectionReport;
      if (!report) return null;
      // Soit on a un comparisonItems déjà calculé côté iOS, soit on calcule
      // à la volée à partir des roomConditions.
      const items = (report.comparisonItems && report.comparisonItems.length > 0)
        ? report.comparisonItems.map((c) => ({
            roomName: c.roomName || "Pièce",
            designation: c.designation || "",
            entryState: c.entryState || "",
            exitState: c.exitState || "",
            estimatedRetention: Number(c.estimatedRetention || 0),
            note: c.note || "",
          }))
        : computeComparisonFromRoomConditions(report.roomConditions || []);
      if (items.length === 0) return null;
      const totalRetention = items.reduce((s, it) => s + (it.estimatedRetention || 0), 0);
      return {
        projectID: p.projectID,
        name: p.name || p.projectID,
        address: report.address || p.address || "—",
        items,
        totalRetention,
        summary: report.comparisonSummary || "",
        inspectionType: report.inspectionType || null,
      };
    })
    .filter(Boolean);

  if (!projectsWithComparison.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>Aucun comparatif disponible.<br>Les comparatifs apparaissent dès qu'un EDL de sortie a été réalisé sur un bien déjà inspecté à l'entrée.</p></div>`;
    return;
  }

  root.innerHTML = projectsWithComparison.map((p) => {
    const diffCount = p.items.length;
    const retentionText = p.totalRetention > 0
      ? `<span style="color:#FF9F0A;font-weight:700">${formatCurrency(p.totalRetention)} estimés</span>`
      : `<span style="color:var(--green)">Aucune retenue</span>`;
    return `
      <div class="bien-card" style="margin-bottom:14px">
        <div class="bien-header" style="cursor:pointer" onclick="openComparatifDetail('${escapeHtml(p.projectID)}')">
          <div class="bien-icon" style="background:linear-gradient(135deg,#FF9F0A,#FF3B30)">⚖️</div>
          <div class="bien-header-title-wrap">
            <div class="bien-address">${escapeHtml(p.name)}</div>
            <div class="bien-tenant">${escapeHtml(p.address)}</div>
          </div>
          <div style="text-align:right;padding-right:16px">
            <div style="font-size:13px;color:var(--text2)">${diffCount} différence${diffCount > 1 ? "s" : ""}</div>
            <div style="font-size:14px;margin-top:2px">${retentionText}</div>
          </div>
        </div>
        <div style="padding:8px 16px 14px;display:flex;gap:8px;border-top:1px solid var(--bg2)">
          <button class="btn-secondary" style="padding:7px 14px;font-size:12px" onclick="openComparatifDetail('${escapeHtml(p.projectID)}')">
            ⚖️ Voir comparatif
          </button>
          <button class="btn-secondary" style="padding:7px 14px;font-size:12px" onclick="openObligationsDetail('${escapeHtml(p.projectID)}')">
            ✅ Relevés obligatoires
          </button>
        </div>
      </div>
    `;
  }).join("");
}

/// Heuristique de calcul comparatif à partir des `roomConditions` :
/// pour chaque item, si `conditionExit` est différent de `conditionEntry`
/// et représente une dégradation, on l'ajoute. L'estimation €€€ est
/// approximative (0€ par défaut — vraie estimation faite par l'agent
/// côté iOS via le module de comparaison).
function computeComparisonFromRoomConditions(roomConditions) {
  const out = [];
  for (const room of roomConditions) {
    for (const item of (room.items || [])) {
      const entry = item.conditionEntry || "";
      const exit = item.conditionExit || "";
      if (!entry || !exit) continue;
      if (entry === exit) continue;
      // Heuristique : on considère une dégradation si l'exit est "Mauvais
      // état" ou "État d'usage" sortant d'un "Bon état" / "Neuf".
      const isDegradation = (
        (entry === "Neuf" || entry === "Bon état") &&
        (exit === "État d'usage" || exit === "Mauvais état")
      ) || (entry === "État d'usage" && exit === "Mauvais état");
      if (!isDegradation) continue;
      out.push({
        roomName: room.roomName || "Pièce",
        designation: item.designation || "",
        entryState: entry,
        exitState: exit,
        estimatedRetention: 0,
        note: item.observation || "",
      });
    }
  }
  return out;
}

/// V5 — Modal sections « Relevés obligatoires » : DAAF + chaudière +
/// réserves locataire pour un projet précis. Lit le `inspectionReport`
/// chargé en mémoire dans `allProjects[i].inspectionReport`.
window.openObligationsDetail = function openObligationsDetail(projectID) {
  const project = allProjects.find((p) => p.projectID === projectID);
  if (!project) return;
  const report = project.inspectionReport;
  if (!report) return;

  const smokePresent = report.smokeDetectorPresent === true;
  const hasBoiler = report.hasBoiler === true;
  const tenantReserves = (report.tenantReserves || "").trim();
  const smokePhotos = Array.isArray(report.smokeDetectorPhotoFileNames) ? report.smokeDetectorPhotoFileNames.length : 0;
  const boilerPhotos = Array.isArray(report.boilerPhotoFileNames) ? report.boilerPhotoFileNames.length : 0;

  // Helpers locaux pour pastilles colorées sur les booléens.
  const yesNoBadge = (ok, labelOk, labelNo) => `<span style="display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;background:${ok ? "#EDFAF1" : "#FFF0EF"};color:${ok ? "#1A7A35" : "#A4282E"}">${ok ? labelOk : labelNo}</span>`;

  const smokeHTML = `
    <div style="background:#fff;border:1px solid var(--bg3);border-radius:12px;padding:18px 20px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#FF3B30,#FF6961);display:flex;align-items:center;justify-content:center;font-size:18px">🔥</div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700">Détecteurs de fumée</div>
          <div style="font-size:11px;color:var(--text2)">Obligation R129-12 CCH (loi 2010-238)</div>
        </div>
        ${yesNoBadge(smokePresent, "PRÉSENT", "ABSENT")}
      </div>
      ${smokePresent ? `
        <table style="width:100%;font-size:13px">
          <tr><td style="padding:4px 0;color:var(--text2);width:140px">Pièces équipées</td><td style="padding:4px 0">${escapeHtml(report.smokeDetectorLocations || "—")}</td></tr>
          <tr><td style="padding:4px 0;color:var(--text2)">Observations</td><td style="padding:4px 0">${escapeHtml(report.smokeDetectorNotes || "—")}</td></tr>
          <tr><td style="padding:4px 0;color:var(--text2)">Photos jointes</td><td style="padding:4px 0">${smokePhotos > 0 ? `📷 ${smokePhotos} photo${smokePhotos > 1 ? "s" : ""}` : "—"}</td></tr>
        </table>
      ` : `<div style="font-size:12px;color:#A4282E;background:#FFF0EF;padding:8px 12px;border-radius:8px">⚠️ Aucun détecteur mentionné. Vérification recommandée par le bailleur (mise en demeure possible côté assureur).</div>`}
    </div>`;

  const boilerHTML = `
    <div style="background:#fff;border:1px solid var(--bg3);border-radius:12px;padding:18px 20px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#FF9F0A,#FF6B00);display:flex;align-items:center;justify-content:center;font-size:18px">🔥</div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700">Entretien chaudière</div>
          <div style="font-size:11px;color:var(--text2)">Obligation R224-41-4 Code env. (décret 2009-649)</div>
        </div>
        ${hasBoiler ? yesNoBadge(true, "PRÉSENTE", "—") : `<span style="display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;background:#F0F0F2;color:#5C5C61">N/A</span>`}
      </div>
      ${hasBoiler ? `
        <table style="width:100%;font-size:13px">
          <tr><td style="padding:4px 0;color:var(--text2);width:160px">Marque / modèle</td><td style="padding:4px 0;font-weight:600">${escapeHtml(report.boilerBrand || "—")}</td></tr>
          <tr><td style="padding:4px 0;color:var(--text2)">Dernier entretien</td><td style="padding:4px 0">${report.boilerLastMaintenanceDate ? new Date(report.boilerLastMaintenanceDate).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) : "—"}</td></tr>
          <tr><td style="padding:4px 0;color:var(--text2)">Entretien annuel effectué</td><td style="padding:4px 0">${yesNoBadge(report.boilerMaintenancePerformed === "Oui" || report.boilerMaintenancePerformed === true, "OUI", "NON")}</td></tr>
          <tr><td style="padding:4px 0;color:var(--text2)">Observations</td><td style="padding:4px 0">${escapeHtml(report.boilerNotes || "—")}</td></tr>
          <tr><td style="padding:4px 0;color:var(--text2)">Photos jointes</td><td style="padding:4px 0">${boilerPhotos > 0 ? `📷 ${boilerPhotos} photo${boilerPhotos > 1 ? "s" : ""}` : "—"}</td></tr>
        </table>
      ` : `<div style="font-size:12px;color:var(--text2);background:var(--bg2);padding:8px 12px;border-radius:8px;font-style:italic">Aucune chaudière individuelle dans le logement (chauffage collectif, électrique, ou autre).</div>`}
    </div>`;

  const reservesHTML = `
    <div style="background:linear-gradient(135deg,#E0F7F5,#F0FFFC);border:1px solid #17A29A33;border-radius:12px;padding:18px 20px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#17A29A,#1FB5AC);display:flex;align-items:center;justify-content:center;font-size:18px">💬</div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700;color:#0E6E68">Réserves et observations du locataire</div>
          <div style="font-size:11px;color:var(--text2)">Bloc dédié — art. 3-2 loi du 6 juillet 1989</div>
        </div>
      </div>
      ${tenantReserves ? `<div style="font-size:13px;line-height:1.6;background:#fff;padding:12px 14px;border-radius:8px;border-left:3px solid #17A29A">${escapeHtml(tenantReserves).replace(/\n/g, "<br>")}</div>` : `<div style="font-size:12px;color:var(--text2);font-style:italic">Aucune réserve formulée par le locataire à l'issue de la visite.</div>`}
    </div>`;

  const modalHTML = `
    <div id="obligationsModal" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)closeObligationsModal()">
      <div style="background:var(--bg2);border-radius:16px;max-width:800px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:18px 24px;background:var(--bg);border-bottom:1px solid var(--bg3);display:flex;align-items:center;justify-content:space-between">
          <div>
            <h2 style="font-size:18px;font-weight:700;margin:0">Relevés obligatoires</h2>
            <p style="font-size:13px;color:var(--text2);margin-top:2px">${escapeHtml(project.name || "")}</p>
          </div>
          <button onclick="closeObligationsModal()" style="border:none;background:var(--bg2);width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:16px">✕</button>
        </div>
        <div style="padding:20px 24px;overflow-y:auto;flex:1">
          ${smokeHTML}
          ${boilerHTML}
          ${reservesHTML}
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", modalHTML);
};

window.closeObligationsModal = function closeObligationsModal() {
  const el = document.getElementById("obligationsModal");
  if (el) el.remove();
};

/// Modal détail comparatif pour un projet précis.
window.openComparatifDetail = function openComparatifDetail(projectID) {
  const project = allProjects.find((p) => p.projectID === projectID);
  if (!project) return;
  const report = project.inspectionReport;
  if (!report) return;

  // Récupère les items (depuis comparisonItems s'ils existent, sinon calcul)
  const items = (report.comparisonItems && report.comparisonItems.length > 0)
    ? report.comparisonItems
    : computeComparisonFromRoomConditions(report.roomConditions || []);

  // Group par pièce
  const byRoom = {};
  for (const item of items) {
    const room = item.roomName || "Pièce";
    if (!byRoom[room]) byRoom[room] = [];
    byRoom[room].push(item);
  }

  const totalRetention = items.reduce((s, it) => s + Number(it.estimatedRetention || 0), 0);

  // Construit le HTML du modal
  const rowsHTML = Object.keys(byRoom).map((roomName) => {
    const rows = byRoom[roomName].map((it) => {
      const retention = Number(it.estimatedRetention || 0);
      const retentionCell = retention > 0
        ? `<span style="color:#FF3B30;font-weight:700">${formatCurrency(retention)}</span>`
        : `<span style="color:var(--text3)">—</span>`;
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid var(--bg2)">${escapeHtml(it.designation || "")}</td>
          <td style="padding:10px 12px;border-bottom:1px solid var(--bg2)">${renderConditionPill(it.entryState)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid var(--bg2)">${renderConditionPill(it.exitState)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid var(--bg2);font-size:12px;color:var(--text2)">${escapeHtml(it.note || "—")}</td>
          <td style="padding:10px 12px;border-bottom:1px solid var(--bg2);text-align:right">${retentionCell}</td>
        </tr>`;
    }).join("");
    return `
      <div style="margin-bottom:18px">
        <h3 style="font-size:14px;font-weight:700;margin-bottom:8px;padding:6px 12px;background:#EBF4FF;border-radius:8px;color:#0062c4;display:inline-block">${escapeHtml(roomName)}</h3>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;border:1px solid var(--bg3)">
          <thead style="background:var(--bg2)"><tr>
            <th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Élément</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Entrée</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Sortie</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Observation</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Retenue est.</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join("");

  const summary = report.comparisonSummary || "";
  const modalHTML = `
    <div id="comparatifModal" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)closeComparatifModal()">
      <div style="background:var(--bg);border-radius:16px;max-width:1100px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:18px 24px;border-bottom:1px solid var(--bg3);display:flex;align-items:center;justify-content:space-between">
          <div>
            <h2 style="font-size:18px;font-weight:700;margin:0">Comparatif EDL entrée / sortie</h2>
            <p style="font-size:13px;color:var(--text2);margin-top:2px">${escapeHtml(project.name || "")}</p>
          </div>
          <button onclick="closeComparatifModal()" style="border:none;background:var(--bg2);width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:16px">✕</button>
        </div>
        <div style="padding:20px 24px;overflow-y:auto;flex:1">
          ${summary ? `<div style="background:#FFF5E5;color:#7A4A00;padding:12px 14px;border-radius:10px;margin-bottom:16px;font-size:13px;line-height:1.5">${escapeHtml(summary)}</div>` : ""}
          ${items.length === 0 ? `<div style="text-align:center;padding:60px;color:var(--text3)"><div style="font-size:48px;margin-bottom:10px">✅</div><div>Aucune différence détectée. Le bien est rendu dans le même état qu'à l'entrée.</div></div>` : rowsHTML}
        </div>
        <div style="padding:14px 24px;border-top:1px solid var(--bg3);background:var(--bg2);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:13px;color:var(--text2)">${items.length} élément${items.length > 1 ? "s" : ""} avec différence</div>
          <div style="font-size:16px;font-weight:700">Total retenue estimée : <span style="color:${totalRetention > 0 ? "#FF3B30" : "var(--green)"}">${formatCurrency(totalRetention)}</span></div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", modalHTML);
};

window.closeComparatifModal = function closeComparatifModal() {
  const el = document.getElementById("comparatifModal");
  if (el) el.remove();
};

/// Pastille colorée pour une condition d'élément (couleurs cohérentes
/// avec le PDF iOS).
function renderConditionPill(condition) {
  const c = String(condition || "").trim();
  let color = "#86868B";
  let bg = "#F5F5F7";
  let text = c || "—";
  if (c === "Neuf" || c === "Bon état") { color = "#1A7A35"; bg = "#EDFAF1"; }
  else if (c === "État d'usage" || c === "Usage normal") { color = "#7A4A00"; bg = "#FFF5E5"; }
  else if (c === "Mauvais état") { color = "#A4282E"; bg = "#FFF0EF"; }
  else if (c === "Non vérifié" || c === "Non vérifiable") { color = "#5C5C61"; bg = "#F0F0F2"; }
  return `<span style="display:inline-block;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;background:${bg};color:${color}">${escapeHtml(text)}</span>`;
}

/// Formate un montant en € (locale FR).
function formatCurrency(amount) {
  const n = Number(amount || 0);
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

// ═════════════════════════════════════════════════════════════════════════════
// V5 — ONGLET « TRAVAUX » (grille d'évaluation financière)
// ═════════════════════════════════════════════════════════════════════════════

/// Liste tous les items qui ont une `estimatedRetention > 0` ou une
/// dégradation détectée, avec colonne montant + total général en bas.
/// Le but : voir d'un coup d'œil tous les chantiers à programmer / facturer.
function renderTravauxTab() {
  const root = document.getElementById("travaux-list");
  if (!root) return;

  // Collecte de tous les items à traiter, à travers tous les projets.
  const allWork = [];
  for (const p of allProjects) {
    const report = p.inspectionReport;
    if (!report) continue;
    const items = (report.comparisonItems && report.comparisonItems.length > 0)
      ? report.comparisonItems
      : computeComparisonFromRoomConditions(report.roomConditions || []);
    for (const it of items) {
      allWork.push({
        projectID: p.projectID,
        projectName: p.name || p.projectID,
        address: report.address || "—",
        tenantName: report.tenantName || "—",
        roomName: it.roomName || "Pièce",
        designation: it.designation || "",
        entryState: it.entryState || "",
        exitState: it.exitState || "",
        retention: Number(it.estimatedRetention || 0),
        note: it.note || "",
      });
    }
  }

  if (!allWork.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">🔧</div><p>Aucun travail à signaler.<br>Les éléments dégradés apparaissent automatiquement ici quand un EDL de sortie le mentionne.</p></div>`;
    return;
  }

  // Group par bien pour clarté.
  const byProject = {};
  for (const w of allWork) {
    if (!byProject[w.projectID]) {
      byProject[w.projectID] = {
        projectName: w.projectName,
        address: w.address,
        tenantName: w.tenantName,
        items: [],
        total: 0,
      };
    }
    byProject[w.projectID].items.push(w);
    byProject[w.projectID].total += w.retention;
  }

  const grandTotal = Object.values(byProject).reduce((s, p) => s + p.total, 0);

  const sectionsHTML = Object.entries(byProject).map(([projectID, p]) => `
    <div class="bien-card" style="margin-bottom:18px">
      <div class="bien-header" style="cursor:default">
        <div class="bien-icon" style="background:linear-gradient(135deg,#FF9F0A,#FF3B30)">🔧</div>
        <div class="bien-header-title-wrap">
          <div class="bien-address">${escapeHtml(p.projectName)}</div>
          <div class="bien-tenant">${escapeHtml(p.address)} · Locataire : ${escapeHtml(p.tenantName)}</div>
        </div>
        <div style="text-align:right;padding-right:16px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Total bien</div>
          <div style="font-size:18px;font-weight:700;color:${p.total > 0 ? "#FF3B30" : "var(--green)"};margin-top:2px">${formatCurrency(p.total)}</div>
        </div>
      </div>
      <div style="padding:0 16px 16px">
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;border:1px solid var(--bg3)">
          <thead style="background:var(--bg2)"><tr>
            <th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Pièce</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Élément</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">État sortie</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Observation</th>
            <th style="text-align:right;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2)">Montant</th>
          </tr></thead>
          <tbody>${p.items.map((it) => `
            <tr>
              <td style="padding:10px 12px;border-bottom:1px solid var(--bg2);font-size:13px;font-weight:600">${escapeHtml(it.roomName)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid var(--bg2);font-size:13px">${escapeHtml(it.designation)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid var(--bg2)">${renderConditionPill(it.exitState)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid var(--bg2);font-size:12px;color:var(--text2)">${escapeHtml(it.note || "—")}</td>
              <td style="padding:10px 12px;border-bottom:1px solid var(--bg2);text-align:right;font-weight:700;color:${it.retention > 0 ? "#FF3B30" : "var(--text3)"}">${it.retention > 0 ? formatCurrency(it.retention) : "—"}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `).join("");

  root.innerHTML = `
    <div style="background:linear-gradient(135deg,#FFF5E5,#FFE0CC);border-radius:14px;padding:18px 24px;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#7A4A00;font-weight:700">Total général</div>
        <div style="font-size:13px;color:var(--text2);margin-top:2px">${allWork.length} élément${allWork.length > 1 ? "s" : ""} à traiter sur ${Object.keys(byProject).length} bien${Object.keys(byProject).length > 1 ? "s" : ""}</div>
      </div>
      <div style="font-size:28px;font-weight:700;color:${grandTotal > 0 ? "#FF3B30" : "var(--green)"}">${formatCurrency(grandTotal)}</div>
    </div>
    ${sectionsHTML}
  `;
}

bootstrap();
