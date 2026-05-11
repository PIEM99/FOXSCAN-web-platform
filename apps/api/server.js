const cors = require("cors");
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { jwtVerify, createRemoteJWKSet } = require("jose");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");

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

// ── STRIPE INIT ──────────────────────────────────────────────────────────────
// La clé secrète est lue depuis .env (jamais en dur dans le code, jamais commit).
// Si la clé manque (déploiement local, env de dev), Stripe sera null et les
// endpoints retourneront une 503 explicite plutôt que de crasher au boot.
const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret
  ? new Stripe(stripeSecret, { apiVersion: "2024-12-18.acacia" })
  : null;
if (!stripe) {
  console.warn("[stripe] STRIPE_SECRET_KEY absente du .env — endpoints Stripe désactivés");
}

// Tarification mensuelle par nombre d'utilisateurs (en centimes EUR).
// Doit rester en parfait sync avec le calculateur de la home (web/index.html).
// 1er user = 29€ · users 2-5 = 20€/each · 6-10 = 16€/each · 11-15 = 12€/each
const SUBSCRIPTION_PRICES_EUR_CENTS = {
  1: 2900, 2: 4900, 3: 6900, 4: 8900, 5: 10900,
  6: 12500, 7: 14100, 8: 15700, 9: 17300, 10: 18900,
  11: 20100, 12: 21300, 13: 22500, 14: 23700, 15: 24900,
};
const FOUNDERS_PRICE_EUR_CENTS = 20000; // 200€ paiement unique

// ── SMTP / NODEMAILER ────────────────────────────────────────────────────────
// Configuré via .env (Hostinger SMTP par défaut). Si manquant, sendMail loggue
// un warning mais ne crashe pas (fallback sans email pour tests/dev local).
const smtpHost = process.env.SMTP_HOST || "";
const smtpPort = parseInt(process.env.SMTP_PORT || "465", 10);
const smtpUser = process.env.SMTP_USER || "";
const smtpPass = process.env.SMTP_PASS || "";
const smtpFrom = process.env.SMTP_FROM || smtpUser;
const smtpFromName = process.env.SMTP_FROM_NAME || "FOXSCAN";
const adminNotifEmail = process.env.ADMIN_NOTIF_EMAIL || smtpFrom || "";

const mailer = (smtpHost && smtpUser && smtpPass)
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // true pour 465 (SSL implicite), false pour 587 (STARTTLS)
      auth: { user: smtpUser, pass: smtpPass },
    })
  : null;

if (!mailer) {
  console.warn("[mailer] SMTP non configuré (SMTP_HOST/USER/PASS manquants) — emails désactivés");
} else {
  // Vérification asynchrone que la connexion SMTP marche (n'empêche pas le boot)
  mailer.verify().then(
    () => console.log(`[mailer] SMTP OK (${smtpHost}:${smtpPort})`),
    (err) => console.error("[mailer] SMTP verify failed:", err.message),
  );
}

async function sendMail({ to, subject, html, text, replyTo }) {
  if (!mailer) {
    console.warn("[mailer] mail not sent (no SMTP):", { to, subject });
    return { sent: false, reason: "no-smtp" };
  }
  try {
    const info = await mailer.sendMail({
      from: `"${smtpFromName}" <${smtpFrom}>`,
      to,
      subject,
      text: text || stripHtml(html || ""),
      html,
      replyTo: replyTo || smtpFrom,
    });
    console.log(`[mailer] sent: to=${to} id=${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mailer] error sending to ${to}:`, err.message);
    return { sent: false, error: err.message };
  }
}

function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Génère un mot de passe aléatoire fort et lisible (pas de caractères ambigus)
function generateRandomPassword(length = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#%*+-=?";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// ── Templates HTML emails (style cohérent avec foxscan.fr) ────────────────────

function emailLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1D1D1F;-webkit-font-smoothing:antialiased">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#F5F5F7;padding:30px 12px">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 6px 28px rgba(0,0,0,.08)">
        <tr><td style="background:linear-gradient(135deg,#0071E3,#5856D6);padding:28px 32px">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td valign="middle" style="padding-right:10px">
                <div style="width:32px;height:32px;background:#fff;border-radius:8px;text-align:center;line-height:32px;font-weight:800;color:#0071E3;font-size:16px">F</div>
              </td>
              <td valign="middle">
                <div style="color:#fff;font-size:18px;font-weight:800;letter-spacing:-.3px">FOXSCAN</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:34px 36px">${bodyHtml}</td></tr>
        <tr><td style="background:#FAFAFC;padding:20px 32px;border-top:1px solid #EDEDF0;font-size:12px;color:#86868B;line-height:1.6">
          <strong style="color:#1D1D1F">FOXSCAN</strong> · L'état des lieux qui se remplit tout seul<br/>
          <a href="https://foxscan.fr" style="color:#0071E3;text-decoration:none">foxscan.fr</a> · <a href="mailto:contact@foxscan.fr" style="color:#0071E3;text-decoration:none">contact@foxscan.fr</a><br/>
          <span style="color:#C7C7CC">Vous recevez cet email suite à votre inscription / paiement sur foxscan.fr.</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function emailWelcomeFounder({ name, email, password, isExistingUser }) {
  const greeting = name ? `Bonjour ${escapeHtml(name)},` : "Bonjour,";
  const credentialsBlock = isExistingUser
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">Votre compte existait déjà — votre <strong>licence à vie</strong> est désormais activée. Connectez-vous avec vos identifiants habituels.</p>`
    : `<div style="background:#F5F5F7;border-radius:12px;padding:18px 22px;margin:18px 0;font-size:14px">
        <div style="font-size:11px;font-weight:700;color:#86868B;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Vos identifiants</div>
        <div style="font-family:Menlo,Monaco,monospace;font-size:13px;line-height:1.8">
          📧 Email : <strong>${escapeHtml(email)}</strong><br/>
          🔑 Mot de passe : <strong>${escapeHtml(password)}</strong>
        </div>
        <div style="margin-top:12px;font-size:12px;color:#86868B">⚠️ Pensez à le changer après votre 1ère connexion.</div>
      </div>`;
  const body = `
    <div style="display:inline-block;background:linear-gradient(135deg,#FF9F0A,#FF6B00);color:#fff;font-size:11px;font-weight:800;padding:6px 14px;border-radius:980px;letter-spacing:.6px;text-transform:uppercase;margin-bottom:18px">🔥 Avantage Spécial · Founders</div>
    <h1 style="margin:0 0 14px;font-size:24px;font-weight:800;letter-spacing:-.5px">${greeting}</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.65">
      Bienvenue chez FOXSCAN ! Votre <strong>licence à vie</strong> avec mises à jour à vie est désormais active. Vous faites partie des 20 founders qui nous soutiennent dès le lancement — merci pour votre confiance.
    </p>
    ${credentialsBlock}
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0">
      <tr><td>
        <a href="https://foxscan.fr/dashboard/" style="display:inline-block;background:#1D1D1F;color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:700;font-size:14px;margin-right:8px">Accéder au dashboard →</a>
        <a href="https://apps.apple.com/fr/app/foxscan" style="display:inline-block;background:#F5F5F7;color:#1D1D1F;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:700;font-size:14px">📱 App iPhone</a>
      </td></tr>
    </table>
    <h3 style="margin:24px 0 10px;font-size:15px;font-weight:700">Prochaines étapes</h3>
    <ol style="margin:0 0 18px 20px;padding:0;font-size:14px;line-height:1.8;color:#3A3A3C">
      <li>Téléchargez l'app FOXSCAN depuis l'App Store (iPhone Pro recommandé pour le LiDAR)</li>
      <li>Connectez-vous avec vos identifiants ci-dessus</li>
      <li>Lancez votre 1er état des lieux — scan 3D + photos en 4 minutes</li>
      <li>Le rapport est généré automatiquement, signez et envoyez</li>
    </ol>
    <div style="background:#EBF4FF;border-left:3px solid #0071E3;padding:14px 18px;border-radius:8px;margin:18px 0;font-size:13px;color:#003F8C">
      💬 Une question, un blocage ? Répondez directement à cet email — nous lisons tout, et vite.
    </div>
  `;
  return emailLayout("Bienvenue chez FOXSCAN", body);
}

function emailWelcomeSubscription({ name, email, password, users, isExistingUser }) {
  const greeting = name ? `Bonjour ${escapeHtml(name)},` : "Bonjour,";
  const credentialsBlock = isExistingUser
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">Votre compte existait déjà — votre <strong>abonnement ${escapeHtml(String(users))} utilisateur${users > 1 ? "s" : ""}</strong> est désormais activé. Connectez-vous avec vos identifiants habituels.</p>`
    : `<div style="background:#F5F5F7;border-radius:12px;padding:18px 22px;margin:18px 0;font-size:14px">
        <div style="font-size:11px;font-weight:700;color:#86868B;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Vos identifiants</div>
        <div style="font-family:Menlo,Monaco,monospace;font-size:13px;line-height:1.8">
          📧 Email : <strong>${escapeHtml(email)}</strong><br/>
          🔑 Mot de passe : <strong>${escapeHtml(password)}</strong>
        </div>
        <div style="margin-top:12px;font-size:12px;color:#86868B">⚠️ Pensez à le changer après votre 1ère connexion.</div>
      </div>`;
  const body = `
    <h1 style="margin:0 0 14px;font-size:24px;font-weight:800;letter-spacing:-.5px">${greeting}</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.65">
      Bienvenue chez FOXSCAN ! Votre abonnement pour <strong>${escapeHtml(String(users))} utilisateur${users > 1 ? "s" : ""}</strong> est désormais actif. Vous pouvez utiliser tout de suite l'app et le dashboard web.
    </p>
    ${credentialsBlock}
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0">
      <tr><td>
        <a href="https://foxscan.fr/dashboard/" style="display:inline-block;background:#1D1D1F;color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:700;font-size:14px;margin-right:8px">Accéder au dashboard →</a>
        <a href="https://apps.apple.com/fr/app/foxscan" style="display:inline-block;background:#F5F5F7;color:#1D1D1F;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:700;font-size:14px">📱 App iPhone</a>
      </td></tr>
    </table>
    <h3 style="margin:24px 0 10px;font-size:15px;font-weight:700">Récap de votre abonnement</h3>
    <ul style="margin:0 0 18px 20px;padding:0;font-size:14px;line-height:1.8;color:#3A3A3C">
      <li>${escapeHtml(String(users))} utilisateur${users > 1 ? "s" : ""} inclus</li>
      <li>EDL illimités, scan 3D LiDAR, comparateur entrée/sortie</li>
      <li>Facturation mensuelle, sans engagement de durée</li>
      <li>Résiliable à tout moment depuis votre dashboard ou en répondant à cet email</li>
    </ul>
    <div style="background:#EBF4FF;border-left:3px solid #0071E3;padding:14px 18px;border-radius:8px;margin:18px 0;font-size:13px;color:#003F8C">
      💬 Besoin d'aide pour démarrer ? Répondez à cet email, nous vous aidons à lancer votre 1er EDL.
    </div>
  `;
  return emailLayout("Bienvenue chez FOXSCAN — Abonnement activé", body);
}

function emailAdminFounderReserved({ founder, position }) {
  const body = `
    <h1 style="margin:0 0 14px;font-size:20px;font-weight:800">🔥 Nouvelle réservation Founder · ${escapeHtml(position)}/20</h1>
    <p style="margin:0 0 18px;font-size:14px;color:#6E6E73">Quelqu'un vient de réserver l'avantage spécial — il/elle va être redirigé(e) vers Stripe pour payer 200 €. Si paiement réussi, vous recevrez un 2ᵉ email "Founder converti".</p>
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#86868B;width:120px">Nom</td><td style="padding:6px 0;font-weight:600">${escapeHtml(founder.name)}</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Email</td><td style="padding:6px 0;font-weight:600"><a href="mailto:${escapeHtml(founder.email)}" style="color:#0071E3">${escapeHtml(founder.email)}</a></td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Téléphone</td><td style="padding:6px 0">${escapeHtml(founder.phone || "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Société</td><td style="padding:6px 0">${escapeHtml(founder.company || "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Activité</td><td style="padding:6px 0">${escapeHtml(founder.role || "—")}</td></tr>
      ${founder.comment ? `<tr><td style="padding:6px 0;color:#86868B" valign="top">Message</td><td style="padding:6px 0;font-style:italic">${escapeHtml(founder.comment)}</td></tr>` : ""}
    </table>
    <a href="https://foxscan.fr/admin/" style="display:inline-block;margin-top:18px;background:#1D1D1F;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700;font-size:14px">Voir dans l'admin →</a>
  `;
  return emailLayout("Nouvelle réservation Founder", body);
}

function emailAdminPaymentSuccess({ type, email, amountEur, customerName, users }) {
  const isFounders = type === "founders";
  const body = `
    <h1 style="margin:0 0 14px;font-size:20px;font-weight:800">💸 Paiement reçu · ${escapeHtml(amountEur)} €</h1>
    <p style="margin:0 0 18px;font-size:14px;color:#6E6E73">${isFounders ? "Founder converti — licence à vie" : `Nouvel abonnement — ${escapeHtml(String(users))} utilisateur${users > 1 ? "s" : ""}/mois`}.</p>
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#86868B;width:120px">Type</td><td style="padding:6px 0;font-weight:600">${isFounders ? "🔥 Founder licence à vie" : "📅 Abonnement mensuel"}</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Montant</td><td style="padding:6px 0;font-weight:600">${escapeHtml(amountEur)} €</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Client</td><td style="padding:6px 0">${escapeHtml(customerName || "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Email</td><td style="padding:6px 0"><a href="mailto:${escapeHtml(email)}" style="color:#0071E3">${escapeHtml(email)}</a></td></tr>
    </table>
    <p style="margin-top:18px;font-size:13px;color:#6E6E73">✅ Compte FOXSCAN créé automatiquement, email de bienvenue envoyé au client.</p>
    <a href="https://dashboard.stripe.com/payments" style="display:inline-block;margin-top:8px;background:#1D1D1F;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700;font-size:14px">Voir sur Stripe →</a>
  `;
  return emailLayout("Paiement reçu", body);
}

// ── Helper : créer (ou retrouver) un compte FOXSCAN après un paiement Stripe.
// Retourne { user, password (si créé), isExisting }.
function createOrFindUserForPaidEmail(store, { email, name }) {
  const existing = store.users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
  if (existing) {
    // Compte déjà présent : on l'active simplement
    if (existing.subscriptionStatus !== "active") {
      existing.subscriptionStatus = "active";
      existing.updatedAt = nowIso();
    }
    return { user: existing, password: null, isExisting: true };
  }
  // Création d'un nouveau compte email/password
  const password = generateRandomPassword(12);
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  const user = {
    id: `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    authProvider: "email",
    email: email.toLowerCase(),
    passwordHash,
    passwordSalt: salt,
    name: name || email.split("@")[0],
    agencyID: null,
    subscriptionStatus: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.users.push(user);
  return { user, password, isExisting: false };
}

const app = express();

// ── SÉCURITÉ : headers HTTP sur toutes les réponses ──────────────────────────
app.use((req, res, next) => {
  // HSTS : force HTTPS pendant 1 an
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Anti-clickjacking : pas d'iframe extérieure
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  // Anti-MIME sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Referrer minimal
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Désactive APIs sensibles non utilisées
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  // CSP : autorise Apple Sign-in, Google Sign-in, model-viewer Google, qrserver, fonts Google, Stripe
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://appleid.cdn-apple.com https://accounts.google.com https://*.gstatic.com https://ajax.googleapis.com https://js.stripe.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://api.qrserver.com https://*.googleusercontent.com",
      "frame-src 'self' https://accounts.google.com https://appleid.apple.com https://js.stripe.com https://hooks.stripe.com",
      "connect-src 'self' blob: data: https://api.foxscan.fr https://accounts.google.com https://appleid.apple.com https://api.stripe.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ].join("; ")
  );
  next();
});

// ── CORS strict : whitelist des origines autorisées ──────────────────────────
const ALLOWED_ORIGINS = [
  "https://foxscan.fr",
  "https://www.foxscan.fr",
  "https://api.foxscan.fr",
  // Pour le développement local éventuel :
  "http://localhost:3000",
  "http://localhost:5173",
];
app.use(cors({
  origin(origin, callback) {
    // Autorise les requêtes sans origin (Postman, curl, app iOS native)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("CORS: origin not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  maxAge: 86400, // cache preflight 24h
}));

// ── RATE LIMITING partagé sur disque (Passenger lance plusieurs workers) ─────
// Anti-brute force sans dépendance externe. Le fichier est lu/écrit à chaque
// requête sur les routes sensibles → ~1-3 ms d'overhead, acceptable.
const RATE_LIMIT_FILE = path.join(__dirname, "tmp", ".ratelimits.json");

function readRateLimitsStore() {
  try { return JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, "utf-8")); }
  catch { return {}; }
}
function writeRateLimitsStore(data) {
  try {
    ensureDir(path.dirname(RATE_LIMIT_FILE));
    fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(data));
  } catch (e) { console.error("[ratelimit] write failed:", e.message); }
}

function rateLimit({ maxAttempts = 5, windowMs = 60_000, blockMs = 5 * 60_000 } = {}) {
  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"] || req.ip || req.connection?.remoteAddress || "?")
      .split(",")[0].trim();
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const store = readRateLimitsStore();
    const entry = store[key];

    // Bloqué actuellement ?
    if (entry?.blockedUntil && now < entry.blockedUntil) {
      const remaining = Math.ceil((entry.blockedUntil - now) / 1000);
      res.setHeader("Retry-After", String(remaining));
      return res.status(429).json({ ok: false, detail: `Trop de tentatives. Réessayez dans ${remaining}s.` });
    }

    // Nouveau ou fenêtre expirée → reset
    if (!entry || now > entry.resetAt) {
      store[key] = { count: 1, resetAt: now + windowMs, blockedUntil: 0 };
      writeRateLimitsStore(store);
      return next();
    }

    // Incrémente
    entry.count += 1;
    if (entry.count > maxAttempts) {
      entry.blockedUntil = now + blockMs;
      console.warn(`[ratelimit] IP ${ip} bloquée sur ${req.path} après ${entry.count} tentatives`);
      writeRateLimitsStore(store);
      res.setHeader("Retry-After", String(Math.ceil(blockMs / 1000)));
      return res.status(429).json({ ok: false, detail: "Trop de tentatives. Compte temporairement bloqué." });
    }
    writeRateLimitsStore(store);
    next();
  };
}

// Nettoyage périodique des entrées expirées (toutes les 10 min)
setInterval(() => {
  const now = Date.now();
  const store = readRateLimitsStore();
  let changed = false;
  for (const [k, v] of Object.entries(store)) {
    if (now > v.resetAt && now > (v.blockedUntil || 0)) {
      delete store[k];
      changed = true;
    }
  }
  if (changed) writeRateLimitsStore(store);
}, 10 * 60_000).unref?.();

// On applique le rate limit aux routes sensibles. Express ne supporte pas
// un tableau de paths dans app.use(), on fait un middleware filtrant.
const authRateLimit = rateLimit({ maxAttempts: 5, windowMs: 60_000, blockMs: 5 * 60_000 });
const adminRateLimit = rateLimit({ maxAttempts: 10, windowMs: 60_000, blockMs: 10 * 60_000 });
// Anti-spam pour le formulaire public d'avantage spécial : 3 tentatives/min/IP
const foundersRateLimit = rateLimit({ maxAttempts: 3, windowMs: 60_000, blockMs: 30 * 60_000 });

const AUTH_LIMITED_PATHS = new Set([
  "/auth/email/login",
  "/auth/email/register",
  "/auth/apple",
  "/auth/google",
  "/auth/refresh",
]);
app.use((req, res, next) => {
  if (AUTH_LIMITED_PATHS.has(req.path)) return authRateLimit(req, res, next);
  if (req.path.startsWith("/admin")) return adminRateLimit(req, res, next);
  if (req.path === "/founders" && req.method === "POST") return foundersRateLimit(req, res, next);
  next();
});
// IMPORTANT : Le webhook Stripe doit recevoir le BODY BRUT (Buffer) pour que
// la signature soit vérifiable. On enregistre la route AVANT le json parser.
// Stripe envoie un POST sur /stripe/webhook avec un header Stripe-Signature.
app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.status(503).send("Stripe disabled");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
  const sig = req.header("stripe-signature") || "";
  let event;
  try {
    if (!webhookSecret) {
      // Si pas de secret webhook configuré, on accepte sans vérif (mode dev/début).
      // À durcir dès que le webhook est créé dans Stripe Dashboard.
      event = JSON.parse(req.body.toString("utf-8"));
      console.warn("[stripe webhook] WEBHOOK_SECRET manquant — signature non vérifiée");
    } else {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    }
  } catch (err) {
    console.error("[stripe webhook] signature invalid :", err.message);
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  // On répond IMMÉDIATEMENT à Stripe (best practice : <5s, sinon Stripe retry).
  // Le handler tourne en arrière-plan (création compte + emails). Si ça plante,
  // c'est loggué mais Stripe reçoit déjà le 200 OK et ne retentera pas.
  res.json({ received: true });
  Promise.resolve()
    .then(() => handleStripeEvent(event))
    .catch((err) => console.error("[stripe webhook] handler error :", err));
});

// Limite haute : /ai/responses peut embarquer 5-6 photos JPEG en base64
// (analyse fiche pièce → ~250 KB/photo × 1.33 base64 = ~1.6 MB juste d'images)
// + prompts système. /ai/vision-ocr envoie aussi des images base64.
app.use(express.json({ limit: "25mb" }));

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
  // Stockage des fichiers d'export uploadés par l'app iOS (sauvegardes JSON, USDZ,
  // PDFs, archives photos…). Configurable via FOXSCAN_EXPORT_FILES_DIR si Hostinger
  // exige un chemin spécifique (ex: hors du dossier de l'app pour la persistance).
  exportFilesDir:
    process.env.FOXSCAN_EXPORT_FILES_DIR || path.join(__dirname, "data", "exports"),
  // Plafond du body parser pour /exports/upload (binaire). 200 Mo couvre les
  // sauvegardes complètes typiques (toutes les photos + USDZ inlinés en base64
  // dans le JSON pèsent rarement plus). À ajuster si Passenger Hostinger limite.
  uploadLimit: process.env.FOXSCAN_UPLOAD_LIMIT || "200mb",
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
      founders: [],
      teams: [],
      drafts: [],
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
    founders: parsed.founders || [],
    teams: parsed.teams || [],
    drafts: parsed.drafts || [],
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
    trialStartedAt: ts,
    trialEndsAt: nowPlus7DaysIso(),
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
    trialStartedAt: ts,
    trialEndsAt: nowPlus7DaysIso(),
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
      // subscriptionActive = true si essai en cours OU founder OU abo Stripe
      subscriptionActive: isAccessActive(user),
      accessStatus: computeAccessStatus(user), // "trial" | "lifetime" | "subscription" | "expired"
      trialEndsAt: user.trialEndsAt || null,
      trialDaysRemaining: trialDaysRemaining(user),
      foundersAccount: user.foundersAccount === true,
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

// ── ESSAI GRATUIT 7 JOURS + LICENCE À VIE ────────────────────────────────────
// Tout nouveau user reçoit un trial de 7 jours pendant lequel il a accès complet
// à l'app (illimité). Au-delà, accès bloqué SAUF si :
//   - foundersAccount = true (a payé les 200€ Avantage Spécial à vie)
//   - subscriptionStatus = "active" (abonnement mensuel Stripe payé)
const TRIAL_DURATION_DAYS = 7;

function nowPlus7DaysIso() {
  const d = new Date();
  d.setDate(d.getDate() + TRIAL_DURATION_DAYS);
  return d.toISOString();
}

// Retourne le statut d'accès de l'utilisateur :
//   "lifetime"     : a payé les 200€ founders → accès illimité à vie
//   "subscription" : abonnement mensuel actif (Stripe)
//   "trial"        : encore dans la période d'essai 7j
//   "expired"      : essai expiré, pas de paiement → accès bloqué
function computeAccessStatus(user) {
  if (!user) return "expired";
  if (user.foundersAccount === true) return "lifetime";
  // subscriptionStatus === "active" peut venir d'un abo Stripe ou d'une activation admin
  if (user.subscriptionStatus === "active" && !user.foundersAccount && !user.trialEndsAt) {
    // Anciens comptes (avant l'introduction du trial) → considérés "subscription" pour
    // ne casser personne. Si l'admin a activé manuellement quelqu'un, ça reste OK.
    return "subscription";
  }
  if (user.subscriptionStatus === "active" && user.stripeSubscriptionId) {
    return "subscription";
  }
  // Trial check
  if (user.trialEndsAt) {
    const trialEnd = new Date(user.trialEndsAt).getTime();
    if (Number.isFinite(trialEnd) && trialEnd > Date.now()) return "trial";
  }
  // Cas de fallback : s'il n'y a aucun trialEndsAt sur un user existant et qu'il est
  // marqué "active", on respecte ce statut (rétrocompat).
  if (user.subscriptionStatus === "active") return "subscription";
  return "expired";
}

function isAccessActive(user) {
  const s = computeAccessStatus(user);
  return s === "lifetime" || s === "subscription" || s === "trial";
}

function trialDaysRemaining(user) {
  if (!user || !user.trialEndsAt) return 0;
  const ms = new Date(user.trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function ensureDashboardAllowed(user) {
  if (settings.requireActiveSubscription && !isAccessActive(user)) {
    const err = new Error("Trial expired or subscription inactive");
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

  // 60 s : nécessaire pour les analyses vision en `detail: high` avec plusieurs photos
  // (état des lieux complet d'une pièce). Les appels texte courts répondent en <2 s,
  // donc allonger le plafond ne pénalise personne.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
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
      // `response_format` est l'ancien nom (Chat Completions). Conservé par compatibilité.
      response_format: body.response_format,
      // `text` est la forme moderne pour la Responses API : permet de forcer
      // un JSON strict via `text.format = { type: "json_schema", schema, strict: true }`.
      // Indispensable pour les analyses d'état des lieux (sortie JSON garantie).
      text: body.text,
      // Pour les futurs modèles à raisonnement (o-series).
      reasoning: body.reasoning,
      // top_p / parallel_tool_calls / tool_choice : laissés ouverts si on en a besoin plus tard.
      top_p: body.top_p,
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
    trialStartedAt: nowIso(),
    trialEndsAt: nowPlus7DaysIso(),
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

// Suppression complète d'un compte utilisateur — requis par App Store rule
// 5.1.1(v) (iOS 16+). Supprime irréversiblement :
//   - l'utilisateur (store.users)
//   - tous ses refresh tokens
//   - ses projets, reports, exports (lignes en base)
//   - les fichiers d'exports correspondants sur disque
//   - les audit events qui lui sont rattachés
//
// Le client iOS appelle ce endpoint avant de wiper son Keychain et son
// Documents/FoxScanData. On ne fait pas de "soft delete" : RGPD impose un
// effacement effectif des données personnelles.
app.delete("/auth/account", requireCurrentUser, (req, res) => {
  const store = req._store;
  const user = req._user;
  const userID = user.id;

  // 1) Fichiers d'exports physiques sur disque (PDF, USDZ, backups…)
  const userExports = store.exports.filter((e) => e.userID === userID);
  for (const exp of userExports) {
    if (exp.diskPath && fs.existsSync(exp.diskPath)) {
      try {
        fs.unlinkSync(exp.diskPath);
      } catch (e) {
        console.error("[/auth/account DELETE] unlink failed", exp.diskPath, e.message);
      }
    }
  }
  // Et le dossier user dédié (settings.exportFilesDir/<userID>) si vide
  try {
    const userDir = path.join(settings.exportFilesDir, userID);
    if (fs.existsSync(userDir)) {
      // rm récursif (Node 14+)
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("[/auth/account DELETE] rmdir userDir failed", e.message);
  }

  // 2) Lignes en base — purge en place
  store.users = store.users.filter((u) => u.id !== userID);
  store.refreshTokens = store.refreshTokens.filter((t) => t.userID !== userID);
  store.projects = store.projects.filter((p) => p.userID !== userID);
  store.reports = store.reports.filter((r) => r.userID !== userID);
  store.exports = store.exports.filter((e) => e.userID !== userID);
  // Les audit events sont conservés si actorUserID/userID est mis à null
  // (utile pour journal de sécurité), mais on anonymise.
  store.auditEvents = store.auditEvents.map((ev) => {
    if (ev.userID === userID || ev.actorUserID === userID) {
      return {
        ...ev,
        userID: null,
        actorUserID: null,
        payload: { ...(ev.payload || {}), redactedReason: "account-deleted" },
      };
    }
    return ev;
  });

  writeStore(store);
  console.log(`[/auth/account DELETE] account ${userID} deleted (RGPD)`);
  res.json({ ok: true, message: "Account deleted", id: userID });
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

// ── /auth/me ─────────────────────────────────────────────────────────────────
// GET : retourne l'utilisateur courant (utilisé par l'app iOS à chaque ouverture
//       pour synchroniser le statut d'abonnement, le nom, le trial, etc.)
// PATCH : permet à l'app de mettre à jour le nom (firstName/lastName) du user.

function publicUserShape(user) {
  // Reconstruction firstName/lastName depuis name si non stockés
  const fallbackFirst = user.firstName || (user.name ? user.name.split(" ")[0] : "");
  const fallbackLast = user.lastName || (user.name ? user.name.split(" ").slice(1).join(" ") : "");
  return {
    id: user.id,
    authProvider: user.authProvider || "email",
    email: user.email || "",
    name: user.name || "",
    firstName: fallbackFirst,
    lastName: fallbackLast,
    picture: user.picture || null,
    agencyID: user.agencyID || null,
    subscriptionActive: isAccessActive(user),
    subscriptionStatus: user.subscriptionStatus || "inactive",
    accessStatus: computeAccessStatus(user),
    trialStartedAt: user.trialStartedAt || null,
    trialEndsAt: user.trialEndsAt || null,
    trialDaysRemaining: trialDaysRemaining(user),
    foundersAccount: user.foundersAccount === true,
    teamId: user.teamId || null,
    stripeCustomerId: user.stripeCustomerId || null,
    stripeSubscriptionId: user.stripeSubscriptionId || null,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
}

// V5 — Endpoint missions stub. Le mobile (`MissionService.fetchMissions`)
// appelle ce endpoint à chaque ouverture pour récupérer les missions
// assignées par le dashboard. Tant que la feature n'est pas implémentée
// côté web, on renvoie une liste vide avec 200 OK pour stopper les 404
// silencieux qui polluent les logs.
app.get("/missions/me", requireCurrentUser, (req, res) => {
  res.json({ ok: true, items: [] });
});

app.get("/auth/me", requireCurrentUser, (req, res) => {
  const user = publicUserShape(req._user);
  // V5 — Réponse compatible double-format :
  //  • `user: {...}` en camelCase pour le dashboard web (inchangé)
  //  • Champs snake_case top-level pour les clients iOS qui parsent
  //    un struct `MeResponse` plat (voir BackendAPIContracts.swift).
  // Ça évite à iOS d'avoir à connaître la structure nested et permet
  // au dashboard de continuer à lire `user.subscriptionActive` etc.
  res.json({
    ok: true,
    user,
    user_id: user.id,
    email: user.email || null,
    display_name: user.name || null,
    agency_id: user.agencyID || null,
    subscription_active: user.subscriptionActive,
    subscription_status: user.subscriptionStatus,
    subscription_expires_at: user.trialEndsAt || null,
  });
});

app.patch("/auth/me", requireCurrentUser, (req, res) => {
  const body = req.body || {};
  const store = readStore();
  const target = store.users.find((u) => u.id === req._user.id);
  if (!target) return res.status(404).json({ ok: false, detail: "User not found" });

  // V5 — Accepte les deux conventions de nommage :
  //   • snake_case (`first_name`, `last_name`, `display_name`) → iOS
  //   • camelCase (`firstName`, `lastName`, `name`) → dashboard web
  // Le snake_case prend la priorité s'il est explicitement présent dans
  // la payload, sinon on retombe sur le camelCase.
  const incomingName =
    (typeof body.name === "string" ? body.name : undefined) ??
    (typeof body.display_name === "string" ? body.display_name : undefined);
  const incomingFirst =
    (typeof body.first_name === "string" ? body.first_name : undefined) ??
    (typeof body.firstName === "string" ? body.firstName : undefined);
  const incomingLast =
    (typeof body.last_name === "string" ? body.last_name : undefined) ??
    (typeof body.lastName === "string" ? body.lastName : undefined);

  let didChangeFirstOrLast = false;
  if (typeof incomingName === "string" && incomingName.trim()) {
    target.name = incomingName.trim().slice(0, 120);
  }
  if (typeof incomingFirst === "string") {
    target.firstName = incomingFirst.trim().slice(0, 60);
    didChangeFirstOrLast = true;
  }
  if (typeof incomingLast === "string") {
    target.lastName = incomingLast.trim().slice(0, 60);
    didChangeFirstOrLast = true;
  }
  // Si on a modifié firstName/lastName mais sans `name` explicite, on
  // recompose `name` pour cohérence côté admin/dashboard.
  if ((!incomingName || incomingName.trim() === "") && didChangeFirstOrLast) {
    const composed = `${target.firstName || ""} ${target.lastName || ""}`.trim();
    if (composed) target.name = composed;
  }

  target.updatedAt = nowIso();
  writeStore(store);

  // V5 — Réponse au même format que GET /auth/me (user wrapper +
  // mirror snake_case top-level pour iOS).
  const updated = publicUserShape(target);
  res.json({
    ok: true,
    user: updated,
    user_id: updated.id,
    email: updated.email || null,
    display_name: updated.name || null,
    agency_id: updated.agencyID || null,
    subscription_active: updated.subscriptionActive,
    subscription_status: updated.subscriptionStatus,
    subscription_expires_at: updated.trialEndsAt || null,
  });
});

// ─── /drafts ─────────────────────────────────────────────────────────────────
// Brouillons d'EDL créés depuis le dashboard web, exportables vers l'app iOS
// via deep link `foxscan://draft/<id>`. L'agent ouvre l'app sur place et
// retrouve déjà adresse, locataire, type, etc. pré-remplis.

const DRAFT_PROPERTY_TYPES = new Set(["studio", "T1", "T2", "T3", "T4", "T5+", "maison", "local-commercial"]);
const DRAFT_EDL_TYPES = new Set(["entry", "exit", "inventory"]);

function sanitizeDraftText(s, maxLen = 200) {
  return String(s || "").trim().replace(/[\x00-\x1F\x7F]/g, "").slice(0, maxLen);
}

// V5.2.4 — Sanitize d'un tableau de co-locataires. Whitelist stricte de
// champs (name, phone, email) pour éviter qu'un payload malveillant
// injecte des propriétés arbitraires. Max 10 co-locataires par EDL.
function sanitizeAdditionalTenants(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).map((t) => {
    const obj = t || {};
    return {
      name: sanitizeDraftText(obj.name, 120),
      phone: sanitizeDraftText(obj.phone, 40),
      email: sanitizeDraftText(obj.email, 120).toLowerCase(),
    };
  }).filter((t) => t.name.length > 0);  // un co-locataire sans nom = invalide
}

function draftPublicShape(d) {
  return {
    id: d.id,
    address: d.address,
    propertyType: d.propertyType,
    edlType: d.edlType,
    scheduledAt: d.scheduledAt,
    tenantName: d.tenantName || "",
    tenantEmail: d.tenantEmail || "",
    // V5.2.4 — Co-locataires (couple, colocation). Compatible avec le
    // modèle iOS PropertyInspectionReport.AdditionalTenant.
    additionalTenants: Array.isArray(d.additionalTenants) ? d.additionalTenants : [],
    landlordName: d.landlordName || "",
    notes: d.notes || "",
    status: d.status || "pending",  // pending | exported | completed
    exportedAt: d.exportedAt || null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    // V5 — Origine du brouillon ; "web" = créé via /drafts depuis le
    // dashboard, "ios" = projet iPhone non finalisé surfacé en draft.
    source: "web",
  };
}

/// V5 — Projection d'un projet iPhone non-finalisé en "draft" pour
/// l'unifier avec les brouillons web côté liste UI.
/// On extrait l'adresse + locataire + dates depuis le `payload.report`
/// pour avoir un rendu cohérent dans la même liste.
function iosProjectToDraftShape(proj) {
  const report = proj.payload?.report || {};
  // Adresse priorisée : projet (extrait V5) > champs structurés du report
  const address = proj.address && proj.address !== "(adresse à renseigner)"
    ? proj.address
    : [
        [report.address, report.addressComplement].filter(Boolean).join(", "),
        [report.postalCode, report.city].filter(Boolean).join(" "),
      ].filter(Boolean).join(", ") || "(adresse à renseigner)";
  // Mapping inspectionType (entry/exit/inventory) vers edlType web.
  const edlTypeMap = {
    "Entrée": "entry", "entry": "entry", "Sortie": "exit", "exit": "exit",
    "Inventaire": "inventory", "inventory": "inventory",
  };
  const edlType = edlTypeMap[report.inspectionType] || "entry";
  // Mapping propertyType : on prend le rawValue tel quel s'il match,
  // sinon "apartment" par défaut.
  const propertyTypeRaw = String(report.propertyType || "").toLowerCase();
  const propertyType = ["studio", "T1", "T2", "T3", "T4", "T5+", "maison", "local-commercial"].includes(report.propertyType)
    ? report.propertyType
    : propertyTypeRaw.includes("maison") ? "maison"
    : propertyTypeRaw.includes("local") || propertyTypeRaw.includes("commerc") ? "local-commercial"
    : "apartment";
  // Status iOS → status web
  // - completed (finalisé) n'apparaît PAS dans /drafts (filtré côté caller)
  // - in_progress + non finalisé → "in-progress"
  // - pas encore commencé → "pending"
  let status = "in-progress";
  if (proj.status === "completed") status = "completed";
  else if (!report.id || report.id === "") status = "pending";

  return {
    id: proj.id,
    address,
    propertyType,
    edlType,
    scheduledAt: proj.scheduledAt || null,
    tenantName: report.tenantName || proj.tenantName || "",
    tenantEmail: report.tenantEmail || "",
    // V5.2.4 — Co-locataires : on les lit depuis `payload.report.additionalTenants`
    // (iOS les pousse sous cette forme). Compat : si vide ou absent, [].
    additionalTenants: Array.isArray(report.additionalTenants) ? report.additionalTenants : [],
    landlordName: report.landlordName || proj.landlordName || "",
    notes: (report.notes || "").slice(0, 1000),
    status,
    exportedAt: null,
    createdAt: proj.createdAt || proj.updatedAt,
    updatedAt: proj.updatedAt,
    source: "ios",
    // Métadonnées spécifiques iOS pour le rendu dashboard.
    isArchived: proj.isArchived === true,
    iosProjectID: proj.id,  // pour les actions (delete, voir, etc.)
  };
}

// GET /drafts : liste les brouillons du user courant.
//
// V5 — Fusionne 2 sources :
//   • store.drafts[] : brouillons créés via le dashboard web (POST /drafts)
//   • store.projects[] : projets iPhone non-finalisés (status !== "completed"
//     et non archivés) → surfacés ici pour que l'agent voie depuis le web
//     ce qui est en cours côté téléphone.
app.get("/drafts", requireCurrentUser, (req, res) => {
  const store = readStore();
  const userID = req._user.id;

  // Source A : brouillons web purs
  const webDrafts = (store.drafts || [])
    .filter((d) => d.userID === userID)
    .map(draftPublicShape);

  // Source B : projets iPhone non-finalisés et non archivés
  const iosDrafts = (store.projects || [])
    .filter((p) =>
      p.userID === userID
      && p.status !== "completed"
      && p.isArchived !== true
    )
    .map(iosProjectToDraftShape);

  // Merge + tri (plus récent en premier).
  const allDrafts = [...webDrafts, ...iosDrafts].sort((a, b) => {
    const aDate = new Date(a.scheduledAt || a.updatedAt || a.createdAt || 0);
    const bDate = new Date(b.scheduledAt || b.updatedAt || b.createdAt || 0);
    return bDate - aDate;
  });

  res.json({
    ok: true,
    items: allDrafts,
    total: allDrafts.length,
    counts: { web: webDrafts.length, ios: iosDrafts.length },
  });
});

// POST /drafts : créer un brouillon
app.post("/drafts", requireCurrentUser, (req, res) => {
  const body = req.body || {};
  const address = sanitizeDraftText(body.address, 200);
  const propertyType = sanitizeDraftText(body.propertyType, 20);
  const edlType = sanitizeDraftText(body.edlType, 20);
  const scheduledAt = sanitizeDraftText(body.scheduledAt, 30);

  if (!address) return res.status(400).json({ ok: false, detail: "Adresse obligatoire" });
  if (!DRAFT_PROPERTY_TYPES.has(propertyType)) {
    return res.status(400).json({ ok: false, detail: "propertyType invalide" });
  }
  if (!DRAFT_EDL_TYPES.has(edlType)) {
    return res.status(400).json({ ok: false, detail: "edlType invalide (entry/exit/inventory)" });
  }
  if (!scheduledAt) return res.status(400).json({ ok: false, detail: "Date prévue obligatoire" });

  const store = readStore();
  if (!Array.isArray(store.drafts)) store.drafts = [];

  const draft = {
    id: `dft_${crypto.randomBytes(5).toString("hex")}`,
    userID: req._user.id,
    address,
    propertyType,
    edlType,
    scheduledAt,
    tenantName: sanitizeDraftText(body.tenantName, 120),
    tenantEmail: sanitizeDraftText(body.tenantEmail, 120).toLowerCase(),
    // V5.2.4 — Co-locataires (couple/colocation). Whitelist : {name, phone, email}.
    additionalTenants: sanitizeAdditionalTenants(body.additionalTenants),
    landlordName: sanitizeDraftText(body.landlordName, 120),
    notes: sanitizeDraftText(body.notes, 1000),
    status: "pending",
    exportedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.drafts.push(draft);
  writeStore(store);
  res.json({ ok: true, draft: draftPublicShape(draft) });
});

// GET /drafts/:id : un brouillon particulier (utilisé par l'app iOS pour pré-remplir)
app.get("/drafts/:id", requireCurrentUser, (req, res) => {
  const store = readStore();
  const draft = (store.drafts || []).find((d) => d.id === req.params.id && d.userID === req._user.id);
  if (!draft) return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });
  res.json({ ok: true, draft: draftPublicShape(draft) });
});

// PATCH /drafts/:id : modifier un brouillon
app.patch("/drafts/:id", requireCurrentUser, (req, res) => {
  const store = readStore();
  const draft = (store.drafts || []).find((d) => d.id === req.params.id && d.userID === req._user.id);
  if (!draft) return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });

  const body = req.body || {};
  if (typeof body.address === "string") {
    const v = sanitizeDraftText(body.address, 200);
    if (v) draft.address = v;
  }
  if (typeof body.propertyType === "string" && DRAFT_PROPERTY_TYPES.has(body.propertyType)) draft.propertyType = body.propertyType;
  if (typeof body.edlType === "string" && DRAFT_EDL_TYPES.has(body.edlType)) draft.edlType = body.edlType;
  if (typeof body.scheduledAt === "string") draft.scheduledAt = sanitizeDraftText(body.scheduledAt, 30);
  if (typeof body.tenantName === "string") draft.tenantName = sanitizeDraftText(body.tenantName, 120);
  if (typeof body.tenantEmail === "string") draft.tenantEmail = sanitizeDraftText(body.tenantEmail, 120).toLowerCase();
  // V5.2.4 — Mise à jour des co-locataires si fournis (array remplacé en entier).
  if (Array.isArray(body.additionalTenants)) {
    draft.additionalTenants = sanitizeAdditionalTenants(body.additionalTenants);
  }
  if (typeof body.landlordName === "string") draft.landlordName = sanitizeDraftText(body.landlordName, 120);
  if (typeof body.notes === "string") draft.notes = sanitizeDraftText(body.notes, 1000);
  if (body.status === "exported" && draft.status !== "exported") {
    draft.status = "exported";
    draft.exportedAt = nowIso();
  }
  draft.updatedAt = nowIso();
  writeStore(store);
  res.json({ ok: true, draft: draftPublicShape(draft) });
});

// DELETE /drafts/:id
app.delete("/drafts/:id", requireCurrentUser, (req, res) => {
  const store = readStore();
  const before = (store.drafts || []).length;
  store.drafts = (store.drafts || []).filter((d) => !(d.id === req.params.id && d.userID === req._user.id));
  if (store.drafts.length === before) {
    return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });
  }
  writeStore(store);
  res.json({ ok: true });
});

app.get("/dashboard/session", requireCurrentUser, (req, res) => {
  const user = req._user;
  // Note : on n'appelle PLUS ensureDashboardAllowed ici. On laisse la session
  // se charger avec le bon statut (trial/expired/lifetime), et c'est le
  // dashboard qui affiche le bon bandeau (essai actif, expiré, illimité).
  res.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      agencyID: user.agencyID,
      subscriptionActive: isAccessActive(user),
      accessStatus: computeAccessStatus(user),
      trialEndsAt: user.trialEndsAt || null,
      trialDaysRemaining: trialDaysRemaining(user),
      foundersAccount: user.foundersAccount === true,
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
  // V5 — Liste enrichie pour permettre au mobile de synchroniser sans
  // appel additionnel : on retourne les champs d'organisation (archive,
  // programmation, image bien) au top-level.
  // Filtre `includeArchived` (par défaut true) pour permettre au mobile
  // d'ignorer les archivés s'il le souhaite. Le dashboard, lui, peut
  // toujours les voir via `?includeArchived=true`.
  const includeArchived = req.query.includeArchived !== "false";

  const items = store.projects
    .filter((p) => p.userID === user.id)
    .filter((p) => includeArchived || !p.isArchived)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .map((p) => ({
      id: p.id,
      name: p.projectName || "Projet",
      address: p.address || "-",
      status: p.status || "in_progress",
      updatedAt: p.updatedAt || nowIso(),
      createdAt: p.createdAt || nowIso(),
      // V5 — Champs d'organisation projet exposés au top-level.
      isArchived: p.isArchived === true,
      archivedAt: p.archivedAt || null,
      scheduledAt: p.scheduledAt || null,
      propertyImageFileName: p.propertyImageFileName || null,
      // Métadonnées résumées pour affichage list.
      tenantName: p.tenantName || null,
      landlordName: p.landlordName || null,
      inspectionType: p.inspectionType || null,
    }));

  res.json({ ok: true, items });
});

// V5 — Détail complet d'un projet incluant son report (utile pour le
// mobile pour reconstituer entièrement un projet créé / modifié depuis
// le dashboard).
app.get("/projects/:id", requireCurrentUser, (req, res) => {
  const user = req._user;
  try {
    ensureDashboardAllowed(user);
  } catch (err) {
    return res.status(err.status || 403).json({ ok: false, detail: err.message });
  }

  const store = req._store;
  const project = store.projects.find(
    (p) => p.id === req.params.id && p.userID === user.id
  );
  if (!project) {
    return res.status(404).json({ ok: false, detail: "Project not found" });
  }

  // On récupère TOUS les reports liés à ce projet (ordre createdAt desc).
  const reports = store.reports
    .filter((r) => r.projectID === project.id && r.userID === user.id)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((r) => ({
      id: r.id,
      projectID: r.projectID,
      fileName: r.fileName,
      createdAt: r.createdAt,
      address: r.address,
      tenantName: r.tenantName,
      isFinalized: r.isFinalized === true,
      finalizedAt: r.finalizedAt || null,
      // V5 — payload complet (toutes les données de l'inspection) pour
      // que le mobile puisse reconstituer l'EDL fidèle au backend.
      payload: r.payload || null,
    }));

  res.json({
    ok: true,
    project: {
      id: project.id,
      name: project.projectName || "Projet",
      address: project.address || null,
      status: project.status || "in_progress",
      updatedAt: project.updatedAt || nowIso(),
      createdAt: project.createdAt || nowIso(),
      isArchived: project.isArchived === true,
      archivedAt: project.archivedAt || null,
      scheduledAt: project.scheduledAt || null,
      propertyImageFileName: project.propertyImageFileName || null,
      tenantName: project.tenantName || null,
      landlordName: project.landlordName || null,
      inspectionType: project.inspectionType || null,
    },
    reports,
  });
});

// V5 — Suppression d'un projet (et de tous ses reports associés).
// Appelé depuis le dashboard ou depuis le mobile pour propager une
// suppression. Idempotent : un projet déjà inexistant renvoie 200.
app.delete("/projects/:id", requireCurrentUser, (req, res) => {
  const user = req._user;
  const store = req._store;
  const projectID = req.params.id;

  const beforeP = store.projects.length;
  store.projects = store.projects.filter(
    (p) => !(p.id === projectID && p.userID === user.id)
  );
  const deletedProjects = beforeP - store.projects.length;

  const beforeR = store.reports.length;
  store.reports = store.reports.filter(
    (r) => !(r.projectID === projectID && r.userID === user.id)
  );
  const deletedReports = beforeR - store.reports.length;

  // Optionnel : on retire aussi les exports liés (mais pas les fichiers
  // sur disque pour le moment — purge à faire manuellement / cron).
  const beforeE = store.exports.length;
  store.exports = store.exports.filter(
    (e) => !(e.projectID === projectID && e.userID === user.id)
  );
  const deletedExports = beforeE - store.exports.length;

  if (deletedProjects + deletedReports + deletedExports > 0) {
    writeStore(store);
  }

  res.json({
    ok: true,
    deleted: {
      projects: deletedProjects,
      reports: deletedReports,
      exports: deletedExports,
    },
  });
});

// V5 — PATCH partiel sur un projet : permet au mobile / dashboard de
// modifier l'état d'archivage, la date de programmation, l'image du bien
// sans avoir à renvoyer toute la payload d'un EDL.
app.patch("/projects/:id", requireCurrentUser, (req, res) => {
  const user = req._user;
  const store = req._store;
  const project = store.projects.find(
    (p) => p.id === req.params.id && p.userID === user.id
  );
  if (!project) {
    return res.status(404).json({ ok: false, detail: "Project not found" });
  }

  const body = req.body || {};
  // Whitelist des champs modifiables (sécurité : on ne laisse pas changer
  // userID, payload, etc.).
  if (typeof body.isArchived === "boolean") {
    project.isArchived = body.isArchived;
    project.archivedAt = body.isArchived ? (body.archivedAt || nowIso()) : null;
  }
  if (body.scheduledAt !== undefined) {
    project.scheduledAt = body.scheduledAt || null;
  }
  if (typeof body.propertyImageFileName === "string" || body.propertyImageFileName === null) {
    project.propertyImageFileName = body.propertyImageFileName || null;
  }
  if (typeof body.projectName === "string" && body.projectName.length) {
    project.projectName = body.projectName;
  }

  // V5.1 — Édition depuis le dashboard web des champs de "draft" sur un
  // projet iPhone non finalisé (status !== "completed"). Permet à
  // l'agent de compléter/corriger l'adresse, le locataire, etc. depuis
  // l'onglet Brouillons ou le Calendrier, et que la modif soit propagée
  // à l'iPhone à la prochaine sync.
  //
  // Garde-fou : on refuse l'édition de ces champs si le projet est
  // terminé (status === "completed") — un EDL signé ne doit pas voir
  // ses métadonnées altérées rétroactivement.
  const canEditDraftFields = project.status !== "completed";
  if (canEditDraftFields) {
    // Top-level (utilisé pour les listings, /api/projects, etc.)
    if (typeof body.address === "string" && body.address.trim().length) {
      project.address = body.address.trim().slice(0, 200);
    }
    if (typeof body.tenantName === "string") {
      project.tenantName = body.tenantName.trim().slice(0, 120);
    }
    if (typeof body.landlordName === "string") {
      project.landlordName = body.landlordName.trim().slice(0, 120);
    }
    if (typeof body.inspectionType === "string") {
      // Accepte les valeurs iOS ("Entrée"/"Sortie"/"Inventaire") ou
      // les keys web ("entry"/"exit"/"inventory") — on stocke en clair.
      project.inspectionType = body.inspectionType;
    }

    // payload.report : la source de vérité pour l'app iPhone. On
    // mirror les changements pour que l'iPhone les voie lors du pull.
    if (project.payload && typeof project.payload === "object") {
      if (!project.payload.report) project.payload.report = {};
      const r = project.payload.report;
      if (typeof body.address === "string" && body.address.trim().length) {
        r.address = body.address.trim().slice(0, 200);
      }
      if (typeof body.addressComplement === "string") {
        r.addressComplement = body.addressComplement.trim().slice(0, 200);
      }
      if (typeof body.postalCode === "string") {
        r.postalCode = body.postalCode.trim().slice(0, 20);
      }
      if (typeof body.city === "string") {
        r.city = body.city.trim().slice(0, 100);
      }
      if (typeof body.tenantName === "string") {
        r.tenantName = body.tenantName.trim().slice(0, 120);
      }
      if (typeof body.tenantEmail === "string") {
        r.tenantEmail = body.tenantEmail.trim().slice(0, 120).toLowerCase();
      }
      // V5.2.4 — Co-locataires : on mirror dans `payload.report.additionalTenants`
      // qui est le format consommé directement par iOS (PropertyInspectionReport.AdditionalTenant).
      if (Array.isArray(body.additionalTenants)) {
        r.additionalTenants = sanitizeAdditionalTenants(body.additionalTenants);
      }
      if (typeof body.landlordName === "string") {
        r.landlordName = body.landlordName.trim().slice(0, 120);
      }
      if (typeof body.notes === "string") {
        r.notes = body.notes.trim().slice(0, 1000);
      }
      // Mapping web edlType → iOS inspectionType.
      if (typeof body.edlType === "string") {
        const map = { entry: "Entrée", exit: "Sortie", inventory: "Inventaire" };
        r.inspectionType = map[body.edlType] || r.inspectionType;
      }
      if (typeof body.inspectionType === "string") {
        r.inspectionType = body.inspectionType;
      }
      if (typeof body.propertyType === "string") {
        r.propertyType = body.propertyType;
      }
    }
  }

  project.updatedAt = nowIso();
  project.updatedAtDb = nowIso();

  writeStore(store);
  res.json({
    ok: true,
    project: {
      id: project.id,
      isArchived: project.isArchived === true,
      archivedAt: project.archivedAt,
      scheduledAt: project.scheduledAt,
      propertyImageFileName: project.propertyImageFileName,
      address: project.address,
      tenantName: project.tenantName,
      landlordName: project.landlordName,
      inspectionType: project.inspectionType,
      updatedAt: project.updatedAt,
    },
  });
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
      // V5 — Métadonnées de surface ajoutées au listing.
      address: r.address || null,
      tenantName: r.tenantName || null,
      isFinalized: r.isFinalized === true,
      finalizedAt: r.finalizedAt || null,
    }));

  res.json({ ok: true, items });
});

// V5 — Suppression d'un report seul (sans toucher au projet parent).
// Cas d'usage : EDL en double, EDL annulé, etc.
app.delete("/reports/:id", requireCurrentUser, (req, res) => {
  const user = req._user;
  const store = req._store;
  const reportID = req.params.id;

  const before = store.reports.length;
  store.reports = store.reports.filter(
    (r) => !(r.id === reportID && r.userID === user.id)
  );
  const deleted = before - store.reports.length;

  if (deleted > 0) {
    writeStore(store);
  }
  res.json({ ok: true, deleted });
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
  const teamsById = new Map((store.teams || []).map((t) => [t.id, t]));
  const users = store.users.map((u) => {
    const team = u.teamId ? teamsById.get(u.teamId) : null;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      authProvider: u.authProvider || "apple",
      subscriptionActive: isAccessActive(u),
      accessStatus: computeAccessStatus(u),
      foundersAccount: u.foundersAccount === true,
      trialEndsAt: u.trialEndsAt || null,
      trialDaysRemaining: trialDaysRemaining(u),
      teamId: u.teamId || null,
      teamName: team?.name || null,
      isTeamOwner: team ? team.ownerUserId === u.id : false,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  });

  res.json({ ok: true, users, total: users.length });
});

// V5.2.2 — Diagnostic admin : retourne les compteurs de drafts/projects/reports
// d'un user pour debugger les disparitions de données.
app.get("/admin/diagnose/:userId", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  const userId = req.params.userId;
  const user = (store.users || []).find((u) => u.id === userId);
  const drafts = (store.drafts || []).filter((d) => d.userID === userId);
  const projects = (store.projects || []).filter((p) => p.userID === userId);
  const reports = (store.reports || []).filter((r) => r.userID === userId);

  // V5.2.5 — Simule le rendu /drafts (unifié web + iOS) pour ce user
  // afin de voir EXACTEMENT ce que le dashboard reçoit.
  let unifiedDraftsResponse = null;
  let unifiedDraftsError = null;
  try {
    const webDrafts = drafts.map(draftPublicShape);
    const iosDrafts = (store.projects || [])
      .filter((p) => p.userID === userId && p.status !== "completed" && p.isArchived !== true)
      .map(iosProjectToDraftShape);
    unifiedDraftsResponse = {
      total: webDrafts.length + iosDrafts.length,
      counts: { web: webDrafts.length, ios: iosDrafts.length },
      sample: [...webDrafts, ...iosDrafts].slice(0, 5).map((d) => ({
        id: d.id, source: d.source, address: d.address, tenantName: d.tenantName,
        additionalTenants: d.additionalTenants, edlType: d.edlType,
      })),
    };
  } catch (e) {
    unifiedDraftsError = `${e.message}\n${e.stack}`;
  }

  res.json({
    ok: true,
    user: user ? { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } : null,
    counts: {
      drafts: drafts.length,
      projects: projects.length,
      projectsInProgress: projects.filter((p) => p.status !== "completed").length,
      projectsArchived: projects.filter((p) => p.isArchived === true).length,
      reports: reports.length,
    },
    // Reflet de ce que GET /drafts renverrait pour ce user — permet de
    // confirmer si l'erreur "je ne vois plus les drafts" vient du backend
    // (réponse vide / crash mapper) ou du frontend (bug rendering).
    drafts_endpoint_simulation: unifiedDraftsResponse,
    drafts_endpoint_error: unifiedDraftsError,
    drafts: drafts.slice(0, 20).map((d) => ({
      id: d.id, address: d.address, edlType: d.edlType, status: d.status,
      scheduledAt: d.scheduledAt, createdAt: d.createdAt,
    })),
    projects: projects.slice(0, 20).map((p) => ({
      id: p.id, projectName: p.projectName, address: p.address, status: p.status,
      isArchived: p.isArchived, origin: p.origin, createdAt: p.createdAt,
      // Inclut le payload report partiellement pour diag des imports
      report_tenant: p.payload?.report?.tenantName,
      report_additional_tenants: p.payload?.report?.additionalTenants,
      report_rooms_count: p.payload?.report?.roomConditions?.length,
    })),
  });
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

// ─── FOUNDERS / AVANTAGE SPÉCIAL 20 PREMIERS UTILISATEURS ────────────────────
// Inscription publique au programme "licence à vie 200€"

const FOUNDERS_MAX_SLOTS = 20;

function sanitizeFounderText(s, maxLen = 200) {
  return String(s || "").trim().replace(/[\x00-\x1F\x7F]/g, "").slice(0, maxLen);
}
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

app.post("/founders", (req, res) => {
  const body = req.body || {};
  const name = sanitizeFounderText(body.name, 100);
  const email = sanitizeFounderText(body.email, 120).toLowerCase();
  const phone = sanitizeFounderText(body.phone, 30);
  const company = sanitizeFounderText(body.company, 120);
  const role = sanitizeFounderText(body.role, 80);
  const comment = sanitizeFounderText(body.comment, 1000);

  if (!name || !email || !isValidEmail(email)) {
    return res.status(400).json({ ok: false, detail: "Nom et email valides obligatoires" });
  }

  const store = readStore();
  if (!Array.isArray(store.founders)) store.founders = [];

  const remaining = Math.max(0, FOUNDERS_MAX_SLOTS - store.founders.length);
  if (remaining <= 0) {
    return res.status(409).json({ ok: false, detail: "L'avantage spécial est complet (20 places remplies)." });
  }

  // Anti-doublon : si même email déjà inscrit, on retourne le premier sans erreur
  const existing = store.founders.find((f) => f.email === email);
  if (existing) {
    return res.json({ ok: true, alreadyRegistered: true, position: store.founders.indexOf(existing) + 1, remaining });
  }

  const ip = (req.header("x-forwarded-for") || req.ip || "").split(",")[0].trim();
  const founder = {
    id: `fnd_${crypto.randomBytes(5).toString("hex")}`,
    name,
    email,
    phone,
    company,
    role,
    comment,
    status: "pending",
    createdAt: nowIso(),
    ipAddress: ip,
    userAgent: sanitizeFounderText(req.header("user-agent") || "", 250),
  };
  store.founders.push(founder);
  writeStore(store);

  // Email admin (asynchrone, ne bloque pas la réponse au client)
  if (adminNotifEmail) {
    sendMail({
      to: adminNotifEmail,
      subject: `🔥 Nouvelle réservation Founder · ${founder.email} · place ${store.founders.length}/${FOUNDERS_MAX_SLOTS}`,
      html: emailAdminFounderReserved({ founder, position: `${store.founders.length}/${FOUNDERS_MAX_SLOTS}` }),
    }).catch((e) => console.error("[mailer] admin notif failed:", e.message));
  }

  res.json({
    ok: true,
    id: founder.id,
    position: store.founders.length,
    total: FOUNDERS_MAX_SLOTS,
    remaining: Math.max(0, FOUNDERS_MAX_SLOTS - store.founders.length),
  });
});

// Endpoint public léger : nb de places restantes (pour afficher live sur la home)
app.get("/founders/availability", (req, res) => {
  const store = readStore();
  const taken = (store.founders || []).length;
  res.json({
    ok: true,
    total: FOUNDERS_MAX_SLOTS,
    taken,
    remaining: Math.max(0, FOUNDERS_MAX_SLOTS - taken),
  });
});

// Admin : liste complète (réservé)
app.get("/admin/founders", (req, res) => {
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.header("x-admin-key") || "";
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }
  const store = readStore();
  const founders = (store.founders || []).slice().reverse(); // plus récents en premier
  res.json({
    ok: true,
    total: FOUNDERS_MAX_SLOTS,
    taken: founders.length,
    remaining: Math.max(0, FOUNDERS_MAX_SLOTS - founders.length),
    items: founders,
  });
});

// Admin : changer le statut d'une inscription (pending → contacted → converted → cancelled)
app.patch("/admin/founders/:id/status", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const allowed = new Set(["pending", "contacted", "converted", "cancelled"]);
  const status = String(req.body?.status || "");
  if (!allowed.has(status)) {
    return res.status(400).json({ ok: false, detail: "status doit être pending|contacted|converted|cancelled" });
  }
  const store = readStore();
  const f = (store.founders || []).find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ ok: false, detail: "Founder introuvable" });
  f.status = status;
  f.updatedAt = nowIso();
  writeStore(store);
  res.json({ ok: true, id: f.id, status: f.status });
});

// Admin : supprimer une inscription
app.delete("/admin/founders/:id", (req, res) => {
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.header("x-admin-key") || "";
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }
  const store = readStore();
  const before = (store.founders || []).length;
  store.founders = (store.founders || []).filter((x) => x.id !== req.params.id);
  if (store.founders.length === before) {
    return res.status(404).json({ ok: false, detail: "Founder introuvable" });
  }
  writeStore(store);
  res.json({ ok: true });
});

// ─── STRIPE CHECKOUT ─────────────────────────────────────────────────────────
// 2 endpoints publics qui créent une Checkout Session et renvoient une URL
// vers laquelle le frontend redirige le navigateur. Le webhook (plus haut)
// confirme le paiement réussi et marque le founder/user comme "converted/active".

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://foxscan.fr";

// Sécurité : vérifie que l'origine de la requête est bien celle de notre site
// (anti-CSRF léger). On laisse passer aussi en mode "no origin" (curl, mobile).
function isAllowedOrigin(req) {
  const origin = req.header("origin") || "";
  if (!origin) return true;
  return origin === "https://foxscan.fr" || origin === "https://www.foxscan.fr";
}

// FOUNDERS : 200€ paiement unique
// Body : { founderId: "fnd_..." } (l'ID renvoyé par POST /founders)
app.post("/checkout/founders", async (req, res) => {
  if (!stripe) return res.status(503).json({ ok: false, detail: "Stripe non configuré" });
  if (!isAllowedOrigin(req)) return res.status(403).json({ ok: false, detail: "Origin non autorisée" });

  const founderId = String(req.body?.founderId || "");
  if (!founderId) return res.status(400).json({ ok: false, detail: "founderId requis" });

  const store = readStore();
  const founder = (store.founders || []).find((f) => f.id === founderId);
  if (!founder) return res.status(404).json({ ok: false, detail: "Réservation introuvable" });
  if (founder.status === "converted") {
    return res.status(409).json({ ok: false, detail: "Cette réservation a déjà été payée" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: {
            name: "FOXSCAN — Licence à vie (Avantage Spécial 20 premiers)",
            description: "Accès complet, mises à jour à vie, 1 utilisateur. Paiement unique.",
          },
          unit_amount: FOUNDERS_PRICE_EUR_CENTS,
        },
        quantity: 1,
      }],
      customer_email: founder.email,
      metadata: {
        type: "founders",
        founderId: founder.id,
        name: founder.name || "",
        company: founder.company || "",
      },
      success_url: `${PUBLIC_BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&type=founders`,
      cancel_url: `${PUBLIC_BASE_URL}/checkout/cancel?type=founders`,
      locale: "fr",
      allow_promotion_codes: false,
    });

    // On stocke l'id de session sur le founder pour traçabilité
    founder.stripeSessionId = session.id;
    founder.updatedAt = nowIso();
    writeStore(store);

    res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[stripe] checkout founders error :", err.message);
    res.status(500).json({ ok: false, detail: "Erreur Stripe : " + err.message });
  }
});

// SUBSCRIPTION : abonnement mensuel selon nombre d'utilisateurs (1-15)
// Body : { users: 5, email: "agent@example.com", company?: "..." }
app.post("/checkout/subscription", async (req, res) => {
  if (!stripe) return res.status(503).json({ ok: false, detail: "Stripe non configuré" });
  if (!isAllowedOrigin(req)) return res.status(403).json({ ok: false, detail: "Origin non autorisée" });

  const users = parseInt(req.body?.users, 10);
  const email = String(req.body?.email || "").trim().toLowerCase();
  const company = String(req.body?.company || "").trim().slice(0, 120);

  if (!Number.isInteger(users) || users < 1 || users > 15) {
    return res.status(400).json({ ok: false, detail: "users doit être un entier entre 1 et 15" });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, detail: "email valide requis" });
  }

  const amountCents = SUBSCRIPTION_PRICES_EUR_CENTS[users];
  if (!amountCents) {
    return res.status(400).json({ ok: false, detail: "Tarif inconnu pour ce nombre d'utilisateurs" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "eur",
          unit_amount: amountCents,
          recurring: { interval: "month" },
          product_data: {
            name: `FOXSCAN — Abonnement ${users} utilisateur${users > 1 ? "s" : ""}`,
            description: `Plateforme complète : EDL illimités, scan 3D, comparateur, dashboard. Facturation mensuelle, sans engagement.`,
          },
        },
        quantity: 1,
      }],
      customer_email: email,
      metadata: {
        type: "subscription",
        users: String(users),
        company,
      },
      subscription_data: {
        metadata: {
          users: String(users),
          company,
        },
      },
      success_url: `${PUBLIC_BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&type=subscription`,
      cancel_url: `${PUBLIC_BASE_URL}/checkout/cancel?type=subscription`,
      locale: "fr",
      allow_promotion_codes: true,
      billing_address_collection: "auto",
    });

    res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[stripe] checkout subscription error :", err.message);
    res.status(500).json({ ok: false, detail: "Erreur Stripe : " + err.message });
  }
});

// Endpoint utilitaire : récupère l'état d'une session Checkout (utilisé par
// la page /checkout/success pour afficher le bon message au client).
app.get("/checkout/session/:id", async (req, res) => {
  if (!stripe) return res.status(503).json({ ok: false, detail: "Stripe non configuré" });
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json({
      ok: true,
      status: session.status,
      paymentStatus: session.payment_status,
      mode: session.mode,
      amountTotal: session.amount_total,
      currency: session.currency,
      customerEmail: session.customer_details?.email || session.customer_email || "",
      metadata: session.metadata || {},
    });
  } catch (err) {
    res.status(404).json({ ok: false, detail: "Session introuvable" });
  }
});

// ─── Stripe event handler (utilisé par le webhook plus haut) ─────────────────
async function handleStripeEvent(event) {
  console.log(`[stripe webhook] event=${event.type} id=${event.id}`);
  const store = readStore();
  let mutated = false;

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      const meta = s.metadata || {};
      const customerEmail = (s.customer_details?.email || s.customer_email || "").toLowerCase();
      const customerName = s.customer_details?.name || "";

      // ─── CAS 1 : Paiement Founders 200€ ────────────────────────────────────
      if (meta.type === "founders" && meta.founderId) {
        const f = (store.founders || []).find((x) => x.id === meta.founderId);
        if (f && f.status !== "converted") {
          f.status = "converted";
          f.paidAt = nowIso();
          f.stripeSessionId = s.id;
          f.stripeCustomerId = s.customer || "";
          f.amountPaidCents = s.amount_total || FOUNDERS_PRICE_EUR_CENTS;
          mutated = true;

          // Création / activation du compte FOXSCAN
          const { user, password, isExisting } = createOrFindUserForPaidEmail(store, {
            email: f.email,
            name: f.name,
          });
          user.subscriptionStatus = "active";
          user.stripeCustomerId = s.customer || "";
          user.foundersAccount = true; // marque comme licence à vie
          user.updatedAt = nowIso();
          f.userId = user.id;

          console.log(`[stripe] Founder ${f.id} (${f.email}) → converted, user=${user.id} ${isExisting ? "(existant)" : "(nouveau)"}`);
          writeStore(store);
          mutated = false; // déjà persisté

          // Envoi des emails (en parallèle, pas bloquant)
          sendMail({
            to: f.email,
            subject: "🎉 Bienvenue chez FOXSCAN — votre licence à vie est activée",
            html: emailWelcomeFounder({ name: f.name, email: f.email, password, isExistingUser: isExisting }),
          }).catch((e) => console.error("[stripe] welcome email error:", e.message));

          if (adminNotifEmail) {
            sendMail({
              to: adminNotifEmail,
              subject: `💸 Founder converti · ${f.email} · 200 €`,
              html: emailAdminPaymentSuccess({
                type: "founders",
                email: f.email,
                amountEur: ((s.amount_total || 20000) / 100).toFixed(2),
                customerName: f.name || customerName,
              }),
            }).catch((e) => console.error("[stripe] admin notif error:", e.message));
          }
        }
        break;
      }

      // ─── CAS 2 : Abonnement mensuel souscrit ───────────────────────────────
      if (meta.type === "subscription") {
        const users = parseInt(meta.users || "0", 10);
        if (!customerEmail) {
          console.warn("[stripe] subscription event sans email — ignoré");
          break;
        }

        if (!Array.isArray(store.auditEvents)) store.auditEvents = [];
        store.auditEvents.push({
          id: `aud_${crypto.randomBytes(4).toString("hex")}`,
          type: "stripe.subscription.subscribed",
          email: customerEmail,
          users,
          company: meta.company || "",
          stripeSubscriptionId: s.subscription || "",
          stripeCustomerId: s.customer || "",
          amountCents: s.amount_total || 0,
          createdAt: nowIso(),
        });

        // Création / activation du compte FOXSCAN
        const { user, password, isExisting } = createOrFindUserForPaidEmail(store, {
          email: customerEmail,
          name: customerName,
        });
        user.subscriptionStatus = "active";
        user.stripeCustomerId = s.customer || "";
        user.stripeSubscriptionId = s.subscription || "";
        user.subscriptionUsers = users;
        user.updatedAt = nowIso();

        console.log(`[stripe] Subscription ${customerEmail} (${users} users) → active, user=${user.id} ${isExisting ? "(existant)" : "(nouveau)"}`);
        writeStore(store);
        mutated = false;

        sendMail({
          to: customerEmail,
          subject: `🎉 Bienvenue chez FOXSCAN — abonnement ${users} utilisateur${users > 1 ? "s" : ""} activé`,
          html: emailWelcomeSubscription({ name: customerName, email: customerEmail, password, users, isExistingUser: isExisting }),
        }).catch((e) => console.error("[stripe] welcome email error:", e.message));

        if (adminNotifEmail) {
          sendMail({
            to: adminNotifEmail,
            subject: `💸 Nouvel abonné · ${customerEmail} · ${users} users · ${((s.amount_total || 0) / 100).toFixed(2)} €/mois`,
            html: emailAdminPaymentSuccess({
              type: "subscription",
              email: customerEmail,
              amountEur: ((s.amount_total || 0) / 100).toFixed(2),
              customerName,
              users,
            }),
          }).catch((e) => console.error("[stripe] admin notif error:", e.message));
        }
        break;
      }

      console.warn(`[stripe] checkout completed sans metadata.type — ignoré (session=${s.id})`);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const user = (store.users || []).find((u) => u.stripeSubscriptionId === sub.id);
      if (user && user.subscriptionStatus === "active") {
        user.subscriptionStatus = "inactive";
        user.updatedAt = nowIso();
        mutated = true;
        console.log(`[stripe] User ${user.id} → subscription cancelled`);
      }
      break;
    }

    case "invoice.payment_failed": {
      const inv = event.data.object;
      console.warn(`[stripe] Payment failed for ${inv.customer_email || inv.customer} amount=${(inv.amount_due || 0) / 100}€`);
      if (adminNotifEmail) {
        sendMail({
          to: adminNotifEmail,
          subject: `⚠️ Échec de paiement · ${inv.customer_email || inv.customer}`,
          html: emailLayout("Échec de paiement", `<p>Une charge a échoué sur Stripe :</p><pre style="background:#FFEFEE;padding:14px;border-radius:8px;font-size:13px">Email : ${escapeHtml(inv.customer_email || "")}<br>Montant : ${(inv.amount_due || 0) / 100} €</pre><p>Vérifiez sur <a href="https://dashboard.stripe.com/payments">Stripe Dashboard</a>.</p>`),
        }).catch(() => {});
      }
      break;
    }

    default:
      // event ignoré, c'est OK (Stripe envoie beaucoup de types par défaut)
      break;
  }

  if (mutated) writeStore(store);
}

// Admin : INVITATION MANUELLE d'un founder (compte à vie offert)
// Body : { email, name?, password?, sendEmail? }
//   - Si password absent → généré aléatoirement
//   - Si sendEmail !== false → envoie l'email de bienvenue
//   - Bypass la limite des 20 places (l'admin peut inviter qui il veut)
app.post("/admin/founders/invite", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const body = req.body || {};
  const email = sanitizeFounderText(body.email, 120).toLowerCase();
  const name = sanitizeFounderText(body.name, 100);
  let password = String(body.password || "").trim();
  const sendWelcome = body.sendEmail !== false;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ ok: false, detail: "Email valide obligatoire" });
  }
  if (password && password.length < 6) {
    return res.status(400).json({ ok: false, detail: "Mot de passe min. 6 caractères (ou laissez vide pour auto-générer)" });
  }

  const store = readStore();
  if (!Array.isArray(store.founders)) store.founders = [];

  // Anti-doublon : si déjà founder, on retourne l'existant (pas d'erreur)
  const existingFounder = store.founders.find((f) => f.email === email);
  if (existingFounder && existingFounder.status === "converted") {
    return res.status(409).json({ ok: false, detail: "Cet email est déjà un founder converti" });
  }

  // Création/réactivation du compte FOXSCAN
  // (createOrFindUserForPaidEmail génère un mot de passe random si nouveau)
  const generated = !password;
  if (generated) password = generateRandomPassword(12);

  let user = store.users.find((u) => (u.email || "").toLowerCase() === email);
  let isExisting = !!user;
  if (!user) {
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    user = {
      id: `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      authProvider: "email",
      email,
      passwordHash,
      passwordSalt: salt,
      name: name || email.split("@")[0],
      agencyID: null,
      subscriptionStatus: "active",
      foundersAccount: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.users.push(user);
  } else {
    // Compte existant : on le ré-active et on remplace le mot de passe SI fourni
    user.subscriptionStatus = "active";
    user.foundersAccount = true;
    user.updatedAt = nowIso();
    if (!generated && password) {
      // Le mot de passe a été explicitement fourni par l'admin → on le set
      const salt = crypto.randomBytes(16).toString("hex");
      user.passwordHash = hashPassword(password, salt);
      user.passwordSalt = salt;
      user.authProvider = "email";
    } else if (generated) {
      // Pas de mot de passe fourni et compte existant → on garde l'ancien
      // (sinon on casserait l'accès du user). On ne renverra donc pas le password.
      password = null;
    }
  }

  // Création/MAJ de l'entrée Founder
  let founder = existingFounder;
  if (!founder) {
    founder = {
      id: `fnd_${crypto.randomBytes(5).toString("hex")}`,
      name: name || user.name,
      email,
      phone: "",
      company: "",
      role: "",
      comment: "Invité manuellement par l'admin",
      status: "converted",
      source: "admin_invite",
      createdAt: nowIso(),
      paidAt: nowIso(),
      userId: user.id,
      ipAddress: "",
      userAgent: "",
    };
    store.founders.push(founder);
  } else {
    founder.status = "converted";
    founder.paidAt = nowIso();
    founder.source = founder.source || "admin_invite";
    founder.userId = user.id;
    founder.updatedAt = nowIso();
  }

  writeStore(store);

  // Envoi du mail de bienvenue (asynchrone, ne bloque pas la réponse)
  let emailResult = { sent: false, reason: "skipped" };
  if (sendWelcome) {
    emailResult = await sendMail({
      to: email,
      subject: "🎉 Bienvenue chez FOXSCAN — votre licence à vie est activée",
      html: emailWelcomeFounder({
        name: founder.name,
        email,
        password: password, // null si compte existant et pas de mdp fourni
        isExistingUser: isExisting && !password,
      }),
    });
  }

  res.json({
    ok: true,
    founder,
    user: { id: user.id, email: user.email, name: user.name },
    passwordGenerated: generated,
    password: generated ? password : null, // on renvoie le mdp généré pour que l'admin puisse le copier
    emailSent: emailResult.sent,
    emailError: emailResult.error || null,
  });
});

// Admin : ré-envoie l'email de bienvenue à un founder existant
// (utile si le client a perdu son mail). Régénère un mot de passe.
app.post("/admin/founders/:id/resend-email", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  const founder = (store.founders || []).find((f) => f.id === req.params.id);
  if (!founder) return res.status(404).json({ ok: false, detail: "Founder introuvable" });

  // Régénère un mot de passe et l'applique au compte FOXSCAN
  const newPassword = generateRandomPassword(12);
  const user = (store.users || []).find((u) => (u.email || "").toLowerCase() === (founder.email || "").toLowerCase());
  if (user) {
    const salt = crypto.randomBytes(16).toString("hex");
    user.passwordHash = hashPassword(newPassword, salt);
    user.passwordSalt = salt;
    user.subscriptionStatus = "active";
    user.foundersAccount = true;
    user.updatedAt = nowIso();
    writeStore(store);
  }

  const result = await sendMail({
    to: founder.email,
    subject: "🔑 FOXSCAN — vos identifiants (renvoi)",
    html: emailWelcomeFounder({
      name: founder.name,
      email: founder.email,
      password: user ? newPassword : null,
      isExistingUser: !user,
    }),
  });

  res.json({
    ok: result.sent,
    passwordReset: !!user,
    password: user ? newPassword : null,
    emailError: result.error || null,
  });
});

// Admin : envoie un email de test pour vérifier la config SMTP
app.post("/admin/test-email", async (req, res) => {
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.body?.adminKey || req.header("x-admin-key") || "";
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }
  const to = (req.body?.to || adminNotifEmail || "").trim();
  if (!to) return res.status(400).json({ ok: false, detail: "destination email manquant" });
  const result = await sendMail({
    to,
    subject: "✅ Test SMTP FOXSCAN",
    html: emailLayout("Test SMTP FOXSCAN", `<p>Cet email confirme que la configuration SMTP de FOXSCAN fonctionne.</p><p style="font-size:13px;color:#86868B">Envoyé le ${new Date().toLocaleString("fr-FR")} depuis ${escapeHtml(smtpHost)}:${smtpPort}.</p>`),
  });
  res.json({ ok: result.sent, ...result });
});

// ─── ADMIN : ÉQUIPES (regroupement de comptes par entreprise/agence) ────────
// Une équipe regroupe plusieurs users. Chaque user a un seul teamId (ou null).
// Le owner est le compte "admin de l'équipe" (typiquement le directeur d'agence).
// L'admin de la plateforme (toi via /admin/) crée et gère les équipes.

function teamSummary(team, users) {
  const members = (users || []).filter((u) => u.teamId === team.id);
  const owner = members.find((u) => u.id === team.ownerUserId);
  return {
    id: team.id,
    name: team.name,
    ownerUserId: team.ownerUserId || null,
    ownerName: owner?.name || "—",
    ownerEmail: owner?.email || "",
    membersCount: members.length,
    members: members.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isOwner: u.id === team.ownerUserId,
      authProvider: u.authProvider || "email",
      accessStatus: computeAccessStatus(u),
    })),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

// GET : liste de toutes les équipes (avec leurs membres)
app.get("/admin/teams", (req, res) => {
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.header("x-admin-key") || "";
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }
  const store = readStore();
  const items = (store.teams || []).map((t) => teamSummary(t, store.users));
  res.json({ ok: true, total: items.length, items });
});

// POST : créer une équipe — { name, ownerUserId? }
app.post("/admin/teams", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const name = sanitizeFounderText(req.body?.name, 80);
  const ownerUserId = String(req.body?.ownerUserId || "").trim();
  if (!name) return res.status(400).json({ ok: false, detail: "Nom de l'équipe obligatoire" });

  const store = readStore();
  if (!Array.isArray(store.teams)) store.teams = [];

  // Empêche les doublons de nom (case-insensitive)
  if (store.teams.some((t) => (t.name || "").toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ ok: false, detail: "Une équipe avec ce nom existe déjà" });
  }

  const team = {
    id: `team_${crypto.randomBytes(5).toString("hex")}`,
    name,
    ownerUserId: ownerUserId || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.teams.push(team);

  // Si un owner est défini, on lui attribue le teamId
  if (ownerUserId) {
    const owner = store.users.find((u) => u.id === ownerUserId);
    if (owner) {
      owner.teamId = team.id;
      owner.updatedAt = nowIso();
    }
  }

  writeStore(store);
  res.json({ ok: true, team: teamSummary(team, store.users) });
});

// PATCH : renommer / changer owner — { name?, ownerUserId? }
app.patch("/admin/teams/:id", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  const team = (store.teams || []).find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ ok: false, detail: "Équipe introuvable" });

  if (typeof req.body?.name === "string") {
    const newName = sanitizeFounderText(req.body.name, 80);
    if (newName) team.name = newName;
  }
  if (typeof req.body?.ownerUserId === "string") {
    const newOwnerId = req.body.ownerUserId.trim();
    if (newOwnerId === "" || newOwnerId === null) {
      team.ownerUserId = null;
    } else {
      const owner = store.users.find((u) => u.id === newOwnerId);
      if (!owner) return res.status(404).json({ ok: false, detail: "Owner introuvable" });
      // Le nouvel owner doit être membre de l'équipe (ou on l'y ajoute)
      owner.teamId = team.id;
      owner.updatedAt = nowIso();
      team.ownerUserId = newOwnerId;
    }
  }
  team.updatedAt = nowIso();
  writeStore(store);
  res.json({ ok: true, team: teamSummary(team, store.users) });
});

// DELETE : supprimer l'équipe (les membres voient leur teamId effacé)
app.delete("/admin/teams/:id", (req, res) => {
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.header("x-admin-key") || "";
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }
  const store = readStore();
  const before = (store.teams || []).length;
  store.teams = (store.teams || []).filter((t) => t.id !== req.params.id);
  if (store.teams.length === before) {
    return res.status(404).json({ ok: false, detail: "Équipe introuvable" });
  }
  // Détacher tous les membres
  let detached = 0;
  for (const u of store.users) {
    if (u.teamId === req.params.id) {
      u.teamId = null;
      u.updatedAt = nowIso();
      detached++;
    }
  }
  writeStore(store);
  res.json({ ok: true, detached });
});

// POST : ajouter des membres — body { userIds: ["usr_xxx", ...] }
app.post("/admin/teams/:id/members", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  const team = (store.teams || []).find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ ok: false, detail: "Équipe introuvable" });
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  let added = 0;
  for (const id of userIds) {
    const user = store.users.find((u) => u.id === id);
    if (user) {
      user.teamId = team.id;
      user.updatedAt = nowIso();
      added++;
    }
  }
  team.updatedAt = nowIso();
  writeStore(store);
  res.json({ ok: true, added, team: teamSummary(team, store.users) });
});

// DELETE : retirer un membre
app.delete("/admin/teams/:id/members/:userId", (req, res) => {
  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.header("x-admin-key") || "";
  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }
  const store = readStore();
  const team = (store.teams || []).find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ ok: false, detail: "Équipe introuvable" });
  const user = store.users.find((u) => u.id === req.params.userId);
  if (!user) return res.status(404).json({ ok: false, detail: "User introuvable" });
  if (user.teamId !== team.id) {
    return res.status(400).json({ ok: false, detail: "Cet utilisateur n'est pas membre de cette équipe" });
  }
  user.teamId = null;
  user.updatedAt = nowIso();
  // Si c'était le owner, on l'efface
  if (team.ownerUserId === user.id) team.ownerUserId = null;
  team.updatedAt = nowIso();
  writeStore(store);
  res.json({ ok: true, team: teamSummary(team, store.users) });
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

  // V5 — Extraction des champs au TOP-LEVEL du projet pour que le
  // dashboard puisse filtrer / trier / archiver sans avoir à parcourir
  // le sous-objet `payload.report.X` à chaque requête.
  const report = body.report || {};

  // Adresse lisible reconstituée depuis les champs structurés du rapport.
  const addressLine1 = [report.address, report.addressComplement]
    .filter((v) => v && String(v).trim().length)
    .join(", ");
  const addressLine2 = [report.postalCode, report.city]
    .filter((v) => v && String(v).trim().length)
    .join(" ");
  const fullAddress = [addressLine1, addressLine2]
    .filter((v) => v && v.length)
    .join(", ");

  // Statut du projet : si l'EDL est finalisé → completed.
  let projectStatus = "in_progress";
  if (report.isFinalized === true) projectStatus = "completed";
  if (report.signedByTenant === true && report.signedByOwner === true) {
    projectStatus = "completed";
  }

  // Si projet existe déjà, on PRÉSERVE les champs d'archivage / programmation
  // déjà stockés (jamais écrasés par une re-sync mobile).
  const existingProject = store.projects.find((p) => p.id === projectID);
  const preservedIsArchived = existingProject?.isArchived ?? false;
  const preservedArchivedAt = existingProject?.archivedAt ?? null;
  const preservedScheduledAt = existingProject?.scheduledAt ?? null;
  const preservedPropertyImage = existingProject?.propertyImageFileName ?? null;

  upsertByID(store.projects, projectID, {
    userID,
    projectName: body.projectName || "Nouveau projet",
    updatedAt: body.updatedAt || nowIso(),
    status: projectStatus,
    // V5 — Vraie adresse extraite (au lieu du hard-coded « Adresse
    // synchronisée depuis iOS » qui était inutilisable côté dashboard).
    address: fullAddress || "(adresse à renseigner)",
    tenantName: report.tenantName || "",
    landlordName: report.landlordName || "",
    agentName: report.agentName || "",
    inspectionType: report.inspectionType || "Entrée",
    // V5 — Champs d'organisation projet préservés (jamais réinitialisés
    // par une re-sync depuis le mobile, sauf s'ils sont volontairement
    // explicites dans la payload mobile, à venir si on étend le contrat).
    isArchived: preservedIsArchived,
    archivedAt: preservedArchivedAt,
    scheduledAt: preservedScheduledAt,
    propertyImageFileName: preservedPropertyImage,
    payload: body,
    updatedAtDb: nowIso(),
    createdAt: existingProject?.createdAt || nowIso(),
  });

  upsertByID(store.reports, reportID, {
    userID,
    projectID,
    projectName: body.projectName || "Nouveau projet",
    fileName: `${reportID}.pdf`,
    createdAt: body.updatedAt || nowIso(),
    payload: report,
    // V5 — Métadonnées de surface pour faciliter l'affichage liste
    // sans avoir à déballer `payload` à chaque fois.
    address: fullAddress || null,
    tenantName: report.tenantName || null,
    isFinalized: report.isFinalized === true,
    finalizedAt: report.finalizedAt || null,
    createdAtDb: nowIso(),
  });

  writeStore(store);
  res.json({ ok: true, id: reportID, projectID, message: "Inspection synchronized" });
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

// ── Upload binaire des fichiers exportés (sauvegarde JSON, USDZ, PDF…) ──────
// L'app iOS POSTe le contenu en `application/octet-stream` avec les
// métadonnées en query string. On stocke sur disque et on enregistre la
// référence dans store.exports[] pour que le dashboard puisse la lister
// + servir le téléchargement.
//
// Pourquoi pas multipart/form-data ? Ça nécessiterait une dépendance (multer)
// alors qu'express.raw() fait l'affaire pour 1 fichier par requête, sans
// surcoût. Pour plusieurs fichiers en parallèle on appelle plusieurs fois.
ensureDir(settings.exportFilesDir);

function safeFileName(input) {
  return String(input || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 180) || "export.bin";
}

// ─────────────────────────────────────────────────────────────────────
// V5.2 — Import d'EDL externes (PDFs d'autres prestataires)
//
// POST /imports/edl  (body : raw PDF, Content-Type: application/pdf)
//   → Parse le PDF (parser dédié si format reconnu, sinon IA Vision)
//   → Crée un projet "in_progress" dans store.projects[] avec payload.report
//     pré-rempli depuis les données extraites
//   → Retourne le project + le JSON normalisé pour preview/edition côté UI
//
// L'agent peut ensuite ouvrir ce projet dans l'app iPhone (pull /api/projects
// le ramène) ou éditer les champs depuis le dashboard.
// ─────────────────────────────────────────────────────────────────────

const { importEDL: importEDLImpl, toFoxscanReport } = require("./lib/edlImport");

app.post(
  "/imports/edl",
  requireCurrentUser,
  // Plafond du body raw spécifique aux PDFs d'EDL : 30 Mo couvre largement
  // les rapports les plus lourds (avec photos). Si besoin, FOXSCAN_IMPORT_LIMIT.
  express.raw({
    type: ["application/pdf", "application/octet-stream"],
    limit: process.env.FOXSCAN_IMPORT_LIMIT || "30mb",
  }),
  async (req, res) => {
    const user = req._user;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ ok: false, detail: "PDF manquant" });
    }
    if (buf.length > 30 * 1024 * 1024) {
      return res.status(413).json({ ok: false, detail: "PDF trop volumineux (max 30 Mo)" });
    }
    // Quick magic-bytes check : un vrai PDF commence par "%PDF-"
    if (buf.slice(0, 4).toString("ascii") !== "%PDF") {
      return res.status(400).json({ ok: false, detail: "Le fichier n'est pas un PDF valide" });
    }

    let normalized;
    try {
      normalized = await importEDLImpl(buf, { callOpenAI: callOpenAIResponses });
    } catch (err) {
      console.error(`[/imports/edl] user=${user.id} parse failed: ${err.message}`);
      return res.status(err.status || 500).json({
        ok: false,
        detail: `Analyse du PDF impossible : ${err.message}`,
      });
    }

    // Construit l'adresse "humaine" pour le top-level project (utilisé par
    // /api/projects + dashboard listings).
    const meta = normalized.meta || {};
    const fullAddress = [
      [meta.address, meta.addressComplement].filter(Boolean).join(", "),
      [meta.postalCode, meta.city].filter(Boolean).join(" "),
    ].filter((v) => v && v.trim().length).join(", ") || "(adresse à renseigner)";

    // V5 — On crée le projet sous la même forme que ceux poussés par iOS
    // via /inspections/sync, pour qu'il soit immédiatement visible :
    //   • dashboard Brouillons (via /drafts unifié, status !== "completed")
    //   • dashboard Calendrier (si scheduledAt renseigné plus tard)
    //   • iPhone (via /api/projects → pull HomeView)
    const store = readStore();
    const projectID = crypto.randomUUID();
    const reportID = crypto.randomUUID();

    const reportPayload = toFoxscanReport(normalized, { reportId: reportID, projectId: projectID });

    const tenantName = reportPayload.tenantName || "";
    const landlordName = reportPayload.landlordName || "";
    const inspectionType = reportPayload.inspectionType || "Entrée";

    const project = {
      id: projectID,
      userID: user.id,
      projectName: `Import ${normalized.sourceFormat || "EDL"} — ${fullAddress.slice(0, 60)}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      updatedAtDb: nowIso(),
      status: "in_progress",
      address: fullAddress,
      tenantName,
      landlordName,
      inspectionType,
      // V5.1 — Origine du projet : permet à l'UI de badger "Importé" sur
      // les cards et de filtrer côté reporting.
      origin: "import",
      importedSourceFormat: normalized.sourceFormat || null,
      importedConfidence: normalized.confidence || null,
      isArchived: false,
      archivedAt: null,
      scheduledAt: null,
      propertyImageFileName: null,
      payload: {
        report: reportPayload,
      },
    };

    store.projects = store.projects || [];
    store.projects.push(project);

    // V5.2 — Pushed aussi en store.reports[] pour que GET /projects/:id
    // (utilisé par l'iPhone pour pré-remplir l'EDL) renvoie le report avec
    // les rooms/items extraits — sinon iOS verrait juste un projet vide.
    store.reports = store.reports || [];
    store.reports.push({
      id: reportID,
      userID: user.id,
      projectID,
      projectName: project.projectName,
      fileName: `${reportID}.pdf`,
      createdAt: nowIso(),
      payload: reportPayload,
      address: fullAddress,
      tenantName,
      isFinalized: false,
      finalizedAt: null,
      origin: "import",
      createdAtDb: nowIso(),
    });
    writeStore(store);

    console.log(`[/imports/edl] user=${user.id} project=${projectID} format=${normalized.sourceFormat} rooms=${(normalized.rooms || []).length}`);

    res.json({
      ok: true,
      project: {
        id: projectID,
        projectName: project.projectName,
        address: project.address,
        tenantName,
        landlordName,
        inspectionType,
        sourceFormat: normalized.sourceFormat,
        confidence: normalized.confidence,
      },
      // Le JSON normalisé est inclus pour permettre à l'UI d'afficher une
      // preview détaillée avant que l'agent aille sur place. L'UI peut
      // ensuite faire PATCH /projects/:id pour corriger les champs.
      extracted: normalized,
    });
  }
);

app.post(
  "/exports/upload",
  requireCurrentUser,
  express.raw({ type: "*/*", limit: settings.uploadLimit }),
  async (req, res, next) => {
    try {
      const store = req._store;
      const user = req._user;
      ensureDashboardAllowed(user);

      const buffer = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ ok: false, detail: "binary body is empty" });
      }

      const fileName = safeFileName(req.query.fileName);
      const projectID = String(req.query.projectID || "").trim() || null;
      const reportID = String(req.query.reportID || "").trim() || null;
      const kind = String(req.query.kind || "inspectionBundle").trim();

      // Métadonnées de groupement par bien (entrée vs sortie). Optionnelles
      // pour ne pas casser les anciens clients iOS qui ne les envoient pas
      // encore. Le dashboard les utilisera pour comparer entrée/sortie d'un
      // même bien (matching sur propertyID stable).
      const inspectionType = String(req.query.inspectionType || "").trim() || null;
      const propertyID = String(req.query.propertyID || "").trim() || null;
      const propertyAddress = String(req.query.propertyAddress || "").trim() || null;
      const tenantName = String(req.query.tenantName || "").trim() || null;
      const inspectionDate = String(req.query.inspectionDate || "").trim() || null;

      const exportID = `exp_${crypto.randomBytes(4).toString("hex")}`;
      const userDir = path.join(settings.exportFilesDir, user.id);
      ensureDir(userDir);

      const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");

      // V5 — Dédup idempotente : si on a DÉJÀ un export avec le même
      // (userID, projectID, fileName, contentHash), on retourne l'existant
      // sans créer de duplicata. Permet à iOS de re-pousser les photos en
      // background sans gonfler la base à chaque tentative.
      const dedupExisting = store.exports.find((e) =>
        e.userID === user.id
        && e.projectID === projectID
        && e.fileName === fileName
        && e.contentHash === contentHash
      );
      if (dedupExisting) {
        console.log(`[/exports/upload] dedup hit user=${user.id} file=${fileName} → reused id=${dedupExisting.id}`);
        return res.json({
          ok: true,
          id: dedupExisting.id,
          fileName: dedupExisting.fileName,
          sizeBytes: dedupExisting.sizeBytes,
          downloadPath: dedupExisting.downloadPath,
          deduplicated: true,
        });
      }

      const diskName = `${exportID}_${fileName}`;
      const diskPath = path.join(userDir, diskName);
      fs.writeFileSync(diskPath, buffer);

      const downloadPath = `/exports/files/${user.id}/${diskName}`;

      store.exports.push({
        id: exportID,
        userID: user.id,
        projectID,
        reportID,
        createdByUserID: user.id,
        createdAt: nowIso(),
        kind,
        fileName,
        contentHash,
        sizeBytes: buffer.length,
        diskPath,
        downloadPath,
        // Champs de groupement (peuvent être null pour anciens clients).
        inspectionType,
        propertyID,
        propertyAddress,
        tenantName,
        inspectionDate,
        createdAtDb: nowIso(),
      });

      if (reportID) {
        upsertByID(store.reports, reportID, {
          userID: user.id,
          projectID: projectID || "",
          projectName: req.query.projectName || propertyAddress || "Projet exporté",
          fileName,
          createdAt: nowIso(),
          payload: {
            kind,
            downloadPath,
            sizeBytes: buffer.length,
            inspectionType,
            propertyID,
            propertyAddress,
            tenantName,
            inspectionDate,
          },
          createdAtDb: nowIso(),
        });
      }

      writeStore(store);
      console.log(
        `[/exports/upload] user=${user.id} file=${fileName} bytes=${buffer.length} kind=${kind}` +
        (propertyID ? ` propertyID=${propertyID} type=${inspectionType || "?"}` : "")
      );

      // ── AUTO-EXTRACTION du bundle si c'est un inspectionBundle JSON ──
      // On parse, extrait les fichiers binaires sur disque dans
      // data/projects/<projectID>/ et on stocke les metadata dans _meta.json.
      // Le bundle d'origine reste aussi accessible via /exports/files/...
      let extractedProject = null;
      if (kind === "inspectionBundle" && fileName.toLowerCase().endsWith(".json")) {
        try {
          const bundle = JSON.parse(buffer.toString("utf-8"));
          extractedProject = await ingestParsedBundle(user.id, bundle);
          // Persister le projectID extrait dans l'entry export pour que le
          // dashboard puisse rediriger vers /api/projects/<id>/...
          const exportEntry = store.exports.find((e) => e.id === exportID);
          if (exportEntry) {
            exportEntry.extractedProjectID = extractedProject.projectID;
            writeStore(store);
          }
          console.log(
            `[/exports/upload] auto-extracted projectID=${extractedProject.projectID} ` +
            `files=${extractedProject.filesCount}` +
            (extractedProject.warnings?.length ? ` warnings=${extractedProject.warnings.length}` : "")
          );
        } catch (err) {
          console.warn(`[/exports/upload] auto-extraction failed: ${err.message}`);
        }
      }

      res.json({
        ok: true,
        id: exportID,
        fileName,
        sizeBytes: buffer.length,
        downloadPath,
        extractedProject, // null si pas un bundle ou si l'extraction a échoué
      });
    } catch (err) {
      return next(err);
    }
  }
);

// Téléchargement d'un fichier d'export (auth requise, scopé au user owner).
// Utilisé par le dashboard web pour proposer un lien "Télécharger".
// Liste les exports binaires uploadés par l'utilisateur courant (pour le dashboard)
app.get("/exports", requireCurrentUser, (req, res) => {
  const store = req._store;
  const user = req._user;
  ensureDashboardAllowed(user);

  const items = store.exports
    .filter((e) => e.userID === user.id)
    .map((e) => ({
      id: e.id,
      projectID: e.projectID || null,
      reportID: e.reportID || null,
      fileName: e.fileName,
      kind: e.kind || "inspectionBundle",
      sizeBytes: e.sizeBytes || 0,
      contentHash: e.contentHash || null,
      downloadPath: e.downloadPath || null,
      createdAt: e.createdAt || e.createdAtDb,
      // Métadonnées de groupement par bien (peuvent être null pour les
      // anciens uploads pré-feature, le dashboard doit les gérer comme tels)
      inspectionType: e.inspectionType || null,
      propertyID: e.propertyID || null,
      propertyAddress: e.propertyAddress || null,
      tenantName: e.tenantName || null,
      inspectionDate: e.inspectionDate || null,
      // ProjectID extrait du bundle (utilisé par le dashboard pour appeler
      // /api/projects/<id>/report.pdf et autres routes natives)
      extractedProjectID: e.extractedProjectID || null,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Pour chaque export, on enrichit avec le nom du projet pour faciliter le groupement côté dashboard
  const projectsMap = new Map(store.projects.map((p) => [p.id, p]));
  const enriched = items.map((it) => {
    const proj = it.projectID ? projectsMap.get(it.projectID) : null;
    return { ...it, projectName: proj?.projectName || proj?.name || null };
  });

  res.json({ ok: true, items: enriched, total: enriched.length });
});

// ── GET /properties : regroupement des exports par bien immobilier ─────────
// Le dashboard utilise cette route pour afficher la liste des biens scannés
// par l'utilisateur, avec pour chacun le nombre d'EDL d'entrée vs de sortie.
// L'agent peut ensuite cliquer sur un bien pour comparer entrée et sortie.
//
// Note : la source de vérité du `propertyID` reste l'app iOS (qui le génère
// et le persiste localement). Côté serveur on ne fait que regrouper sur ce
// que l'iOS envoie.
app.get("/properties", requireCurrentUser, (req, res) => {
  const store = req._store;
  const user = req._user;
  ensureDashboardAllowed(user);

  const userExports = store.exports.filter((e) => e.userID === user.id && e.propertyID);

  const groups = new Map();
  for (const e of userExports) {
    const id = e.propertyID;
    if (!groups.has(id)) {
      groups.set(id, {
        propertyID: id,
        address: e.propertyAddress || null,
        tenantName: e.tenantName || null,
        firstSeenAt: e.createdAt || e.createdAtDb,
        lastSeenAt: e.createdAt || e.createdAtDb,
        counts: { entry: 0, exit: 0, inventory: 0, other: 0, total: 0 },
        exports: [],
      });
    }
    const g = groups.get(id);
    // Garde les libellés non-null les plus récents
    if (e.propertyAddress) g.address = e.propertyAddress;
    if (e.tenantName) g.tenantName = e.tenantName;
    if (e.createdAt && new Date(e.createdAt) > new Date(g.lastSeenAt || 0)) {
      g.lastSeenAt = e.createdAt;
    }
    if (e.createdAt && new Date(e.createdAt) < new Date(g.firstSeenAt || Date.now())) {
      g.firstSeenAt = e.createdAt;
    }
    const t = e.inspectionType || "other";
    if (g.counts[t] !== undefined) g.counts[t] += 1;
    else g.counts.other += 1;
    g.counts.total += 1;
    g.exports.push({
      id: e.id,
      fileName: e.fileName,
      kind: e.kind || null,
      inspectionType: e.inspectionType || null,
      inspectionDate: e.inspectionDate || null,
      downloadPath: e.downloadPath || null,
      sizeBytes: e.sizeBytes || 0,
      createdAt: e.createdAt || e.createdAtDb,
      extractedProjectID: e.extractedProjectID || null,
    });
  }

  const items = Array.from(groups.values())
    .map((g) => ({
      ...g,
      // Tri des exports du bien : plus récent en haut
      exports: g.exports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    }))
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));

  res.json({ ok: true, items, total: items.length });
});

// Liste les fichiers contenus dans un bundle JSON (sauvegarde complète)
// pour permettre la visualisation directe dans le dashboard (PDF, photos, USDZ).
app.get("/exports/:exportID/contents", requireCurrentUser, (req, res) => {
  const store = req._store;
  const user = req._user;
  const exp = store.exports.find((e) => e.id === req.params.exportID && e.userID === user.id);
  if (!exp) return res.status(404).json({ ok: false, detail: "Export not found" });
  if (!exp.diskPath || !fs.existsSync(exp.diskPath)) {
    return res.status(404).json({ ok: false, detail: "File missing on disk" });
  }
  // On ne sait dépaqueter que les bundles JSON FoxScan ; pour les autres on
  // renvoie le fichier brut comme entrée unique.
  if (exp.kind !== "inspectionBundle" && !exp.fileName.endsWith(".json")) {
    return res.json({
      ok: true, exportID: exp.id, fileName: exp.fileName,
      files: [{ index: 0, path: exp.fileName, kind: detectKindFromName(exp.fileName), sizeBytes: exp.sizeBytes }],
      isBundle: false,
    });
  }
  try {
    const raw = fs.readFileSync(exp.diskPath, "utf-8");
    const bundle = JSON.parse(raw);
    const rawFiles = Array.isArray(bundle.files) ? bundle.files : [];
    const files = rawFiles.map((f, idx) => {
      const path = f.path || f.fileName || f.name || `file-${idx}`;
      const data = typeof f.data === "string" ? f.data : "";
      const head = data.slice(0, 20);
      let kind = "binary";
      if (head.startsWith("JVBERi")) kind = "pdf";
      else if (head.startsWith("/9j/")) kind = "image";
      else if (head.startsWith("iVBORw0KGgo")) kind = "image";
      else if (head.startsWith("UEsDB") || head.startsWith("AAAA")) kind = "usdz";
      else if (head.startsWith("ewog") || data.trim().startsWith("eyJ")) kind = "json";
      const sizeBytes = Math.floor((data.length * 3) / 4);
      return { index: idx, path, kind, sizeBytes };
    });
    res.json({
      ok: true,
      exportID: exp.id,
      fileName: exp.fileName,
      isBundle: true,
      bundleVersion: bundle.version || null,
      exportedAt: bundle.exportedAt || null,
      project: bundle.project || null,
      files,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, detail: "Failed to parse bundle: " + err.message });
  }
});

// Sert un fichier individuel extrait d'un bundle JSON (PDF, photo, USDZ).
// Décode le base64 à la volée et streame avec le bon Content-Type pour
// permettre l'affichage natif dans une iframe / img / model-viewer.
app.get("/exports/:exportID/file/:index", requireCurrentUser, (req, res) => {
  const store = req._store;
  const user = req._user;
  const exp = store.exports.find((e) => e.id === req.params.exportID && e.userID === user.id);
  if (!exp) return res.status(404).json({ ok: false, detail: "Export not found" });
  if (!exp.diskPath || !fs.existsSync(exp.diskPath)) {
    return res.status(404).json({ ok: false, detail: "File missing on disk" });
  }
  try {
    const raw = fs.readFileSync(exp.diskPath, "utf-8");
    const bundle = JSON.parse(raw);
    const idx = parseInt(req.params.index, 10);
    const file = Array.isArray(bundle.files) ? bundle.files[idx] : null;
    if (!file) return res.status(404).json({ ok: false, detail: "File index out of range" });
    const data = typeof file.data === "string" ? file.data : "";
    if (!data) return res.status(404).json({ ok: false, detail: "Empty file data" });
    const head = data.slice(0, 20);
    let contentType = "application/octet-stream";
    if (head.startsWith("JVBERi")) contentType = "application/pdf";
    else if (head.startsWith("/9j/")) contentType = "image/jpeg";
    else if (head.startsWith("iVBORw0KGgo")) contentType = "image/png";
    else if (head.startsWith("UEsDB") || head.startsWith("AAAA")) contentType = "model/vnd.usdz+zip";
    else if (head.startsWith("ewog")) contentType = "application/json";
    const buffer = Buffer.from(data, "base64");
    const safeName = (file.path || `file-${idx}`).replace(/[^A-Za-z0-9._-]/g, "_");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    return res.status(500).json({ ok: false, detail: "Failed to extract file: " + err.message });
  }
});

function detectKindFromName(name) {
  const lower = (name || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png")) return "image";
  if (lower.endsWith(".usdz")) return "usdz";
  if (lower.endsWith(".json")) return "json";
  return "binary";
}

// Génère un PDF côté serveur à partir des données du inspection_report.json
// contenu dans un bundle. Permet de visualiser un vrai PDF d'EDL même quand
// l'app iOS ne l'a pas embarqué dans le bundle.
const PDFDocument = require("pdfkit");
app.get("/exports/:exportID/generated-pdf", requireCurrentUser, (req, res) => {
  const store = req._store;
  const user = req._user;
  const exp = store.exports.find((e) => e.id === req.params.exportID && e.userID === user.id);
  if (!exp) return res.status(404).json({ ok: false, detail: "Export not found" });
  if (!exp.diskPath || !fs.existsSync(exp.diskPath)) {
    return res.status(404).json({ ok: false, detail: "File missing on disk" });
  }
  try {
    const raw = fs.readFileSync(exp.diskPath, "utf-8");
    const bundle = JSON.parse(raw);
    const reportFile = (bundle.files || []).find((f) => (f.path || "").endsWith("inspection_report.json"));
    if (!reportFile) return res.status(404).json({ ok: false, detail: "Inspection report not found in bundle" });
    const reportJSON = JSON.parse(Buffer.from(reportFile.data, "base64").toString("utf-8"));

    // Helpers de formatage
    const fmt = (val, fallback = "—") => (val === null || val === undefined || val === "" ? fallback : String(val));
    const fmtDate = (iso) => {
      if (!iso) return "—";
      try { return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }); }
      catch { return iso; }
    };
    const fmtBool = (b) => (b ? "Oui" : "Non");
    const inspectionTypeLabel = (t) => {
      const map = { entry: "État des lieux d'entrée", exit: "État des lieux de sortie", inventory: "Inventaire", other: "Autre" };
      return map[t] || fmt(t);
    };

    // Construire le PDF
    const doc = new PDFDocument({ size: "A4", margin: 50, info: {
      Title: `EDL ${reportJSON.address || ""} — ${fmtDate(reportJSON.inspectionDate)}`,
      Author: "FOXSCAN",
      Subject: "État des lieux",
    }});

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="EDL_${(reportJSON.address || "logement").replace(/[^A-Za-z0-9]/g, "_")}.pdf"`);
    doc.pipe(res);

    // ── Page de garde ──
    doc.fillColor("#0071E3").fontSize(28).font("Helvetica-Bold").text("ÉTAT DES LIEUX", { align: "center" });
    doc.moveDown(0.3);
    doc.fillColor("#1D1D1F").fontSize(14).font("Helvetica").text(inspectionTypeLabel(reportJSON.inspectionType), { align: "center" });
    doc.moveDown(2);

    // Cadre infos principales
    const startY = doc.y;
    doc.rect(50, startY, 495, 110).fillAndStroke("#F5F5F7", "#E5E5EA");
    doc.fillColor("#1D1D1F").fontSize(11).font("Helvetica");
    let curY = startY + 14;
    const writeRow = (label, value) => {
      doc.font("Helvetica-Bold").text(label, 65, curY, { width: 130, continued: false });
      doc.font("Helvetica").text(fmt(value), 200, curY, { width: 340 });
      curY += 16;
    };
    writeRow("Adresse :", `${reportJSON.address || ""} ${reportJSON.addressComplement || ""}`.trim() || "—");
    writeRow("Code postal · Ville :", `${reportJSON.postalCode || "—"} · ${reportJSON.city || "—"}`);
    writeRow("Type de bien :", `${fmt(reportJSON.propertyType)} · ${reportJSON.surfaceArea ? reportJSON.surfaceArea + " m²" : "surface non renseignée"}`);
    writeRow("Date EDL :", fmtDate(reportJSON.inspectionDate));
    writeRow("Agent :", `${fmt(reportJSON.agentName)} · ${fmt(reportJSON.agentContact)}`);
    writeRow("Référence :", fmt(reportJSON.dossierReference || reportJSON.mandateReference));
    doc.y = startY + 120;

    // ── Section Locataire / Bailleur ──
    doc.moveDown(1);
    doc.fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Parties");
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text("Locataire :", { continued: false });
    doc.font("Helvetica").text(`Nom : ${fmt(reportJSON.tenantName)}`);
    doc.text(`Email : ${fmt(reportJSON.tenantEmail)}`);
    doc.text(`Téléphone : ${fmt(reportJSON.tenantPhone)}`);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text("Bailleur :", { continued: false });
    doc.font("Helvetica").text(`Nom : ${fmt(reportJSON.landlordName)}`);
    doc.text(`Contact : ${fmt(reportJSON.landlordContact)}`);

    // ── Caractéristiques générales ──
    doc.moveDown(1);
    doc.fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Caractéristiques");
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
    doc.moveDown(0.4);
    doc.text(`Nombre de pièces : ${fmt(reportJSON.roomCount)}   ·   Meublé : ${fmt(reportJSON.furnished)}   ·   Cuisine équipée : ${fmt(reportJSON.kitchenEquipped)}`);
    doc.text(`Chauffage : ${fmt(reportJSON.heatingType)}   ·   Eau chaude : ${fmt(reportJSON.hotWaterType)}`);
    doc.text(`Cave : ${fmtBool(reportJSON.hasCellar)} (${fmt(reportJSON.cellarCount, 0)})   ·   Garage : ${fmtBool(reportJSON.hasGarage)} (${fmt(reportJSON.garageCount, 0)})   ·   Balcon : ${fmtBool(reportJSON.hasBalcony)}   ·   BAL : ${fmtBool(reportJSON.hasMailbox)}`);

    // ── Compteurs ──
    if (Array.isArray(reportJSON.meters) && reportJSON.meters.length > 0) {
      doc.moveDown(1);
      doc.fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Relevés des compteurs");
      doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
      doc.moveDown(0.4);
      reportJSON.meters.forEach((m) => {
        doc.text(`• ${fmt(m.type || m.label || "Compteur")} — N° ${fmt(m.serial || m.number)} — Index : ${fmt(m.indexValue)} ${fmt(m.unit || "")}`);
      });
    }

    // V5 — Détecteur de fumée + Chaudière (obligations légales)
    doc.moveDown(1).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold")
      .text("Détecteurs de fumée");
    doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique")
      .text("Obligation R129-12 CCH (loi 2010-238).").moveDown(0.2);
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
    const smokePresent = reportJSON.smokeDetectorPresent === true;
    doc.font("Helvetica-Bold").text(`Présent : ${smokePresent ? "OUI" : "NON"}`);
    doc.font("Helvetica");
    if (smokePresent) {
      if (reportJSON.smokeDetectorLocations) doc.text(`Pièces équipées : ${fmt(reportJSON.smokeDetectorLocations)}`);
      if (reportJSON.smokeDetectorNotes) doc.text(`Observations : ${fmt(reportJSON.smokeDetectorNotes)}`);
    }

    doc.moveDown(1).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold")
      .text("Entretien chaudière");
    doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique")
      .text("Obligation R224-41-4 Code env. (entretien annuel).").moveDown(0.2);
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
    const hasBoiler = reportJSON.hasBoiler === true;
    if (!hasBoiler) {
      doc.font("Helvetica-Oblique").fillColor("#86868B")
        .text("Aucune chaudière individuelle dans le logement.")
        .fillColor("#1D1D1F").font("Helvetica");
    } else {
      doc.font("Helvetica-Bold").text(`Marque / modèle : ${fmt(reportJSON.boilerBrand)}`);
      doc.font("Helvetica")
        .text(`Dernier entretien : ${reportJSON.boilerLastMaintenanceDate ? fmtDate(reportJSON.boilerLastMaintenanceDate) : "—"}`);
      const mp = reportJSON.boilerMaintenancePerformed;
      const mpLabel = mp === "Oui" || mp === true ? "OUI" : mp === "Non" || mp === false ? "NON" : "—";
      doc.font("Helvetica-Bold").fillColor(
        mpLabel === "OUI" ? "#1A7A35" : mpLabel === "NON" ? "#FF3B30" : "#86868B"
      ).text(`Entretien annuel effectué : ${mpLabel}`);
      doc.fillColor("#1D1D1F").font("Helvetica");
      if (reportJSON.boilerNotes) doc.text(`Observations : ${fmt(reportJSON.boilerNotes)}`);
    }

    // ── Pièces ──
    if (Array.isArray(reportJSON.roomConditions) && reportJSON.roomConditions.length > 0) {
      doc.addPage();
      doc.fillColor("#0071E3").fontSize(18).font("Helvetica-Bold").text("État pièce par pièce");
      doc.moveDown(0.5);
      reportJSON.roomConditions.forEach((room, idx) => {
        doc.moveDown(0.6);
        doc.fillColor("#1D1D1F").fontSize(13).font("Helvetica-Bold").text(`${idx + 1}. ${fmt(room.name || room.label || "Pièce")}`);
        if (Array.isArray(room.items)) {
          doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
          room.items.forEach((it) => {
            const label = fmt(it.element || it.label || it.name);
            const state = fmt(it.condition || it.state || it.value);
            const note = it.note || it.comment;
            doc.text(`  • ${label} : ${state}${note ? " — " + note : ""}`);
          });
        }
        if (doc.y > 720) doc.addPage();
      });
    }

    // ── Comparaison entrée/sortie ──
    if (reportJSON.comparisonItems && Array.isArray(reportJSON.comparisonItems) && reportJSON.comparisonItems.length > 0) {
      doc.addPage();
      doc.fillColor("#0071E3").fontSize(18).font("Helvetica-Bold").text("Comparaison entrée / sortie");
      doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
      doc.moveDown(0.5);
      doc.text(fmt(reportJSON.comparisonSummary, "Aucun écart matériel significatif détecté."));
      if (reportJSON.comparisonEstimatedRetention) {
        doc.moveDown(0.4);
        doc.font("Helvetica-Bold").text(`Retenue estimée : ${reportJSON.comparisonEstimatedRetention} €`);
        doc.font("Helvetica");
      }
      doc.moveDown(0.5);
      reportJSON.comparisonItems.forEach((c) => {
        doc.text(`• ${fmt(c.label || c.element)} : ${fmt(c.delta || c.note)}`);
      });
    }

    // ── Clés ──
    if (Array.isArray(reportJSON.keyInventory) && reportJSON.keyInventory.length > 0) {
      doc.addPage();
      doc.fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Inventaire des clés");
      doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
      doc.moveDown(0.5);
      reportJSON.keyInventory.forEach((k) => {
        doc.text(`• ${fmt(k.destination)} — État : ${fmt(k.functionality)}${k.quantity ? ` (×${k.quantity})` : ""}`);
      });
    }

    // V5 — Réserves locataire (avant signatures, art. 3-2 loi 1989)
    doc.moveDown(1.5).fillColor("#17A29A").fontSize(14).font("Helvetica-Bold")
      .text("Réserves et observations du locataire");
    doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique")
      .text("Bloc dédié — art. 3-2 loi du 6 juillet 1989.").moveDown(0.3);
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
    const tenantReservesText = (reportJSON.tenantReserves || "").trim();
    if (tenantReservesText) {
      doc.text(tenantReservesText, { align: "justify" });
    } else {
      doc.fillColor("#86868B").font("Helvetica-Oblique")
        .text("Aucune réserve formulée par le locataire à l'issue de la visite.")
        .fillColor("#1D1D1F").font("Helvetica");
    }

    // ── Signatures ──
    doc.moveDown(2);
    doc.fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Signatures");
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
    doc.moveDown(0.5);
    doc.text(`Locataire signé : ${fmtBool(reportJSON.signedByTenant)}`);
    doc.text(`Bailleur signé : ${fmtBool(reportJSON.signedByOwner)}`);
    doc.text(`Lieu de clôture : ${fmt(reportJSON.closingLocation)}`);

    // ── Mention légale ──
    if (reportJSON.legalStatement) {
      doc.moveDown(1);
      doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique").text(reportJSON.legalStatement, { align: "justify" });
    }

    // Pied de page
    const pageRange = doc.bufferedPageRange();
    for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
      doc.switchToPage(i);
      doc.fillColor("#86868B").fontSize(8).font("Helvetica");
      doc.text(`Document généré par FOXSCAN — foxscan.fr — ${new Date().toLocaleDateString("fr-FR")} — Page ${i + 1}/${pageRange.count}`,
        50, 800, { align: "center", width: 495 });
    }

    doc.end();
  } catch (err) {
    console.error("[/exports/.../generated-pdf]", err);
    return res.status(500).json({ ok: false, detail: "PDF generation failed: " + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INGESTION DE BUNDLE FOXSCAN (extraction sur disque + routes /api/projects)
// ─────────────────────────────────────────────────────────────────────────────
// L'app iOS upload un seul fichier JSON `*_foxscan_backup.json` qui contient :
// - bundle.project (metadata projet)
// - bundle.inspectionReport (metadata rapport)
// - bundle.files[] : array de { path, data: base64 } avec PDF, PNG plan,
//   USDZ scan, photos, sub-rapports, etc.
//
// On EXTRAIT ces fichiers sur disque dans data/projects/<projectID>/ pour
// pouvoir les servir directement (Content-Type natif) au lieu de décoder le
// base64 à chaque requête.
// ─────────────────────────────────────────────────────────────────────────────

const PROJECTS_ROOT = process.env.FOXSCAN_PROJECTS_DIR
  || path.join(__dirname, "data", "projects");

// Magic numbers pour valider les types de fichiers décodés
const MAGIC_NUMBERS = {
  pdf: Buffer.from("%PDF-"),
  png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  jpg: Buffer.from([0xFF, 0xD8, 0xFF]),
  zip: Buffer.from("PK"), // USDZ + ZIP
};
function bufferStartsWith(buf, magic) {
  if (!buf || buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}

function detectMimeType(filename, buffer) {
  const ext = (filename.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  const map = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".usdz": "model/vnd.usdz+zip",
    ".json": "application/json",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".svg": "image/svg+xml",
  };
  return map[ext] || "application/octet-stream";
}

// Valide un path RELATIF d'un fichier dans le bundle.
// Refuse path traversal, paths absolus, antislash Windows.
function safeBundlePath(p) {
  if (!p || typeof p !== "string") return null;
  if (p.startsWith("/") || p.startsWith("\\")) return null;
  if (p.includes("..")) return null;
  if (p.includes("\\")) return null; // pas de Windows-style
  // Normalise : pas de double slash, pas de . segments
  const segments = p.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (segments.length === 0) return null;
  return segments.join("/");
}

// Vérifie qu'un projectID est un UUID-like sécurisé (alphanumérique + tirets)
function safeProjectID(id) {
  if (!id || typeof id !== "string") return null;
  if (!/^[A-Za-z0-9_\-]{4,80}$/.test(id)) return null;
  return id;
}

// Ingère un bundle parsé : extrait tous les fichiers sur disque et stocke
// les métadonnées dans data/projects/<projectID>/_meta.json
async function ingestParsedBundle(userID, bundle) {
  if (!bundle || typeof bundle !== "object") {
    throw Object.assign(new Error("Invalid bundle structure"), { status: 400 });
  }
  if (bundle.version !== 1) {
    console.warn(`[ingestBundle] version inconnue: ${bundle.version}, on continue`);
  }

  const projectID = safeProjectID(bundle.project?.id);
  if (!projectID) {
    throw Object.assign(new Error("bundle.project.id missing or invalid"), { status: 400 });
  }
  if (!Array.isArray(bundle.files)) {
    throw Object.assign(new Error("bundle.files must be an array"), { status: 400 });
  }

  const projectDir = path.join(PROJECTS_ROOT, projectID);
  ensureDir(projectDir);

  // Extraction des fichiers
  const extractedFiles = [];
  const warnings = [];
  for (const file of bundle.files) {
    const safePath = safeBundlePath(file.path);
    if (!safePath) {
      warnings.push(`path rejeté (suspect): ${file.path}`);
      console.warn(`[ingestBundle] path rejeté: ${file.path}`);
      continue;
    }
    if (!file.data || typeof file.data !== "string") {
      warnings.push(`data manquante: ${safePath}`);
      continue;
    }
    let buffer;
    try {
      buffer = Buffer.from(file.data, "base64");
    } catch (e) {
      warnings.push(`base64 invalide: ${safePath}`);
      continue;
    }
    // Validation magic-number selon extension (warning seulement)
    const lower = safePath.toLowerCase();
    if (lower.endsWith(".pdf") && !bufferStartsWith(buffer, MAGIC_NUMBERS.pdf)) {
      warnings.push(`PDF magic invalide: ${safePath}`);
    } else if (lower.endsWith(".png") && !bufferStartsWith(buffer, MAGIC_NUMBERS.png)) {
      warnings.push(`PNG magic invalide: ${safePath}`);
    } else if ((lower.endsWith(".jpg") || lower.endsWith(".jpeg")) && !bufferStartsWith(buffer, MAGIC_NUMBERS.jpg)) {
      warnings.push(`JPG magic invalide: ${safePath}`);
    } else if (lower.endsWith(".usdz") && !bufferStartsWith(buffer, MAGIC_NUMBERS.zip)) {
      warnings.push(`USDZ magic invalide: ${safePath}`);
    }

    const targetPath = path.join(projectDir, safePath);
    ensureDir(path.dirname(targetPath));
    fs.writeFileSync(targetPath, buffer);
    extractedFiles.push({
      path: safePath,
      sizeBytes: buffer.length,
      mimeType: detectMimeType(safePath, buffer),
    });
    console.log(`[ingestBundle] extracted ${safePath} (${buffer.length} bytes)`);
  }

  // Sauvegarde des metadata du projet
  const meta = {
    projectID,
    userID,
    project: bundle.project,
    inspectionReport: bundle.inspectionReport || null,
    files: extractedFiles,
    extractedAt: nowIso(),
    bundleVersion: bundle.version || 1,
    bundleExportedAt: bundle.exportedAt || null,
    warnings,
  };
  fs.writeFileSync(path.join(projectDir, "_meta.json"), JSON.stringify(meta, null, 2));

  return { projectID, filesCount: extractedFiles.length, warnings };
}

// ── ROUTE 1 : POST /api/exports/bundle (upload + extraction synchrone) ──────
// Le client envoie le bundle JSON BRUT (pas en multipart) avec
// Content-Type: application/json. La taille est limitée par express.json()
// (25 MB par défaut, à augmenter si bundle > 25 MB → utiliser /exports/upload).
app.post("/api/exports/bundle", requireCurrentUser, async (req, res) => {
  try {
    const result = await ingestParsedBundle(req._user.id, req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/exports/bundle]", err.message);
    return res.status(err.status || 500).json({ ok: false, detail: err.message });
  }
});

// ── ROUTE 2 : GET /api/projects (liste des projets de l'utilisateur) ───────
//
// V5 — MERGE de 2 sources :
//   A) `data/projects/<projectID>/_meta.json` : projets pour lesquels un
//      BUNDLE complet a été uploadé (export depuis l'app iOS avec PDF +
//      photos + USDZ extraits sur disque).
//   B) `store.projects[]` : projets synchronisés via `/inspections/sync`
//      depuis l'app, SANS export bundle (ex. EDL en cours, brouillon
//      sauvegardé, EDL signé pas encore exporté). Ces projets ont leur
//      `payload.report` accessible via `store.reports[]`.
//
// Les onglets Comparatifs / Travaux / Photos du dashboard consomment
// cette route — ils marchent maintenant pour TOUS les projets de l'agent,
// pas uniquement ceux avec bundle extrait.
app.get("/api/projects", requireCurrentUser, (req, res) => {
  const userID = req._user.id;
  // V5 — Filtre `?includeArchived=false` pour masquer les projets archivés
  // (par défaut on les inclut pour rétro-compat avec le dashboard actuel).
  const includeArchived = req.query.includeArchived !== "false";
  ensureDir(PROJECTS_ROOT);
  const items = [];
  const seenIDs = new Set();

  // Source A : bundles extraits sur disque (_meta.json).
  try {
    for (const projectID of fs.readdirSync(PROJECTS_ROOT)) {
      const metaPath = path.join(PROJECTS_ROOT, projectID, "_meta.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (meta.userID !== userID) continue;
        items.push({
          projectID: meta.projectID,
          name: meta.project?.name || projectID,
          extractedAt: meta.extractedAt,
          filesCount: meta.files?.length || 0,
          totalSize: (meta.files || []).reduce((s, f) => s + (f.sizeBytes || 0), 0),
          source: "bundle",
        });
        seenIDs.add(meta.projectID);
      } catch (e) { /* ignore corrupted meta */ }
    }
  } catch (e) { /* dir doesn't exist yet */ }

  // Source B : projets de store.projects[] sans bundle extrait.
  // On compose des « pseudo-fichiers » à partir des exports listés dans
  // `store.exports[]` (PDF, USDZ, photos uploadés via /exports/upload),
  // pour que les onglets Photos / Rapports puissent itérer dessus comme
  // s'il s'agissait d'un projet extrait.
  try {
    const store = req._store;
    for (const proj of store.projects || []) {
      if (proj.userID !== userID) continue;
      if (seenIDs.has(proj.id)) continue; // déjà présent via bundle
      // V5 — Filtre archived si demandé.
      if (!includeArchived && proj.isArchived === true) continue;
      // Récupère les exports liés à ce projet pour synthétiser une
      // liste de fichiers consultables.
      const projectExports = (store.exports || []).filter(
        (e) => e.projectID === proj.id && e.userID === userID
      );
      const files = projectExports
        .map((e) => ({
          path: e.fileName || "(sans nom)",
          sizeBytes: e.sizeBytes || 0,
          mimeType: e.mimeType || null,
          exportID: e.id,
        }))
        .filter((f) => f.path);
      items.push({
        projectID: proj.id,
        name: proj.projectName || proj.id,
        extractedAt: proj.updatedAt || proj.createdAt,
        filesCount: files.length,
        totalSize: files.reduce((s, f) => s + (f.sizeBytes || 0), 0),
        // V5 — Champs d'organisation projet (archive, programmation,
        // image bien) exposés pour le dashboard.
        isArchived: proj.isArchived === true,
        archivedAt: proj.archivedAt || null,
        scheduledAt: proj.scheduledAt || null,
        address: proj.address || null,
        tenantName: proj.tenantName || null,
        source: "store",
      });
    }
  } catch (e) {
    console.warn("Error merging store.projects:", e.message);
  }

  items.sort((a, b) => new Date(b.extractedAt || 0) - new Date(a.extractedAt || 0));
  res.json({ ok: true, items, total: items.length });
});

// Helper : charge le _meta.json avec contrôle d'ownership
function loadProjectMeta(req, res) {
  const projectID = safeProjectID(req.params.projectID);
  if (!projectID) {
    res.status(400).json({ ok: false, detail: "Invalid projectID" });
    return null;
  }
  const metaPath = path.join(PROJECTS_ROOT, projectID, "_meta.json");
  if (!fs.existsSync(metaPath)) {
    res.status(404).json({ ok: false, detail: "Project not found" });
    return null;
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); }
  catch { res.status(500).json({ ok: false, detail: "Corrupted meta" }); return null; }
  if (meta.userID !== req._user.id) {
    res.status(403).json({ ok: false, detail: "Not your project" });
    return null;
  }
  return { projectID, meta, projectDir: path.join(PROJECTS_ROOT, projectID) };
}

// ── ROUTE 3 : GET /api/projects/:projectID (metadata projet) ───────────────
app.get("/api/projects/:projectID", requireCurrentUser, (req, res) => {
  const ctx = loadProjectMeta(req, res);
  if (!ctx) return;
  res.json({
    ok: true,
    projectID: ctx.projectID,
    project: ctx.meta.project,
    extractedAt: ctx.meta.extractedAt,
    bundleExportedAt: ctx.meta.bundleExportedAt,
  });
});

// ── ROUTE 4 : GET /api/projects/:projectID/inspection (metadata rapport) ──
//
// V5 — Cherche le `inspectionReport` dans 2 sources, dans cet ordre :
//   A) `data/projects/<projectID>/_meta.json` (bundle extrait, source de
//      vérité si un export complet a été fait)
//   B) `store.reports[]` filtrés par projectID, on prend le plus récent
//      (cas où le projet a juste été sync via `/inspections/sync` sans
//      bundle export complet)
//
// Côté dashboard, les onglets Comparatifs / Travaux peuvent maintenant
// fonctionner même quand l'agent n'a pas encore fait d'export bundle.
app.get("/api/projects/:projectID/inspection", requireCurrentUser, (req, res) => {
  const projectID = safeProjectID(req.params.projectID);
  if (!projectID) {
    return res.status(400).json({ ok: false, detail: "Invalid projectID" });
  }
  const user = req._user;

  // Source A : bundle extrait
  const metaPath = path.join(PROJECTS_ROOT, projectID, "_meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.userID === user.id) {
        return res.json({
          ok: true,
          inspectionReport: meta.inspectionReport,
          source: "bundle",
        });
      }
    } catch { /* fall through to source B */ }
  }

  // Source B : store.reports filtrés
  try {
    const store = req._store;
    // Vérif ownership : le projet doit appartenir au user.
    const project = (store.projects || []).find(
      (p) => p.id === projectID && p.userID === user.id
    );
    if (!project) {
      return res.status(404).json({ ok: false, detail: "Project not found" });
    }
    // Report le plus récent du projet pour cet utilisateur.
    const reports = (store.reports || [])
      .filter((r) => r.projectID === projectID && r.userID === user.id)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (reports.length === 0) {
      // Pas de report → projet existe mais aucun EDL saisi
      return res.json({ ok: true, inspectionReport: null, source: "store-empty" });
    }
    return res.json({
      ok: true,
      inspectionReport: reports[0].payload || null,
      source: "store",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, detail: e.message });
  }
});

// ── ROUTE 5 : GET /api/projects/:projectID/files (liste des fichiers) ─────
//
// V5 — Fallback sur `store.exports[]` quand le projet n'a pas de bundle
// extrait. Permet à l'onglet Photos du dashboard de montrer les images
// uploadées via `/exports/upload` même sans bundle complet.
app.get("/api/projects/:projectID/files", requireCurrentUser, (req, res) => {
  const projectID = safeProjectID(req.params.projectID);
  if (!projectID) {
    return res.status(400).json({ ok: false, detail: "Invalid projectID" });
  }
  const user = req._user;

  // Source A : bundle extrait
  const metaPath = path.join(PROJECTS_ROOT, projectID, "_meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.userID === user.id) {
        return res.json({ ok: true, files: meta.files || [], source: "bundle" });
      }
    } catch { /* fall through */ }
  }

  // Source B : store.exports[] filtrés par projectID
  try {
    const store = req._store;
    const project = (store.projects || []).find(
      (p) => p.id === projectID && p.userID === user.id
    );
    if (!project) {
      return res.status(404).json({ ok: false, detail: "Project not found" });
    }
    const exports = (store.exports || []).filter(
      (e) => e.projectID === projectID && e.userID === user.id
    );
    // Reconstitue une liste de fichiers depuis les exports — on inclut
    // l'`exportID` pour pouvoir construire l'URL d'accès au binaire.
    const files = exports
      .map((e) => ({
        path: e.fileName || "(sans nom)",
        sizeBytes: e.sizeBytes || 0,
        mimeType: e.mimeType || null,
        exportID: e.id,
        kind: e.kind || null,
      }))
      .filter((f) => f.path && f.path !== "(sans nom)");
    return res.json({ ok: true, files, source: "store" });
  } catch (e) {
    return res.status(500).json({ ok: false, detail: e.message });
  }
});

// ── ROUTE 6 : GET /api/projects/:projectID/files/* (sert un fichier) ──────
//
// V5 — Sert un fichier d'un projet, en cherchant dans 2 endroits :
//   A) Bundle extrait : `data/projects/<projectID>/<relPath>` (cas standard
//      quand l'agent a fait un export bundle complet depuis l'app iOS)
//   B) Exports individuels : `data/exportFiles/<userID>/<exportID>_<name>`
//      (cas d'une photo ou d'un PDF poussé individuellement via
//      `/exports/upload` sans bundle complet — ex. photo DAAF / chaudière
//      uploadée après un `/inspections/sync` sans export bundle).
//
// Le param `relPath` peut être :
//   - un chemin relatif au bundle (ex. "photos/cuisine_01.jpg")
//   - un fileName d'export (ex. "12_rue_Paix · Plan 3D - Cuisine.usdz")
app.get("/api/projects/:projectID/files/*", requireCurrentUser, (req, res) => {
  const projectID = safeProjectID(req.params.projectID);
  if (!projectID) {
    return res.status(400).json({ ok: false, detail: "Invalid projectID" });
  }
  const relPath = safeBundlePath(req.params[0]);
  if (!relPath) {
    return res.status(400).json({ ok: false, detail: "Invalid file path" });
  }
  const user = req._user;

  // ── A) Tentative bundle extrait ──
  const metaPath = path.join(PROJECTS_ROOT, projectID, "_meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.userID === user.id) {
        const projectDir = path.join(PROJECTS_ROOT, projectID);
        const filePath = path.join(projectDir, relPath);
        const resolved = path.resolve(filePath);
        if (resolved.startsWith(path.resolve(projectDir) + path.sep) && fs.existsSync(resolved)) {
          const mime = detectMimeType(relPath);
          res.setHeader("Content-Type", mime);
          res.setHeader("Content-Disposition", `inline; filename="${path.basename(relPath)}"`);
          res.setHeader("Cache-Control", "private, max-age=3600");
          return fs.createReadStream(resolved).pipe(res);
        }
      }
    } catch { /* fall through to source B */ }
  }

  // ── B) Fallback : chercher dans store.exports[] ──
  try {
    const store = req._store;
    // Sécurité : vérifie que le projet appartient au user.
    const project = (store.projects || []).find(
      (p) => p.id === projectID && p.userID === user.id
    );
    if (!project) {
      return res.status(404).json({ ok: false, detail: "Project not found" });
    }
    // Cherche un export dont le nom de fichier ou l'exportID matche.
    const fileName = path.basename(relPath);
    const exp = (store.exports || []).find((e) =>
      e.projectID === projectID
      && e.userID === user.id
      && (e.fileName === fileName || e.fileName === relPath || e.id === fileName)
    );
    if (!exp || !exp.diskPath || !fs.existsSync(exp.diskPath)) {
      return res.status(404).json({ ok: false, detail: "File not found" });
    }
    const mime = detectMimeType(exp.fileName || fileName);
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `inline; filename="${path.basename(exp.fileName || fileName)}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    return fs.createReadStream(exp.diskPath).pipe(res);
  } catch (e) {
    return res.status(500).json({ ok: false, detail: e.message });
  }
});

// ── ROUTE 7 : GET /api/projects/:projectID/report.pdf ─────────────────────
// Sert le PDF d'EDL avec stratégie intelligente :
//   1. Si inspection_report.pdf existe dans le bundle → on le sert tel quel
//      (PDF natif généré par l'app iOS, design FOXSCAN officiel)
//   2. Sinon → on le GÉNÈRE côté serveur avec PDFKit à partir des données
//      du inspectionReport stockées dans _meta.json
// → Le client (dashboard) appelle TOUJOURS cette URL et récupère un PDF.
app.get("/api/projects/:projectID/report.pdf", requireCurrentUser, (req, res) => {
  const ctx = loadProjectMeta(req, res);
  if (!ctx) return;

  // Stratégie 1 : PDF natif présent dans le bundle ?
  const nativePdfPath = path.join(ctx.projectDir, "inspection_report.pdf");
  if (fs.existsSync(nativePdfPath)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="EDL_${ctx.projectID}.pdf"`);
    res.setHeader("X-FOXSCAN-PDF-Source", "native"); // header debug : provient de l'app
    return fs.createReadStream(nativePdfPath).pipe(res);
  }

  // Stratégie 2 : régénérer côté serveur avec PDFKit
  // Si pas de inspectionReport structuré, on génère un PDF MINIMAL avec les
  // métadonnées projet + liste des fichiers extraits — au moins le user voit
  // quelque chose au lieu d'un 404.
  const report = ctx.meta.inspectionReport || {
    address: ctx.meta.project?.name || "Bien immobilier",
    inspectionType: "other",
    inspectionDate: ctx.meta.bundleExportedAt || ctx.meta.extractedAt,
    agentName: "FOXSCAN",
  };

  try {
    generateInspectionPDF(report, ctx.meta.project, res, ctx.meta.files || []);
  } catch (err) {
    console.error("[/api/projects/:id/report.pdf] gen failed:", err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, detail: "PDF generation failed: " + err.message });
    }
  }
});

// Helper de génération PDF réutilisable (déjà extrait pour /exports/:id/generated-pdf)
function generateInspectionPDF(report, project, res, files = []) {
  const fmt = (val, fallback = "—") => (val === null || val === undefined || val === "" ? fallback : String(val));
  const fmtDate = (iso) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }); }
    catch { return iso; }
  };
  const fmtBool = (b) => (b ? "Oui" : "Non");
  const inspectionTypeLabel = (t) => {
    const map = { entry: "État des lieux d'entrée", exit: "État des lieux de sortie", inventory: "Inventaire", other: "Autre" };
    return map[t] || fmt(t);
  };

  const projectName = project?.name || report.address || "Projet";
  const doc = new PDFDocument({ size: "A4", margin: 50, info: {
    Title: `EDL ${projectName} — ${fmtDate(report.inspectionDate)}`,
    Author: "FOXSCAN",
    Subject: "État des lieux",
  }});

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="EDL_${(report.address || projectName).replace(/[^A-Za-z0-9]/g, "_")}.pdf"`);
  res.setHeader("X-FOXSCAN-PDF-Source", "generated"); // header debug : généré côté serveur
  doc.pipe(res);

  // En-tête
  doc.fillColor("#0071E3").fontSize(28).font("Helvetica-Bold").text("ÉTAT DES LIEUX", { align: "center" });
  doc.moveDown(0.3);
  doc.fillColor("#1D1D1F").fontSize(14).font("Helvetica").text(inspectionTypeLabel(report.inspectionType), { align: "center" });
  doc.moveDown(2);

  const startY = doc.y;
  doc.rect(50, startY, 495, 110).fillAndStroke("#F5F5F7", "#E5E5EA");
  doc.fillColor("#1D1D1F").fontSize(11).font("Helvetica");
  let curY = startY + 14;
  const writeRow = (label, value) => {
    doc.font("Helvetica-Bold").text(label, 65, curY, { width: 130 });
    doc.font("Helvetica").text(fmt(value), 200, curY, { width: 340 });
    curY += 16;
  };
  writeRow("Adresse :", `${report.address || ""} ${report.addressComplement || ""}`.trim() || "—");
  writeRow("Code postal · Ville :", `${report.postalCode || "—"} · ${report.city || "—"}`);
  writeRow("Type de bien :", `${fmt(report.propertyType)} · ${report.surfaceArea ? report.surfaceArea + " m²" : "surface non renseignée"}`);
  writeRow("Date EDL :", fmtDate(report.inspectionDate));
  writeRow("Agent :", `${fmt(report.agentName)} · ${fmt(report.agentContact)}`);
  writeRow("Référence :", fmt(report.dossierReference || report.mandateReference));
  doc.y = startY + 120;

  // Parties
  doc.moveDown(1).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Parties");
  doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica").moveDown(0.5);
  doc.font("Helvetica-Bold").text("Locataire :");
  doc.font("Helvetica").text(`Nom : ${fmt(report.tenantName)}`)
     .text(`Email : ${fmt(report.tenantEmail)}`)
     .text(`Téléphone : ${fmt(report.tenantPhone)}`);
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").text("Bailleur :");
  doc.font("Helvetica").text(`Nom : ${fmt(report.landlordName)}`)
     .text(`Contact : ${fmt(report.landlordContact)}`);

  // Caractéristiques
  doc.moveDown(1).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Caractéristiques");
  doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica").moveDown(0.4);
  doc.text(`Nombre de pièces : ${fmt(report.roomCount)}   ·   Meublé : ${fmt(report.furnished)}   ·   Cuisine équipée : ${fmt(report.kitchenEquipped)}`);
  doc.text(`Chauffage : ${fmt(report.heatingType)}   ·   Eau chaude : ${fmt(report.hotWaterType)}`);
  doc.text(`Cave : ${fmtBool(report.hasCellar)} (${fmt(report.cellarCount, 0)})   ·   Garage : ${fmtBool(report.hasGarage)} (${fmt(report.garageCount, 0)})   ·   Balcon : ${fmtBool(report.hasBalcony)}   ·   BAL : ${fmtBool(report.hasMailbox)}`);

  // Compteurs
  if (Array.isArray(report.meters) && report.meters.length > 0) {
    doc.moveDown(1).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Relevés des compteurs");
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica").moveDown(0.4);
    report.meters.forEach((m) => doc.text(`• ${fmt(m.type || m.label || "Compteur")} — N° ${fmt(m.serial || m.number)} — Index : ${fmt(m.indexValue)} ${fmt(m.unit || "")}`));
  }

  // V5 — Détecteur de fumée (obligation R129-12 CCH)
  // Section affichée systématiquement pour acter contradictoirement la
  // présence ou l'absence (ne pas omettre → faille légale).
  doc.moveDown(1).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold")
    .text("Détecteurs de fumée");
  doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique")
    .text("Obligation légale R129-12 CCH (loi 2010-238). À vérifier dans les zones de circulation.")
    .moveDown(0.2);
  doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
  const smokePresent = report.smokeDetectorPresent === true;
  doc.font("Helvetica-Bold")
    .text(`Présent dans le logement : ${smokePresent ? "OUI" : "NON"}`,
          { continued: false });
  doc.font("Helvetica");
  if (smokePresent) {
    if (report.smokeDetectorLocations) {
      doc.text(`Pièces équipées : ${fmt(report.smokeDetectorLocations)}`);
    }
    if (report.smokeDetectorNotes) {
      doc.text(`Observations : ${fmt(report.smokeDetectorNotes)}`);
    }
    const smokePhotos = Array.isArray(report.smokeDetectorPhotoFileNames)
      ? report.smokeDetectorPhotoFileNames.length : 0;
    if (smokePhotos > 0) {
      doc.fillColor("#86868B").fontSize(9).font("Helvetica-Oblique")
        .text(`📷 ${smokePhotos} photo${smokePhotos > 1 ? "s" : ""} jointe${smokePhotos > 1 ? "s" : ""} au dossier.`)
        .fillColor("#1D1D1F").font("Helvetica").fontSize(10);
    }
  } else {
    doc.fillColor("#FF3B30").text("Aucun détecteur de fumée mentionné — vérification à confirmer par le bailleur.")
       .fillColor("#1D1D1F");
  }

  // V5 — Entretien chaudière (obligation R224-41-4 Code de l'environnement)
  doc.moveDown(1).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold")
    .text("Entretien chaudière");
  doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique")
    .text("Obligation d'entretien annuel — art. R224-41-4 Code de l'environnement (décret 2009-649).")
    .moveDown(0.2);
  doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
  const hasBoiler = report.hasBoiler === true;
  if (!hasBoiler) {
    doc.font("Helvetica-Oblique").fillColor("#86868B")
      .text("Aucune chaudière individuelle dans le logement (chauffage collectif, électrique ou autre).")
      .fillColor("#1D1D1F").font("Helvetica");
  } else {
    doc.font("Helvetica-Bold").text(`Marque / modèle : ${fmt(report.boilerBrand)}`,
                                    { continued: false });
    doc.font("Helvetica")
      .text(`Dernier entretien : ${report.boilerLastMaintenanceDate ? fmtDate(report.boilerLastMaintenanceDate) : "—"}`);
    const maintenance = report.boilerMaintenancePerformed;
    const maintenanceLabel = maintenance === "Oui" || maintenance === true ? "OUI"
      : maintenance === "Non" || maintenance === false ? "NON" : "—";
    doc.font("Helvetica-Bold").fillColor(
      maintenanceLabel === "OUI" ? "#1A7A35" : maintenanceLabel === "NON" ? "#FF3B30" : "#86868B"
    ).text(`Entretien annuel effectué : ${maintenanceLabel}`);
    doc.fillColor("#1D1D1F").font("Helvetica");
    if (report.boilerNotes) {
      doc.text(`Observations : ${fmt(report.boilerNotes)}`);
    }
    const boilerPhotos = Array.isArray(report.boilerPhotoFileNames)
      ? report.boilerPhotoFileNames.length : 0;
    if (boilerPhotos > 0) {
      doc.fillColor("#86868B").fontSize(9).font("Helvetica-Oblique")
        .text(`📷 ${boilerPhotos} photo${boilerPhotos > 1 ? "s" : ""} jointe${boilerPhotos > 1 ? "s" : ""} au dossier.`)
        .fillColor("#1D1D1F").font("Helvetica").fontSize(10);
    }
  }

  // Pièces
  if (Array.isArray(report.roomConditions) && report.roomConditions.length > 0) {
    doc.addPage();
    doc.fillColor("#0071E3").fontSize(18).font("Helvetica-Bold").text("État pièce par pièce").moveDown(0.5);
    report.roomConditions.forEach((room, idx) => {
      doc.moveDown(0.6);
      doc.fillColor("#1D1D1F").fontSize(13).font("Helvetica-Bold").text(`${idx + 1}. ${fmt(room.name || room.label || "Pièce")}`);
      if (Array.isArray(room.items)) {
        doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
        room.items.forEach((it) => {
          const label = fmt(it.element || it.label || it.name);
          const state = fmt(it.condition || it.state || it.value);
          const note = it.note || it.comment;
          doc.text(`  • ${label} : ${state}${note ? " — " + note : ""}`);
        });
      }
      if (doc.y > 720) doc.addPage();
    });
  }

  // Comparaison
  if (Array.isArray(report.comparisonItems) && report.comparisonItems.length > 0) {
    doc.addPage();
    doc.fillColor("#0071E3").fontSize(18).font("Helvetica-Bold").text("Comparaison entrée / sortie");
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica").moveDown(0.5);
    doc.text(fmt(report.comparisonSummary, "Aucun écart matériel significatif détecté."));
    if (report.comparisonEstimatedRetention) {
      doc.moveDown(0.4).font("Helvetica-Bold").text(`Retenue estimée : ${report.comparisonEstimatedRetention} €`).font("Helvetica");
    }
    doc.moveDown(0.5);
    report.comparisonItems.forEach((c) => doc.text(`• ${fmt(c.label || c.element)} : ${fmt(c.delta || c.note)}`));
  }

  // Clés
  if (Array.isArray(report.keyInventory) && report.keyInventory.length > 0) {
    doc.addPage();
    doc.fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Inventaire des clés");
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica").moveDown(0.5);
    report.keyInventory.forEach((k) => doc.text(`• ${fmt(k.destination)} — État : ${fmt(k.functionality)}${k.quantity ? ` (×${k.quantity})` : ""}`));
  }

  // Inventaire des fichiers extraits du bundle (utile quand le rapport est minimal)
  if (Array.isArray(files) && files.length > 0) {
    doc.moveDown(1).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Fichiers du dossier");
    doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica").moveDown(0.5);
    const photos = files.filter((f) => /\.(jpg|jpeg|png|webp|heic)$/i.test(f.path));
    const usdz = files.filter((f) => /\.usdz$/i.test(f.path));
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.path));
    const reports = files.filter((f) => /\.json$/i.test(f.path));
    if (photos.length) doc.text(`📷 Photos : ${photos.length} fichier${photos.length > 1 ? "s" : ""}`);
    if (usdz.length) doc.text(`🧊 Modèles 3D LiDAR : ${usdz.length}`);
    if (pdfs.length) doc.text(`📄 PDF additionnels : ${pdfs.length}`);
    if (reports.length) doc.text(`📝 Rapports JSON : ${reports.length}`);
    const totalBytes = files.reduce((s, f) => s + (f.sizeBytes || 0), 0);
    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
    doc.text(`💾 Total : ${files.length} fichier${files.length > 1 ? "s" : ""} (${mb} Mo)`);
  }

  // V5 — Réserves du locataire (bloc dédié, art. 3-2 loi 1989)
  // Placé AVANT les signatures pour bien marquer qu'il s'agit du dernier
  // mot du locataire avant qu'il appose sa signature.
  const tenantReserves = (report.tenantReserves || "").trim();
  doc.moveDown(1.5).fillColor("#17A29A").fontSize(14).font("Helvetica-Bold")
    .text("Réserves et observations du locataire");
  doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique")
    .text("Bloc dédié — art. 3-2 loi du 6 juillet 1989. Valeur contractuelle propre.")
    .moveDown(0.3);
  doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
  if (tenantReserves) {
    doc.text(tenantReserves, { align: "justify" });
  } else {
    doc.fillColor("#86868B").font("Helvetica-Oblique")
      .text("Aucune réserve formulée par le locataire à l'issue de la visite.")
      .fillColor("#1D1D1F").font("Helvetica");
  }

  // Signatures + mention légale
  doc.moveDown(2).fillColor("#0071E3").fontSize(14).font("Helvetica-Bold").text("Signatures");
  doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica").moveDown(0.5);
  doc.text(`Locataire signé : ${fmtBool(report.signedByTenant)}`)
     .text(`Bailleur signé : ${fmtBool(report.signedByOwner)}`)
     .text(`Lieu de clôture : ${fmt(report.closingLocation)}`);
  if (report.legalStatement) {
    doc.moveDown(1).fillColor("#86868B").fontSize(8).font("Helvetica-Oblique").text(report.legalStatement, { align: "justify" });
  }

  // Pied de page sur toutes les pages
  const pageRange = doc.bufferedPageRange();
  for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
    doc.switchToPage(i);
    doc.fillColor("#86868B").fontSize(8).font("Helvetica");
    doc.text(`Document généré par FOXSCAN — foxscan.fr — ${new Date().toLocaleDateString("fr-FR")} — Page ${i + 1}/${pageRange.count}`,
      50, 800, { align: "center", width: 495 });
  }
  doc.end();
}

// Suppression d'un export par son owner
app.delete("/exports/:exportID", requireCurrentUser, (req, res) => {
  const store = req._store;
  const user = req._user;
  ensureDashboardAllowed(user);

  const idx = store.exports.findIndex(
    (e) => e.id === req.params.exportID && e.userID === user.id
  );
  if (idx < 0) {
    return res.status(404).json({ ok: false, detail: "Export not found" });
  }

  const exp = store.exports[idx];
  if (exp.diskPath && fs.existsSync(exp.diskPath)) {
    try { fs.unlinkSync(exp.diskPath); } catch (e) { console.error("[/exports DELETE]", e.message); }
  }
  store.exports.splice(idx, 1);
  writeStore(store);
  res.json({ ok: true, id: req.params.exportID });
});

app.get("/exports/files/:userID/:fileName", requireCurrentUser, (req, res) => {
  if (req.params.userID !== req._user.id) {
    return res.status(403).json({ ok: false, detail: "Not your file" });
  }
  // Empêche les traversées de chemin (../../etc/passwd)
  const safeName = String(req.params.fileName).replace(/\/|\\|\.\.+/g, "_");
  const filePath = path.join(settings.exportFilesDir, req.params.userID, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, detail: "File not found" });
  }
  return res.sendFile(filePath);
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
