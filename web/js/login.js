import {
  getApiBaseUrl,
  persistSession,
  signInWithAppleToken,
  signInWithEmail,
  registerWithEmail,
} from "./foxscan-client.js";

const loadingEl = document.getElementById("loading");

function setLoading(isLoading) {
  loadingEl.classList.toggle("show", isLoading);
}

function redirectToDashboard() {
  window.location.href = "../dashboard/index.html";
}

function redirectIfAuthed() {
  if (localStorage.getItem("foxscan_auth") === "1") {
    redirectToDashboard();
  }
}

function initApple() {
  const sdkReady = window.AppleID && window.AppleID.auth;
  if (!sdkReady) {
    throw new Error("AppleID JS SDK unavailable");
  }

  const redirectPath = window.location.pathname.includes("/apps/site/")
    ? "/apps/site/login.html"
    : "/login.html";

  window.AppleID.auth.init({
    clientId: "fr.foxscan.web",
    scope: "name email",
    redirectURI: `${window.location.origin}${redirectPath}`,
    usePopup: true,
  });
}

async function exchangeAppleToken(idToken) {
  const auth = await signInWithAppleToken(idToken);
  persistSession(auth);
  redirectToDashboard();
}

async function handleSignInClick() {
  setLoading(true);
  try {
    const data = await window.AppleID.auth.signIn();
    const idToken = data?.authorization?.id_token;
    if (!idToken) {
      throw new Error("Apple did not return id_token");
    }
    await exchangeAppleToken(idToken);
  } catch (error) {
    setLoading(false);
    if (error?.error !== "popup_closed_by_user") {
      alert("Connexion Apple impossible. Vérifie la configuration Apple Sign In et l'API FOXSCAN.");
      console.error(error);
    }
  }
}

function bindEvents() {
  document.getElementById("apple-signin-btn").addEventListener("click", handleSignInClick);

  document.addEventListener("AppleIDSignInOnSuccess", async (event) => {
    const idToken = event?.detail?.authorization?.id_token;
    if (!idToken) return;

    try {
      await exchangeAppleToken(idToken);
    } catch (error) {
      setLoading(false);
      alert("Connexion Apple reçue mais rejetée par l'API FOXSCAN.");
      console.error(error);
    }
  });

  document.addEventListener("AppleIDSignInOnFailure", (event) => {
    setLoading(false);
    console.error("Apple sign-in failure:", event?.detail || event);
  });
}

function initApiHint() {
  const hint = document.getElementById("api-base");
  if (hint) hint.textContent = getApiBaseUrl();
}

// ── Email auth ────────────────────────────────────────────────────────────────

let currentMode = "login"; // "login" | "register"

window.setMode = function (mode) {
  currentMode = mode;
  document.getElementById("tab-login").classList.toggle("active", mode === "login");
  document.getElementById("tab-register").classList.toggle("active", mode === "register");
  document.getElementById("field-name-wrap").style.display = mode === "register" ? "block" : "none";
  document.getElementById("email-btn-label").textContent =
    mode === "register" ? "Créer un compte" : "Se connecter";
  document.getElementById("email-error").textContent = "";
  document.getElementById("field-password").autocomplete =
    mode === "register" ? "new-password" : "current-password";
};

window.handleEmailSubmit = async function () {
  const email = document.getElementById("field-email").value.trim();
  const password = document.getElementById("field-password").value;
  const name = document.getElementById("field-name").value.trim();
  const errorEl = document.getElementById("email-error");
  const btn = document.getElementById("email-submit-btn");

  errorEl.textContent = "";
  if (!email || !password) { errorEl.textContent = "Email et mot de passe requis."; return; }
  if (currentMode === "register" && password.length < 6) {
    errorEl.textContent = "Mot de passe : 6 caractères minimum."; return;
  }

  btn.disabled = true;
  setLoading(true);
  try {
    const auth = currentMode === "register"
      ? await registerWithEmail(email, password, name || email.split("@")[0])
      : await signInWithEmail(email, password);
    persistSession(auth);
    redirectToDashboard();
  } catch (err) {
    const msg = err?.message || "Erreur de connexion.";
    errorEl.textContent = msg.includes("409") || msg.includes("already")
      ? "Email déjà utilisé. Connectez-vous."
      : msg.includes("401") || msg.includes("Invalid")
      ? "Email ou mot de passe incorrect."
      : msg;
    setLoading(false);
    btn.disabled = false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────

redirectIfAuthed();
try {
  initApple();
} catch (error) {
  console.error(error);
}
bindEvents();
initApiHint();
