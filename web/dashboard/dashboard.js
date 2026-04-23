import {
  clearSession,
  dashboardSession,
  fetchModels,
  fetchProjects,
  fetchReports,
  getApiBaseUrl,
  getSessionUser,
  logoutApi,
} from "../site/js/foxscan-client.js";

function escapeHtml(text = "") {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(isoString) {
  if (!isoString) return "-";
  const d = new Date(isoString);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString("fr-FR");
}

function setUserHeader(user) {
  const initial = (user.name || "U").charAt(0).toUpperCase();
  document.getElementById("userAvatar").textContent = initial;
  document.getElementById("userName").textContent = user.name;
  document.getElementById("welcomeTitle").textContent = `Bonjour, ${user.name.split(" ")[0]} 👋`;
}

function renderProjects(projects) {
  const root = document.getElementById("projets-list");

  if (!projects.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📱</div>
        <p>Aucun projet synchronisé pour ce compte.<br>Lance un scan dans l'app FOXSCAN pour alimenter le dashboard.</p>
        <button class="btn-ghost" onclick="openApp()">Ouvrir l'app</button>
      </div>
    `;
    return;
  }

  root.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Projet</th>
          <th>Adresse</th>
          <th>Mis à jour</th>
          <th>Statut</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${projects
          .map(
            (project) => `
              <tr>
                <td>${escapeHtml(project.name || "Projet")}</td>
                <td>${escapeHtml(project.address || "-")}</td>
                <td>${formatDate(project.updatedAt)}</td>
                <td><span class="badge ${
                  project.status === "completed" ? "badge-green" : "badge-orange"
                }">${project.status === "completed" ? "Complet" : "En cours"}</span></td>
                <td><button class="btn-ghost" onclick="openApp()">Voir</button></td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderReports(reports) {
  const root = document.getElementById("rapports-tbody");

  if (!reports.length) {
    root.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty-state">
            <div class="empty-icon">📄</div>
            <p>Aucun rapport exporté pour le moment.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  root.innerHTML = reports
    .map(
      (report) => `
        <tr>
          <td>${escapeHtml(report.fileName || report.id || "Rapport")}</td>
          <td>${escapeHtml(report.projectName || "-")}</td>
          <td>${formatDate(report.createdAt)}</td>
          <td><span class="badge badge-blue">Disponible</span></td>
          <td><button class="btn-ghost" onclick="openApp()">Télécharger</button></td>
        </tr>
      `,
    )
    .join("");
}

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

  root.innerHTML = `<div class="models-grid">${models
    .map(
      (model) => `
        <article class="model-card">
          <div class="model-thumb">🧊</div>
          <div class="model-info">
            <h4>${escapeHtml(model.label || model.projectName || "Modèle 3D")}</h4>
            <p>MAJ ${formatDate(model.updatedAt)}</p>
          </div>
        </article>
      `,
    )
    .join("")}</div>`;
}

function applyStats(projects, reports, models) {
  document.getElementById("statProjets").textContent = String(projects.length);
  document.getElementById("statRapports").textContent = String(reports.length);
  document.getElementById("statModeles").textContent = String(models.length);
}

function setStatus(message) {
  const status = document.getElementById("api-status");
  status.textContent = message;
}

function showSubscriptionBlocked() {
  const status = document.getElementById("api-status");
  status.textContent = "Abonnement inactif. Active un abonnement dans l'app FOXSCAN pour accéder au dashboard.";

  const projects = document.getElementById("projets-list");
  projects.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🔒</div>
      <p>Accès dashboard bloqué: abonnement inactif.<br>Active ton offre depuis l'app iOS FOXSCAN.</p>
      <button class="btn-ghost" onclick="openApp()">Gérer l'abonnement dans l'app</button>
    </div>
  `;
}

async function bootstrap() {
  const localUser = getSessionUser();
  if (!localUser.isAuthed) {
    window.location.href = "../site/login.html";
    return;
  }

  setUserHeader(localUser);

  try {
    const session = await dashboardSession();
    const serverUser = session?.user || localUser;
    setUserHeader(serverUser);

    setStatus(`Connecté à ${getApiBaseUrl()}`);

    const [projectsData, reportsData, modelsData] = await Promise.all([
      fetchProjects(),
      fetchReports(),
      fetchModels(),
    ]);

    const projects = projectsData?.items || [];
    const reports = reportsData?.items || [];
    const models = modelsData?.items || [];

    renderProjects(projects);
    renderReports(reports);
    renderModels(models);
    applyStats(projects, reports, models);
  } catch (error) {
    console.error("Dashboard bootstrap error:", error);

    if (error?.status === 403) {
      showSubscriptionBlocked();
      return;
    }

    if (error?.status === 401) {
      clearSession();
      window.location.href = "../site/login.html";
      return;
    }

    setStatus(`Connexion API impossible (${getApiBaseUrl()})`);
  }
}

window.showTab = function showTab(tab, tabButton) {
  document.querySelectorAll(".tab-content").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach((el) => el.classList.remove("active"));
  document.getElementById(`tab-${tab}`).classList.add("active");
  tabButton.classList.add("active");
};

window.logout = async function logout() {
  await logoutApi();
  clearSession();
  window.location.href = "../site/login.html";
};

window.openApp = function openApp() {
  window.location.href = "foxscan://new-scan";
  setTimeout(() => {
    window.location.href = "https://apps.apple.com/app/foxscan";
  }, 1500);
};

bootstrap();
