const cors = require("cors");
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { jwtVerify, createRemoteJWKSet } = require("jose");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
// V5.3 — Proxy /ai/scans* vers le PC ML (avec fallback mock pour dev)
const { mountScansRoutes } = require("./lib/scansProxy");
const { optimizePdfBuffer } = require("./lib/pdfOptimize");

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

// Tarification : un prix unique, utilisateurs illimités (septembre 2026).
//
// L'ancienne grille facturait de 49 € (1 utilisateur) à 349 € (15). Elle a été
// remplacée par un abonnement plat : le nombre de collaborateurs ne change plus
// rien au prix. La variable, désormais, c'est la consommation d'analyse, qui
// est refacturée à son coût réel (cf. `costMicrosFor` et /ai/usage/summary).
//
// Doit rester en parfait sync avec la page foxscan.fr (#pricing) et l'article 5
// des CGV. Un écart entre affiché et facturé se paie cash.
const SUBSCRIPTION_PRICE_EUR_CENTS = 2900;   // 29 € / mois, utilisateurs illimités

// Annuel : 10 % de remise sur le cumul de 12 mensualités → 313 €.
const YEARLY_DISCOUNT = 0.9;
function yearlyPriceCents() {
  // Arrondi à l'euro pour éviter les centimes disgracieux sur la facture.
  return Math.round((SUBSCRIPTION_PRICE_EUR_CENTS * 12 * YEARLY_DISCOUNT) / 100) * 100;
}
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
// Adresse de réponse. IMPORTANT : le champ "From" doit rester sur le domaine
// authentifié (SPF/DKIM) sous peine de finir en spam ; c'est le "Reply-To" qui
// redirige les réponses vers la boîte réellement relevée.
const smtpReplyTo = process.env.SMTP_REPLY_TO || smtpFrom || "";

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
      replyTo: replyTo || smtpReplyTo,
    });
    console.log(`[mailer] sent: to=${to} id=${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mailer] error sending to ${to}:`, err.message);
    return { sent: false, error: err.message };
  }
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h1|h2|h3|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    // Conserve l'URL des liens : « libellé (https://… ) »
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const txt = String(label).replace(/<[^>]+>/g, "").trim();
      return href.startsWith("mailto:") ? txt : `${txt} ( ${href} )`;
    })
    // Le bloc <table> d'en-tête (logo + titre) génère des lignes vides en
    // version texte : on le retire pour un rendu propre.
    .replace(/<td[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    // ORDRE IMPORTANT : on vide d'abord les lignes ne contenant que des
    // espaces, PUIS on réduit les sauts multiples — l'inverse laissait des
    // trous dans le rendu texte.
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function emailLayout(title, bodyHtml, preheader) {
  // Charte FOXSCAN : vert sapin + orange (les emails utilisaient un bleu Apple
  // sans rapport avec la marque). Le « preheader » est le texte d'aperçu
  // affiché par les messageries à côté de l'objet : sans lui, elles affichent
  // le début du HTML, ce qui fait très peu professionnel.
  const pre = preheader || "";
  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#F4F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#21283A;-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(pre)}</div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#F4F5F7;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(33,40,58,.10)">
        <tr><td style="background:#1B3A2F;padding:26px 32px">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td valign="middle" style="padding-right:12px">
                <div style="width:34px;height:34px;background:#FF7A1A;border-radius:9px;text-align:center;line-height:34px;font-weight:800;color:#fff;font-size:17px">F</div>
              </td>
              <td valign="middle">
                <div style="color:#fff;font-size:19px;font-weight:800;letter-spacing:-.3px">FOXSCAN</div>
                <div style="color:rgba(255,255,255,.62);font-size:12px;margin-top:1px">État des lieux numérique</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:34px 36px;font-size:15px;line-height:1.65">${bodyHtml}</td></tr>
        <tr><td style="background:#FAFAFB;padding:22px 32px;border-top:1px solid #ECEDF1;font-size:12px;color:#6B7280;line-height:1.7">
          <strong style="color:#21283A">FOXSCAN</strong> — L'état des lieux qui se remplit tout seul<br/>
          <a href="https://foxscan.fr" style="color:#FF7A1A;text-decoration:none">foxscan.fr</a>
          &nbsp;·&nbsp;
          <a href="mailto:contact@foxscan.fr" style="color:#FF7A1A;text-decoration:none">contact@foxscan.fr</a><br/>
          <span style="color:#9AA0AC">Vous recevez cet email suite à votre inscription ou à un paiement sur foxscan.fr.</span>
        </td></tr>
      </table>
      <div style="max-width:600px;margin:14px auto 0;font-size:11px;color:#9AA0AC;text-align:center">
        FOXSCAN · Lyon, France
      </div>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Email de bienvenue, envoyé une seule fois par compte.
 *
 * Volontairement court : il dit ce que la personne peut faire maintenant et
 * combien de temps il lui reste. Aucune mention de la mécanique interne.
 */
function emailWelcomeSignup({ name }) {
  const hello = name ? `Bonjour ${escapeHtml(name)},` : "Bonjour,";
  return emailLayout(
    "Bienvenue sur FOXSCAN",
    `<p>${hello}</p>
     <p>Votre compte est créé. Vous disposez de
     <strong>7 jours</strong> et de <strong>${TRIAL_MAX_EDL} états des lieux</strong>
     pour essayer FOXSCAN — sans carte bancaire, sans engagement.</p>
     <p>Pour commencer : ouvrez l'application sur votre iPhone, créez un dossier,
     puis scannez la première pièce. Comptez une quinzaine de minutes pour un
     état des lieux complet, signé et exporté en PDF.</p>
     <p style="margin:26px 0">
       <a href="https://foxscan.fr/login.html"
          style="display:inline-block;background:#1C5FD9;color:#fff;text-decoration:none;
                 padding:13px 26px;border-radius:10px;font-weight:600">Ouvrir mon espace</a>
     </p>
     <p style="font-size:13px;color:#6B7280">
       Vos états des lieux restent consultables et exportables même après la fin
       de l'essai. Une question ? Répondez simplement à ce message.
     </p>`,
    `Votre compte FOXSCAN est prêt — 7 jours et ${TRIAL_MAX_EDL} états des lieux pour l'essayer.`,
  );
}

/**
 * Envoi best-effort, à la création du compte.
 *
 * Idempotent par `welcomeEmailSentAt` : même si le chemin d'inscription est
 * rejoué, la personne ne reçoit qu'un seul message. Et jamais bloquant —
 * une panne SMTP ne doit pas faire échouer une inscription.
 */
function sendWelcomeEmailOnce(user) {
  if (!user || !user.email || user.welcomeEmailSentAt) return;
  user.welcomeEmailSentAt = nowIso();
  Promise.resolve()
    .then(() => sendMail({
      to: user.email,
      subject: "Bienvenue sur FOXSCAN",
      html: emailWelcomeSignup({ name: user.name }),
    }))
    .catch((e) => console.error("[welcome] envoi échoué:", e.message));
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
    <div style="background:#FFF4EC;border-left:3px solid #FF7A1A;padding:14px 18px;border-radius:8px;margin:18px 0;font-size:13px;color:#003F8C">
      💬 Une question, un blocage ? Répondez directement à cet email — nous lisons tout, et vite.
    </div>
  `;
  return emailLayout("Bienvenue chez FOXSCAN", body);
}

function emailWelcomeSubscription({ name, email, password, users, isExistingUser }) {
  const greeting = name ? `Bonjour ${escapeHtml(name)},` : "Bonjour,";
  const credentialsBlock = isExistingUser
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">Votre compte existait déjà — votre <strong>abonnement</strong> est désormais activé. Connectez-vous avec vos identifiants habituels.</p>`
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
      Bienvenue chez FOXSCAN ! Votre abonnement est actif, avec <strong>autant d'utilisateurs que nécessaire</strong>. Vous pouvez utiliser tout de suite l'app et le dashboard web.
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
      <li>Utilisateurs illimités — ajoutez vos collaborateurs sans surcoût</li>
      <li>EDL illimités, scan 3D LiDAR, comparateur entrée/sortie</li>
      <li>Facturation mensuelle, sans engagement de durée</li>
      <li>Analyses refacturées à leur coût réel, sans marge — le détail figure sur chaque facture</li>
      <li>Résiliable à tout moment depuis votre dashboard ou en répondant à cet email</li>
    </ul>
    <div style="background:#FFF4EC;border-left:3px solid #FF7A1A;padding:14px 18px;border-radius:8px;margin:18px 0;font-size:13px;color:#003F8C">
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
      <tr><td style="padding:6px 0;color:#86868B">Email</td><td style="padding:6px 0;font-weight:600"><a href="mailto:${escapeHtml(founder.email)}" style="color:#FF7A1A">${escapeHtml(founder.email)}</a></td></tr>
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
    <p style="margin:0 0 18px;font-size:14px;color:#6E6E73">${isFounders ? "Founder converti — licence à vie" : "Nouvel abonnement — utilisateurs illimités"}.</p>
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#86868B;width:120px">Type</td><td style="padding:6px 0;font-weight:600">${isFounders ? "🔥 Founder licence à vie" : "📅 Abonnement mensuel"}</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Montant</td><td style="padding:6px 0;font-weight:600">${escapeHtml(amountEur)} €</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Client</td><td style="padding:6px 0">${escapeHtml(customerName || "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#86868B">Email</td><td style="padding:6px 0"><a href="mailto:${escapeHtml(email)}" style="color:#FF7A1A">${escapeHtml(email)}</a></td></tr>
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

// Relances d'essai — déclencheur opportuniste placé AVANT les routes pour
// couvrir tout le trafic (Express exécute les middlewares dans l'ordre de
// déclaration : plus bas, il n'aurait servi qu'aux dernières routes).
// Non bloquant : la requête n'attend jamais l'envoi des emails.
app.use((req, res, next) => {
  sweepTrialReminders().catch(() => {});
  next();
});

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
  accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS || 3600),
  refreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS || 60 * 60 * 24 * 90),
  requireActiveSubscription:
    String(process.env.DASHBOARD_REQUIRE_ACTIVE_SUBSCRIPTION || "true").toLowerCase() === "true",
  defaultSubscriptionStatus: process.env.DEFAULT_SUBSCRIPTION_STATUS || "active",
  // Stockage des fichiers d'export uploadés par l'app iOS (sauvegardes JSON, USDZ,
  // PDFs, archives photos…). Configurable via FOXSCAN_EXPORT_FILES_DIR si Hostinger
  // exige un chemin spécifique (ex: hors du dossier de l'app pour la persistance).
  exportFilesDir:
    process.env.FOXSCAN_EXPORT_FILES_DIR || path.join(__dirname, "data", "exports"),
  uploadLimit: process.env.FOXSCAN_UPLOAD_LIMIT || "2gb",
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

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENCE LAYER V6.2 — Production-hardened JSON store
// ═══════════════════════════════════════════════════════════════════════════
// Trois garanties ajoutées par rapport à la v1 :
//
//  1) WRITE ATOMIQUE — `fs.writeFileSync` peut tronquer le fichier si le
//     process est tué pendant l'écriture (POSIX ne garantit RIEN sur l'atomicité
//     d'un write multi-blocs). On écrit donc dans `store.json.tmp` puis on fait
//     `fs.renameSync()` qui EST atomique sur le même filesystem (ext4/xfs/btrfs).
//     Résultat : impossible d'avoir un store.json corrompu/tronqué.
//
//  2) MUTEX EN MÉMOIRE — Express handle plusieurs requêtes concurrentes.
//     Si deux d'entre elles font readStore() → modify → writeStore() en
//     parallèle, la seconde écrase la première (lost update). Le mutex
//     `_writeQueue` sérialise les writes. Les reads restent parallèles
//     (lecture rapide, pas de race possible si le write est atomique).
//
//  3) BACKUP HORAIRE + ROTATION 7 JOURS — startBackupCron() copie le fichier
//     toutes les heures dans data/backups/store-YYYYMMDD-HHMM.json et purge
//     les backups de plus de 7 jours. Restauration manuelle = `cp backup store.json`.
//
// Ce code est synchrone à dessein (writeFileSync, renameSync) : Node monothread,
// donc serialiser sur l'event loop ne pose pas de problème de concurrence interne
// et garantit la cohérence de chaque op de write.
// ═══════════════════════════════════════════════════════════════════════════

const EMPTY_STORE = {
  users: [],
  refreshTokens: [],
  projects: [],
  reports: [],
  exports: [],
  auditEvents: [],
  founders: [],
  teams: [],
  drafts: [],
  passwordResetTokens: [],
};

function readStore() {
  ensureDir(path.dirname(settings.dbPath));
  if (!fs.existsSync(settings.dbPath)) {
    const empty = { ...EMPTY_STORE };
    // Use writeStoreAtomicSync directement (mutex pas encore init au 1er boot)
    writeStoreAtomicSync(empty);
    return empty;
  }

  let raw;
  try {
    raw = fs.readFileSync(settings.dbPath, "utf-8");
  } catch (e) {
    console.error("[store] Read failed, attempting recovery from latest backup:", e.message);
    return recoverFromBackupOrEmpty();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("[store] CORRUPTION DÉTECTÉE — store.json invalide JSON :", e.message);
    return recoverFromBackupOrEmpty();
  }

  // Garantit la présence des collections connues, TOUT en préservant les autres
  // clés (grilles, pdfCustomizations, vetuste, folders, providers…). Avant, ce
  // return listait seulement 10 clés et SUPPRIMAIT le reste à chaque lecture →
  // ces collections ne survivaient pas d'une requête à l'autre (et étaient
  // effacées par tout writeStore/mutateStore ultérieur). Le spread corrige ça.
  return {
    ...parsed,
    users: parsed.users || [],
    refreshTokens: parsed.refreshTokens || [],
    projects: parsed.projects || [],
    reports: parsed.reports || [],
    exports: parsed.exports || [],
    auditEvents: parsed.auditEvents || [],
    founders: parsed.founders || [],
    teams: parsed.teams || [],
    drafts: parsed.drafts || [],
    passwordResetTokens: parsed.passwordResetTokens || [],
  };
}

// Mutex async — sérialise les writes pour éviter les lost updates.
// Toutes les modifs passent par writeStore() qui enqueue ici.
let _writeQueue = Promise.resolve();
let _writeQueueLen = 0;
const WRITE_QUEUE_WARN_THRESHOLD = 20;

function writeStoreAtomicSync(store) {
  ensureDir(path.dirname(settings.dbPath));
  const tmpPath = settings.dbPath + ".tmp";
  const data = JSON.stringify(store, null, 2);
  // Write to tmp file, sync to disk, then atomic rename.
  fs.writeFileSync(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
  // Force fsync : garantit que les blocs sont écrits sur le disque avant le rename.
  // Sans ça, le rename est atomique mais le contenu peut être perdu sur power-off.
  try {
    const fd = fs.openSync(tmpPath, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (_) { /* fsync best-effort */ }
  fs.renameSync(tmpPath, settings.dbPath);
}

function writeStore(store) {
  // Enqueue le write. Retourne une Promise mais on garde l'API sync pour
  // ne pas casser les ~96 call sites existants — ils ne peuvent juste plus
  // assumer que le fichier est écrit AVANT que le handler termine, ce qui
  // n'est pas un problème car aucun read ultérieur ne se fait dans la même
  // requête sans aller relire le disque.
  _writeQueueLen++;
  if (_writeQueueLen > WRITE_QUEUE_WARN_THRESHOLD) {
    console.warn(`[store] Write queue saturée (${_writeQueueLen} pending). Charge serveur élevée ?`);
  }
  _writeQueue = _writeQueue
    .then(() => {
      try {
        writeStoreAtomicSync(store);
      } catch (e) {
        console.error("[store] WRITE FAILED:", e.message, e.stack);
      } finally {
        _writeQueueLen--;
      }
    });
  return _writeQueue;
}

// V6.5 — Écriture ATOMIQUE contre le lost-update.
//
// writeStore(store) écrit un INSTANTANÉ capturé avant le verrou : si deux
// requêtes font readStore()→modify→writeStore() en parallèle, la seconde
// écrase les modifs de la première (des exports/refresh tokens ont ainsi été
// perdus). mutateStore() relit l'état à jour DANS la file sérialisée, applique
// la mutation, puis écrit — donc aucune perte, même sous concurrence.
// À utiliser pour toute écriture critique (append d'export, de report, etc.).
function mutateStore(mutatorFn) {
  _writeQueueLen++;
  if (_writeQueueLen > WRITE_QUEUE_WARN_THRESHOLD) {
    console.warn(`[store] Write queue saturée (${_writeQueueLen} pending). Charge serveur élevée ?`);
  }
  _writeQueue = _writeQueue
    .then(() => {
      try {
        const fresh = readStore();     // relit le dernier état commité
        mutatorFn(fresh);              // applique la mutation sur l'état frais
        writeStoreAtomicSync(fresh);   // écrit
      } catch (e) {
        console.error("[store] MUTATE FAILED:", e.message, e.stack);
      } finally {
        _writeQueueLen--;
      }
    });
  return _writeQueue;
}

// Recovery : tente de restaurer depuis le backup le plus récent si store.json
// est corrompu/illisible. Évite la perte totale en cas de crash disque.
function recoverFromBackupOrEmpty() {
  const backupDir = path.join(path.dirname(settings.dbPath), "backups");
  if (fs.existsSync(backupDir)) {
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith("store-") && (f.endsWith(".json") || f.endsWith(".json.gz")))
      .sort()
      .reverse(); // plus récent en tête
    for (const f of files) {
      try {
        const fp = path.join(backupDir, f);
        // Les snapshots sont compressés depuis septembre 2026 ; les anciens
        // fichiers .json restent lisibles tels quels.
        const raw = f.endsWith(".gz")
          ? zlib.gunzipSync(fs.readFileSync(fp)).toString("utf-8")
          : fs.readFileSync(fp, "utf-8");
        const parsed = JSON.parse(raw);
        console.warn(`[store] Recovery depuis backup ${f} — ${(parsed.users||[]).length} users restaurés`);
        // Réécrit le store principal à partir du backup
        writeStoreAtomicSync(parsed);
        return parsed;
      } catch (_) { /* try next backup */ }
    }
  }
  console.error("[store] ⚠️ AUCUN BACKUP VALIDE — initialisation store vide.");
  const empty = { ...EMPTY_STORE };
  writeStoreAtomicSync(empty);
  return empty;
}

// ─── BACKUP HORAIRE + ROTATION 7 JOURS ─────────────────────────────────────
const BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const BACKUP_RETENTION_DAYS = 7;

function runBackupOnce() {
  try {
    if (!fs.existsSync(settings.dbPath)) return;
    const backupDir = path.join(path.dirname(settings.dbPath), "backups");
    ensureDir(backupDir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16); // YYYY-MM-DDTHH-MM
    const dest = path.join(backupDir, `store-${ts}.json.gz`);
    // Ne pas refaire un backup si on en a déjà un pour la même minute (idempotence après restart)
    if (fs.existsSync(dest)) return;

    const current = fs.readFileSync(settings.dbPath);

    // Un snapshot identique au précédent n'apporte rien. Mesuré avant ce
    // garde-fou : 250 fichiers pour 44 contenus réellement distincts, soit
    // 1,1 Go dont 900 Mo de copies conformes.
    const hash = crypto.createHash("sha256").update(current).digest("hex");
    const stampPath = path.join(backupDir, ".last-hash");
    try {
      if (fs.existsSync(stampPath) && fs.readFileSync(stampPath, "utf-8").trim() === hash) return;
    } catch (_) { /* empreinte illisible : on refait un backup, c'est le sens sûr */ }

    // Le store est du JSON : il se comprime d'un facteur 9 (mesuré 4,9 → 0,52 Mo).
    fs.writeFileSync(dest, zlib.gzipSync(current, { level: 6 }));
    try { fs.writeFileSync(stampPath, hash); } catch (_) { /* sans empreinte, on backupera à chaque tour */ }

    // Rotation : supprime les backups > BACKUP_RETENTION_DAYS jours
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(backupDir);
    for (const f of files) {
      if (!f.startsWith("store-") || !(f.endsWith(".json") || f.endsWith(".json.gz"))) continue;
      const fp = path.join(backupDir, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch (_) { /* ignore */ }
    }
  } catch (e) {
    console.error("[backup] failed:", e.message);
  }
}

function startBackupCron() {
  // Backup immédiat au boot puis toutes les heures
  setTimeout(runBackupOnce, 30 * 1000); // 30s après boot
  setInterval(runBackupOnce, BACKUP_INTERVAL_MS).unref?.();
  console.log(`[backup] Cron démarré — toutes les ${BACKUP_INTERVAL_MS/60000} min, rétention ${BACKUP_RETENTION_DAYS} jours`);
}

// ─── CLEANUP AUTO : refresh tokens expirés + audit events anciens ──────────
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const AUDIT_RETENTION_DAYS = 90;

function runCleanupOnce() {
  try {
    const store = readStore();
    const now = Date.now();
    let changes = 0;

    // 1) Refresh tokens expirés (champ expiresAt en ISO)
    const beforeRT = store.refreshTokens.length;
    store.refreshTokens = store.refreshTokens.filter((t) => {
      if (!t?.expiresAt) return true;
      const exp = new Date(t.expiresAt).getTime();
      return isNaN(exp) || exp > now;
    });
    if (store.refreshTokens.length !== beforeRT) {
      changes += beforeRT - store.refreshTokens.length;
      console.log(`[cleanup] Purgé ${beforeRT - store.refreshTokens.length} refresh tokens expirés`);
    }

    // 2) Password reset tokens expirés
    const beforePR = (store.passwordResetTokens || []).length;
    store.passwordResetTokens = (store.passwordResetTokens || []).filter((t) => {
      if (!t?.expiresAt) return true;
      return new Date(t.expiresAt).getTime() > now;
    });
    if (store.passwordResetTokens.length !== beforePR) {
      changes += beforePR - store.passwordResetTokens.length;
      console.log(`[cleanup] Purgé ${beforePR - store.passwordResetTokens.length} password reset tokens expirés`);
    }

    // 3) Audit events > AUDIT_RETENTION_DAYS : archivés dans un fichier compressé puis supprimés
    const auditCutoff = now - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const beforeAE = (store.auditEvents || []).length;
    const oldEvents = (store.auditEvents || []).filter((e) => {
      const ts = new Date(e.ts || e.timestamp || 0).getTime();
      return !isNaN(ts) && ts < auditCutoff;
    });
    if (oldEvents.length > 0) {
      const archiveDir = path.join(path.dirname(settings.dbPath), "archives");
      ensureDir(archiveDir);
      const archiveTs = new Date().toISOString().slice(0, 10);
      const archivePath = path.join(archiveDir, `audit-events-pre-${archiveTs}.json`);
      // Append (concat) si le fichier d'archive du jour existe déjà
      let existing = [];
      if (fs.existsSync(archivePath)) {
        try { existing = JSON.parse(fs.readFileSync(archivePath, "utf-8")); } catch {}
      }
      fs.writeFileSync(archivePath, JSON.stringify(existing.concat(oldEvents), null, 0));
      store.auditEvents = (store.auditEvents || []).filter((e) => {
        const ts = new Date(e.ts || e.timestamp || 0).getTime();
        return isNaN(ts) || ts >= auditCutoff;
      });
      changes += oldEvents.length;
      console.log(`[cleanup] Archivé ${oldEvents.length} audit events > ${AUDIT_RETENTION_DAYS}j (${beforeAE} → ${store.auditEvents.length})`);
    }

    if (changes > 0) writeStore(store);
  } catch (e) {
    console.error("[cleanup] failed:", e.message);
  }
}

function startCleanupCron() {
  // 5 min après boot puis toutes les 24h
  setTimeout(runCleanupOnce, 5 * 60 * 1000);
  setInterval(runCleanupOnce, CLEANUP_INTERVAL_MS).unref?.();
  console.log(`[cleanup] Cron démarré — refresh tokens + audit events > ${AUDIT_RETENTION_DAYS}j`);
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

function findOrCreateUserFromEmail(store, { email, passwordHash, name, product }) {
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
    // Essai identique à Apple/Google : 7 jours (et 3 EDL max, cf. TRIAL_MAX_EDL).
    // Sans ces champs, l'inscription email n'avait AUCUN essai et basculait
    // directement en « abonné » via l'ancienne clause de rétrocompatibilité.
    trialStartedAt: ts,
    trialEndsAt: nowPlus7DaysIso(),
    createdAt: ts,
    updatedAt: ts,
  };

  if (PRODUCTS.has(product)) user.product = product;
  store.users.push(user);
  sendWelcomeEmailOnce(user);
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
// Google : https://www.googleapis.com/oauth2/v3/certs (via jose)
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

// Apple : vérification manuelle via crypto natif Node.js pour éviter
// ERR_JOSE_NOT_SUPPORTED sur lsnode (Hostinger LiteSpeed).
// Cache JWKS Apple 1h pour ne pas refetch à chaque connexion.
let _appleJwksCache = null;
let _appleJwksCacheAt = 0;
const APPLE_JWKS_TTL_MS = 60 * 60 * 1000; // 1h

async function fetchAppleJwks() {
  const now = Date.now();
  if (_appleJwksCache && now - _appleJwksCacheAt < APPLE_JWKS_TTL_MS) {
    return _appleJwksCache;
  }
  const res = await fetch("https://appleid.apple.com/auth/keys");
  if (!res.ok) throw new Error(`Apple JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  _appleJwksCache = body.keys || [];
  _appleJwksCacheAt = now;
  return _appleJwksCache;
}

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

  // 1) Décoder l'en-tête pour trouver kid + alg
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    const err = new Error("Malformed JWT");
    err.status = 401;
    throw err;
  }
  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8"));
  } catch {
    const err = new Error("Invalid JWT header");
    err.status = 401;
    throw err;
  }

  // 2) Récupérer la clé publique depuis le JWKS Apple
  const keys = await fetchAppleJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Invalide le cache et réessaie (Apple tourne ses clés)
    _appleJwksCache = null;
    const freshKeys = await fetchAppleJwks();
    const freshJwk = freshKeys.find((k) => k.kid === header.kid);
    if (!freshJwk) {
      const err = new Error("Apple public key not found (unknown kid)");
      err.status = 401;
      throw err;
    }
    Object.assign(jwk || {}, freshJwk);
    if (!jwk) keys.push(freshJwk);
  }

  const matchedJwk = keys.find((k) => k.kid === header.kid);

  // 3) Créer la clé publique via crypto natif (évite jose ERR_JOSE_NOT_SUPPORTED)
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: matchedJwk, format: "jwk" });
  } catch (e) {
    const err = new Error(`Failed to import Apple public key: ${e.message}`);
    err.status = 500;
    throw err;
  }

  // 4) Vérifier la signature RS256
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], "base64url");
  const alg = header.alg === "RS256" ? "SHA256" : (header.alg || "SHA256");
  const isValid = crypto.createVerify(alg.replace("RS", "SHA"))
    .update(signingInput)
    .verify(publicKey, signature);
  if (!isValid) {
    const err = new Error("Apple ID token signature invalid");
    err.status = 401;
    throw err;
  }

  // 5) Valider les claims (iss, aud, exp)
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    const err = new Error("Invalid JWT payload");
    err.status = 401;
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "https://appleid.apple.com") {
    const err = new Error("Invalid Apple token issuer");
    err.status = 401;
    throw err;
  }
  if (claims.exp && now > claims.exp) {
    const err = new Error("Apple ID token expired");
    err.status = 401;
    throw err;
  }
  const aud = typeof claims.aud === "string" ? [claims.aud] : (claims.aud || []);
  const audMatch = audiences.some((a) => aud.includes(a));
  if (!audMatch) {
    const err = new Error(`Apple token audience mismatch: ${JSON.stringify(aud)}`);
    err.status = 401;
    throw err;
  }

  return claims;
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
    // V6.4.14 — Ne PAS écraser le name si l'utilisateur l'a personnalisé via le dashboard.
    // Apple ne renvoie le name qu'au 1er login ; pour les logins suivants il renvoie
    // souvent vide, ou pire, l'identifiant privaterelay (m8xnvxtzpc) qui n'est pas un
    // vrai nom. On garde la valeur en DB sauf si :
    //   • L'user n'a pas encore de name défini
    //   • OU le name actuel ressemble à l'email/relay (auto-généré par défaut)
    if (name && typeof name === "string" && name.trim()) {
      const currentName = (user.name || "").trim();
      const looksAutoGenerated = !currentName
        || currentName === "Utilisateur FOXSCAN"
        || (user.email && currentName === user.email.split("@")[0]);
      if (looksAutoGenerated) {
        user.name = name.trim();
      }
      // Sinon on garde le name personnalisé (firstName/lastName aussi préservés)
    }
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
  sendWelcomeEmailOnce(user);
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
    // V6.4.14 — Idem Apple : ne pas écraser un name personnalisé au login Google.
    if (name && typeof name === "string" && name.trim()) {
      const currentName = (user.name || "").trim();
      const looksAutoGenerated = !currentName
        || currentName === "Utilisateur FOXSCAN"
        || (user.email && currentName === user.email.split("@")[0]);
      if (looksAutoGenerated) {
        user.name = name.trim();
      }
    }
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
  sendWelcomeEmailOnce(user);
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

// V6.2 — Middleware requireAdmin
// Un user est admin si :
//   - user.role === "admin", OU
//   - son email est dans process.env.ADMIN_EMAILS (CSV) — fallback pour le bootstrap initial
// ─── HIÉRARCHIE DE RÔLES ────────────────────────────────────────────────────
//
//   superadmin  → tout : organisations, achats/CA, rôles, support
//   admin       → support uniquement : tickets, diagnostic, assistance EDL
//                 (PAS d'accès aux achats ni à la gestion des rôles)
//   manager     → SON organisation : invite/retire des agents, usage de son équipe
//   user        → ses propres EDL
//
// L'allowlist ADMIN_EMAILS reste un FILET DE SÉCURITÉ : elle confère toujours
// le rang superadmin, pour ne jamais se verrouiller dehors en cas d'erreur de
// rôle en base.
const ROLE_SUPERADMIN = "superadmin";
const ROLE_ADMIN = "admin";
const ROLE_MANAGER = "manager";
const ROLE_USER = "user";
const ASSIGNABLE_ROLES = new Set([ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_MANAGER, ROLE_USER]);

function isAdminEmail(user) {
  const adminEmails = (process.env.ADMIN_EMAILS || "pe.emery.d@icloud.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(String(user?.email || "").toLowerCase());
}

/** Rang effectif du compte (filet email inclus). */
function roleOf(user) {
  if (!user) return ROLE_USER;
  if (user.role === ROLE_SUPERADMIN || isAdminEmail(user)) return ROLE_SUPERADMIN;
  if (user.role === ROLE_ADMIN) return ROLE_ADMIN;
  // Manager : rôle explicite, OU compte « owner » historique (sans parent).
  if (user.role === ROLE_MANAGER || !user.parentUserId) return ROLE_MANAGER;
  return ROLE_USER;
}

function isSuperAdmin(user) {
  return roleOf(user) === ROLE_SUPERADMIN;
}

/** Admin plateforme = superadmin OU admin support. */
function isAdmin(user) {
  const r = roleOf(user);
  return r === ROLE_SUPERADMIN || r === ROLE_ADMIN;
}

/** Peut administrer SON organisation (inviter des agents, etc.). */
function isManager(user) {
  const r = roleOf(user);
  return r === ROLE_SUPERADMIN || r === ROLE_ADMIN || r === ROLE_MANAGER;
}

function requireAdmin(req, res, next) {
  // requireCurrentUser envoie res.status(401) lui-même si auth échoue, donc
  // on lui passe un next custom qui ne sera appelé que si auth a réussi.
  requireCurrentUser(req, res, () => {
    if (!isAdmin(req._user)) {
      return res.status(403).json({ ok: false, detail: "Réservé aux administrateurs FOXSCAN." });
    }
    return next();
  });
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

// Quota d'essai : 7 jours ET 3 EDL maximum. Le premier atteint bloque l'accès
// et bascule l'utilisateur dans le tunnel d'achat.
const TRIAL_MAX_EDL = Number(process.env.TRIAL_MAX_EDL || 3);

/** Nombre d'EDL réalisés pendant l'essai. */
function trialEdlUsed(store, user) {
  if (!store || !user) return 0;
  const start = user.trialStartedAt ? new Date(user.trialStartedAt).getTime() : 0;
  return (store.reports || []).filter((r) => {
    if (r.userID !== user.id) return false;
    if (!start) return true;
    const t = new Date(r.createdAt || 0).getTime();
    return Number.isFinite(t) ? t >= start : true;
  }).length;
}

// Statut d'accès :
//   "lifetime"     : compte fondateur → illimité à vie
//   "subscription" : abonnement Stripe réel, activation admin, ou compte historique
//   "trial"        : essai en cours (< 7 j ET < 3 EDL)
//   "trial_quota"  : essai en cours mais quota d'EDL atteint → tunnel d'achat
//   "expired"      : essai terminé sans paiement → tunnel d'achat
//
// ⚠️ « subscription » n'est JAMAIS déduit du seul `subscriptionStatus`, qui est
// écrit par des chemins non fiables. Il exige une preuve : Stripe, fondateur,
// activation admin explicite, ou `legacyAccess` (comptes antérieurs, préservés).
function computeAccessStatus(user, store) {
  if (!user) return "expired";
  if (user.foundersAccount === true) return "lifetime";

  const active = user.subscriptionStatus === "active";
  if (active && user.stripeSubscriptionId) return "subscription";  // abonnement réel
  if (active && user.adminActivated === true) return "subscription"; // activé par un admin
  if (user.legacyAccess === true) return "subscription";             // compte historique

  if (user.trialEndsAt) {
    const trialEnd = new Date(user.trialEndsAt).getTime();
    const inTime = Number.isFinite(trialEnd) && trialEnd > Date.now();
    if (inTime) {
      // Le quota n'est évalué que si l'on dispose du store (sinon on reste permissif).
      if (store && trialEdlUsed(store, user) >= TRIAL_MAX_EDL) return "trial_quota";
      return "trial";
    }
  }
  return "expired";
}

function isAccessActive(user, store) {
  const s = computeAccessStatus(user, store);
  return s === "lifetime" || s === "subscription" || s === "trial";
}

/** Détail d'accès destiné à l'app (pour afficher le bon écran de tunnel). */
function accessDetail(user, store) {
  const status = computeAccessStatus(user, store);
  const used = store ? trialEdlUsed(store, user) : 0;
  const days = trialDaysRemaining(user);
  let blockReason = null;
  if (status === "trial_quota") blockReason = "trial_edl_quota";
  else if (status === "expired") blockReason = "trial_expired";
  return {
    accessStatus: status,
    accessActive: status === "lifetime" || status === "subscription" || status === "trial",
    blockReason,
    trialDaysRemaining: days,
    trialEdlUsed: used,
    trialEdlLimit: TRIAL_MAX_EDL,
    checkoutUrl: "https://foxscan.fr/#pricing",
  };
}

/**
 * Archive un compte avant sa suppression, puis purge ses données personnelles.
 *
 * Deux régimes, dictés par le droit :
 *
 *  1. Le compte a une histoire de facturation → l'article L123-22 du Code de
 *     commerce impose de conserver les pièces comptables DIX ANS. Cette
 *     obligation prime sur le droit à l'effacement (RGPD art. 17-3-b), et une
 *     facture porte nécessairement l'identité du client. On conserve donc le
 *     dossier comptable nominatif.
 *
 *  2. Le compte n'a jamais rien payé → aucune obligation comptable, donc aucune
 *     base légale pour garder son identité. On ne conserve que des statistiques
 *     ANONYMES : elles sortent du champ du RGPD, et permettent malgré tout de
 *     suivre l'usage et le coût.
 *
 * Dans les deux cas on supprime ce qui n'est nécessaire à aucun des deux
 * objectifs : photos, scans, adresses, noms de locataires, IP, user-agent,
 * journaux de support.
 */
function archiveDeletedAccount(store, user) {
  const uid = user.id;
  const hasBilling = Boolean(
    user.stripeCustomerId || user.stripeSubscriptionId ||
    (store.payments || []).some((p) => (p.userId || p.userID) === uid),
  );

  const events = (store.usageEvents || []).filter((e) => (e.userId || e.userID) === uid);
  const costMicros = events.reduce((n, e) => n + (e.costMicros || 0), 0);
  const aiCalls = events.reduce((n, e) => n + (e.calls || 0), 0);

  const archiveId = `del_${crypto.randomBytes(6).toString("hex")}`;
  const record = {
    id: archiveId,
    // Statistiques — anonymes, conservables sans limite de durée.
    signupAt: user.createdAt || null,
    deletedAt: nowIso(),
    authProvider: user.authProvider || null,
    accessStatusAtDeletion: computeAccessStatus(user, store),
    edlCount: (store.reports || []).filter((r) => r.userID === uid).length,
    projectCount: (store.projects || []).filter((p) => p.userID === uid).length,
    exportCount: (store.exports || []).filter((e) => e.userID === uid).length,
    trialEdlUsed: trialEdlUsed(store, user),
    costMicros,
    aiCalls,
    // Dossier comptable — nominatif, et UNIQUEMENT si la loi l'impose.
    billing: hasBilling
      ? {
          name: user.name || null,
          email: user.email || null,
          stripeCustomerId: user.stripeCustomerId || null,
          retentionUntil: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString(),
          legalBasis: "Code de commerce L123-22 — conservation des pièces comptables",
        }
      : null,
  };

  if (!Array.isArray(store.deletedAccounts)) store.deletedAccounts = [];
  store.deletedAccounts.push(record);

  // Les relevés de coût sont ré-indexés sur l'identifiant d'archive : le suivi
  // financier survit, le lien avec la personne disparaît.
  store.usageEvents = (store.usageEvents || []).map((e) =>
    (e.userId || e.userID) === uid ? { ...e, userId: archiveId, userID: undefined } : e,
  );

  // Brouillons : contiennent noms de locataires et adresses. Rien à en garder.
  store.drafts = (store.drafts || []).filter((d) => (d.userID || d.userId) !== uid);

  // Tickets : on garde la trace technique, on retire l'identité et le journal.
  store.tickets = (store.tickets || []).map((t) =>
    (t.userId || t.userID) === uid
      ? {
          ...t, userId: archiveId, userID: undefined,
          email: null, userName: null, log: null, messages: null,
          redacted: "account-deleted",
        }
      : t,
  );

  return archiveId;
}

function trialDaysRemaining(user) {
  if (!user || !user.trialEndsAt) return 0;
  const ms = new Date(user.trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Refuse la création d'un EDL quand l'essai est épuisé (7 jours ou 3 EDL).
 * Renvoie `true` si la requête a été refusée (l'appelant doit s'arrêter).
 *
 * La réponse 402 porte tout le nécessaire pour que l'app ouvre l'écran d'achat :
 * motif du blocage, quota consommé, et URL de souscription.
 */
/** L'EDL visé existe-t-il déjà pour ce compte ? (mise à jour, pas création) */
function edlAlreadyKnown(store, user, body) {
  if (!store || !user || !body) return false;
  const uid = user.id;
  const rid = body.reportID || body.id || null;
  const pid = body.projectID || null;
  if (rid && (store.reports || []).some((r) => r.id === rid && r.userID === uid)) return true;
  if (pid && (store.projects || []).some((p) => p.id === pid && p.userID === uid)) return true;
  if (pid && (store.reports || []).some((r) => r.projectID === pid && r.userID === uid)) return true;
  return false;
}

function blockIfTrialExhausted(user, store, res, body) {
  // Auth optionnelle sur ces routes : sans utilisateur identifié, on ne bloque
  // pas (le flux anonyme historique reste fonctionnel).
  if (!user) return false;
  const detail = accessDetail(user, store);
  if (detail.accessActive) return false;

  // JAMAIS bloquer la synchronisation d'un EDL DÉJÀ commencé : sinon le travail
  // resté sur le téléphone (photos ajoutées, EDL en cours) ne remonterait plus
  // et serait perdu. Seule la création d'un NOUVEL EDL est soumise au quota.
  if (edlAlreadyKnown(store, user, body)) return false;

  res.status(402).json({
    ok: false,
    detail:
      detail.blockReason === "trial_edl_quota"
        ? `Essai gratuit terminé : ${detail.trialEdlLimit} états des lieux atteints. Abonnez-vous pour continuer.`
        : "Votre essai gratuit de 7 jours est terminé. Abonnez-vous pour continuer.",
    ...detail,
  });
  return true;
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

// ── Protection du contenu des états des lieux ──────────────────────────────
//
// Constaté en production (sauvegardes du 29/09/2026) : un rapport finalisé à
// 10 h 21 perdait son contenu à 10 h 53 — chaque fichier exporté (PDF, photo)
// remplaçait `payload` par la fiche de l'export — puis repassait « en cours »
// à 15 h 42, quand un vieux brouillon du même rapport remontait d'un autre
// appareil. Deux règles :
//   1. un export ne touche JAMAIS au contenu d'un rapport qui existe ;
//   2. un brouillon ne remplace pas un rapport finalisé (sauf réouverture
//      explicite depuis l'app : `reopened: true`).

/** Vrai contenu d'état des lieux (et non la fiche d'un export). */
function isInspectionPayload(payload) {
  return !!payload && typeof payload === "object" && Array.isArray(payload.roomConditions);
}

function isReportFinalized(reportRow) {
  return !!reportRow && (reportRow.isFinalized === true || reportRow.payload?.isFinalized === true);
}

/**
 * Rattache un export à son rapport. Si le rapport porte déjà un vrai contenu,
 * on n'y touche pas (seul le nom du PDF est tenu à jour) ; sinon on crée la
 * fiche minimale, comme avant.
 */
function attachExportToReport(reports, reportID, stub) {
  const existing = reports.find((r) => r.id === reportID);
  if (existing && isInspectionPayload(existing.payload)) {
    if (/\.pdf$/i.test(String(stub.fileName || ""))) existing.fileName = stub.fileName;
    return existing;
  }
  return upsertByID(reports, reportID, stub);
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

// Délai accordé à une analyse de photos demandée par l'app (cf. /ai/responses).
const AI_RESPONSES_TIMEOUT_MS = 150000;

async function callOpenAIResponses(payload, timeoutMs = 60000) {
  if (!settings.openaiApiKey) {
    const err = new Error("OPENAI_API_KEY is not configured on server");
    err.status = 503;
    throw err;
  }

  // Timeout par appel. Par défaut 60 s (analyses vision en `detail: high`).
  // L'import d'EDL passe une valeur plus basse (cf. EDL_CALL_TIMEOUT_MS) : sur
  // un import on préfère abandonner un appel lent et rendre un résultat partiel
  // plutôt que laisser le proxy couper toute la requête (504).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

    // L'analyse d'une pièce part avec ses photos d'ensemble et leurs
    // agrandissements vers un modèle à raisonnement : 40 à 90 s courants. Les
    // 60 s par défaut la coupaient (504) ; l'app, de son côté, attend 180 s.
    const startedAt = Date.now();
    const upstream = await callOpenAIResponses(payload, AI_RESPONSES_TIMEOUT_MS);
    console.log(
      `[/ai/responses] user=${req._user?.id || "?"} model=${upstream.model || payload.model} ` +
      `durée=${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
      `entrée=${upstream?.usage?.input_tokens || 0} sortie=${upstream?.usage?.output_tokens || 0}`
    );
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

// V5.3 — Routes /ai/scans* (proxy vers PC ML + mock fallback).
// Voir lib/scansProxy.js pour le détail. Configuration via env :
//   FOXSCAN_ML_BACKEND_URL    URL Cloudflare Tunnel du PC ML (optionnel)
//   FOXSCAN_ML_INTERNAL_TOKEN Token partagé Hostinger ↔ PC (optionnel)
//   FOXSCAN_ML_TIMEOUT_MS     Timeout upload (default 600000 = 10 min)
// Si non configuré → mode MOCK : stocke en local, simule done en 25 s,
// utile pour tester le pipeline iPhone sans avoir le PC ML branché.
mountScansRoutes(app, { requireCurrentUser });

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

// ─── /auth/forgot-password ──────────────────────────────────────────────────
// POST { email } → si email existe avec authProvider=email, génère un token
// stocké dans store.passwordResetTokens[] (expire 1h) et envoie un email avec
// un lien vers https://foxscan.fr/reset-password.html?token=XXX.
//
// SÉCURITÉ : on retourne TOUJOURS 200 (même si email inconnu) pour ne pas
// permettre l'énumération de comptes. Les utilisateurs Apple/Google ne reçoivent
// rien (ils doivent se reconnecter via leur provider).
//
// Rate limit basique : 1 request / 60s / email (pour ne pas spammer la mailbox).
app.post("/auth/forgot-password", async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, detail: "valid email is required" });
  }

  const store = readStore();
  const now = Date.now();

  // Rate limit : ignore si un token a été émis pour ce même email il y a moins de 60s.
  const recent = store.passwordResetTokens.find(
    (t) => t.email === email && (now - new Date(t.createdAt).getTime()) < 60 * 1000
  );
  if (recent) {
    return res.json({ ok: true, message: "Si ce compte existe, un email vient d'être envoyé. Vérifiez votre boîte." });
  }

  const user = store.users.find((u) => u.email === email && u.authProvider === "email");
  // Si le user existe ET a un mot de passe → on génère un token.
  // Sinon on fait semblant d'envoyer pour ne pas leaker l'info.
  if (user && user.passwordHash) {
    const token = crypto.randomBytes(32).toString("hex"); // 256 bits
    const tokenHash = hashToken(token);
    const expiresAt = new Date(now + 60 * 60 * 1000).toISOString(); // 1h

    store.passwordResetTokens.push({
      id: `prt_${crypto.randomBytes(4).toString("hex")}`,
      userID: user.id,
      email,
      tokenHash,
      createdAt: nowIso(),
      expiresAt,
      usedAt: null,
      ipAddress: (req.ip || req.headers["x-forwarded-for"] || "").toString().slice(0, 45),
    });
    writeStore(store);

    const resetLink = `https://foxscan.fr/reset-password.html?token=${encodeURIComponent(token)}`;
    const html = `
      <div style="font-family:-apple-system,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:30px;color:#1D1D1F">
        <div style="text-align:center;margin-bottom:30px">
          <div style="font-size:24px;font-weight:800;color:#FF7A1A">FOXSCAN</div>
        </div>
        <h1 style="font-size:22px;font-weight:700;margin-bottom:14px">Réinitialiser votre mot de passe</h1>
        <p style="font-size:15px;color:#3D3D3F;line-height:1.6;margin-bottom:24px">
          Bonjour,<br/><br/>
          Vous avez demandé à réinitialiser votre mot de passe FOXSCAN. Cliquez sur le bouton ci-dessous
          pour choisir un nouveau mot de passe. Ce lien expire dans <strong>1 heure</strong>.
        </p>
        <div style="text-align:center;margin:30px 0">
          <a href="${resetLink}" style="display:inline-block;background:#FF7A1A;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:600">Réinitialiser mon mot de passe</a>
        </div>
        <p style="font-size:13px;color:#86868B;line-height:1.6;margin-top:24px">
          Si vous n'avez pas fait cette demande, ignorez simplement cet email — votre mot de passe reste inchangé.<br/><br/>
          Lien direct si le bouton ne fonctionne pas :<br/>
          <span style="word-break:break-all;font-size:11px">${resetLink}</span>
        </p>
        <hr style="margin:30px 0;border:0;border-top:1px solid #E5E5EA"/>
        <p style="font-size:11px;color:#86868B;text-align:center">
          FOXSCAN — État des lieux numérique pour agences immobilières<br/>
          Cet email a été envoyé à ${email}. Si vous n'êtes pas à l'origine de cette demande,
          contactez-nous à contact@foxscan.fr.
        </p>
      </div>
    `;
    await sendMail({
      to: email,
      subject: "Réinitialiser votre mot de passe FOXSCAN",
      html,
    });

    // Audit
    store.auditEvents.push({
      id: `aud_${crypto.randomBytes(4).toString("hex")}`,
      userID: user.id,
      createdAt: nowIso(),
      type: "auth.password.reset.requested",
      payload: { email, ipAddress: (req.ip || "").toString().slice(0, 45) },
    });
    writeStore(store);
  } else {
    console.log(`[auth/forgot-password] no email-provider user found for ${email} (silent 200)`);
  }

  res.json({ ok: true, message: "Si ce compte existe, un email vient d'être envoyé. Vérifiez votre boîte." });
});

// ─── /auth/reset-password ───────────────────────────────────────────────────
// POST { token, newPassword } → si le token est valide ET non expiré ET non
// utilisé, change le mot de passe de l'utilisateur, marque le token comme
// utilisé, révoque tous ses refresh tokens (forcer reconnexion partout).
//
// Renvoie 401 si token invalide/expiré/utilisé.
// Renvoie 400 si mot de passe trop court.
app.post("/auth/reset-password", (req, res) => {
  const body = req.body || {};
  const token = String(body.token || "").trim();
  const newPassword = String(body.newPassword || "");

  if (!token || token.length < 32) {
    return res.status(401).json({ ok: false, detail: "Token invalide ou manquant." });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ ok: false, detail: "Le mot de passe doit faire 6 caractères minimum." });
  }

  const store = readStore();
  const tokenHash = hashToken(token);
  const now = Date.now();

  const tokenRow = store.passwordResetTokens.find((t) => t.tokenHash === tokenHash);
  if (!tokenRow) {
    return res.status(401).json({ ok: false, detail: "Lien de réinitialisation invalide." });
  }
  if (tokenRow.usedAt) {
    return res.status(401).json({ ok: false, detail: "Ce lien a déjà été utilisé. Demandez-en un nouveau." });
  }
  if (Number(new Date(tokenRow.expiresAt).getTime()) < now) {
    return res.status(401).json({ ok: false, detail: "Lien expiré. Demandez-en un nouveau." });
  }

  const user = store.users.find((u) => u.id === tokenRow.userID);
  if (!user || user.authProvider !== "email") {
    return res.status(401).json({ ok: false, detail: "Compte introuvable." });
  }

  // Met à jour le mot de passe (nouveau salt à chaque reset).
  const salt = crypto.randomBytes(16).toString("hex");
  user.passwordSalt = salt;
  user.passwordHash = hashPassword(newPassword, salt);
  user.updatedAt = nowIso();

  // Marque le token comme utilisé.
  tokenRow.usedAt = nowIso();

  // SÉCURITÉ : révoque TOUS les refresh tokens actifs de cet user
  // (force la reconnexion sur tous ses appareils, en cas de compromission).
  let revokedCount = 0;
  for (const t of store.refreshTokens) {
    if (t.userID === user.id && !t.revokedAt) {
      t.revokedAt = nowTs();
      revokedCount++;
    }
  }

  // Audit
  store.auditEvents.push({
    id: `aud_${crypto.randomBytes(4).toString("hex")}`,
    userID: user.id,
    createdAt: nowIso(),
    type: "auth.password.reset.completed",
    payload: {
      email: user.email,
      revokedSessions: revokedCount,
      ipAddress: (req.ip || "").toString().slice(0, 45),
    },
  });

  writeStore(store);

  // Émet directement de nouveaux tokens pour que l'utilisateur soit connecté
  // sur l'appareil où il vient de reset (pas besoin de re-saisir le mdp).
  const response = issueTokensForUser(store, user);
  writeStore(store);

  res.json({
    ok: true,
    message: "Mot de passe modifié avec succès. Vous êtes maintenant connecté.",
    ...response,
  });
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
    // DEBUG temporaire : capture la vraie raison + l'audience du token dans un
    // fichier lisible (les logs console partent vers LiteSpeed, inaccessibles).
    try {
      const tok = (req.body && (req.body.idToken || req.body.identityToken)) || "";
      let aud = "?", iss = "?", exp = "?";
      const p = String(tok).split(".");
      if (p.length === 3) {
        const c = JSON.parse(Buffer.from(p[1], "base64url").toString("utf-8"));
        aud = JSON.stringify(c.aud); iss = c.iss; exp = c.exp;
      }
      fs.appendFileSync(
        path.join(__dirname, "data", "auth-debug.log"),
        `${nowIso()} APPLE reject="${err.message}" token.aud=${aud} iss=${iss} exp=${exp} hasUser=${!!(req.body && req.body.user)}\n`,
      );
    } catch (_) { /* best effort */ }
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

  const user = findUserById(store, String(payload.sub || ""));
  if (!user) {
    return res.status(401).json({ ok: false, detail: "User not found" });
  }

  // V6.5 — Refresh SANS rotation ni écriture du store.
  //
  // Avant : on révoquait l'ancien refresh token et on en émettait un nouveau
  // (rotation à usage unique), ce qui nécessitait un writeStore(). Or le cycle
  // readStore()→modify→writeStore() n'est PAS atomique : un autre endpoint qui
  // écrit le store en parallèle (ex. /track/funnel public) réécrasait la version
  // sans le nouveau refresh token → token perdu → déconnexion au refresh suivant.
  // C'était la cause des reconnexions fréquentes ("token expiré").
  //
  // Désormais /auth/refresh est en LECTURE SEULE : on vérifie que le refresh
  // token est valide, présent et non révoqué, puis on émet uniquement un nouvel
  // access token. Le refresh token existant reste valable jusqu'à son expiration
  // (90 j) ; il reste révocable via /auth/logout et "révoquer les sessions".
  const iat = nowTs();
  const accessToken = signJwt(
    {
      iss: "foxscan-api",
      sub: user.id,
      type: "access",
      iat,
      exp: iat + settings.accessTtlSeconds,
      agency_id: user.agencyID,
      subscription_status: user.subscriptionStatus,
      jti: crypto.randomBytes(8).toString("hex"),
    },
    settings.jwtSecret,
  );

  res.json({
    ok: true,
    accessToken,
    refreshToken: body.refreshToken, // inchangé (pas de rotation)
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

  // 2) Archivage AVANT purge : une fois les lignes supprimées, les compteurs
  //    ne sont plus calculables. Voir archiveDeletedAccount() pour le partage
  //    entre statistiques anonymes et dossier comptable nominatif.
  const archiveId = archiveDeletedAccount(store, user);
  console.log(`[/auth/account DELETE] compte archivé sous ${archiveId}`);

  // 3) Lignes en base — purge en place
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
        payload: (() => {
          // L'IP, le user-agent et le référent sont des données personnelles :
          // les garder viderait l'anonymisation de son sens.
          const { ipAddress, userAgent, referrer, ...rest } = ev.payload || {};
          return { ...rest, redactedReason: "account-deleted" };
        })(),
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

  // ⚠️ FAILLE FERMÉE — cet endpoint permettait à N'IMPORTE QUEL utilisateur
  // authentifié de se déclarer abonné (`{subscriptionActive:true}`), donc de
  // contourner entièrement le paiement. Le paiement passe désormais
  // exclusivement par Stripe (web) : seul le webhook Stripe ou un admin peut
  // accorder un accès. Pour un appelant non-admin, on ne modifie plus rien et
  // on renvoie simplement l'état réel calculé côté serveur — l'app continue de
  // fonctionner, mais ne peut plus s'octroyer de droits.
  if (!isAdmin(current)) {
    console.warn(
      `[subscriptions/status] tentative d'auto-activation ignorée user=${current.id}`,
    );
    return res.json({
      ok: true,
      id: target.id,
      message: "Statut lu depuis le serveur (modification non autorisée)",
      subscriptionActive: isAccessActive(target, store),
      ...accessDetail(target, store),
    });
  }

  // Admin : activation manuelle explicite et tracée.
  target.subscriptionStatus = body.subscriptionActive ? "active" : "inactive";
  target.adminActivated = body.subscriptionActive === true;
  target.updatedAt = nowIso();
  writeStore(store);

  res.json({
    ok: true,
    id: target.id,
    message: "Subscription status updated",
    subscriptionActive: target.subscriptionStatus === "active",
    ...accessDetail(target, store),
  });
});

// ── /auth/me ─────────────────────────────────────────────────────────────────
// GET : retourne l'utilisateur courant (utilisé par l'app iOS à chaque ouverture
//       pour synchroniser le statut d'abonnement, le nom, le trial, etc.)
// PATCH : permet à l'app de mettre à jour le nom (firstName/lastName) du user.

function publicUserShape(user, store) {
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
    subscriptionActive: isAccessActive(user, store),
    subscriptionStatus: user.subscriptionStatus || "inactive",
    // Détail complet pour piloter le tunnel d'achat côté app :
    // accessStatus, blockReason, trialEdlUsed/Limit, checkoutUrl.
    ...accessDetail(user, store),
    trialStartedAt: user.trialStartedAt || null,
    trialEndsAt: user.trialEndsAt || null,
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
  const user = publicUserShape(req._user, req._store);
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
  const updated = publicUserShape(target, req._store);
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

// ─────────────────────────────────────────────────────────────────────────
// V6.4.9 — TEAM MANAGEMENT (équipe par compte propriétaire)
// ─────────────────────────────────────────────────────────────────────────
// Modèle V1 simplifié (sans master.db) : un user est "owner" de son équipe
// par défaut. Les agents qu'il invite ont user.parentUserId === ownerId
// et user.role === "agent" (vs "user" par défaut).
//
// Endpoints :
//   GET    /auth/me/team               → liste les membres de mon équipe
//   POST   /auth/me/team/invite        → envoie un email d'invitation
//   POST   /auth/me/team/reset-password → envoie un email de reset pour un membre
// ─────────────────────────────────────────────────────────────────────────

app.get("/auth/me/team", requireCurrentUser, (req, res) => {
  const user = req._user;
  const store = req._store;

  // Détermine l'ownerId : soi-même si pas parent, sinon le parent
  const ownerId = user.parentUserId || user.id;
  const myRole = user.parentUserId ? "agent" : "owner";

  const owner = store.users.find(u => u.id === ownerId);
  // Liste : l'owner + tous les agents dont parentUserId === ownerId
  const members = [
    owner,
    ...store.users.filter(u => u.parentUserId === ownerId),
  ].filter(Boolean).map(u => ({
    userId: u.id,
    name: u.name || "",
    email: u.email || "",
    role: u.id === ownerId ? "owner" : "agent",
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    suspended: u.suspended === true,
  }));

  res.json({
    ok: true,
    orgName: owner?.name ? `Équipe de ${owner.name}` : "Mon équipe",
    ownerId,
    role: myRole,
    members,
    seatsAllowed: owner?.seatsAllowed || 3,
    seatsUsed: members.length,
  });
});

// V6.4.9 — Invite un agent par email. Crée le user en pending, génère un
// token de reset/setup, envoie l'email.
app.post("/auth/me/team/invite", requireCurrentUser, async (req, res) => {
  const user = req._user;
  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim().slice(0, 120) || email.split("@")[0];

  if (!email || !email.includes("@") || !email.includes(".")) {
    return res.status(400).json({ ok: false, detail: "Email invalide" });
  }
  // Seul un owner peut inviter (pas un agent)
  if (user.parentUserId) {
    return res.status(403).json({ ok: false, detail: "Seuls les owners peuvent inviter des agents" });
  }

  const store = readStore();
  // L'email existe déjà ?
  const existing = store.users.find(u => (u.email || "").toLowerCase() === email);
  if (existing) {
    return res.status(409).json({ ok: false, detail: "Cet email a déjà un compte FOXSCAN" });
  }

  // Crée le user agent (pending : pas de password tant que reset pas fait)
  const newUser = {
    id: `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    authProvider: "email",
    email,
    name,
    role: "agent",
    parentUserId: user.id,
    passwordHash: null,         // sera créé via le lien d'invitation
    invitedBy: user.id,
    invitedAt: nowIso(),
    trialEndsAt: user.trialEndsAt || null, // hérite du trial du parent
    createdAt: nowIso(),
    updatedAt: nowIso(),
    suspended: false,
    pendingActivation: true,
  };
  store.users.push(newUser);

  // Génère un token de reset 7 jours
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (!Array.isArray(store.passwordResetTokens)) store.passwordResetTokens = [];
  store.passwordResetTokens.push({
    id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    userID: newUser.id,
    tokenHash,
    expiresAt,
    createdAt: nowIso(),
    purpose: "invite",
  });

  // Audit
  if (!Array.isArray(store.auditEvents)) store.auditEvents = [];
  store.auditEvents.push({
    id: `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    ts: nowIso(),
    actor: user.id, actorEmail: user.email,
    userID: newUser.id,
    action: "team.invite",
    details: { email, invitedBy: user.email },
  });

  writeStore(store);

  // Envoie l'email (si SMTP configuré, sinon log)
  const inviteUrl = `${(process.env.PUBLIC_BASE_URL || "https://foxscan.fr")}/reset-password.html?token=${encodeURIComponent(rawToken)}&setup=1`;
  try {
    if (typeof sendInviteEmail === "function") {
      await sendInviteEmail(email, name, user.name || user.email, inviteUrl);
    } else {
      console.log(`[team.invite] Email pour ${email} : ${inviteUrl}`);
    }
  } catch (e) {
    console.error("[team.invite] envoi email échoué :", e.message);
    // On ne fail pas, le user est créé, l'admin peut renvoyer le lien
  }

  res.json({
    ok: true,
    invited: { id: newUser.id, email, name },
    // En dev, retourne le lien pour pouvoir le tester
    inviteUrl: process.env.NODE_ENV === "production" ? undefined : inviteUrl,
  });
});

// V6.4.9 — Reset mot de passe d'un membre de mon équipe (owner only)
app.post("/auth/me/team/reset-password", requireCurrentUser, async (req, res) => {
  const user = req._user;
  const body = req.body || {};
  const targetUserId = String(body.userId || "").trim();

  if (!targetUserId) return res.status(400).json({ ok: false, detail: "userId requis" });
  if (user.parentUserId) {
    return res.status(403).json({ ok: false, detail: "Seuls les owners peuvent réinitialiser les mots de passe" });
  }

  const store = readStore();
  const target = store.users.find(u => u.id === targetUserId);
  if (!target) return res.status(404).json({ ok: false, detail: "Membre introuvable" });
  if (target.parentUserId !== user.id) {
    return res.status(403).json({ ok: false, detail: "Ce membre ne fait pas partie de votre équipe" });
  }
  if (!target.email) return res.status(400).json({ ok: false, detail: "Le membre n'a pas d'email" });

  // Token reset 24h
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  if (!Array.isArray(store.passwordResetTokens)) store.passwordResetTokens = [];
  store.passwordResetTokens.push({
    id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    userID: target.id,
    tokenHash,
    expiresAt,
    createdAt: nowIso(),
    purpose: "reset",
    requestedBy: user.id,
  });

  if (!Array.isArray(store.auditEvents)) store.auditEvents = [];
  store.auditEvents.push({
    id: `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    ts: nowIso(),
    actor: user.id, actorEmail: user.email,
    userID: target.id,
    action: "team.reset-password",
    details: { targetEmail: target.email },
  });

  writeStore(store);

  const resetUrl = `${(process.env.PUBLIC_BASE_URL || "https://foxscan.fr")}/reset-password.html?token=${encodeURIComponent(rawToken)}`;
  try {
    if (typeof sendPasswordResetEmail === "function") {
      await sendPasswordResetEmail(target.email, target.name || target.email, resetUrl);
    } else {
      console.log(`[team.reset-password] Email pour ${target.email} : ${resetUrl}`);
    }
  } catch (e) {
    console.error("[team.reset-password] envoi email échoué :", e.message);
  }

  res.json({
    ok: true,
    targetUserId,
    targetEmail: target.email,
    inviteUrl: process.env.NODE_ENV === "production" ? undefined : resetUrl,
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

// V5.3.47 — Champs métier étendus partagés dashboard ↔ app iOS.
// L'agent les saisit sur le dashboard ; l'app iOS les récupère pour
// pré-remplir l'EDL (évite de re-taper). Voir docs/NOTE_POUR_AGENT_WEB.md.
// Clé = nom du champ, valeur = longueur max autorisée.
const DRAFT_BUSINESS_TEXT_FIELDS = {
  addressComplement: 120,
  city: 80,
  postalCode: 16,
  building: 40,
  staircase: 40,
  floor: 40,
  doorNumber: 40,
  surfaceArea: 20,
  tenantPhone: 30,
  landlordContact: 120,
  dossierReference: 60,
  lotReference: 60,
  mandateReference: 60,
};

// Applique (création) ou met à jour (édition) les champs métier étendus.
// onlyIfPresent=true → ne touche que les champs effectivement fournis (PATCH).
function applyDraftBusinessFields(target, body, { onlyIfPresent = false } = {}) {
  for (const [field, maxLen] of Object.entries(DRAFT_BUSINESS_TEXT_FIELDS)) {
    if (onlyIfPresent && typeof body[field] !== "string") continue;
    target[field] = sanitizeDraftText(body[field], maxLen);
  }
  return target;
}

// Projection des champs métier étendus pour les responses JSON (toujours
// présents, valeur "" si non renseignés) — l'app iOS lit ces champs.
function draftBusinessFieldsShape(src) {
  const out = {};
  for (const field of Object.keys(DRAFT_BUSINESS_TEXT_FIELDS)) {
    out[field] = src[field] || "";
  }
  return out;
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
    // V6.4.21 — Titre libre optionnel (label custom de l'agent).
    title: d.title || "",
    // V5.3.47 — Champs métier étendus (lus par l'app iOS pour pré-remplir).
    ...draftBusinessFieldsShape(d),
    address: d.address,
    propertyType: d.propertyType,
    edlType: d.edlType,
    // Alias pour l'app iOS qui lit `inspectionType` (nom du champ dans Draft partagé).
    // `edlType` et `inspectionType` ont les mêmes valeurs ("entry"/"exit"/"inventory").
    inspectionType: d.edlType || "entry",
    // Nom du projet que l'app iOS utilise comme titre du nouveau projet.
    projectName: d.title || d.address || "Nouveau EDL",
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
    // V6 — Self-Prep tenant : statut public (jamais le token ni le hash)
    // pour que le dashboard affiche le bon badge sans exposer le secret.
    selfPrep: selfPrepPublicShape(d.selfPrep),
  };
}

// V6 — Projection publique de l'état Self-Prep tenant. On ne renvoie
// JAMAIS le shareTokenHash (côté serveur seulement) ni les photos brutes
// dans la liste — uniquement le statut + métadonnées d'affichage.
function selfPrepPublicShape(sp) {
  if (!sp || typeof sp !== "object") {
    return { status: "none" };
  }
  const now = nowTs();
  const expired = sp.tokenExpiresAt && (Date.parse(sp.tokenExpiresAt) / 1000) < now;
  return {
    status: sp.status || "none",       // none | sent | scanned | validated | expired
    tokenIssuedAt: sp.tokenIssuedAt || null,
    tokenExpiresAt: sp.tokenExpiresAt || null,
    expired: expired === true && sp.status === "sent",
    scannedAt: sp.scannedAt || null,
    validatedAt: sp.validatedAt || null,
    roomsCount: Array.isArray(sp.scanData?.rooms) ? sp.scanData.rooms.length : 0,
    photosCount: Array.isArray(sp.scanData?.rooms)
      ? sp.scanData.rooms.reduce((n, r) => n + (Array.isArray(r.photos) ? r.photos.length : 0), 0)
      : 0,
    score: typeof sp.scanData?.score === "number" ? sp.scanData.score : null,
  };
}

/// V5 — Projection d'un projet iPhone non-finalisé en "draft" pour
/// l'unifier avec les brouillons web côté liste UI.
/// On extrait l'adresse + locataire + dates depuis le `payload.report`
/// pour avoir un rendu cohérent dans la même liste.
// V5.3.2 — Détecte les valeurs "placeholder" héritées des anciens
// syncs (avant V5 où l'adresse était hard-codée à "Adresse synchronisée
// depuis iOS"). On veut JAMAIS exposer ces strings au dashboard ni au
// pull iOS — préférer la reconstitution depuis report.address + city.
const PLACEHOLDER_ADDRESSES = new Set([
  "Adresse synchronisée depuis iOS",
  "Adresse synchronisée depuis iCloud",
  "(adresse à renseigner)",
  "Adresse à renseigner",
  "Nouveau projet",
  "Projet exporté",
]);

function isPlaceholderAddress(s) {
  if (typeof s !== "string") return false;
  return PLACEHOLDER_ADDRESSES.has(s.trim());
}

// V5.3.4 — Détecte si une chaîne d'adresse est polluée (placeholder pur,
// ou contient un placeholder ailleurs, ou contient une duplication
// "69007 Lyon 69007 Lyon").
function isPollutedAddress(s) {
  if (typeof s !== "string") return true;
  const trimmed = s.trim();
  if (!trimmed.length) return true;
  if (PLACEHOLDER_ADDRESSES.has(trimmed)) return true;
  // Placeholder concaténé : "Adresse synchronisée depuis iOS, 69008 Lyon"
  for (const p of PLACEHOLDER_ADDRESSES) {
    if (trimmed.includes(p)) return true;
  }
  // Duplication "12345 Ville, 12345 Ville" répété ≥ 2 fois
  const cityPattern = /(\b\d{5}\b[^,]*)(?:,?\s*\1){1,}/i;
  if (cityPattern.test(trimmed)) return true;
  return false;
}

// V5.3.4 — Reconstitue une adresse propre EN PARTANT DE ZÉRO depuis les
// champs structurés du report. Idempotent : appeler 10 fois donne le
// même résultat, jamais d'accumulation. On ignore complètement
// `report.address` si elle est polluée — dans ce cas on se rabat sur
// postalCode + city seuls (mieux que rien pour l'agent).
function rebuildAddressFromReport(report) {
  if (!report || typeof report !== "object") return "";

  const rawAddress = (typeof report.address === "string"
    && !isPollutedAddress(report.address))
    ? report.address.trim() : "";
  const complement = (report.addressComplement || "").trim();
  const postalCode = (report.postalCode || "").trim();
  const city = (report.city || "").trim();

  // 1ère partie = rue + éventuel complément (uniquement si on a une vraie rue).
  const streetLine = [rawAddress, complement].filter(Boolean).join(", ");

  // 2e partie = code postal + ville, AJOUTÉS uniquement si :
  //   • streetLine ne les contient pas déjà
  //   • on a au moins l'un des deux
  const cityLine = [postalCode, city].filter(Boolean).join(" ").trim();
  const alreadyHasCity = (postalCode && streetLine.includes(postalCode))
                       || (city && streetLine.toLowerCase().includes(city.toLowerCase()));
  const finalCityLine = alreadyHasCity ? "" : cityLine;

  return [streetLine, finalCityLine].filter((s) => s && s.length > 0).join(", ");
}

function iosProjectToDraftShape(proj) {
  const report = proj.payload?.report || {};
  // V5.3.3 — Adresse priorisée :
  //   1) reconstituée depuis les champs structurés du report (filtre
  //      placeholders + évite doublon postal/ville)
  //   2) le top-level project.address SI ce n'est PAS un placeholder
  //   3) fallback "(adresse à renseigner)" pour signaler à l'agent
  const rebuiltFromReport = rebuildAddressFromReport(report);

  let address;
  if (rebuiltFromReport && rebuiltFromReport.length >= 5) {
    address = rebuiltFromReport;
  } else if (proj.address && !isPlaceholderAddress(proj.address)) {
    address = proj.address;
  } else {
    address = "(adresse à renseigner)";
  }
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

  // Source B : projets iPhone non-finalisés et non archivés.
  // On vérifie aussi store.reports : si un rapport associé est finalisé,
  // le projet ne doit plus apparaître dans les brouillons même si son
  // status n'a pas encore été mis à jour côté iOS.
  const iosDrafts = (store.projects || [])
    .filter((p) => {
      if (p.userID !== userID || p.isArchived === true) return false;
      if (p.status === "completed") return false;
      const projectReports = (store.reports || []).filter((r) => r.projectID === p.id);
      const isFinalized = projectReports.some(
        (r) => r.isFinalized === true || r?.payload?.isFinalized === true
      );
      return !isFinalized;
    })
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
    // V6.4.21 — Titre libre optionnel (label custom de l'agent).
    title: sanitizeDraftText(body.title, 120),
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
  // V5.3.47 — Champs métier étendus (adresse détaillée, références, etc.)
  applyDraftBusinessFields(draft, body);
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
  // V6.4.21 — Titre libre du brouillon (label custom pour l'agent, ex:
  // "EDL sortie urgent M. Dupont"). Optionnel ; si vide → fallback adresse.
  if (typeof body.title === "string") draft.title = sanitizeDraftText(body.title, 120);
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
  // V5.3.47 — Met à jour les champs métier étendus fournis (PATCH partiel).
  applyDraftBusinessFields(draft, body, { onlyIfPresent: true });
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

// ─────────────────────────────────────────────────────────────────────────
// V6 — SELF-PREP TENANT (magic link)
//
// L'agence génère un lien magic depuis le dashboard, le copie et l'envoie
// au locataire (SMS/WhatsApp/email manuel). Le locataire ouvre le lien
// sur son téléphone et upload son scan sans avoir besoin de compte.
//
// Sécurité :
//   • Le token est un JWT HS256 signé avec settings.jwtSecret, claim
//     `kind:"draft-share"` pour empêcher toute confusion avec les access
//     tokens d'authentification.
//   • Le serveur stocke uniquement le HASH du token (sha256). Si la DB
//     fuite, les tokens ne sont pas exploitables.
//   • Expiration côté JWT (`exp`) + hash en DB qui peut être révoqué
//     (PATCH selfPrep:{status:"none"} = invalidation manuelle).
//   • Le payload tenant est limité à 8 MB (≈30 photos JPEG compressées).
//   • Un seul scan accepté ; un nouvel upload écrase le précédent
//     (l'agent peut redemander si besoin).
// ─────────────────────────────────────────────────────────────────────────

const SELF_PREP_TOKEN_TTL_SECONDS = 7 * 24 * 3600;       // 7 jours
const SELF_PREP_TOKEN_KIND = "draft-share";
const SELF_PREP_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;     // 8 MB
const SELF_PREP_MAX_ROOMS = 30;
const SELF_PREP_MAX_PHOTOS_PER_ROOM = 12;

// Génère un magic token signé. Le payload contient draftID + userID
// pour qu'on n'ait pas à lire le store côté GET /share/:token avant
// d'avoir vérifié la signature (fail-fast).
function signSelfPrepToken(draftID, userID) {
  const iat = nowTs();
  const exp = iat + SELF_PREP_TOKEN_TTL_SECONDS;
  const token = signJwt(
    { kind: SELF_PREP_TOKEN_KIND, draftID, userID, iat, exp },
    settings.jwtSecret
  );
  return { token, iat, exp };
}

// Vérifie un magic token. Lève une erreur HTTP si invalide / expiré.
// On exige le claim `kind:"draft-share"` pour empêcher l'utilisation
// d'un access token comme magic link et vice-versa.
function verifySelfPrepToken(token) {
  const payload = verifyJwt(token, settings.jwtSecret);
  if (payload.kind !== SELF_PREP_TOKEN_KIND) {
    const err = new Error("Token invalide pour ce contexte");
    err.status = 401;
    throw err;
  }
  if (!payload.draftID || !payload.userID) {
    const err = new Error("Token incomplet");
    err.status = 401;
    throw err;
  }
  return payload;
}

// POST /drafts/:id/share — l'agent demande un nouveau magic link.
// Régénère systématiquement le token (la précédente URL devient morte
// si on n'en a plus le hash). Retourne l'URL complète à copier.
app.post("/drafts/:id/share", requireCurrentUser, (req, res) => {
  const store = readStore();
  const draft = (store.drafts || []).find((d) => d.id === req.params.id && d.userID === req._user.id);
  if (!draft) return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });

  const { token, iat, exp } = signSelfPrepToken(draft.id, req._user.id);
  const issuedAt = new Date(iat * 1000).toISOString();
  const expiresAt = new Date(exp * 1000).toISOString();

  // On préserve les données déjà reçues d'un précédent self-prep, mais
  // on remet le statut à "sent" (nouveau lien => nouveau cycle).
  const existing = draft.selfPrep || {};
  draft.selfPrep = {
    ...existing,
    shareTokenHash: hashToken(token),
    tokenIssuedAt: issuedAt,
    tokenExpiresAt: expiresAt,
    status: "sent",
    sentAt: issuedAt,
  };
  draft.updatedAt = nowIso();
  writeStore(store);

  // L'URL publique pointe vers la page tenant statique côté web/.
  // Le query param `t` est court pour faciliter le copier-coller SMS.
  const baseUrl = (process.env.PUBLIC_SITE_URL || "https://foxscan.fr").replace(/\/+$/, "");
  const shareUrl = `${baseUrl}/prep/?t=${encodeURIComponent(token)}`;

  res.json({
    ok: true,
    shareUrl,
    token,            // renvoyé une seule fois ici — le front DOIT le stocker
    expiresAt,
    issuedAt,
    selfPrep: selfPrepPublicShape(draft.selfPrep),
  });
});

// DELETE /drafts/:id/share — l'agent révoque le lien (futur upload tenant
// sera refusé). Le draft reste, juste la section selfPrep redevient "none".
app.delete("/drafts/:id/share", requireCurrentUser, (req, res) => {
  const store = readStore();
  const draft = (store.drafts || []).find((d) => d.id === req.params.id && d.userID === req._user.id);
  if (!draft) return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });
  if (draft.selfPrep) {
    draft.selfPrep = { status: "none" };
    draft.updatedAt = nowIso();
    writeStore(store);
  }
  res.json({ ok: true, selfPrep: selfPrepPublicShape(draft.selfPrep) });
});

// PATCH /drafts/:id/share/validate — l'agent finalise après visite
// contradictoire sur place. Marque le draft selfPrep.status = "validated".
app.patch("/drafts/:id/share/validate", requireCurrentUser, (req, res) => {
  const store = readStore();
  const draft = (store.drafts || []).find((d) => d.id === req.params.id && d.userID === req._user.id);
  if (!draft) return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });
  if (!draft.selfPrep || draft.selfPrep.status !== "scanned") {
    return res.status(409).json({ ok: false, detail: "Aucun scan tenant à valider." });
  }
  draft.selfPrep.status = "validated";
  draft.selfPrep.validatedAt = nowIso();
  // L'agent peut annoter les défauts qu'il a ajoutés sur place. Stockés
  // tels quels — le front est responsable du shape (objet libre, ≤ 50 KB).
  if (req.body && typeof req.body === "object") {
    const annotations = req.body.agentAnnotations;
    if (annotations && JSON.stringify(annotations).length <= 50000) {
      draft.selfPrep.agentAnnotations = annotations;
    }
  }
  draft.updatedAt = nowIso();
  writeStore(store);
  res.json({ ok: true, selfPrep: selfPrepPublicShape(draft.selfPrep) });
});

// GET /share/:token — endpoint PUBLIC (pas d'auth Bearer). Le locataire
// scanne ou clique sur le lien depuis son téléphone, on lui retourne
// les infos du bien (lecture seule) + on confirme que le token est
// valide. On ne retourne JAMAIS les données sensibles (userID, hash, etc.).
app.get("/share/:token", (req, res) => {
  let payload;
  try {
    payload = verifySelfPrepToken(req.params.token);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, detail: err.message });
  }
  const store = readStore();
  const draft = (store.drafts || []).find((d) => d.id === payload.draftID && d.userID === payload.userID);
  if (!draft) return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });

  // Vérification supplémentaire : le hash du token reçu doit correspondre
  // à celui stocké. Sinon = ancien token révoqué par régénération.
  const expectedHash = draft.selfPrep?.shareTokenHash;
  if (!expectedHash || hashToken(req.params.token) !== expectedHash) {
    return res.status(401).json({ ok: false, detail: "Ce lien a été révoqué par l'agence." });
  }

  // Statut "validated" => le tenant ne peut plus re-uploader.
  const status = draft.selfPrep?.status || "sent";
  res.json({
    ok: true,
    draft: {
      id: draft.id,
      address: draft.address,
      propertyType: draft.propertyType,
      edlType: draft.edlType,
      scheduledAt: draft.scheduledAt,
      tenantName: draft.tenantName || "",
      landlordName: draft.landlordName || "",
      notes: draft.notes || "",
    },
    status,                                           // sent | scanned | validated
    canUpload: status === "sent" || status === "scanned",
    expiresAt: draft.selfPrep?.tokenExpiresAt || null,
  });
});

// POST /share/:token/scan — endpoint PUBLIC. Le locataire upload son
// scan : un objet JSON { rooms: [{ name, photos: [{dataURL}] }], score }.
// Limite de payload stricte côté Express + revalidation ici.
app.post("/share/:token/scan", (req, res) => {
  let payload;
  try {
    payload = verifySelfPrepToken(req.params.token);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, detail: err.message });
  }

  const store = readStore();
  const draft = (store.drafts || []).find((d) => d.id === payload.draftID && d.userID === payload.userID);
  if (!draft) return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });

  // Hash check (lien révoqué ?).
  if (!draft.selfPrep?.shareTokenHash || hashToken(req.params.token) !== draft.selfPrep.shareTokenHash) {
    return res.status(401).json({ ok: false, detail: "Lien révoqué." });
  }
  if (draft.selfPrep.status === "validated") {
    return res.status(409).json({ ok: false, detail: "Cet état des lieux a déjà été validé par l'agence." });
  }

  // Sanitization du body. On accepte uniquement la shape attendue.
  const body = req.body || {};
  if (!Array.isArray(body.rooms)) {
    return res.status(400).json({ ok: false, detail: "rooms doit être un tableau." });
  }
  if (body.rooms.length === 0) {
    return res.status(400).json({ ok: false, detail: "Au moins une pièce est requise." });
  }
  if (body.rooms.length > SELF_PREP_MAX_ROOMS) {
    return res.status(400).json({ ok: false, detail: `Maximum ${SELF_PREP_MAX_ROOMS} pièces.` });
  }

  let totalBytes = 0;
  const cleanRooms = [];
  for (const room of body.rooms) {
    if (!room || typeof room !== "object") continue;
    const name = String(room.name || "").trim().slice(0, 60);
    if (!name) continue;
    const photos = Array.isArray(room.photos) ? room.photos : [];
    if (photos.length > SELF_PREP_MAX_PHOTOS_PER_ROOM) {
      return res.status(400).json({ ok: false, detail: `Maximum ${SELF_PREP_MAX_PHOTOS_PER_ROOM} photos par pièce.` });
    }
    const cleanPhotos = [];
    for (const p of photos) {
      if (!p || typeof p.dataURL !== "string") continue;
      if (!p.dataURL.startsWith("data:image/")) continue;
      totalBytes += p.dataURL.length;
      if (totalBytes > SELF_PREP_MAX_PAYLOAD_BYTES) {
        return res.status(413).json({ ok: false, detail: "Photos trop volumineuses (max 8 Mo cumulé). Reprends en plus basse résolution." });
      }
      cleanPhotos.push({
        dataURL: p.dataURL,
        capturedAt: typeof p.capturedAt === "string" ? p.capturedAt.slice(0, 40) : null,
        note: typeof p.note === "string" ? p.note.slice(0, 200) : "",
      });
    }
    cleanRooms.push({
      name,
      note: typeof room.note === "string" ? room.note.slice(0, 500) : "",
      photos: cleanPhotos,
    });
  }
  if (cleanRooms.length === 0) {
    return res.status(400).json({ ok: false, detail: "Aucune pièce avec photo valide." });
  }

  const score = typeof body.score === "number"
    ? Math.max(0, Math.min(100, Math.round(body.score)))
    : null;

  draft.selfPrep.status = "scanned";
  draft.selfPrep.scannedAt = nowIso();
  draft.selfPrep.scanData = {
    rooms: cleanRooms,
    score,
    submittedAt: nowIso(),
    // Pas de userAgent / IP — on respecte la privacy tenant.
  };
  draft.updatedAt = nowIso();
  writeStore(store);

  res.json({
    ok: true,
    message: "Scan envoyé à l'agence. Vous pouvez fermer cette page.",
    selfPrep: selfPrepPublicShape(draft.selfPrep),
  });
});

// GET /drafts/:id/share/scan — l'agent récupère le scan tenant complet
// (avec les photos) pour la vue Validation. Requiert auth Bearer.
app.get("/drafts/:id/share/scan", requireCurrentUser, (req, res) => {
  const store = readStore();
  const draft = (store.drafts || []).find((d) => d.id === req.params.id && d.userID === req._user.id);
  if (!draft) return res.status(404).json({ ok: false, detail: "Brouillon introuvable" });
  if (!draft.selfPrep || !draft.selfPrep.scanData) {
    return res.status(404).json({ ok: false, detail: "Aucun scan reçu." });
  }
  res.json({
    ok: true,
    scanData: draft.selfPrep.scanData,
    status: draft.selfPrep.status,
    scannedAt: draft.selfPrep.scannedAt,
    validatedAt: draft.selfPrep.validatedAt || null,
    agentAnnotations: draft.selfPrep.agentAnnotations || null,
  });
});

// Note : on n'appelle PLUS ensureDashboardAllowed ici. On laisse la session
// se charger avec le bon statut (trial/expired/lifetime), et c'est le
// dashboard qui affiche le bon bandeau (essai actif, expiré, illimité).
function dashboardSessionHandler(req, res) {
  const user = req._user;
  res.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      agencyID: user.agencyID,
      role: user.role || "user",            // V6.2 — exposé pour toggle admin UI
      effectiveRole: roleOf(user),           // rang effectif (filet email inclus)
      isAdmin: isAdmin(user),                 // V6.2 — calculé serveur (fallback email)
      isSuperAdmin: isSuperAdmin(user),       // achats/CA, organisations, rôles
      isManager: isManager(user),             // administration de SON organisation
      suspended: user.suspended === true,    // V6.2
      subscriptionActive: isAccessActive(user),
      accessStatus: computeAccessStatus(user),
      trialEndsAt: user.trialEndsAt || null,
      trialDaysRemaining: trialDaysRemaining(user),
      foundersAccount: user.foundersAccount === true,
    },
  });
}
// V6.5 — Le dashboard Next.js est servi en statique sous /dashboard/, ce qui
// MASQUAIT la route API /dashboard/session (LiteSpeed renvoyait le 404 statique).
// On expose donc aussi la session sous /api/dashboard/session (non masqué).
app.get("/dashboard/session", requireCurrentUser, dashboardSessionHandler);
app.get("/api/dashboard/session", requireCurrentUser, dashboardSessionHandler);

app.get("/projects", requireCurrentUser, (req, res) => {
  const user = req._user;
  try {
    // Lecture TOUJOURS autorisée : un compte bloqué doit continuer à
    // consulter et exporter les EDL qu'il a déjà réalisés. Seule la
    // CRÉATION d'un nouvel EDL est soumise au quota d'essai.
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
    .map((p) => {
      // Calcule isFinalized en vérifiant les rapports associés — le champ
      // status du projet peut rester "in_progress" côté iOS alors que le
      // rapport est bien finalisé. On expose isFinalized pour que le dashboard
      // affiche le bon badge (Terminé vs En cours).
      const projectReports = (store.reports || []).filter((r) => r.projectID === p.id);
      const isFinalized = p.status === "completed"
        || projectReports.some((r) => r.isFinalized === true || r?.payload?.isFinalized === true);
      return {
        id: p.id,
        name: p.projectName || "Projet",
        // Ligne de produit : un constat ne doit apparaître dans aucun
        // compteur, filtre ou export d'état des lieux.
        product: p.product || (p.inspectionType === "constat" ? "constat" : "edl"),
        // V6.5 — Renommage web : l'app iOS lit `nameCustom` pour savoir qu'un
        // nom a été défini côté dashboard et doit être adopté (cf. spec iOS).
        projectName: p.projectName || null,
        nameCustom: p.nameCustom === true,
        notes: p.notes || null,
        address: p.address || "-",
        status: isFinalized ? "completed" : (p.status || "in_progress"),
        isFinalized,
        updatedAt: p.updatedAt || nowIso(),
        createdAt: p.createdAt || nowIso(),
        // V5 — Champs d'organisation projet exposés au top-level.
        isArchived: p.isArchived === true,
        archivedAt: p.archivedAt || null,
        scheduledAt: p.scheduledAt || null,
        propertyImageFileName: p.propertyImageFileName || null,
        // Action admin en attente : l'app la lit ici, l'applique une fois,
        // puis l'acquitte (sans ces deux champs, elle ne la voyait jamais).
        adminAction: p.adminAction || null,
        adminActionID: p.adminActionID || null,
        // Métadonnées résumées pour affichage list.
        tenantName: p.tenantName || null,
        tenantEmail: p.tenantEmail || null,
        landlordName: p.landlordName || null,
        inspectionType: p.inspectionType || null,
        // V5.3.47 — Champs métier étendus partagés avec l'app iOS.
        ...draftBusinessFieldsShape(p),
      };
    });

  res.json({ ok: true, items });
});

// GET /projects/:projectId/exports — RÉCONCILIATION (spec iOS juillet 2026).
// Retourne la liste des fichiers RÉELLEMENT reçus pour un projet (sizeBytes > 0
// uniquement, on exclut les anciennes cases vides). L'app compare cette liste à
// ses fichiers locaux et ne renvoie QUE ce qui manque → pas de doublons.
app.get("/projects/:projectId/exports", requireCurrentUser, (req, res) => {
  const user = req._user;
  const projectId = String(req.params.projectId || "").trim();
  if (!projectId) {
    return res.status(400).json({ ok: false, detail: "Invalid projectId" });
  }
  const store = req._store;
  const exportsList = (store.exports || [])
    .filter((e) =>
      e.userID === user.id
      && (e.projectID === projectId || e.extractedProjectID === projectId)
      && (e.sizeBytes || 0) > 0   // fichiers confirmés uniquement
    )
    .map((e) => ({
      id: e.id,
      fileName: e.fileName || null,
      kind: e.kind || null,
      sizeBytes: e.sizeBytes || 0,
      contentHash: e.contentHash || null,  // permet à l'app de dédupliquer
      createdAt: e.createdAt || e.createdAtDb || null,
    }));
  // Tableau vide (pas 404) si rien de confirmé.
  res.json({ ok: true, exports: exportsList });
});

// V5 — Détail complet d'un projet incluant son report (utile pour le
// mobile pour reconstituer entièrement un projet créé / modifié depuis
// le dashboard).
app.get("/projects/:id", requireCurrentUser, (req, res) => {
  const user = req._user;
  try {
    // Lecture TOUJOURS autorisée : un compte bloqué doit continuer à
    // consulter et exporter les EDL qu'il a déjà réalisés. Seule la
    // CRÉATION d'un nouvel EDL est soumise au quota d'essai.
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
/**
 * Efface un fichier d'export, si et seulement s'il est bien rangé sous le
 * dossier du propriétaire.
 *
 * Le chemin vient de la base, pas de la requête — mais une entrée corrompue
 * ou une migration bancale suffirait à faire pointer `diskPath` ailleurs. On
 * vérifie donc l'appartenance avant chaque suppression : le coût est nul, et
 * l'erreur qu'il évite serait irréparable.
 */
function unlinkOwnedExportFile(diskPath, userID) {
  if (!diskPath) return false;
  const root = path.resolve(settings.exportFilesDir, userID);
  const target = path.resolve(diskPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    console.warn(`[/projects/:id DELETE] chemin hors périmètre, ignoré : ${diskPath}`);
    return false;
  }
  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch (e) {
    console.warn(`[/projects/:id DELETE] suppression impossible ${diskPath}: ${e.message}`);
    return false;
  }
}

/** Retire les dossiers devenus vides, du plus profond vers la racine. */
function pruneEmptyDirs(dir, stopAt) {
  let cur = path.resolve(dir);
  const root = path.resolve(stopAt);
  while (cur !== root && cur.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(cur).length > 0) return;
      fs.rmdirSync(cur);
    } catch (_) { return; }
    cur = path.dirname(cur);
  }
}

app.delete("/projects/:id", requireCurrentUser, async (req, res, next) => {
  const user = req._user;
  const projectID = req.params.id;

  try {
    let deletedProjects = 0;
    let deletedReports = 0;
    let deletedExports = 0;
    /** @type {{diskPath: string|null, reportID: string|null}[]} */
    const toUnlink = [];

    // Écriture atomique : une suppression concurrente d'un autre onglet ne
    // doit pas ressusciter le projet qu'on efface.
    await mutateStore((fresh) => {
      const beforeP = (fresh.projects || []).length;
      fresh.projects = (fresh.projects || []).filter(
        (p) => !(p.id === projectID && p.userID === user.id)
      );
      deletedProjects = beforeP - fresh.projects.length;

      const beforeR = (fresh.reports || []).length;
      fresh.reports = (fresh.reports || []).filter(
        (r) => !(r.projectID === projectID && r.userID === user.id)
      );
      deletedReports = beforeR - fresh.reports.length;

      const beforeE = (fresh.exports || []).length;
      const kept = [];
      for (const e of fresh.exports || []) {
        if (e.projectID === projectID && e.userID === user.id) {
          toUnlink.push({ diskPath: e.diskPath || null, reportID: e.reportID || null });
        } else {
          kept.push(e);
        }
      }
      fresh.exports = kept;
      deletedExports = beforeE - kept.length;
    });

    // Les octets, ensuite. Jusqu'ici la suppression ne retirait que les
    // lignes de la base : les fichiers restaient sur le disque. Pour un
    // constat c'est une fuite de plusieurs centaines de Mo par acte (l'audio
    // brut pèse ~5,6 Mo la minute) — et, surtout, une demande d'effacement
    // qui n'efface rien.
    let unlinked = 0;
    const reportIDs = new Set();
    for (const { diskPath, reportID } of toUnlink) {
      if (unlinkOwnedExportFile(diskPath, user.id)) unlinked += 1;
      if (reportID) reportIDs.add(reportID);
      if (diskPath) pruneEmptyDirs(path.dirname(diskPath), path.join(settings.exportFilesDir, user.id));
    }

    // Le dossier d'un constat porte aussi son `meta.json`, qui n'est pas un
    // export : il faut le retirer explicitement, sinon la fiche survit à
    // l'acte qu'elle décrit.
    for (const rid of reportIDs) {
      const dir = path.join(settings.exportFilesDir, user.id, "constats", safeFileName(rid));
      if (!fs.existsSync(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        unlinked += 1;
      } catch (e) {
        console.warn(`[/projects/:id DELETE] dossier constat ${rid}: ${e.message}`);
      }
    }

    // Bundles extraits (photos d'un backup iOS dépaquetées côté serveur).
    const extractedDir = path.join(path.dirname(settings.dbPath), "projects", safeFileName(projectID));
    if (fs.existsSync(extractedDir)) {
      try { fs.rmSync(extractedDir, { recursive: true, force: true }); unlinked += 1; }
      catch (e) { console.warn(`[/projects/:id DELETE] bundle ${projectID}: ${e.message}`); }
    }

    console.log(
      `[/projects/:id DELETE] user=${user.id} project=${projectID} ` +
      `exports=${deletedExports} fichiers=${unlinked}`
    );

    res.json({
      ok: true,
      deleted: {
        projects: deletedProjects,
        reports: deletedReports,
        exports: deletedExports,
        files: unlinked,
      },
    });
  } catch (err) {
    return next(err);
  }
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
    // Renommage manuel depuis le web → marqué comme personnalisé pour ne plus
    // être écrasé par une re-sync iOS (cf. /inspections/sync).
    project.nameCustom = true;
  }
  if (typeof body.notes === "string") {
    // Notes / informations libres saisies depuis le dashboard (max 5000 car.).
    // Chaîne vide = efface. Préservées à travers les re-syncs iOS.
    project.notes = body.notes.slice(0, 5000);
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
    // Horodatage de l'édition web → sert au garde-fou anti-écrasement dans
    // /inspections/sync (une édition web récente n'est pas écrasée par un
    // sync app plus ancien).
    project.draftMetaEditedAt = nowIso();
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
    // Lecture TOUJOURS autorisée : un compte bloqué doit continuer à
    // consulter et exporter les EDL qu'il a déjà réalisés. Seule la
    // CRÉATION d'un nouvel EDL est soumise au quota d'essai.
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
      inspectionType: r.inspectionType || null,
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
    // Lecture TOUJOURS autorisée : un compte bloqué doit continuer à
    // consulter et exporter les EDL qu'il a déjà réalisés. Seule la
    // CRÉATION d'un nouvel EDL est soumise au quota d'essai.
  } catch (err) {
    return res.status(err.status || 403).json({ ok: false, detail: err.message });
  }

  res.json({ ok: true, items: [] });
});

// ─── ADMIN ROUTES ────────────────────────────────────────────────────────────

function requireAdminKey(req, res) {
  // V6.2 — Accepte deux modes d'auth admin :
  //   1) Bearer token JWT (session dashboard) avec role admin → users non techniques
  //   2) Legacy : header x-admin-key === ADMIN_SECRET_KEY (scripts CLI, monitoring externe)
  // L'un des deux suffit. On essaie Bearer d'abord (plus sûr, par-user).
  try {
    const token = authHeaderToken(req);
    if (token) {
      const payload = verifyJwt(token, settings.jwtSecret);
      if (payload && payload.type === "access") {
        const store = readStore();
        const user = findUserById(store, String(payload.sub || ""));
        if (user && isAdmin(user)) {
          // Hydrate req pour réutilisation downstream
          req._store = store;
          req._user = user;
          return true;
        }
      }
    }
  } catch (_) { /* Pas de Bearer valide → on essaie la clé secrète */ }

  const adminKey = process.env.ADMIN_SECRET_KEY || "";
  const provided = req.body?.adminKey || req.header("x-admin-key") || "";
  if (adminKey && provided === adminKey) return true;

  res.status(403).json({ ok: false, detail: "Réservé aux administrateurs FOXSCAN." });
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MESURE DE CONSOMMATION — store.usageEvents
// ─────────────────────────────────────────────────────────────────────────────
// Objectif : connaître le COÛT réel généré par chaque compte (marge par client).
// On s'appuie sur les jetons réellement facturés (`usage` renvoyé par l'API),
// pas sur une estimation au doigt mouillé.
//
// { id, userId, type, model, calls, inputTokens, outputTokens, costMicros, createdAt }

// Tarifs API en micro-euros par million de jetons (approx. USD→EUR ~0,92).
// Ajustables sans redéploiement via OPENAI_PRICES_JSON.
const MODEL_PRICES = (() => {
  try {
    if (process.env.OPENAI_PRICES_JSON) return JSON.parse(process.env.OPENAI_PRICES_JSON);
  } catch { /* format invalide → valeurs par défaut */ }
  return {
    "gpt-4o-mini": { in: 138_000, out: 552_000 },
    "gpt-4o": { in: 2_300_000, out: 9_200_000 },
    "gpt-4.1-mini": { in: 368_000, out: 1_472_000 },
    "gpt-4.1": { in: 1_840_000, out: 7_360_000 },
    // Modèle d'inventaire de l'app (logement meublé) : à raisonnement.
    "gpt-5": { in: 1_150_000, out: 9_200_000 },
  };
})();

function costMicrosFor(model, inputTokens, outputTokens) {
  const p = MODEL_PRICES[model] || MODEL_PRICES["gpt-4o-mini"];
  return Math.round(
    ((inputTokens || 0) * p.in + (outputTokens || 0) * p.out) / 1_000_000,
  );
}

/**
 * Enveloppe `callOpenAIResponses` d'un compteur : chaque appel est mesuré
 * (modèle, jetons, coût) sans rien changer au comportement.
 * @returns {{ call: Function, totals: object }}
 */
function meteredOpenAI() {
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, byModel: {} };
  const call = async (payload, timeoutMs) => {
    const json = await callOpenAIResponses(payload, timeoutMs);
    try {
      const model = payload?.model || "inconnu";
      const i = json?.usage?.input_tokens || 0;
      const o = json?.usage?.output_tokens || 0;
      const c = costMicrosFor(model, i, o);
      totals.calls += 1;
      totals.inputTokens += i;
      totals.outputTokens += o;
      totals.costMicros += c;
      totals.byModel[model] = (totals.byModel[model] || 0) + 1;
    } catch { /* la mesure ne doit jamais casser l'appel */ }
    return json;
  };
  return { call, totals };
}

/** Journalise la consommation d'un traitement. N'échoue jamais. */
async function recordUsage({ userId, type, totals }) {
  try {
    if (!totals || totals.calls === 0) return;
    const event = {
      id: `use_${crypto.randomBytes(5).toString("hex")}`,
      userId: userId || "",
      type,
      calls: totals.calls,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costMicros: totals.costMicros,
      byModel: totals.byModel,
      createdAt: nowIso(),
    };
    await mutateStore((fresh) => {
      fresh.usageEvents = fresh.usageEvents || [];
      fresh.usageEvents.push(event);
    });
  } catch (e) {
    console.error("[usage] enregistrement échoué :", e.message);
  }
}

/**
 * Garde SUPERADMIN — pour les données business (achats/CA), la gestion des
 * organisations et l'attribution des rôles. Un admin support n'y a pas accès.
 * La clé secrète CLI reste acceptée (scripts d'exploitation).
 */
function requireSuperAdminKey(req, res) {
  if (!requireAdminKey(req, res)) return false; // a déjà répondu 401/403
  // requireAdminKey hydrate req._user quand l'auth passe par un Bearer.
  // Pas de _user ⇒ authentification par clé secrète CLI ⇒ rang maximal.
  if (!req._user || isSuperAdmin(req._user)) return true;
  res.status(403).json({
    ok: false,
    detail: "Réservé au super administrateur.",
  });
  return false;
}

// ─── A2 — /admin/metrics ────────────────────────────────────────────────────
// Renvoie un snapshot consolidé des métriques business pour l'onglet Overview.
// Combine :
//   - Local : users, founders, EDL finalisés (depuis store.json)
//   - Stripe live : MRR/ARR/churn depuis l'API Stripe (si STRIPE_SECRET_KEY)
//   - Fallback local : si Stripe indispo, calcule MRR depuis les
//     subscriptions stockées localement (subscriptionPriceCents).
//
// Toujours sûr : ne plante jamais — si Stripe timeout/erreur, on retourne
// quand même les métriques locales avec stripe.ok = false + message.
app.get("/admin/metrics", async (req, res) => {
  if (!requireAdminKey(req, res)) return;

  const store = readStore();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Helper : count items créés dans un intervalle
  const countSince = (items, dateField, sinceMs) => {
    return items.filter((it) => {
      const t = new Date(it?.[dateField] || 0).getTime();
      return t >= sinceMs && t <= now;
    }).length;
  };

  // ── USERS ────────────────────────────────────────────────────────
  const users = store.users || [];
  const usersBlock = {
    total: users.length,
    active: users.filter((u) => u.subscriptionActive === true || u.subscriptionStatus === "active").length,
    inactive: users.filter((u) => !(u.subscriptionActive === true || u.subscriptionStatus === "active")).length,
    newToday: countSince(users, "createdAt", now - dayMs),
    newThisWeek: countSince(users, "createdAt", now - 7 * dayMs),
    newThisMonth: countSince(users, "createdAt", now - 30 * dayMs),
  };

  // ── FOUNDERS ────────────────────────────────────────────────────
  const founders = store.founders || [];
  const SLOTS_TOTAL = 20;
  const convertedCount = founders.filter((f) => f.status === "converted").length;
  const pendingCount = founders.filter((f) => f.status === "pending").length;
  const foundersBlock = {
    total: founders.length,
    pending: pendingCount,
    contacted: founders.filter((f) => f.status === "contacted").length,
    converted: convertedCount,
    cancelled: founders.filter((f) => f.status === "cancelled").length,
    slotsTotal: SLOTS_TOTAL,
    slotsTaken: convertedCount + pendingCount, // les pending réservent une place
    slotsRemaining: Math.max(0, SLOTS_TOTAL - (convertedCount + pendingCount)),
  };

  // ── EDL FINALISÉS ────────────────────────────────────────────────
  // Source : store.reports[].payload.isFinalized OR store.reports[].isFinalized
  const reports = store.reports || [];
  const isReportFinalized = (r) =>
    r?.isFinalized === true || r?.payload?.isFinalized === true;
  const finalizedReports = reports.filter(isReportFinalized);
  const finalizedDate = (r) =>
    r?.finalizedAt || r?.payload?.finalizedAt || r?.updatedAt || r?.createdAt;
  const finalizedBlock = {
    total: finalizedReports.length,
    today: finalizedReports.filter(
      (r) => new Date(finalizedDate(r) || 0).getTime() >= now - dayMs
    ).length,
    thisWeek: finalizedReports.filter(
      (r) => new Date(finalizedDate(r) || 0).getTime() >= now - 7 * dayMs
    ).length,
    thisMonth: finalizedReports.filter(
      (r) => new Date(finalizedDate(r) || 0).getTime() >= now - 30 * dayMs
    ).length,
  };

  // ── REVENUE — Stripe d'abord, fallback local ────────────────────
  let revenue = {
    source: "local-fallback",
    mrrCents: 0,
    mrrCurrency: "EUR",
    arrCents: 0,
    activeSubscriptions: 0,
    lifetimePaymentsCount: 0,
    lifetimePaymentsTotalCents: 0,
    churnedLast30Days: 0,
  };
  let stripeStatus = { ok: false, error: null };

  if (stripe) {
    try {
      // Liste TOUTES les subscriptions actives (pagination simple)
      const allActive = [];
      let starting_after = null;
      for (let pass = 0; pass < 10; pass++) { // safety : max 1000 subs
        const params = { status: "active", limit: 100 };
        if (starting_after) params.starting_after = starting_after;
        const list = await stripe.subscriptions.list(params);
        allActive.push(...list.data);
        if (!list.has_more) break;
        starting_after = list.data[list.data.length - 1]?.id;
        if (!starting_after) break;
      }

      // Calcul MRR : pour chaque sub, on somme les unit_amount × quantity sur tous les items
      let mrr = 0;
      for (const sub of allActive) {
        for (const item of sub.items.data) {
          const price = item.price;
          if (!price) continue;
          const qty = item.quantity || 1;
          const amount = price.unit_amount || 0;
          // Normaliser tous les intervals en mensuel
          let monthlyMultiplier = 1;
          if (price.recurring?.interval === "year") monthlyMultiplier = 1 / 12;
          else if (price.recurring?.interval === "week") monthlyMultiplier = 4.33;
          else if (price.recurring?.interval === "day") monthlyMultiplier = 30;
          mrr += amount * qty * monthlyMultiplier;
        }
      }

      // Churn 30j : subscriptions canceled dans les 30 derniers jours
      const canceledList = await stripe.subscriptions.list({
        status: "canceled",
        limit: 100,
      });
      const churnedLast30 = canceledList.data.filter((s) => {
        const ts = (s.canceled_at || s.ended_at || 0) * 1000;
        return ts >= now - 30 * dayMs;
      }).length;

      // Paiements lifetime (Founders) — checkout sessions completées en one-time
      const paymentsList = await stripe.checkout.sessions.list({ limit: 100 });
      const lifetimePayments = paymentsList.data.filter(
        (s) => s.payment_status === "paid" && s.mode === "payment"
      );
      const lifetimeTotal = lifetimePayments.reduce(
        (acc, s) => acc + (s.amount_total || 0),
        0
      );

      revenue = {
        source: "stripe",
        mrrCents: Math.round(mrr),
        mrrCurrency: "EUR",
        arrCents: Math.round(mrr * 12),
        activeSubscriptions: allActive.length,
        lifetimePaymentsCount: lifetimePayments.length,
        lifetimePaymentsTotalCents: lifetimeTotal,
        churnedLast30Days: churnedLast30,
      };
      stripeStatus = { ok: true, error: null };
    } catch (err) {
      console.error("[admin/metrics] Stripe API failed:", err.message);
      stripeStatus = { ok: false, error: err.message };
      // → on tombe dans le fallback local ci-dessous
    }
  } else {
    stripeStatus = { ok: false, error: "STRIPE_SECRET_KEY absente" };
  }

  // Fallback local si Stripe a échoué : utilise les champs stockés sur user
  if (revenue.source !== "stripe") {
    const activeUsers = users.filter(
      (u) => u.subscriptionActive === true || u.subscriptionStatus === "active"
    );
    const localMrrCents = activeUsers.reduce((acc, u) => {
      return acc + (Number(u.subscriptionPriceCents) || 0);
    }, 0);
    const lifetimeFounders = founders.filter((f) => f.status === "converted");
    revenue = {
      source: "local-fallback",
      mrrCents: localMrrCents,
      mrrCurrency: "EUR",
      arrCents: localMrrCents * 12,
      activeSubscriptions: activeUsers.length,
      lifetimePaymentsCount: lifetimeFounders.length,
      lifetimePaymentsTotalCents: lifetimeFounders.length * 20000, // 200€ x N
      churnedLast30Days: 0, // pas calculable depuis le store local
    };
  }

  res.json({
    ok: true,
    timestamp: nowIso(),
    users: usersBlock,
    founders: foundersBlock,
    edl: finalizedBlock,
    revenue,
    stripe: stripeStatus,
  });
});

// ─── A3 — /admin/audit ──────────────────────────────────────────────────────
// Liste les events stockés dans store.auditEvents[] avec pagination + filtres.
//
// Query params :
//   - type : filtre exact (ex: "auth.password.reset.completed")
//   - userID : filtre par utilisateur
//   - since : ISO date début
//   - limit : max items retournés (défaut 200, max 1000)
//
// Enrichit chaque event avec l'email de l'user (pour affichage humain) si
// disponible — réduit le nombre de lookups côté frontend.
// ─── Suivi des achats (admin) ───────────────────────────────────────────────
// Liste les paiements journalisés par le webhook Stripe + agrégats pour
// l'écran « Achats ». Filtres : type, status, email, since.
app.get("/admin/payments", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;

  const store = readStore();
  const all = Array.isArray(store.payments) ? store.payments : [];

  const typeFilter = String(req.query.type || "").trim();
  const statusFilter = String(req.query.status || "").trim();
  const emailFilter = String(req.query.email || "").trim().toLowerCase();
  const since = String(req.query.since || "").trim();
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit || "500", 10)));

  let filtered = all;
  if (typeFilter) filtered = filtered.filter((p) => p.type === typeFilter);
  if (statusFilter) filtered = filtered.filter((p) => p.status === statusFilter);
  if (emailFilter) {
    filtered = filtered.filter((p) => String(p.email || "").toLowerCase().includes(emailFilter));
  }
  if (since) {
    const sinceMs = new Date(since).getTime();
    if (!isNaN(sinceMs)) {
      filtered = filtered.filter((p) => new Date(p.createdAt || 0).getTime() >= sinceMs);
    }
  }

  filtered = filtered
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  // Agrégats calculés sur les paiements encaissés uniquement.
  const paid = all.filter((p) => p.status === "paid");
  const sum = (arr) => arr.reduce((s, p) => s + (p.amountCents || 0), 0);
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const paidThisMonth = paid.filter(
    (p) => new Date(p.createdAt || 0).getTime() >= startOfMonth.getTime(),
  );

  res.json({
    ok: true,
    payments: filtered.slice(0, limit),
    totals: {
      count: all.length,
      paidCount: paid.length,
      revenueCents: sum(paid),
      revenueThisMonthCents: sum(paidThisMonth),
      foundersCount: paid.filter((p) => p.type === "founders").length,
      subscriptionCount: paid.filter((p) => p.type === "subscription").length,
      failedCount: all.filter((p) => p.status === "failed").length,
      canceledCount: all.filter((p) => p.status === "canceled").length,
    },
  });
});

app.get("/admin/audit", (req, res) => {
  if (!requireAdminKey(req, res)) return;

  const store = readStore();
  const events = store.auditEvents || [];

  // Filtres optionnels
  const typeFilter = String(req.query.type || "").trim();
  const userFilter = String(req.query.userID || "").trim();
  const since = String(req.query.since || "").trim();
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || "200", 10)));

  // Index users pour enrichissement
  const userByID = new Map((store.users || []).map((u) => [u.id, u]));

  let filtered = events;
  if (typeFilter) filtered = filtered.filter((e) => e.type === typeFilter);
  if (userFilter) filtered = filtered.filter((e) => e.userID === userFilter);
  if (since) {
    const sinceMs = new Date(since).getTime();
    if (!isNaN(sinceMs)) {
      filtered = filtered.filter((e) => new Date(e.createdAt || 0).getTime() >= sinceMs);
    }
  }

  // Tri décroissant par date (plus récent en haut)
  filtered.sort((a, b) =>
    new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );

  const items = filtered.slice(0, limit).map((e) => {
    const user = userByID.get(e.userID);
    return {
      id: e.id,
      type: e.type,
      userID: e.userID || null,
      userEmail: user?.email || null,
      userName: user?.name || null,
      createdAt: e.createdAt,
      payload: e.payload || {},
    };
  });

  // Stats agrégées pour faciliter l'analyse côté frontend
  const typeCounts = {};
  for (const e of events) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }

  res.json({
    ok: true,
    items,
    total: filtered.length,
    totalAll: events.length,
    typeCounts,
  });
});

// GET /admin/deleted-accounts — comptes supprimés, vus à travers ce que la loi
// autorise à conserver. Les fiches sans `billing` sont anonymes : aucun nom,
// aucun email, seulement des compteurs et un coût.
app.get("/admin/deleted-accounts", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  const items = (store.deletedAccounts || [])
    .slice()
    .sort((a, b) => String(b.deletedAt || "").localeCompare(String(a.deletedAt || "")));

  const totals = items.reduce(
    (acc, r) => {
      acc.edl += r.edlCount || 0;
      acc.costMicros += r.costMicros || 0;
      acc.nominatifs += r.billing ? 1 : 0;
      return acc;
    },
    { edl: 0, costMicros: 0, nominatifs: 0 },
  );

  res.json({ ok: true, items, total: items.length, totals });
});

app.get("/admin/users", (req, res) => {
  // V6.4.8 — Utilise requireAdminKey (accepte Bearer admin OU x-admin-key)
  // au lieu de l'ancienne vérif inline qui ne reconnaissait que la clé CLI.
  if (!requireAdminKey(req, res)) return;

  const store = readStore();
  const teamsById = new Map((store.teams || []).map((t) => [t.id, t]));
  const users = store.users.map((u) => {
    const team = u.teamId ? teamsById.get(u.teamId) : null;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      authProvider: u.authProvider || "apple",
      role: u.role || "user",                    // V6.4.8 — exposé pour le filtre admin
      suspended: u.suspended === true,           // V6.4.8 — exposé pour le filtre
      // `store` est indispensable : sans lui le quota d'EDL n'est pas évalué
      // et un compte bloqué par ses 3 EDL s'affichait encore « trial ».
      subscriptionActive: isAccessActive(u, store),
      accessStatus: computeAccessStatus(u, store),
      foundersAccount: u.foundersAccount === true,
      trialEndsAt: u.trialEndsAt || null,
      trialDaysRemaining: trialDaysRemaining(u),
      // L'essai s'arrête à la PREMIÈRE limite atteinte : les jours restants
      // ne suffisent pas à le décrire, il faut aussi la consommation d'EDL.
      trialEdlUsed: trialEdlUsed(store, u),
      trialEdlLimit: TRIAL_MAX_EDL,
      // Segmentation produit : agences (EDL + scan 3D) vs commissaires de
      // justice (constat). Voir productProfile().
      product: productProfile(store, u),
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

// V5.3.2 — Migration one-shot : nettoie les anciens placeholders d'adresse
// dans store.projects[]. Pour chaque projet dont `proj.address` est une
// valeur placeholder ("Adresse synchronisée depuis iOS", etc.), on tente
// de reconstituer la vraie adresse depuis `payload.report.address` +
// addressComplement + postalCode + city. Si impossible (report vide),
// on met "(adresse à renseigner)" pour signaler à l'agent.
//
// À lancer 1 fois après déploiement V5.3.2 :
//   curl -H "x-admin-key: $KEY" https://foxscan.fr/admin/cleanup-placeholders
app.get("/admin/cleanup-placeholders", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  let updated = 0;
  let unrecoverable = 0;

  for (const proj of (store.projects || [])) {
    // V5.3.4 — Le check pollué couvre TOUS les cas (placeholder pur,
    // placeholder concaténé, duplication ville). Idempotent.
    if (!isPollutedAddress(proj.address)) continue;

    const report = proj.payload?.report || {};
    // Nettoie aussi report.address si polluée pour ne pas la re-pousser
    // au prochain sync iPhone (qui réécrirait proj.address en boucle).
    if (typeof report.address === "string" && isPollutedAddress(report.address)) {
      report.address = "";
    }
    const rebuilt = rebuildAddressFromReport(report);

    if (rebuilt && rebuilt.length >= 5) {
      proj.address = rebuilt;
      proj.updatedAt = nowIso();
      proj.updatedAtDb = nowIso();
      updated++;
    } else {
      proj.address = "(adresse à renseigner)";
      proj.updatedAt = nowIso();
      proj.updatedAtDb = nowIso();
      unrecoverable++;
    }
  }

  if (updated + unrecoverable > 0) {
    writeStore(store);
  }

  res.json({
    ok: true,
    summary: {
      totalProjects: (store.projects || []).length,
      placeholdersRecovered: updated,
      placeholdersResetToBlank: unrecoverable,
    },
  });
});

app.patch("/admin/users/:userId/subscription", async (req, res) => {
  const body = req.body || {};
  if (!requireAdminKey(req, res)) return;

  if (typeof body.subscriptionActive !== "boolean") {
    return res.status(400).json({ ok: false, detail: "subscriptionActive (boolean) is required" });
  }

  // Écriture atomique — voir PATCH /admin/users/:userId.
  let out = null;
  await mutateStore((store) => {
    const user = (store.users || []).find((u) => u.id === req.params.userId);
    if (!user) { out = { notFound: true }; return; }

    // `adminActivated` est la preuve exigée par computeAccessStatus : sans
    // elle, `subscriptionStatus` seul n'accorde aucun accès.
    user.adminActivated = body.subscriptionActive === true;
    if (body.subscriptionActive) {
      user.subscriptionStatus = "active";
    } else if (!user.stripeSubscriptionId) {
      // Retirer une activation manuelle ne doit pas couper un abonnement
      // Stripe réel : dans ce cas Stripe fait foi.
      user.subscriptionStatus = "inactive";
    }
    user.updatedAt = nowIso();
    out = {
      id: user.id,
      subscriptionActive: isAccessActive(user, store),
      detail: accessDetail(user, store),
    };
  });

  if (!out) return res.status(500).json({ ok: false, detail: "Écriture impossible" });
  if (out.notFound) return res.status(404).json({ ok: false, detail: "User not found" });
  res.json({ ok: true, id: out.id, subscriptionActive: out.subscriptionActive, ...out.detail });
});

// ═══════════════════════════════════════════════════════════════════════════
// V6.2 — ADMIN USER MANAGEMENT (suspend, role, lifetime, delete, detail)
// ═══════════════════════════════════════════════════════════════════════════
// Tous protégés par requireAdminKey (qui accepte Bearer admin OU x-admin-key).
// Le dashboard utilise le Bearer JWT, les scripts CLI utilisent la clé.

// GET /admin/users/:userId — détail enrichi d'un user (avec stats + audit)
/**
 * Ce qu'une personne — ou une organisation — paie, et ce qu'elle a consommé.
 *
 * Rassemble les trois sources que l'écran devait sinon recouper à la main :
 * l'abonnement (statut, prix, Stripe), les factures émises, et la
 * consommation d'analyses réellement mesurée.
 */
function billingFor(store, { userIds, teamId, clientName }) {
  const ids = new Set(userIds || []);

  let calls = 0, costMicros = 0, costMicrosThisMonth = 0;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();
  for (const e of store.usageEvents || []) {
    if (!ids.has(e.userId || e.userID)) continue;
    calls += e.calls || 0;
    costMicros += e.costMicros || 0;
    if (new Date(e.createdAt || 0).getTime() >= monthStart) costMicrosThisMonth += e.costMicros || 0;
  }

  // Une facture se rattache par l'organisation si on la connaît, sinon par le
  // nom saisi : les deux cas existent, un client peut être facturé sans équipe.
  const wanted = String(clientName || "").trim().toLowerCase();
  const invoices = (store.invoices || [])
    .filter((i) => (teamId && i.client?.teamId === teamId)
                || (wanted && String(i.client?.name || "").trim().toLowerCase() === wanted))
    .sort((a, b) => String(b.issuedAt || "").localeCompare(String(a.issuedAt || "")))
    .map((i) => ({
      id: i.id, number: i.number, issuedAt: i.issuedAt, dueAt: i.dueAt,
      totalEur: i.totalEur, status: i.status, kind: i.kind,
    }));

  const billedCents = invoices.filter((i) => i.kind !== "creditNote")
    .reduce((n, i) => n + Math.round((i.totalEur || 0) * 100), 0);
  const paidCents = invoices.filter((i) => i.status === "paid")
    .reduce((n, i) => n + Math.round((i.totalEur || 0) * 100), 0);

  return {
    analyses: {
      calls,
      costEur: Math.round(costMicros / 10000) / 100,
      costThisMonthEur: Math.round(costMicrosThisMonth / 10000) / 100,
      // Le dire plutôt que de laisser croire à une consommation nulle.
      measured: calls > 0,
    },
    invoices,
    totals: {
      billedEur: billedCents / 100,
      paidEur: paidCents / 100,
      outstandingEur: (billedCents - paidCents) / 100,
    },
  };
}

/**
 * Le parcours, dans l'ordre. Ce que l'écran « fiche » doit raconter :
 * d'où vient la personne, où elle en est, et ce qui a bougé en dernier.
 */
function journeyFor(store, users) {
  const list = Array.isArray(users) ? users : [users];
  const ids = new Set(list.map((u) => u.id));
  const ev = [];
  const push = (at, label, detail) => { if (at) ev.push({ at, label, detail: detail || null }); };

  for (const u of list) {
    const who = list.length > 1 ? (u.name || u.email || u.id) : null;
    push(u.createdAt, "Inscription", [who, u.authProvider].filter(Boolean).join(" · ") || null);
    push(u.trialEndsAt, "Fin de l'essai gratuit", who);
    if (u.subscriptionStatus === "active" || u.stripeSubscriptionId) {
      push(u.subscriptionActivatedAt || u.updatedAt, "Abonnement actif",
           [who, u.stripeSubscriptionId ? "Stripe" : "activé à la main"].filter(Boolean).join(" · "));
    }
    push(u.lastLoginAt, "Dernière connexion", who);
  }

  const mine = (store.exports || []).filter((e) => ids.has(e.userID))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  if (mine.length) {
    push(mine[0].createdAt, "Premier document produit", mine[0].fileName || null);
    if (mine.length > 1) {
      push(mine[mine.length - 1].createdAt, "Dernier document produit",
           `${mine.length} au total`);
    }
  }

  for (const i of store.invoices || []) {
    const match = list.some((u) => u.teamId && i.client?.teamId === u.teamId);
    if (match) push(i.issuedAt, `Facture ${i.number}`, `${i.totalEur} € · ${i.status === "paid" ? "payée" : "en attente"}`);
  }

  return ev
    .filter((e) => !Number.isNaN(new Date(e.at).getTime()))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 40);
}

// GET /admin/teams/:id — la fiche d'une organisation.
app.get("/admin/teams/:id", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
  const store = readStore();
  const team = (store.teams || []).find((t) => t.id === req.params.id);
  if (!team) return res.status(404).json({ ok: false, detail: "Organisation introuvable" });

  const members = (store.users || []).filter((u) => u.teamId === team.id);
  res.json({
    ok: true,
    team: teamSummary(team, store.users, store),
    billing: billingFor(store, {
      userIds: members.map((u) => u.id),
      teamId: team.id,
      clientName: team.name,
    }),
    journey: journeyFor(store, members),
  });
});

app.get("/admin/users/:userId", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  const user = (store.users || []).find((u) => u.id === req.params.userId);
  if (!user) return res.status(404).json({ ok: false, detail: "User not found" });

  // Compteurs cross-collections
  const draftsCount = (store.drafts || []).filter((d) => d.userID === user.id).length;
  const projectsCount = (store.projects || []).filter((p) => p.userID === user.id).length;
  const reportsCount = (store.reports || []).filter((r) => r.userID === user.id).length;
  const exportsCount = (store.exports || []).filter((e) => e.userID === user.id).length;
  const activeRefreshTokens = (store.refreshTokens || []).filter(
    (t) => t.userID === user.id && new Date(t.expiresAt || 0).getTime() > Date.now()
  ).length;

  // Audit events triés desc + limités à 50
  const recentAudit = (store.auditEvents || [])
    .filter((e) => e.userID === user.id || e.actor === user.id)
    .sort((a, b) => String(b.ts || b.timestamp || "").localeCompare(String(a.ts || a.timestamp || "")))
    .slice(0, 50);

  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      authProvider: user.authProvider || "unknown",
      role: user.role || "user",
      suspended: user.suspended === true,
      foundersAccount: user.foundersAccount === true,
      subscriptionStatus: user.subscriptionStatus || "inactive",
      subscriptionPriceCents: user.subscriptionPriceCents || null,
      stripeCustomerId: user.stripeCustomerId || null,
      stripeSubscriptionId: user.stripeSubscriptionId || null,
      trialEndsAt: user.trialEndsAt || null,
      trialDaysRemaining: trialDaysRemaining(user),
      accessStatus: computeAccessStatus(user),
      teamId: user.teamId || null,
      agencyID: user.agencyID || null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt || null,
    },
    counts: {
      drafts: draftsCount,
      projects: projectsCount,
      reports: reportsCount,
      exports: exportsCount,
      activeRefreshTokens,
    },
    // Ce qu'il paie et ce qu'il a consommé — la question qu'on se pose en
    // ouvrant une fiche, et qui obligeait jusqu'ici à croiser trois écrans.
    billing: billingFor(store, {
      userIds: [user.id],
      teamId: user.teamId || null,
      clientName: (store.teams || []).find((t) => t.id === user.teamId)?.name || null,
    }),
    usage: userUsage(store, user.id),
    product: productProfile(store, user),
    journey: journeyFor(store, user),
    team: user.teamId
      ? (() => {
          const t = (store.teams || []).find((x) => x.id === user.teamId);
          return t ? { id: t.id, name: t.name } : null;
        })()
      : null,
    recentAudit,
  });
});

// PATCH /admin/users/:userId — modifications génériques (role, suspended, founders…)
app.patch("/admin/users/:userId", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const body = req.body || {};

  // Écriture atomique. `readStore` + `writeStore` laissait une fenêtre pendant
  // laquelle une écriture concurrente (synchro d'un iPhone, rafraîchissement de
  // session) était silencieusement écrasée — la cause des déconnexions passées.
  let out = null;
  await mutateStore((store) => {
    const user = (store.users || []).find((u) => u.id === req.params.userId);
    if (!user) { out = { notFound: true }; return; }

    const changes = [];

    // role : "user" | "admin"
    if (typeof body.role === "string" && ["user", "admin"].includes(body.role)) {
      if (user.role !== body.role) {
        changes.push(`role: ${user.role || "user"} → ${body.role}`);
        user.role = body.role;
      }
    }
    // suspended : true/false
    if (typeof body.suspended === "boolean") {
      if (user.suspended !== body.suspended) {
        changes.push(`suspended: ${user.suspended === true} → ${body.suspended}`);
        user.suspended = body.suspended;
        // Si on suspend : invalider tous les refresh tokens
        if (body.suspended === true) {
          const before = (store.refreshTokens || []).length;
          store.refreshTokens = (store.refreshTokens || []).filter((t) => t.userID !== user.id);
          changes.push(`refreshTokens purgés: ${before - store.refreshTokens.length}`);
        }
      }
    }
    // foundersAccount : lifetime access
    if (typeof body.foundersAccount === "boolean") {
      if (user.foundersAccount !== body.foundersAccount) {
        changes.push(`foundersAccount: ${user.foundersAccount === true} → ${body.foundersAccount}`);
        user.foundersAccount = body.foundersAccount;
      }
    }
    // product : ligne de produit d'origine — « edl » (agences) ou « constat »
    // (commissaires de justice). Donnée d'acquisition : on la pose à la main
    // quand l'inscription ne l'a pas portée, et elle ne bouge plus ensuite.
    if (typeof body.product === "string" || body.product === null) {
      const next = body.product === null ? null : String(body.product).trim();
      if (next === null || PRODUCTS.has(next)) {
        if ((user.product || null) !== next) {
          changes.push(`product: ${user.product || "non défini"} → ${next || "non défini"}`);
          if (next) user.product = next;
          else delete user.product;
        }
      }
    }
    // subscriptionActive : activation manuelle par un admin.
    // ⚠️ Les DEUX champs sont nécessaires : `computeAccessStatus` exige
    // `adminActivated` comme preuve explicite, `subscriptionStatus` seul
    // n'accorde aucun accès (il est écrit par des chemins non fiables).
    if (typeof body.subscriptionActive === "boolean") {
      const before = user.subscriptionStatus === "active" && user.adminActivated === true;
      if (before !== body.subscriptionActive) {
        changes.push(`subscriptionActive: ${before} → ${body.subscriptionActive}`);
        user.adminActivated = body.subscriptionActive === true;
        if (body.subscriptionActive) {
          user.subscriptionStatus = "active";
        } else if (!user.stripeSubscriptionId) {
          // Retirer une activation manuelle ne doit pas couper un abonnement
          // Stripe réel : dans ce cas on laisse Stripe faire foi.
          user.subscriptionStatus = "inactive";
        }
      }
    }
    // trialEndsAt : extend/reset trial
    if (typeof body.trialEndsAt === "string" || body.trialEndsAt === null) {
      if (body.trialEndsAt === null || /^\d{4}-\d{2}-\d{2}T/.test(body.trialEndsAt)) {
        changes.push(`trialEndsAt: ${user.trialEndsAt || "null"} → ${body.trialEndsAt || "null"}`);
        user.trialEndsAt = body.trialEndsAt;
      }
    }
    // name / email rarely changed by admin but possible
    if (typeof body.name === "string" && body.name.trim() && body.name !== user.name) {
      changes.push(`name: ${user.name} → ${body.name}`);
      user.name = body.name.trim();
    }
    if (typeof body.email === "string" && body.email.trim() && body.email !== user.email) {
      changes.push(`email: ${user.email} → ${body.email}`);
      user.email = body.email.trim().toLowerCase();
    }

    if (changes.length === 0) {
      out = { changes: [] };
    return;
    }

    user.updatedAt = nowIso();
    // Audit
    if (!Array.isArray(store.auditEvents)) store.auditEvents = [];
    store.auditEvents.push({
      id: `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      ts: nowIso(),
      actor: req._user?.id || "admin-cli",
      actorEmail: req._user?.email || null,
      userID: user.id,
      action: "admin.user.patch",
      details: changes.join(" · "),
    });

    out = { changes, userId: user.id };
  });

  if (!out) return res.status(500).json({ ok: false, detail: "Écriture impossible" });
  if (out.notFound) return res.status(404).json({ ok: false, detail: "User not found" });
  if (out.changes.length === 0) {
    return res.json({ ok: true, changes: [], detail: "Aucun changement" });
  }
  res.json({ ok: true, changes: out.changes, userId: out.userId });
});

// DELETE /admin/users/:userId — supprime un user et toutes ses données associées
app.delete("/admin/users/:userId", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const confirm = req.query.confirm === "true" || req.body?.confirm === true;
  if (!confirm) {
    return res.status(400).json({
      ok: false,
      detail: "Suppression irréversible. Ajoutez ?confirm=true ou body { confirm: true }.",
    });
  }

  const store = readStore();
  const userIdx = (store.users || []).findIndex((u) => u.id === req.params.userId);
  if (userIdx === -1) return res.status(404).json({ ok: false, detail: "User not found" });
  const user = store.users[userIdx];

  // Empêche un admin de se supprimer lui-même
  if (req._user && req._user.id === user.id) {
    return res.status(400).json({ ok: false, detail: "Vous ne pouvez pas supprimer votre propre compte admin." });
  }

  // Archivage AVANT la cascade : les compteurs deviennent incalculables une
  // fois les lignes supprimées. Même règle que la suppression par
  // l'utilisateur — voir archiveDeletedAccount().
  const archiveId = archiveDeletedAccount(store, user);

  const stats = {
    drafts: 0, projects: 0, reports: 0, exports: 0, refreshTokens: 0,
  };

  // Cascade delete
  const filterOut = (arr, key = "userID") => {
    const before = arr.length;
    const after = arr.filter((x) => x[key] !== user.id);
    return { after, removed: before - after.length };
  };

  let r;
  r = filterOut(store.drafts || []);       store.drafts = r.after;       stats.drafts = r.removed;
  r = filterOut(store.projects || []);     store.projects = r.after;     stats.projects = r.removed;
  r = filterOut(store.reports || []);      store.reports = r.after;      stats.reports = r.removed;
  r = filterOut(store.exports || []);      store.exports = r.after;      stats.exports = r.removed;
  r = filterOut(store.refreshTokens || []); store.refreshTokens = r.after; stats.refreshTokens = r.removed;

  // Retire le user
  store.users.splice(userIdx, 1);
  stats.archiveId = archiveId;

  // Audit
  if (!Array.isArray(store.auditEvents)) store.auditEvents = [];
  store.auditEvents.push({
    id: `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    ts: nowIso(),
    actor: req._user?.id || "admin-cli",
    actorEmail: req._user?.email || null,
    userID: user.id,
    action: "admin.user.delete",
    details: `Suppression de ${user.email || user.id}. Cascade: ${JSON.stringify(stats)}`,
  });

  writeStore(store);

  res.json({
    ok: true,
    deleted: { id: user.id, email: user.email, name: user.name },
    cascade: stats,
  });
});

// POST /admin/users/:userId/extend-trial — étend le trial de N jours
app.post("/admin/users/:userId/extend-trial", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const days = Math.max(1, Math.min(365, Math.round(Number(req.body?.days) || 7)));
  const store = readStore();
  const user = (store.users || []).find((u) => u.id === req.params.userId);
  if (!user) return res.status(404).json({ ok: false, detail: "User not found" });

  const base = user.trialEndsAt && new Date(user.trialEndsAt).getTime() > Date.now()
    ? new Date(user.trialEndsAt)
    : new Date();
  base.setDate(base.getDate() + days);
  user.trialEndsAt = base.toISOString();
  user.updatedAt = nowIso();

  if (!Array.isArray(store.auditEvents)) store.auditEvents = [];
  store.auditEvents.push({
    id: `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    ts: nowIso(),
    actor: req._user?.id || "admin-cli",
    actorEmail: req._user?.email || null,
    userID: user.id,
    action: "admin.user.extend-trial",
    details: `+${days}j → ${user.trialEndsAt}`,
  });
  writeStore(store);

  res.json({
    ok: true,
    trialEndsAt: user.trialEndsAt,
    trialDaysRemaining: trialDaysRemaining(user),
  });
});

// GET /admin/health — métriques rapides pour le dashboard admin
app.get("/admin/health", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  const now = Date.now();

  const activeRT = (store.refreshTokens || []).filter(
    (t) => new Date(t.expiresAt || 0).getTime() > now
  ).length;

  // Backups disponibles
  let backups = [];
  try {
    const backupDir = path.join(path.dirname(settings.dbPath), "backups");
    if (fs.existsSync(backupDir)) {
      backups = fs.readdirSync(backupDir)
        .filter((f) => f.startsWith("store-") && f.endsWith(".json"))
        .map((f) => {
          const st = fs.statSync(path.join(backupDir, f));
          return { name: f, sizeKB: Math.round(st.size / 1024), mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
        .slice(0, 12);
    }
  } catch (_) { /* ignore */ }

  // Taille store.json
  let storeSizeKB = 0;
  try { storeSizeKB = Math.round(fs.statSync(settings.dbPath).size / 1024); } catch {}

  res.json({
    ok: true,
    storeSizeKB,
    counts: {
      users: (store.users || []).length,
      activeUsers: (store.users || []).filter((u) => isAccessActive(u) && !u.suspended).length,
      suspendedUsers: (store.users || []).filter((u) => u.suspended === true).length,
      foundersUsers: (store.users || []).filter((u) => u.foundersAccount === true).length,
      drafts: (store.drafts || []).length,
      projects: (store.projects || []).length,
      reports: (store.reports || []).length,
      exports: (store.exports || []).length,
      refreshTokensActive: activeRT,
      auditEvents: (store.auditEvents || []).length,
    },
    writeQueueLen: _writeQueueLen,
    backups,
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
// POST /billing/portal — ouvre le portail client Stripe (gérer/annuler
// l'abonnement, changer la carte, télécharger les factures). Réservé à
// l'utilisateur connecté, sur SON propre compte client Stripe.
app.post("/billing/portal", requireCurrentUser, express.json({ limit: "2kb" }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ ok: false, detail: "Stripe non configuré" });
  }
  const user = req._user;

  // Il faut un identifiant client Stripe. Il est posé par le webhook au
  // premier paiement ; un compte fondateur/historique peut ne pas en avoir.
  let customerId = user.stripeCustomerId || null;
  try {
    if (!customerId && user.email) {
      // Repli : on retrouve le client Stripe par email et on le mémorise.
      const found = await stripe.customers.list({ email: user.email, limit: 1 });
      customerId = found?.data?.[0]?.id || null;
      if (customerId) {
        await mutateStore((fresh) => {
          const u = (fresh.users || []).find((x) => x.id === user.id);
          if (u) { u.stripeCustomerId = customerId; u.updatedAt = nowIso(); }
        });
      }
    }
  } catch (e) {
    console.error("[billing/portal] recherche client Stripe:", e.message);
  }

  // Lien public du portail (page « login » où le client saisit son email).
  // Sert de filet : si on n'a pas de customerId, ou si la session API échoue,
  // on renvoie ce lien pour que le bouton fonctionne quand même.
  const loginUrl = process.env.STRIPE_PORTAL_LOGIN_URL || null;

  if (!customerId) {
    if (loginUrl) return res.json({ ok: true, url: loginUrl, mode: "login" });
    return res.status(404).json({
      ok: false,
      detail: "Aucun abonnement Stripe rattaché à ce compte.",
    });
  }

  try {
    const returnBase = process.env.PUBLIC_BASE_URL || "https://foxscan.fr";
    const params = {
      customer: customerId,
      return_url: `${returnBase}/dashboard/billing/`,
    };
    // Configuration de portail explicite (bpc_…) si fournie ; sinon Stripe
    // utilise la configuration par défaut du compte.
    if (process.env.STRIPE_PORTAL_CONFIG_ID) {
      params.configuration = process.env.STRIPE_PORTAL_CONFIG_ID;
    }
    const session = await stripe.billingPortal.sessions.create(params);
    res.json({ ok: true, url: session.url, mode: "session" });
  } catch (e) {
    // Cause fréquente : le portail n'est pas activé dans le Dashboard Stripe.
    console.error("[billing/portal] création session:", e.message);
    if (loginUrl) return res.json({ ok: true, url: loginUrl, mode: "login" });
    const notConfigured = /configuration|portal/i.test(e.message || "");
    res.status(notConfigured ? 503 : 502).json({
      ok: false,
      detail: notConfigured
        ? "Portail client non activé dans Stripe (Paramètres → Facturation → Portail client)."
        : "Impossible d'ouvrir le portail de gestion.",
    });
  }
});

app.post("/checkout/subscription", async (req, res) => {
  if (!stripe) return res.status(503).json({ ok: false, detail: "Stripe non configuré" });
  if (!isAllowedOrigin(req)) return res.status(403).json({ ok: false, detail: "Origin non autorisée" });

  const email = String(req.body?.email || "").trim().toLowerCase();
  const company = String(req.body?.company || "").trim().slice(0, 120);

  // `users` n'entre plus dans le prix : l'abonnement est à utilisateurs
  // illimités. On continue d'accepter le champ — les anciens formulaires en
  // circulation l'envoient encore — mais uniquement pour le renseignement.
  const declaredUsers = parseInt(req.body?.users, 10);
  const usersMeta = Number.isInteger(declaredUsers) && declaredUsers > 0
    ? String(declaredUsers) : "illimité";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, detail: "email valide requis" });
  }

  // Période : mensuelle par défaut, annuelle avec 10 % de remise.
  const period = String(req.body?.period || "monthly") === "yearly" ? "yearly" : "monthly";
  const amountCents = period === "yearly"
    ? yearlyPriceCents()
    : SUBSCRIPTION_PRICE_EUR_CENTS;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "eur",
          unit_amount: amountCents,
          recurring: { interval: period === "yearly" ? "year" : "month" },
          product_data: {
            name: "FOXSCAN — Abonnement, utilisateurs illimités",
            description: period === "yearly"
              ? "Plateforme complète : EDL illimités, utilisateurs illimités, scan 3D, comparateur, dashboard. Facturation annuelle (−10 %). Les analyses sont refacturées à leur coût réel, en sus."
              : "Plateforme complète : EDL illimités, utilisateurs illimités, scan 3D, comparateur, dashboard. Facturation mensuelle, sans engagement. Les analyses sont refacturées à leur coût réel, en sus.",
          },
        },
        quantity: 1,
      }],
      customer_email: email,
      metadata: {
        type: "subscription",
        users: usersMeta,
        period,
        company,
      },
      subscription_data: {
        metadata: {
          users: usersMeta,
          period,
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
// ─────────────────────────────────────────────────────────────────────────────
// SUIVI DES ACHATS — store.payments
// ─────────────────────────────────────────────────────────────────────────────
// Chaque événement Stripe monétaire est journalisé ici (source de vérité pour
// l'écran admin « Achats »). Écriture ATOMIQUE et indépendante du reste du
// handler : même si la logique métier autour échoue, l'achat reste tracé.
//
// { id, type: 'founders'|'subscription', status: 'paid'|'canceled'|'failed',
//   email, userId, amountCents, currency, users, stripe*, createdAt }
async function recordPayment(entry) {
  try {
    const payment = {
      id: `pay_${crypto.randomBytes(6).toString("hex")}`,
      createdAt: nowIso(),
      currency: "eur",
      amountCents: 0,
      ...entry,
    };
    await mutateStore((fresh) => {
      fresh.payments = fresh.payments || [];
      fresh.payments.push(payment);
    });
    return payment;
  } catch (e) {
    // Ne jamais casser le webhook pour un souci de journalisation.
    console.error("[payments] enregistrement échoué :", e.message);
    return null;
  }
}

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

          await recordPayment({
            type: "founders",
            status: "paid",
            email: f.email,
            userId: user.id,
            customerName: f.name || customerName,
            amountCents: s.amount_total || FOUNDERS_PRICE_EUR_CENTS,
            currency: s.currency || "eur",
            stripeSessionId: s.id,
            stripeCustomerId: s.customer || "",
          });

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

        await recordPayment({
          type: "subscription",
          status: "paid",
          email: customerEmail,
          userId: user.id,
          customerName,
          users,
          company: meta.company || "",
          amountCents: s.amount_total || 0,
          currency: s.currency || "eur",
          stripeSessionId: s.id,
          stripeCustomerId: s.customer || "",
          stripeSubscriptionId: s.subscription || "",
        });

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
      await recordPayment({
        type: "subscription",
        status: "canceled",
        email: user?.email || "",
        userId: user?.id || "",
        amountCents: 0,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: sub.customer || "",
      });
      break;
    }

    case "invoice.payment_failed": {
      const inv = event.data.object;
      console.warn(`[stripe] Payment failed for ${inv.customer_email || inv.customer} amount=${(inv.amount_due || 0) / 100}€`);
      await recordPayment({
        type: "subscription",
        status: "failed",
        email: (inv.customer_email || "").toLowerCase(),
        amountCents: inv.amount_due || 0,
        currency: inv.currency || "eur",
        stripeCustomerId: inv.customer || "",
        stripeSubscriptionId: inv.subscription || "",
      });
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

// ─── Usage par utilisateur (MÉTADONNÉES uniquement) ─────────────────────────
//
// Volontairement limité à des COMPTEURS et des montants : jamais le contenu des
// EDL (adresses, locataires, photos). L'exploitant a besoin de savoir « combien
// et combien ça rapporte », pas de lire les dossiers de ses clients.
function userUsage(store, userId) {
  const reports = (store.reports || []).filter((r) => r.userID === userId);
  const projects = (store.projects || []).filter((p) => p.userID === userId);
  const exps = (store.exports || []).filter((e) => e.userID === userId);

  const finalized = reports.filter(
    (r) => r.isFinalized === true || r.payload?.isFinalized === true,
  ).length;

  // Activité sur 30 jours glissants.
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const isRecent = (d) => {
    const t = new Date(d || 0).getTime();
    return Number.isFinite(t) && t >= since;
  };
  const edlLast30d = reports.filter((r) => isRecent(r.createdAt)).length;

  // Dernière activité connue, tous objets confondus.
  const lastActivityAt =
    [...reports, ...projects, ...exps]
      .map((x) => x.createdAt)
      .filter(Boolean)
      .sort()
      .pop() || null;

  // Volume stocké (octets) — proxy du coût d'hébergement.
  const storageBytes = exps.reduce((s, e) => s + (e.sizeBytes || 0), 0);

  // Recettes encaissées attribuées à ce compte.
  const revenueCents = (store.payments || [])
    .filter((p) => p.status === "paid" && p.userId === userId)
    .reduce((s, p) => s + (p.amountCents || 0), 0);

  // Coûts de traitement réellement consommés (jetons facturés).
  const events = (store.usageEvents || []).filter((e) => e.userId === userId);
  const costMicros = events.reduce((s, e) => s + (e.costMicros || 0), 0);
  const costMicros30d = events
    .filter((e) => isRecent(e.createdAt))
    .reduce((s, e) => s + (e.costMicros || 0), 0);
  const aiCalls = events.reduce((s, e) => s + (e.calls || 0), 0);

  return {
    edlCount: reports.length,
    edlFinalized: finalized,
    edlLast30d,
    projectCount: projects.length,
    fileCount: exps.length,
    storageBytes,
    revenueCents,
    // Coûts en micro-euros (1 € = 1 000 000) pour éviter les arrondis.
    costMicros,
    costMicros30d,
    aiCalls,
    // Marge = recettes − coûts de traitement, en centimes.
    marginCents: revenueCents - Math.round(costMicros / 10_000),
    lastActivityAt,
  };
}

/** Agrège l'usage de plusieurs comptes (organisation). */
function sumUsage(list) {
  const out = {
    edlCount: 0, edlFinalized: 0, edlLast30d: 0, projectCount: 0,
    fileCount: 0, storageBytes: 0, revenueCents: 0,
    costMicros: 0, costMicros30d: 0, aiCalls: 0, marginCents: 0,
    lastActivityAt: null,
  };
  for (const u of list) {
    for (const k of Object.keys(out)) {
      if (k === "lastActivityAt") continue;
      out[k] += u[k] || 0;
    }
    if (u.lastActivityAt && (!out.lastActivityAt || u.lastActivityAt > out.lastActivityAt)) {
      out.lastActivityAt = u.lastActivityAt;
    }
  }
  return out;
}

function teamSummary(team, users, store) {
  const members = (users || []).filter((u) => u.teamId === team.id);
  const owner = members.find((u) => u.id === team.ownerUserId);
  const memberRows = members.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    isOwner: u.id === team.ownerUserId,
    authProvider: u.authProvider || "email",
    accessStatus: computeAccessStatus(u),
    ...(store ? userUsage(store, u.id) : {}),
  }));

  return {
    id: team.id,
    name: team.name,
    ownerUserId: team.ownerUserId || null,
    ownerName: owner?.name || "—",
    ownerEmail: owner?.email || "",
    membersCount: members.length,
    members: memberRows,
    usage: store ? sumUsage(memberRows) : null,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

// PATCH /admin/users/:userId/role — attribuer un rôle. SUPERADMIN uniquement.
// Body : { role: "superadmin" | "admin" | "manager" | "user" }
app.patch("/admin/users/:userId/role", express.json({ limit: "4kb" }), async (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
  const role = String(req.body?.role || "").trim();
  if (!ASSIGNABLE_ROLES.has(role)) {
    return res.status(400).json({ ok: false, detail: "Rôle invalide" });
  }
  const userId = String(req.params.userId || "").trim();

  // Garde-fou : on ne peut pas se rétrograder soi-même (risque de se verrouiller
  // dehors). L'allowlist ADMIN_EMAILS resterait un filet, mais autant l'éviter.
  if (req._user && req._user.id === userId && role !== ROLE_SUPERADMIN) {
    return res.status(400).json({
      ok: false,
      detail: "Vous ne pouvez pas retirer votre propre rang de super administrateur.",
    });
  }

  let updated = null;
  let notFound = false;
  await mutateStore((fresh) => {
    const u = (fresh.users || []).find((x) => x.id === userId);
    if (!u) { notFound = true; return; }
    u.role = role;
    u.updatedAt = nowIso();
    updated = u;
    fresh.auditEvents = fresh.auditEvents || [];
    fresh.auditEvents.push({
      id: `aud_${crypto.randomBytes(4).toString("hex")}`,
      type: "user.role.changed",
      userID: userId,
      adminID: req._user?.id || "cli",
      role,
      createdAt: nowIso(),
    });
  });

  if (notFound) return res.status(404).json({ ok: false, detail: "Utilisateur introuvable" });
  res.json({
    ok: true,
    user: { id: updated.id, email: updated.email, role: updated.role, effectiveRole: roleOf(updated) },
  });
});

// GET : liste de toutes les équipes (avec leurs membres + usage)
// NB : utilise requireAdminKey (Bearer admin OU x-admin-key). L'ancienne
// version n'acceptait que la clé CLI, ce qui rendait la liste inatteignable
// depuis le dashboard — d'où l'absence d'écran d'administration des organisations.
// ═══════════════════════════════════════════════════════════════════════════
// FACTURATION CLIENT
//
// Une facture n'est pas une fiche de plus : c'est une pièce comptable. Trois
// règles la distinguent du reste de ce fichier, et elles ont guidé le code.
//
//  1. NUMÉROTATION CONTINUE. L'article 242 nonies A de l'annexe II au CGI
//     impose un numéro unique, « basé sur une séquence chronologique continue,
//     sans rupture ». Le compteur passe donc par `mutateStore` : deux factures
//     créées en même temps ne peuvent pas recevoir le même numéro.
//  2. IMMUABLE. Une facture émise ne se modifie ni ne se supprime. Une erreur
//     se corrige par un AVOIR, qui est lui-même une facture — d'où l'absence
//     volontaire de route DELETE ou PATCH sur les montants.
//  3. MENTIONS OBLIGATOIRES. Elles sont figées ci-dessous plutôt que saisies
//     à la main : une facture à laquelle il manque la mention 293 B ou
//     l'indemnité de recouvrement est irrégulière.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * L'émetteur. Pour un entrepreneur individuel, la facture porte le nom de
 * l'entrepreneur suivi de « EI » (obligatoire depuis le 15 mai 2022) ; le nom
 * commercial l'accompagne sans le remplacer.
 */
const INVOICE_ISSUER = {
  legalName: "Pierre-Emmanuel EMERY--DUVAREILLE (EI)",
  tradeName: "TruFox",
  address: "7 ter boulevard de Verdun",
  postalCode: "42800",
  city: "Saint-Martin-la-Plaine",
  country: "France",
  siret: "102 982 899 00019",
  siren: "102 982 899",
  legalForm: "Entrepreneur individuel (micro-entreprise)",
  vatNote: "TVA non applicable — article 293 B du Code général des impôts",
  email: "contact@foxscan.fr",
  website: "foxscan.fr",
};

/** Mentions que la loi impose de faire figurer sur une facture entre professionnels. */
const INVOICE_LEGAL_TERMS = {
  paymentTermDays: 30,
  latePenalty:
    "Tout retard de paiement entraîne des pénalités au taux d'intérêt appliqué par la "
    + "Banque centrale européenne à son opération de refinancement la plus récente, "
    + "majoré de 10 points de pourcentage (art. L441-10 du Code de commerce).",
  recoveryIndemnity:
    "Indemnité forfaitaire pour frais de recouvrement en cas de retard : 40 € "
    + "(art. D441-5 du Code de commerce).",
  noDiscount: "Pas d'escompte pour paiement anticipé.",
};

const centsFromEuros = (v) => Math.round((Number(v) || 0) * 100);
const eurosFromCents = (c) => Math.round(c) / 100;

/** Normalise et vérifie une ligne de facture. Retourne null si inexploitable. */
function sanitizeInvoiceLine(raw) {
  const label = String(raw?.label || "").trim().slice(0, 160);
  if (!label) return null;
  const qty = Number(raw?.qty);
  const quantity = Number.isFinite(qty) && qty > 0 ? Math.round(qty * 100) / 100 : 1;
  // Le prix arrive en euros depuis l'écran ; on travaille en centimes pour ne
  // jamais accumuler d'erreur de virgule flottante sur un montant dû.
  const unitCents = centsFromEuros(raw?.unitPriceEur);
  return {
    label,
    quantity,
    unitPriceCents: unitCents,
    totalCents: Math.round(quantity * unitCents),
  };
}

app.get("/admin/invoices", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
  const store = readStore();
  const items = [...(store.invoices || [])].sort(
    (a, b) => String(b.issuedAt || "").localeCompare(String(a.issuedAt || "")),
  );
  const totalIssuedCents = items
    .filter((i) => i.kind !== "creditNote")
    .reduce((n, i) => n + (i.totalCents || 0), 0);
  const totalPaidCents = items
    .filter((i) => i.status === "paid")
    .reduce((n, i) => n + (i.totalCents || 0), 0);
  res.json({
    ok: true,
    total: items.length,
    items,
    issuer: INVOICE_ISSUER,
    terms: INVOICE_LEGAL_TERMS,
    totals: {
      issuedEur: eurosFromCents(totalIssuedCents),
      paidEur: eurosFromCents(totalPaidCents),
      outstandingEur: eurosFromCents(totalIssuedCents - totalPaidCents),
    },
  });
});

/**
 * Pré-remplissage : ce qu'on peut facturer à une organisation sur une période.
 *
 * L'abonnement est un montant connu ; les analyses, elles, sont refacturées à
 * leur coût réel — ce chiffre ne doit donc jamais être saisi à la main, il se
 * lit dans les relevés de consommation des membres de l'organisation.
 */
app.get("/admin/invoices/prefill", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
  const store = readStore();
  const teamId = String(req.query.teamId || "").trim();
  const team = (store.teams || []).find((t) => t.id === teamId);

  const now = new Date();
  const parse = (v, fb) => {
    const d = new Date(String(v || ""));
    return Number.isNaN(d.getTime()) ? fb : d;
  };
  const from = parse(req.query.from, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const to = parse(req.query.to, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59)));

  const memberIds = new Set(
    (store.users || []).filter((u) => u.teamId && u.teamId === teamId).map((u) => u.id),
  );

  let calls = 0;
  let costMicros = 0;
  for (const e of store.usageEvents || []) {
    if (!memberIds.has(e.userId || e.userID)) continue;
    const t = new Date(e.createdAt || 0);
    if (t < from || t > to) continue;
    calls += e.calls || 0;
    costMicros += e.costMicros || 0;
  }

  res.json({
    ok: true,
    team: team ? { id: team.id, name: team.name } : null,
    members: memberIds.size,
    period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    subscription: { label: "Abonnement FOXSCAN — utilisateurs illimités", unitPriceEur: 29 },
    analyses: {
      calls,
      costEur: Math.round(costMicros / 10000) / 100,
      // Le relevé est volontairement transmis tel quel : si le compteur
      // n'a rien enregistré, il faut que ça se voie avant d'émettre.
      measured: calls > 0,
    },
  });
});

app.post("/admin/invoices", express.json({ limit: "64kb" }), async (req, res, next) => {
  if (!requireSuperAdminKey(req, res)) return;
  try {
    const b = req.body || {};
    const clientName = String(b.clientName || "").trim().slice(0, 160);
    if (!clientName) {
      return res.status(400).json({ ok: false, detail: "Le nom de l'organisation à facturer est obligatoire." });
    }

    const lines = (Array.isArray(b.lines) ? b.lines : []).map(sanitizeInvoiceLine).filter(Boolean);
    if (!lines.length) {
      return res.status(400).json({ ok: false, detail: "Au moins une ligne de prestation est requise." });
    }

    const kind = b.kind === "creditNote" ? "creditNote" : "invoice";
    const sign = kind === "creditNote" ? -1 : 1;
    const totalCents = sign * lines.reduce((n, l) => n + l.totalCents, 0);

    const issuedAt = new Date();
    const dueAt = new Date(issuedAt.getTime() + INVOICE_LEGAL_TERMS.paymentTermDays * 86400000);

    let created = null;
    await mutateStore((fresh) => {
      fresh.invoices = fresh.invoices || [];
      // Compteur jamais remis à zéro : une séquence continue se défend, une
      // séquence qui repart à 1 chaque année oblige à prouver la série.
      fresh.invoiceCounter = (fresh.invoiceCounter || 0) + 1;
      const seq = String(fresh.invoiceCounter).padStart(4, "0");
      const prefix = kind === "creditNote" ? "AV" : "FA";
      created = {
        id: `inv_${crypto.randomBytes(5).toString("hex")}`,
        number: `TF-${prefix}-${issuedAt.getUTCFullYear()}-${seq}`,
        kind,
        issuedAt: issuedAt.toISOString(),
        dueAt: dueAt.toISOString(),
        periodFrom: String(b.periodFrom || "").slice(0, 10) || null,
        periodTo: String(b.periodTo || "").slice(0, 10) || null,
        client: {
          teamId: String(b.teamId || "").trim() || null,
          name: clientName,
          address: String(b.clientAddress || "").trim().slice(0, 240),
          siret: String(b.clientSiret || "").trim().slice(0, 32),
          vatNumber: String(b.clientVat || "").trim().slice(0, 32),
          email: String(b.clientEmail || "").trim().slice(0, 160),
        },
        lines,
        totalCents,
        totalEur: eurosFromCents(totalCents),
        currency: "EUR",
        // Franchise en base : pas de TVA, mais la mention est obligatoire.
        vatNote: INVOICE_ISSUER.vatNote,
        notes: String(b.notes || "").trim().slice(0, 600),
        correctsInvoiceId: kind === "creditNote" ? (String(b.correctsInvoiceId || "").trim() || null) : null,
        status: "issued",
        paidAt: null,
        createdAtDb: nowIso(),
      };
      fresh.invoices.push(created);
    });

    console.log(`[facture] ${created.number} · ${created.client.name} · ${created.totalEur} €`);
    res.json({ ok: true, invoice: created, issuer: INVOICE_ISSUER, terms: INVOICE_LEGAL_TERMS });
  } catch (err) {
    return next(err);
  }
});

app.post("/admin/invoices/:id/paid", async (req, res, next) => {
  if (!requireSuperAdminKey(req, res)) return;
  try {
    let found = null;
    await mutateStore((fresh) => {
      const inv = (fresh.invoices || []).find((i) => i.id === req.params.id);
      if (!inv) return;
      // On ne touche jamais aux montants : seul l'encaissement est consigné.
      inv.status = inv.status === "paid" ? "issued" : "paid";
      inv.paidAt = inv.status === "paid" ? nowIso() : null;
      found = inv;
    });
    if (!found) return res.status(404).json({ ok: false, detail: "Facture introuvable" });
    res.json({ ok: true, invoice: found });
  } catch (err) {
    return next(err);
  }
});

app.get("/admin/teams", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
  const store = readStore();
  const items = (store.teams || []).map((t) => teamSummary(t, store.users, store));

  // Utilisateurs sans organisation : utile pour les rattacher depuis l'écran.
  const unassigned = (store.users || [])
    .filter((u) => !u.teamId)
    .map((u) => ({
      id: u.id,
      name: u.name || "",
      email: u.email || "",
      accessStatus: computeAccessStatus(u),
      ...userUsage(store, u.id),
    }));

  res.json({ ok: true, total: items.length, items, unassigned });
});

// POST : créer une équipe — { name, ownerUserId? }
app.post("/admin/teams", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
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
  res.json({ ok: true, team: teamSummary(team, store.users, store) });
});

// PATCH : renommer / changer owner — { name?, ownerUserId? }
app.patch("/admin/teams/:id", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
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
  res.json({ ok: true, team: teamSummary(team, store.users, store) });
});

// DELETE : supprimer l'équipe (les membres voient leur teamId effacé)
app.delete("/admin/teams/:id", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
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
  if (!requireSuperAdminKey(req, res)) return;
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
  res.json({ ok: true, added, team: teamSummary(team, store.users, store) });
});

// DELETE : retirer un membre
app.delete("/admin/teams/:id/members/:userId", (req, res) => {
  if (!requireSuperAdminKey(req, res)) return;
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
  res.json({ ok: true, team: teamSummary(team, store.users, store) });
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

  // Quota d'essai (7 jours / 3 EDL) : au-delà, l'app doit passer au paiement.
  if (blockIfTrialExhausted(user, store, res, body)) return;

  const userID = user?.id || body.actorUserID || "ios_anonymous";
  const projectID = body.projectID || `proj_${crypto.randomBytes(4).toString("hex")}`;
  const reportID = body.reportID || `rep_${crypto.randomBytes(4).toString("hex")}`;

  // V5 — Extraction des champs au TOP-LEVEL du projet pour que le
  // dashboard puisse filtrer / trier / archiver sans avoir à parcourir
  // le sous-objet `payload.report.X` à chaque requête.
  const report = body.report || {};

  // Adresse reconstituée de façon idempotente (evite d'accumuler ville/CP
  // à chaque sync si report.address inclut déjà le code postal et la ville).
  const fullAddress = rebuildAddressFromReport(report);

  // Statut du projet : si l'EDL est finalisé → completed.
  let projectStatus = "in_progress";
  if (report.isFinalized === true) projectStatus = "completed";
  if (report.signedByTenant === true && report.signedByOwner === true) {
    projectStatus = "completed";
  }

  // ── GARDE-FOU : un état des lieux signé ne repasse pas en brouillon ───────
  // Un appareil qui a gardé une vieille copie non finalisée du même rapport
  // ne doit pas l'imposer au serveur. Seule une réouverture voulue depuis
  // l'app (`reopened: true`) ou une nouvelle version finalisée passe.
  // Réponse 200 : l'app considère l'envoi comme traité et ne le rejoue pas.
  const existingReportRow = (store.reports || []).find((r) => r.id === reportID);
  if (isReportFinalized(existingReportRow) && report.isFinalized !== true && body.reopened !== true) {
    console.warn(
      `[/inspections/sync] brouillon ignoré — rapport ${reportID} déjà finalisé ` +
      `(user=${userID} project=${projectID})`
    );
    return res.json({
      ok: true,
      id: reportID,
      projectID,
      ignored: "finalized",
      message: "Rapport déjà finalisé : brouillon ignoré",
    });
  }

  // Si projet existe déjà, on PRÉSERVE les champs d'archivage / programmation
  // déjà stockés (jamais écrasés par une re-sync mobile).
  const existingProject = store.projects.find((p) => p.id === projectID);
  const preservedIsArchived = existingProject?.isArchived ?? false;
  const preservedArchivedAt = existingProject?.archivedAt ?? null;
  const preservedScheduledAt = existingProject?.scheduledAt ?? null;
  const preservedPropertyImage = existingProject?.propertyImageFileName ?? null;
  // Nom personnalisé depuis le web : ne doit PAS être écrasé par la re-sync.
  const preservedNameCustom = existingProject?.nameCustom === true;

  // ── GARDE-FOU édition bidirectionnelle des brouillons ──────────────────────
  // Si le web a édité les métadonnées plus récemment que la donnée poussée par
  // l'app (updatedAt), on PRÉSERVE la version web (fusion champ par champ) au
  // lieu de la laisser écraser. Dès que l'app renvoie une donnée plus récente,
  // elle gagne (dernière écriture gagne). Si l'app n'envoie pas d'updatedAt, on
  // protège l'édition web par prudence.
  const WEB_META_FIELDS = [
    "address", "addressComplement", "postalCode", "city",
    "tenantName", "tenantEmail", "additionalTenants",
    "landlordName", "notes", "inspectionType", "propertyType",
  ];
  const webEditedAt = existingProject?.draftMetaEditedAt || null;
  const webNewer = !!webEditedAt
    && (!body.updatedAt
        || new Date(webEditedAt).getTime() > new Date(body.updatedAt).getTime());

  let effectivePayload = body;
  let effAddress = fullAddress || "(adresse à renseigner)";
  let effTenant = report.tenantName || "";
  let effLandlord = report.landlordName || "";
  let effInspType = report.inspectionType || "Entrée";

  if (webNewer && existingProject) {
    // Overlay des champs web sur la payload poussée (garde pièces/photos de l'app).
    const webReport = (existingProject.payload && existingProject.payload.report) || {};
    const overlay = {};
    for (const f of WEB_META_FIELDS) {
      if (webReport[f] !== undefined) overlay[f] = webReport[f];
    }
    effectivePayload = { ...body, report: { ...(body.report || {}), ...overlay } };
    effAddress = existingProject.address || effAddress;
    if (existingProject.tenantName !== undefined) effTenant = existingProject.tenantName;
    if (existingProject.landlordName !== undefined) effLandlord = existingProject.landlordName;
    effInspType = existingProject.inspectionType || effInspType;
  }

  upsertByID(store.projects, projectID, {
    userID,
    projectName: preservedNameCustom
      ? (existingProject.projectName || body.projectName || "Nouveau projet")
      : (body.projectName || "Nouveau projet"),
    nameCustom: preservedNameCustom,
    // Notes web : conservées à travers les re-syncs (iOS ne les envoie pas).
    notes: existingProject?.notes ?? null,
    // Marqueur d'édition web conservé (protège jusqu'à ce que l'app rattrape).
    draftMetaEditedAt: webEditedAt,
    updatedAt: body.updatedAt || nowIso(),
    status: projectStatus,
    // V5 — Vraie adresse extraite (au lieu du hard-coded « Adresse
    // synchronisée depuis iOS » qui était inutilisable côté dashboard).
    address: effAddress,
    tenantName: effTenant,
    landlordName: effLandlord,
    agentName: report.agentName || "",
    inspectionType: effInspType,
    // V5 — Champs d'organisation projet préservés (jamais réinitialisés
    // par une re-sync depuis le mobile, sauf s'ils sont volontairement
    // explicites dans la payload mobile, à venir si on étend le contrat).
    isArchived: preservedIsArchived,
    archivedAt: preservedArchivedAt,
    scheduledAt: preservedScheduledAt,
    propertyImageFileName: preservedPropertyImage,
    payload: effectivePayload,
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

  // Quota d'essai (7 jours / 3 EDL) : au-delà, l'app doit passer au paiement.
  if (blockIfTrialExhausted(user, store, res, body)) return;

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
    attachExportToReport(store.reports, body.reportID, {
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

/**
 * Nom de fichier LOGIQUE, barres obliques conservées.
 *
 * L'app envoie des chemins relatifs — `constat-media/photos/photo-001.jpg` —
 * qui portent l'ordre du récit et la séparation audio/photos. `safeFileName`
 * les aplatissait en `constat-media_photos_photo-001.jpg`, ce qui cassait la
 * réconciliation : l'app compare les `fileName` reçus aux siens, ne retrouvait
 * rien, et réenvoyait toute la visite à chaque synchronisation.
 *
 * On préserve donc l'arborescence, en neutralisant la traversée de répertoire
 * (`..`) et les caractères hors jeu autorisé, segment par segment.
 */
function safeRelativePath(input) {
  const segments = String(input || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, "_"))
    .filter((seg) => seg && seg !== "." && !/^\.\.+$/.test(seg));
  const joined = segments.join("/").slice(0, 400);
  return joined || "export.bin";
}

/**
 * Types d'artefact acceptés. Un `kind` inconnu est REFUSÉ plutôt que rangé
 * par défaut : un procès-verbal de constat classé parmi les états des lieux
 * serait une erreur bien plus coûteuse qu'un envoi rejeté.
 */
const EXPORT_KINDS = new Set([
  "inspectionPDF",     // état des lieux locatif
  "inspectionBundle",  // plan 2D du scan 3D
  "mediaArchive",      // matière première : photos et bandes audio
  "constatPDF",        // procès-verbal de constat — espace distinct des EDL
  // Types hérités d'anciennes versions de l'app : encore présents en base et
  // possiblement envoyés par un iPhone non mis à jour. Les refuser casserait
  // ces installations sans rien apporter.
  "inspectionPhoto",
  "lidarScan",
]);

/**
 * Ligne de produit à laquelle se rattache un artefact.
 * C'est la clé du rangement : un constat et un état des lieux sont deux actes
 * de nature différente, ils ne se mélangent jamais.
 */
const KIND_TO_PRODUCT = {
  constatPDF: "constat",
  inspectionPDF: "edl",
  inspectionBundle: "edl",
  inspectionPhoto: "edl",
  lidarScan: "edl",
  // `mediaArchive` sert aux deux : on le rattache par son inspectionType.
};

/**
 * Un artefact appartient-il à un constat ?
 *
 * Le `kind` fait foi pour le document ; la matière première (`mediaArchive`)
 * se reconnaît à son `inspectionType` ou au préfixe de son chemin.
 */
function isConstatArtifact({ kind, inspectionType, fileName }) {
  if (kind === "constatPDF") return true;
  if (inspectionType === "constat") return true;
  return String(fileName || "").startsWith("constat-media/");
}

/**
 * Chemin de rangement d'un constat, relatif au dossier de l'utilisateur.
 *
 *   constats/<constatID>/acte.pdf
 *   constats/<constatID>/media/audio/prise-001.caf
 *   constats/<constatID>/media/photos/photo-001.jpg
 *
 * L'intérêt n'est pas technique : c'est qu'un constat se reconstitue
 * intégralement depuis un seul dossier, sans retourner sur place. Cette
 * garantie n'a de valeur que si elle survit aussi côté serveur.
 */
function constatDiskTarget(constatID, kind, fileName) {
  const safeId = safeFileName(constatID || "sans-id");
  if (kind === "constatPDF") return path.join("constats", safeId, "acte.pdf");
  const rel = String(fileName || "").replace(/^constat-media\//, "");
  return path.join("constats", safeId, "media", rel);
}

const PRODUCTS = new Set(["edl", "constat"]);

/**
 * Profil produit d'un client.
 *
 * Deux informations distinctes, qu'il ne faut pas confondre :
 *
 *  • `declared` — POURQUOI il est venu. Posé à l'inscription, jamais écrasé
 *    automatiquement : c'est la donnée d'acquisition, elle doit rester stable
 *    même si l'usage dérive.
 *  • `observed` — CE QU'IL FAIT. Recalculé depuis ses artefacts.
 *
 * L'écart entre les deux est un signal : quelqu'un venu pour l'état des lieux
 * qui ne produit que des constats n'a pas été vendu le bon produit.
 */
function productProfile(store, user) {
  const declared = PRODUCTS.has(user.product) ? user.product : null;

  let edl = 0;
  let constat = 0;
  for (const e of store.exports || []) {
    if (e.userID !== user.id) continue;
    const viaKind = KIND_TO_PRODUCT[e.kind];
    const viaType = e.inspectionType === "constat" ? "constat" : null;
    const p = viaKind || viaType;
    if (p === "constat") constat += 1;
    else if (p === "edl") edl += 1;
  }

  let observed = null;
  if (edl && constat) observed = "mixte";
  else if (constat) observed = "constat";
  else if (edl) observed = "edl";

  return {
    declared,
    observed,
    // Le déclaré prime : c'est lui qui dit par quelle porte le client est entré.
    segment: declared || observed || "inconnu",
    counts: { edl, constat },
    mismatch: Boolean(
      declared && observed && observed !== "mixte" && declared !== observed,
    ),
  };
}

// Parse un body multipart/form-data sans dépendance externe.
// Retourne null si le Content-Type n'est pas multipart ou si le boundary est absent.
function parseMultipart(buffer, contentTypeHeader) {
  const m = (contentTypeHeader || "").match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const crlfcrlf = Buffer.from("\r\n\r\n");
  const results = [];
  let pos = 0;
  while (pos < buffer.length) {
    const delimPos = buffer.indexOf(boundary, pos);
    if (delimPos === -1) break;
    const afterDelim = delimPos + boundary.length;
    // boundary-- = fin du body
    if (buffer[afterDelim] === 0x2D && buffer[afterDelim + 1] === 0x2D) break;
    const partStart = afterDelim + 2; // saute le \r\n après le délimiteur
    const headersEnd = buffer.indexOf(crlfcrlf, partStart);
    if (headersEnd === -1) break;
    const headers = buffer.slice(partStart, headersEnd).toString("utf8");
    const dataStart = headersEnd + 4;
    const nextDelim = buffer.indexOf(boundary, dataStart);
    const dataEnd = nextDelim === -1 ? buffer.length : nextDelim - 2;
    const nameM = headers.match(/name="([^"]+)"/i);
    const fileM = headers.match(/filename="([^"]+)"/i);
    const ctM = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    results.push({
      name: nameM ? nameM[1] : null,
      fileName: fileM ? fileM[1] : null,
      contentType: ctM ? ctM[1].trim() : null,
      data: buffer.slice(dataStart, Math.max(dataStart, dataEnd)),
    });
    pos = nextDelim !== -1 ? nextDelim : buffer.length;
  }
  return results.length ? results : null;
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

const {
  importEDL: importEDLImpl,
  importEDLFromImages: importEDLFromImagesImpl,
  toFoxscanReport,
} = require("./lib/edlImport");

// V6.4 — Détection de type via magic bytes (plus fiable que Content-Type spoof)
function detectFileKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const magic = buf.slice(0, 12);
  if (magic.slice(0, 4).toString("ascii") === "%PDF") return { kind: "pdf", mime: "application/pdf" };
  if (magic[0] === 0xFF && magic[1] === 0xD8 && magic[2] === 0xFF) return { kind: "image", mime: "image/jpeg" };
  if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4E && magic[3] === 0x47) return { kind: "image", mime: "image/png" };
  if (magic.slice(0, 4).toString("ascii") === "RIFF" && magic.slice(8, 12).toString("ascii") === "WEBP") return { kind: "image", mime: "image/webp" };
  // HEIC/HEIF : magic bytes ftyp à offset 4-8 puis "heic"/"heif"/"hevc" à offset 8
  if (magic.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = magic.slice(8, 12).toString("ascii");
    if (["heic","heix","heim","heis","hevc","hevm","hevs","mif1","msf1","heif"].includes(brand)) {
      return { kind: "image", mime: "image/heic" };
    }
  }
  return null;
}

app.post(
  "/imports/edl",
  requireCurrentUser,
  // V6.4 — Accepte PDF ET images (photos d'EDL, scans). Magic-bytes pour la sécurité.
  express.raw({
    type: [
      "application/pdf", "application/octet-stream",
      "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp",
    ],
    limit: process.env.FOXSCAN_IMPORT_LIMIT || "30mb",
  }),
  async (req, res) => {
    const user = req._user;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ ok: false, detail: "Fichier manquant" });
    }
    if (buf.length > 30 * 1024 * 1024) {
      return res.status(413).json({ ok: false, detail: "Fichier trop volumineux (max 30 Mo)" });
    }

    // V6.4 — Détection automatique du type (PDF ou image) via magic bytes
    const detected = detectFileKind(buf);
    if (!detected) {
      return res.status(400).json({
        ok: false,
        detail: "Format non reconnu. Formats acceptés : PDF, JPG, PNG, HEIC, WEBP.",
      });
    }

    let normalized;
    try {
      if (detected.kind === "pdf") {
        normalized = await importEDLImpl(buf, { callOpenAI: callOpenAIResponses });
      } else {
        // Image unique → Vision API directe
        normalized = await importEDLFromImagesImpl(
          [{ mime: detected.mime, buffer: buf }],
          { callOpenAI: callOpenAIResponses }
        );
      }
    } catch (err) {
      console.error(`[/imports/edl] user=${user.id} kind=${detected.kind} parse failed: ${err.message}`);
      return res.status(err.status || 500).json({
        ok: false,
        detail: `Analyse du ${detected.kind === "pdf" ? "PDF" : "fichier"} impossible : ${err.message}`,
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

// V6.4 — Import multi-images : plusieurs photos d'un EDL papier multi-pages.
// Body JSON : { images: [ { mime, dataUrl }, ... ] }
// Limite : 8 images max, 5 Mo par image, ~25 Mo total.
app.post(
  "/imports/edl-images",
  requireCurrentUser,
  express.json({ limit: "30mb" }),
  async (req, res) => {
    const user = req._user;
    const body = req.body || {};
    if (!Array.isArray(body.images) || body.images.length === 0) {
      return res.status(400).json({ ok: false, detail: "Aucune image fournie (champ images requis)" });
    }
    if (body.images.length > 8) {
      return res.status(400).json({ ok: false, detail: "Max 8 pages d'EDL par import" });
    }

    // Décode les data URLs en Buffer + valide
    const images = [];
    let totalBytes = 0;
    for (let i = 0; i < body.images.length; i++) {
      const item = body.images[i];
      if (!item || typeof item.dataUrl !== "string") {
        return res.status(400).json({ ok: false, detail: `Image ${i+1} : dataUrl manquant` });
      }
      const match = item.dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (!match) {
        return res.status(400).json({ ok: false, detail: `Image ${i+1} : format dataUrl invalide` });
      }
      const mime = match[1].toLowerCase();
      const allowedMimes = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"];
      if (!allowedMimes.includes(mime)) {
        return res.status(400).json({ ok: false, detail: `Image ${i+1} : MIME ${mime} non supporté` });
      }
      const buf = Buffer.from(match[2], "base64");
      if (buf.length > 5 * 1024 * 1024) {
        return res.status(413).json({ ok: false, detail: `Image ${i+1} : trop volumineuse (max 5 Mo)` });
      }
      totalBytes += buf.length;
      if (totalBytes > 25 * 1024 * 1024) {
        return res.status(413).json({ ok: false, detail: "Taille totale des images > 25 Mo" });
      }
      images.push({ mime, buffer: buf });
    }

    let normalized;
    try {
      normalized = await importEDLFromImagesImpl(images, { callOpenAI: callOpenAIResponses });
    } catch (err) {
      console.error(`[/imports/edl-images] user=${user.id} parse failed: ${err.message}`);
      return res.status(err.status || 500).json({
        ok: false,
        detail: `Analyse des images impossible : ${err.message}`,
      });
    }

    // Construit l'adresse + crée le projet (même logique que /imports/edl)
    const meta = normalized.meta || {};
    const fullAddress = [
      [meta.address, meta.addressComplement].filter(Boolean).join(", "),
      [meta.postalCode, meta.city].filter(Boolean).join(" "),
    ].filter((v) => v && v.trim().length).join(", ") || "(adresse à renseigner)";

    const store = readStore();
    const projectID = crypto.randomUUID();
    const reportID = crypto.randomUUID();
    const reportPayload = toFoxscanReport(normalized, { reportId: reportID, projectId: projectID });
    const tenantName = reportPayload.tenantName || "";
    const landlordName = reportPayload.landlordName || "";
    const inspectionType = reportPayload.inspectionType || "Entrée";

    const project = {
      id: projectID, userID: user.id,
      projectName: `Import photos — ${fullAddress.slice(0, 60)}`,
      createdAt: nowIso(), updatedAt: nowIso(), updatedAtDb: nowIso(),
      status: "in_progress", address: fullAddress,
      tenantName, landlordName, inspectionType,
      origin: "import", importedSourceFormat: normalized.sourceFormat,
      importedConfidence: normalized.confidence,
      isArchived: false, archivedAt: null, scheduledAt: null,
      propertyImageFileName: null,
      payload: { report: reportPayload },
    };
    store.projects = store.projects || [];
    store.projects.push(project);
    store.reports = store.reports || [];
    store.reports.push({
      id: reportID, userID: user.id, projectID,
      projectName: project.projectName, fileName: `${reportID}.json`,
      createdAt: nowIso(), payload: reportPayload,
      address: fullAddress, tenantName,
      isFinalized: false, finalizedAt: null,
      origin: "import", createdAtDb: nowIso(),
    });
    writeStore(store);

    console.log(`[/imports/edl-images] user=${user.id} project=${projectID} images=${images.length} rooms=${(normalized.rooms || []).length}`);

    res.json({
      ok: true,
      project: {
        id: projectID, projectName: project.projectName,
        address: project.address, tenantName, landlordName, inspectionType,
        sourceFormat: normalized.sourceFormat, confidence: normalized.confidence,
        imageCount: images.length,
      },
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
      // Quota d'essai : on ne bloque QUE l'envoi rattaché à un nouvel EDL.
      // Un `ensureDashboardAllowed` était appliqué ici : il empêchait tout
      // envoi de photo/PDF dès l'essai expiré, y compris pour compléter un
      // EDL déjà commencé — le travail resté sur le téléphone était perdu.
      if (blockIfTrialExhausted(user, store, res, req.query || {})) return;

      let rawBuffer = Buffer.isBuffer(req.body) ? req.body : null;
      if (!rawBuffer || rawBuffer.length === 0) {
        return res.status(400).json({ ok: false, detail: "binary body is empty" });
      }

      // Support multipart/form-data (photos individuels envoyés par iOS ≥ v2)
      // iOS envoie un body multipart SANS poser Content-Type: multipart/form-data
      // dans le header HTTP. On détecte donc aussi le multipart par signature de
      // contenu : si le body commence par "--" (0x2D 0x2D) c'est un multipart.
      let buffer = rawBuffer;
      let multipartFileName = null;
      const multipartFields = {};
      const ct = req.headers["content-type"] || "";

      // Choisir le Content-Type à passer à parseMultipart :
      // 1. Si le header dit bien multipart/form-data → l'utiliser directement
      // 2. Sinon si le body commence par "--" → extraire la boundary du body
      const bodyIsMultipart = rawBuffer.length > 2 && rawBuffer[0] === 0x2D && rawBuffer[1] === 0x2D;
      let ctForMultipart = null;
      if (ct.toLowerCase().includes("multipart/form-data")) {
        ctForMultipart = ct;
      } else if (bodyIsMultipart) {
        const eolIdx = rawBuffer.indexOf("\r\n");
        const firstLine = rawBuffer.slice(0, eolIdx > 0 ? eolIdx : Math.min(300, rawBuffer.length)).toString("ascii");
        const bodyBoundary = firstLine.slice(2); // enlève les "--" initiaux
        if (bodyBoundary) ctForMultipart = `multipart/form-data; boundary=${bodyBoundary}`;
      }

      if (ctForMultipart) {
        const parts = parseMultipart(rawBuffer, ctForMultipart);
        if (parts && parts.length > 0) {
          // Part avec filename = la photo ; sans filename = champ texte
          const filePart = parts.find((p) => p.fileName && p.data && p.data.length > 0)
            || parts.reduce((a, b) => (b.data.length > a.data.length ? b : a), parts[0]);
          buffer = filePart.data;
          if (filePart.fileName) multipartFileName = filePart.fileName;
          // Extraire les champs texte (projectID, kind, propertyID, etc.)
          for (const p of parts) {
            if (!p.fileName && p.name && p.data && p.data.length < 4096) {
              multipartFields[p.name] = p.data.toString("utf-8").trim();
            }
          }
          console.log(`[/exports/upload] multipart détecté : ${parts.length} parts, file="${multipartFileName}", fields=${JSON.stringify(Object.keys(multipartFields))}`);
        }
      }
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ ok: false, detail: "binary body is empty after multipart extraction" });
      }

      // Les champs du multipart ont priorité sur les query params
      // (iOS v2 les envoie dans le body, pas dans l'URL)
      const fileName = safeRelativePath(multipartFileName || multipartFields.fileName || req.query.fileName);
      const projectID = String(multipartFields.projectID || req.query.projectID || "").trim() || null;
      const reportID = String(req.query.reportID || "").trim() || null;
      // Un `kind` absent reste toléré (anciens clients iOS) et retombe sur
      // inspectionBundle. Un `kind` FOURNI mais inconnu est refusé : ranger un
      // constat parmi les états des lieux par défaut serait pire qu'un rejet.
      const rawKind = (multipartFields.kind ?? req.query.kind ?? "").toString().trim();
      const kind = rawKind || "inspectionBundle";
      if (rawKind && !EXPORT_KINDS.has(kind)) {
        return res.status(400).json({
          ok: false,
          detail: `kind inconnu : « ${kind} ». Valeurs acceptées : ${[...EXPORT_KINDS].join(", ")}.`,
        });
      }

      // Métadonnées de groupement par bien (entrée vs sortie). Optionnelles
      // pour ne pas casser les anciens clients iOS qui ne les envoient pas
      // encore. Le dashboard les utilisera pour comparer entrée/sortie d'un
      // même bien (matching sur propertyID stable).
      const inspectionType = String(multipartFields.inspectionType || req.query.inspectionType || "").trim() || null;
      const propertyID = String(multipartFields.propertyID || req.query.propertyID || "").trim() || null;
      // Données personnelles de tiers (locataire, adresse du bien). Elles ne
      // doivent PAS transiter par l'URL : elle est écrite en clair dans les
      // journaux d'accès du serveur et du CDN, qui n'ont pas à les conserver.
      //
      // Ordre de lecture : champ multipart, puis en-tête HTTP, puis paramètre
      // d'URL. Ce dernier reste toléré le temps que l'app iOS bascule — la
      // migration ne nécessite donc AUCUN déploiement synchronisé. Une fois
      // l'app à jour partout, la lecture de req.query pourra être retirée.
      //
      // Les en-têtes sont attendus percent-encodés (les noms comportent des
      // accents, et HTTP n'accepte pas l'UTF-8 brut en en-tête).
      const piiMeta = (name, headerName) => {
        const raw = multipartFields[name];
        if (raw) return String(raw).trim() || null;
        const h = req.headers[headerName];
        if (h) {
          let v = String(h);
          try { v = decodeURIComponent(v); } catch (_) { /* valeur non encodée */ }
          return v.trim() || null;
        }
        return String(req.query[name] || "").trim() || null;
      };

      const propertyAddress = piiMeta("propertyAddress", "x-foxscan-property-address");
      const tenantName = piiMeta("tenantName", "x-foxscan-tenant-name");
      const inspectionDate = piiMeta("inspectionDate", "x-foxscan-inspection-date");
      const projectNameMeta = piiMeta("projectName", "x-foxscan-project-name");

      const exportID = `exp_${crypto.randomBytes(4).toString("hex")}`;
      const userDir = path.join(settings.exportFilesDir, user.id);
      ensureDir(userDir);

      const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");

      // Dédup idempotente (spec iOS juillet 2026) : on ne "matche" QUE sur un
      // fichier RÉEL déjà reçu (même contentHash, sizeBytes > 0, présent sur
      // disque). IMPORTANT : on ne retourne JAMAIS une case vide (0 octet),
      // sinon l'iOS lit sizeBytes=0, croit l'upload échoué, et re-tente sans fin.
      // Les cases vides correspondantes seront REMPLIES/nettoyées plus bas.
      const realDup = store.exports.find((e) =>
        e.userID === user.id
        && e.projectID === projectID
        && e.contentHash === contentHash
        && (e.sizeBytes || 0) > 0
        && e.diskPath && fs.existsSync(e.diskPath)
      );
      if (realDup) {
        console.log(`[/exports/upload] dedup hit user=${user.id} file=${fileName} → reused id=${realDup.id}`);
        return res.json({
          ok: true,
          id: realDup.id,
          fileName: realDup.fileName,
          sizeBytes: realDup.sizeBytes,
          downloadPath: realDup.downloadPath,
          deduplicated: true,
        });
      }

      // Les constats sont rangés en arborescence, le reste reste à plat.
      // Un constat doit pouvoir se relire et se refaire depuis un seul dossier.
      const isConstat = isConstatArtifact({ kind, inspectionType, fileName });
      const relTarget = isConstat
        ? constatDiskTarget(reportID, kind, fileName)
        : `${exportID}_${fileName.replace(/\//g, "_")}`;
      const diskName = relTarget;
      const rawDiskPath = path.join(userDir, relTarget);
      fs.mkdirSync(path.dirname(rawDiskPath), { recursive: true });

      // Allègement des PDF : on ré-encode en JPEG les photos que l'app iOS
      // stocke en bitmap sans perte. Mesuré sur un EDL de 33 pages : 62,3 Mo
      // → 3,6 Mo, à dimensions d'image strictement inchangées.
      //
      // L'ancien gzip a été retiré : mesuré sur les PDF réellement stockés, il
      // rapportait 0,0 % (le contenu est déjà compressé) tout en rendant les
      // fichiers illisibles via /exports/files/... qui ne gère pas le `.gz`.
      let diskPath = rawDiskPath;
      let storedBytes = buffer.length;
      // L'acte d'un constat est exclu : c'est un procès-verbal de commissaire
      // de justice. Le ré-encodage est visuellement neutre, mais réécrire les
      // octets d'une pièce opposable ne se décide pas dans une route d'upload.
      // Le manque à gagner est faible (~50 Mo par acte, contre ~220 Mo d'audio
      // pour une visite de 40 min) : la prudence coûte peu ici.
      // FOXSCAN_OPTIMIZE_CONSTAT_PDF=1 pour l'activer quand même.
      const optimizeConstat = process.env.FOXSCAN_OPTIMIZE_CONSTAT_PDF === "1";
      const isPdf = fileName.toLowerCase().endsWith(".pdf")
        && (!isConstat || optimizeConstat);
      if (isPdf) {
        const opt = await optimizePdfBuffer(buffer);
        fs.writeFileSync(diskPath, opt.buffer);
        storedBytes = opt.buffer.length;
        if (opt.applied) {
          console.log(`[/exports/upload] pdf ${opt.before} → ${opt.after} octets (${Math.round(opt.ratio * 100)}%) ${fileName}`);
        } else {
          console.log(`[/exports/upload] pdf conservé tel quel (${opt.reason}) ${fileName}`);
        }
      } else {
        fs.writeFileSync(diskPath, buffer);
      }

      const downloadPath = isConstat
        ? `/exports/${exportID}/download`
        : `/exports/files/${user.id}/${diskName}`;

      // Fiche du constat : ce qui permet de le reconstituer sans la base.
      if (isConstat) {
        try {
          const dir = path.join(userDir, "constats", safeFileName(reportID || "sans-id"));
          const metaPath = path.join(dir, "meta.json");
          const prev = fs.existsSync(metaPath)
            ? JSON.parse(fs.readFileSync(metaPath, "utf8"))
            : { constatID: reportID, files: [] };
          prev.projectID = projectID || prev.projectID || null;
          prev.propertyAddress = propertyAddress || prev.propertyAddress || null;
          prev.occupant = tenantName || prev.occupant || null;
          prev.inspectionDate = inspectionDate || prev.inspectionDate || null;
          prev.updatedAt = nowIso();
          prev.files = (prev.files || []).filter((f) => f.fileName !== fileName);
          prev.files.push({ fileName, kind, sizeBytes: buffer.length, at: nowIso() });
          fs.writeFileSync(metaPath, JSON.stringify(prev, null, 2));
        } catch (e) {
          // La fiche est un confort de reconstitution : son échec ne doit
          // jamais faire perdre le fichier qu'on vient de recevoir.
          console.error("[/exports/upload] meta.json constat échoué:", e.message);
        }
      }

      const newExportEntry = {
        id: exportID,
        userID: user.id,
        projectID,
        reportID,
        createdByUserID: user.id,
        createdAt: nowIso(),
        kind,
        fileName,
        contentHash,
        sizeBytes: buffer.length,   // taille ENVOYÉE : base de réconciliation iOS, ne pas changer
        storedBytes,                // taille réellement occupée sur le disque
        diskPath,
        downloadPath,
        // Champs de groupement (peuvent être null pour anciens clients).
        inspectionType,
        propertyID,
        propertyAddress,
        tenantName,
        inspectionDate,
        createdAtDb: nowIso(),
      };

      // V6.5 — Écriture ATOMIQUE : évite que le nouvel export soit perdu par un
      // write concurrent (c'est ce qui a orphelin é les scans 3D auparavant).
      await mutateStore((fresh) => {
        fresh.exports.push(newExportEntry);

        // Création implicite du projet.
        //
        // Un constat n'est jamais annoncé : il n'existe aucun appel « créer un
        // projet constat ». Le serveur le découvre avec son premier fichier.
        // Sans cette fiche, l'acte remonte bien dans `exports` mais reste
        // invisible dans GET /projects — donc introuvable dans le dashboard.
        //
        // On ne touche JAMAIS un projet déjà connu : un EDL synchronisé depuis
        // l'app a un nom et une adresse que cet upload ne saurait pas mieux
        // renseigner.
        if (projectID) {
          fresh.projects = fresh.projects || [];
          const known = fresh.projects.find((pr) => pr.id === projectID && pr.userID === user.id);
          if (!known) {
            fresh.projects.push({
              id: projectID,
              userID: user.id,
              // « Constat du 16/09/2026 14:00 » tant que l'adresse est inconnue.
              projectName: projectNameMeta || propertyAddress || "Projet exporté",
              nameCustom: false,
              createdAt: nowIso(),
              updatedAt: nowIso(),
              updatedAtDb: nowIso(),
              status: "in_progress",
              address: propertyAddress || "",
              // Pour un constat, `tenantName` porte la PERSONNE PRÉSENTE.
              // Le dashboard doit l'afficher avec le vocabulaire de l'acte.
              tenantName: tenantName || "",
              landlordName: "",
              inspectionType: isConstat ? "constat" : (inspectionType || null),
              product: isConstat ? "constat" : "edl",
              origin: "app",
              isArchived: false,
              archivedAt: null,
              scheduledAt: null,
              propertyImageFileName: null,
            });
          } else {
            // Complément au fil des envois.
            //
            // L'app envoie la matière première AVANT l'acte : le projet naît
            // donc d'une bande audio, sans nom ni adresse — ceux-ci n'arrivent
            // qu'avec le PDF, en dernier. Sans ce rattrapage, la fiche resterait
            // pour toujours « Projet exporté » à l'adresse « - ».
            //
            // On ne remplit que les cases VIDES : un nom choisi dans le
            // dashboard (`nameCustom`) et une adresse déjà connue ne sont
            // jamais écrasés par un upload.
            let touched = false;
            const fillIn = (field, value) => {
              if (!value) return;
              const cur = known[field];
              if (cur && String(cur).trim() && String(cur).trim() !== "-") return;
              known[field] = value;
              touched = true;
            };
            if (!known.nameCustom) {
              const generic = !known.projectName
                || known.projectName === "Projet exporté"
                || known.projectName === "Projet";
              if (generic && (projectNameMeta || propertyAddress)) {
                known.projectName = projectNameMeta || propertyAddress;
                touched = true;
              }
            }
            fillIn("address", propertyAddress);
            fillIn("tenantName", tenantName);
            fillIn("inspectionDate", inspectionDate);

            // Un projet peut être vu d'abord par une photo, puis identifié
            // comme constat par l'acte. Le marqueur ne se pose qu'en avant.
            if (isConstat && known.product !== "constat") {
              known.product = "constat";
              known.inspectionType = "constat";
              touched = true;
            }
            if (touched) known.updatedAt = nowIso();
          }
        }
        // Nettoyage : supprime les anciennes "cases vides" (0 octet) qui
        // correspondent à ce fichier (même contentHash ou même nom) — l'app
        // vient d'en envoyer le vrai binaire, le placeholder n'a plus lieu d'être.
        fresh.exports = fresh.exports.filter((e) =>
          e.id === exportID ||
          !(
            e.userID === user.id
            && e.projectID === projectID
            && (e.sizeBytes || 0) === 0
            && ((contentHash && e.contentHash === contentHash) || e.fileName === fileName)
          )
        );
        if (reportID) {
          attachExportToReport(fresh.reports, reportID, {
            userID: user.id,
            projectID: projectID || "",
            projectName: projectNameMeta || propertyAddress || "Projet exporté",
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
      });
      console.log(
        `[/exports/upload] user=${user.id} file=${fileName} bytes=${buffer.length} kind=${kind}` +
        (propertyID ? ` propertyID=${propertyID} type=${inspectionType || "?"}` : "")
      );

      // ── AUTO-EXTRACTION du bundle si c'est un inspectionBundle JSON ──
      // On parse, extrait les fichiers binaires sur disque dans
      // data/projects/<projectID>/ et on stocke les metadata dans _meta.json.
      // Le bundle d'origine reste aussi accessible via /exports/files/...
      let extractedProject = null;
      // V6.5 — Auto-extraction ROBUSTE : on déclenche dès qu'un JSON contient
      // des fichiers embarqués (`files[]`), peu importe le `kind` déclaré par
      // l'app. Avant, seul `kind === "inspectionBundle"` déclenchait, donc un
      // backup arrivé avec un autre kind restait "piégé" (photos invisibles).
      const looksLikeJsonBundle =
        fileName.toLowerCase().endsWith(".json") ||
        /_foxscan_backup\.json$/i.test(fileName) ||
        (buffer.length > 2 && buffer[0] === 0x7B); // commence par '{'
      if (looksLikeJsonBundle) {
        try {
          const bundle = JSON.parse(buffer.toString("utf-8"));
          if (Array.isArray(bundle.files) && bundle.files.length > 0) {
            extractedProject = await ingestParsedBundle(user.id, bundle);
            // Persister le projectID extrait dans l'entry export pour que le
            // dashboard puisse rediriger vers /api/projects/<id>/...
            await mutateStore((fresh) => {
              const ee = fresh.exports.find((e) => e.id === exportID);
              if (ee) ee.extractedProjectID = extractedProject.projectID;
            });
            console.log(
              `[/exports/upload] auto-extracted projectID=${extractedProject.projectID} ` +
              `files=${extractedProject.filesCount}` +
              (extractedProject.warnings?.length ? ` warnings=${extractedProject.warnings.length}` : "")
            );
          }
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
    // Lecture TOUJOURS autorisée : un compte bloqué doit continuer à
    // consulter et exporter les EDL qu'il a déjà réalisés. Seule la
    // CRÉATION d'un nouvel EDL est soumise au quota d'essai.

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
    // Lecture TOUJOURS autorisée : un compte bloqué doit continuer à
    // consulter et exporter les EDL qu'il a déjà réalisés. Seule la
    // CRÉATION d'un nouvel EDL est soumise au quota d'essai.

  // Index des projets et rapports pour enrichir les groupes sans propertyID
  const projectsById = new Map((store.projects || []).filter((p) => p.userID === user.id).map((p) => [p.id, p]));
  const reportsByProjectId = new Map();
  for (const r of (store.reports || []).filter((r) => r.userID === user.id)) {
    if (r.projectID && !reportsByProjectId.has(r.projectID)) reportsByProjectId.set(r.projectID, r);
  }

  const allUserExports = store.exports.filter((e) => e.userID === user.id);

  const groups = new Map(); // clé = propertyID réel ou "proj-<projectID>"

  const pushExport = (groupKey, e, meta) => {
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        propertyID: groupKey,
        address: meta.address || null,
        tenantName: meta.tenantName || null,
        firstSeenAt: e.createdAt || e.createdAtDb,
        lastSeenAt: e.createdAt || e.createdAtDb,
        counts: { entry: 0, exit: 0, inventory: 0, other: 0, total: 0 },
        exports: [],
      });
    }
    const g = groups.get(groupKey);
    if (meta.address) g.address = meta.address;
    if (meta.tenantName) g.tenantName = meta.tenantName;
    if (e.createdAt && new Date(e.createdAt) > new Date(g.lastSeenAt || 0)) g.lastSeenAt = e.createdAt;
    if (e.createdAt && new Date(e.createdAt) < new Date(g.firstSeenAt || Date.now())) g.firstSeenAt = e.createdAt;
    const t = e.inspectionType || "other";
    if (g.counts[t] !== undefined) g.counts[t] += 1; else g.counts.other += 1;
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
      projectID: e.projectID || null,
      extractedProjectID: e.extractedProjectID || null,
    });
  };

  for (const e of allUserExports) {
    if (e.propertyID) {
      // Groupe par propertyID réel (cas normal avec iOS récent)
      pushExport(e.propertyID, e, {
        address: e.propertyAddress || null,
        tenantName: e.tenantName || null,
      });
    } else if (e.projectID) {
      // Fallback : groupe par projectID pour les exports sans propertyID
      const proj = projectsById.get(e.projectID);
      const rep = reportsByProjectId.get(e.projectID);
      pushExport(`proj-${e.projectID}`, e, {
        address: proj?.address || rep?.address || e.propertyAddress || null,
        tenantName: proj?.tenantName || rep?.tenantName || e.tenantName || null,
      });
    }
  }

  const items = Array.from(groups.values())
    .map((g) => {
      const pid = g.exports[0]?.projectID || null;
      const proj = pid ? projectsById.get(pid) : null;
      return {
        ...g,
        // Nom personnalisé (renommage web) exposé au dashboard, sinon null.
        projectName: proj?.nameCustom ? (proj.projectName || null) : null,
        notes: proj?.notes || null,
        exports: g.exports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      };
    })
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));

  res.json({ ok: true, items, total: items.length });
});

// Liste les fichiers contenus dans un bundle JSON (sauvegarde complète)
// pour permettre la visualisation directe dans le dashboard (PDF, photos, USDZ).
// GET /exports/:exportID/download — sert un artefact par son identifiant.
// Indispensable pour les constats, rangés en arborescence : la route plate
// /exports/files/:userID/:fileName ne sait pas descendre dans les dossiers.
// GET /constats — les constats de l'utilisateur, regroupés par acte.
//
// Section délibérément SÉPARÉE des états des lieux : un constat de commissaire
// de justice et un EDL locatif sont deux actes de nature différente, ils ne
// doivent jamais apparaître dans la même liste.
app.get("/constats", requireCurrentUser, (req, res) => {
  const store = req._store;
  const mine = (store.exports || []).filter(
    (e) => e.userID === req._user.id &&
           isConstatArtifact({ kind: e.kind, inspectionType: e.inspectionType, fileName: e.fileName }),
  );

  const byConstat = new Map();
  for (const e of mine) {
    const id = e.reportID || "sans-id";
    if (!byConstat.has(id)) {
      byConstat.set(id, {
        constatID: id,
        projectID: e.projectID || null,
        propertyAddress: e.propertyAddress || null,
        occupant: e.tenantName || null,
        inspectionDate: e.inspectionDate || null,
        acte: null,
        acteVersions: [],
        audio: [],
        photos: [],
        totalBytes: 0,
        createdAt: e.createdAt || null,
      });
    }
    const c = byConstat.get(id);
    c.totalBytes += e.sizeBytes || 0;
    if (!c.createdAt || String(e.createdAt) < String(c.createdAt)) c.createdAt = e.createdAt;
    c.propertyAddress = c.propertyAddress || e.propertyAddress || null;
    c.occupant = c.occupant || e.tenantName || null;
    c.inspectionDate = c.inspectionDate || e.inspectionDate || null;

    const item = {
      id: e.id,
      fileName: e.fileName,
      sizeBytes: e.sizeBytes || 0,
      createdAt: e.createdAt || null,
      downloadPath: e.downloadPath || null,
    };
    if (e.kind === "constatPDF") {
      // L'app régénère l'acte après correction : plusieurs PDF coexistent
      // pour un même constat. On présente le plus récent — pas celui que
      // l'ordre de stockage fait remonter en premier — et on garde la trace
      // des précédents, que rien ne doit effacer en silence.
      c.acteVersions.push(item);
    } else if (/\.(caf|m4a|wav|mp3)$/i.test(e.fileName || "")) c.audio.push(item);
    else c.photos.push(item);
  }

  // L'ordre des prises et des photos porte le récit : on le préserve.
  const items = [...byConstat.values()].map((c) => {
    c.audio.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
    c.photos.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
    // Plus récent en tête.
    c.acteVersions.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    c.acte = c.acteVersions[0] || null;
    return c;
  }).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  res.json({ ok: true, items, total: items.length });
});

app.get("/exports/:exportID/download", requireCurrentUser, (req, res) => {
  const store = req._store;
  const exp = (store.exports || []).find((e) => e.id === req.params.exportID);
  if (!exp) return res.status(404).json({ ok: false, detail: "Export not found" });
  if (exp.userID !== req._user.id) {
    return res.status(403).json({ ok: false, detail: "Not your file" });
  }
  if (!exp.diskPath || !fs.existsSync(exp.diskPath)) {
    return res.status(404).json({ ok: false, detail: "File not found on disk" });
  }
  if (exp.diskPath.endsWith(".gz")) res.setHeader("Content-Encoding", "gzip");

  // L'app envoie tout en `application/octet-stream` : c'est au serveur de
  // redonner son type au fichier. Sans cela le navigateur propose un
  // téléchargement opaque là où il pourrait lire la bande ou afficher l'acte.
  const ext = path.extname(exp.diskPath).toLowerCase();
  const byExt = {
    ".caf": "audio/x-caf",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".heic": "image/heic",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".usdz": "model/vnd.usdz+zip",
    ".glb": "model/gltf-binary",
  };
  if (byExt[ext]) res.type(byExt[ext]);

  // Nom d'origine — `constat-media/audio/prise-001.caf` est rangé en
  // `media/audio/prise-001.caf` : sans en-tête, l'utilisateur récupérerait
  // un fichier nommé d'après l'arborescence interne.
  const original = path.basename(exp.fileName || exp.diskPath);
  res.setHeader("Content-Disposition", `inline; filename="${original.replace(/"/g, "")}"`);

  return res.sendFile(path.resolve(exp.diskPath));
});

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
        doc.text(`• ${fmt(m.kind || m.type || m.label || "Compteur")} — N° ${fmt(m.meterNumber || m.serial || m.number)} — Index : ${fmt(m.indexValue)} ${fmt(m.unit || "")}`.trim());
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
        if (doc.y > 680) doc.addPage();
        doc.moveDown(0.6);
        doc.fillColor("#1D1D1F").fontSize(13).font("Helvetica-Bold").text(`${idx + 1}. ${fmt(room.roomName || room.name || room.label || "Pièce")}`);
        if (Array.isArray(room.items)) {
          doc.fillColor("#1D1D1F").fontSize(10).font("Helvetica");
          room.items.forEach((it) => {
            if (doc.y > 700) doc.addPage();
            const label = fmt(it.designation || it.element || it.label || it.name);
            const entry = it.conditionEntry || it.condition || it.state || it.value;
            const exit = it.conditionExit;
            const state = (entry && exit && exit !== entry)
              ? `${fmt(entry)} -> ${fmt(exit)}`
              : fmt(entry || exit);
            const note = it.observation || it.note || it.comment;
            doc.text(`  * ${label} : ${state}${note ? " -- " + note : ""}`);
          });
        }
        if (room.notes) {
          if (doc.y > 700) doc.addPage();
          doc.fillColor("#86868B").fontSize(9).font("Helvetica-Oblique")
            .text(`  Obs. : ${room.notes}`)
            .fillColor("#1D1D1F").font("Helvetica").fontSize(10);
        }
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
        const qty = k.quantityTotal || k.quantity || 0;
        doc.text(`• ${fmt(k.destination)} (${fmt(k.itemType || k.type, "clé")}) — État : ${fmt(k.functionality)}${qty ? ` (x${qty})` : ""}`);
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
          address: meta.project?.address || null,
          tenantName: meta.project?.tenantName || null,
          tenantEmail: meta.project?.tenantEmail || null,
          landlordName: meta.project?.landlordName || null,
          inspectionType: meta.project?.inspectionType || null,
          // V5.3.47 — Champs métier étendus (lus par l'app iOS).
          ...draftBusinessFieldsShape(meta.project || {}),
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
        tenantEmail: proj.tenantEmail || null,
        landlordName: proj.landlordName || null,
        inspectionType: proj.inspectionType || null,
        // V5.3.47 — Champs métier étendus partagés avec l'app iOS.
        ...draftBusinessFieldsShape(proj),
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

// V5.3.26 — Endpoint qui retourne TOUS les EDL d'un projet (pluriel).
// Bug observé 2026-05-18 : la route /inspection (singulier) ci-dessus ne
// retournait QUE le report le plus récent, ce qui faisait croire que
// l'EDL de sortie était "supprimé" après duplication en EDL d'entrée
// pour nouveaux occupants (cf. duplicateForNewTenant côté iOS).
//
// Cette nouvelle route permet au dashboard d'afficher la liste complète
// des EDL d'un projet (sortie + entrée + …), avec leurs payloads.
//
// Réponse :
// {
//   ok: true,
//   count: N,
//   reports: [
//     { id, projectID, fileName, createdAt, tenantName, isFinalized,
//       finalizedAt, inspectionType, payload: {...full report...} }
//   ]
// }
app.get("/api/projects/:projectID/inspections", requireCurrentUser, (req, res) => {
  const projectID = safeProjectID(req.params.projectID);
  if (!projectID) {
    return res.status(400).json({ ok: false, detail: "Invalid projectID" });
  }
  const user = req._user;

  try {
    const store = req._store;
    const project = (store.projects || []).find(
      (p) => p.id === projectID && p.userID === user.id
    );
    if (!project) {
      return res.status(404).json({ ok: false, detail: "Project not found" });
    }

    const reports = (store.reports || [])
      .filter((r) => r.projectID === projectID && r.userID === user.id)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .map((r) => {
        // L'app réinjecte `payload` tel quel comme état des lieux : on ne lui
        // sert jamais la fiche d'un export à la place. Si le contenu a été
        // perdu ici, on reprend celui gardé sur le projet (même rapport),
        // sinon rien — l'app ignore un rapport sans contenu.
        let payload = r.payload || null;
        if (!isInspectionPayload(payload)) {
          const kept = project.payload && project.payload.report;
          payload = kept && kept.id === r.id && isInspectionPayload(kept) ? kept : null;
        }
        return {
          id: r.id,
          projectID: r.projectID,
          fileName: r.fileName || `${r.id}.pdf`,
          createdAt: r.createdAt,
          // Métadonnées de surface pour affichage liste sans déballer payload
          tenantName: r.tenantName || r.payload?.tenantName || null,
          isFinalized: r.isFinalized === true || r.payload?.isFinalized === true,
          finalizedAt: r.finalizedAt || r.payload?.finalizedAt || null,
          inspectionType: r.payload?.inspectionType || null,
          address: r.address || null,
          // Payload complet pour navigation détaillée
          payload,
        };
      });

    return res.json({
      ok: true,
      count: reports.length,
      reports,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, detail: e.message });
  }
});

// V5.3.26 — Endpoint pour récupérer un report par son ID (complet).
// Permet à l'app iOS de "tirer" depuis le backend un report qu'elle aurait
// perdu localement (recovery scenario). Ownership vérifié via JWT.
app.get("/api/reports/:reportID", requireCurrentUser, (req, res) => {
  const reportID = String(req.params.reportID || "").trim();
  if (!reportID) {
    return res.status(400).json({ ok: false, detail: "Invalid reportID" });
  }
  const user = req._user;

  try {
    const store = req._store;
    const report = (store.reports || []).find(
      (r) => r.id === reportID && r.userID === user.id
    );
    if (!report) {
      return res.status(404).json({ ok: false, detail: "Report not found" });
    }
    // Pour les rapports créés via /exports/upload, le payload peut être sparse
    // (juste des métadonnées, sans roomConditions). On complète depuis store.projects.
    const rawPayload = report.payload || {};
    const hasRoomData = Array.isArray(rawPayload.roomConditions) && rawPayload.roomConditions.length > 0;
    let fullPayload = rawPayload;
    if (!hasRoomData && report.projectID) {
      const proj = (store.projects || []).find((p) => p.id === report.projectID);
      if (proj) {
        const projectReportData = (proj.payload || {}).report || proj.payload || {};
        if (Object.keys(projectReportData).length) {
          fullPayload = { ...projectReportData, ...rawPayload };
        }
      }
    }
    return res.json({
      ok: true,
      report: {
        id: report.id,
        projectID: report.projectID,
        fileName: report.fileName,
        createdAt: report.createdAt,
        tenantName: fullPayload.tenantName || report.tenantName || null,
        isFinalized: report.isFinalized === true,
        finalizedAt: report.finalizedAt || null,
        inspectionType: report.inspectionType || fullPayload.inspectionType || null,
        address: fullPayload.address || report.address || null,
        payload: fullPayload,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, detail: e.message });
  }
});

// ── GET /api/reports/:reportID/pdf ────────────────────────────────────────
//
// Télécharge le PDF d'un rapport SYNCHRONISÉ (store.reports). Contrairement à
// /api/projects/:id/report.pdf qui exige un bundle extrait sur disque, cet
// endpoint fonctionne même quand le rapport vient uniquement de la sync iOS
// (pas de _meta.json). Stratégie :
//   1. Si un PDF natif existe dans le bundle extrait → on le sert tel quel
//   2. Sinon → on génère le PDF côté serveur depuis report.payload
app.get("/api/reports/:reportID/pdf", requireCurrentUser, (req, res) => {
  const reportID = String(req.params.reportID || "").trim();
  if (!reportID) {
    return res.status(400).json({ ok: false, detail: "Invalid reportID" });
  }
  const user = req._user;
  const store = req._store;
  const report = (store.reports || []).find(
    (r) => r.id === reportID && r.userID === user.id
  );
  if (!report) {
    return res.status(404).json({ ok: false, detail: "Report not found" });
  }

  // Stratégie 1a : PDF natif présent dans un bundle extrait pour ce projet ?
  const projID = safeProjectID(report.projectID || "");
  if (projID) {
    const nativePdfPath = path.join(PROJECTS_ROOT, projID, "inspection_report.pdf");
    if (fs.existsSync(nativePdfPath)) {
      let okOwner = true;
      try {
        const metaPath = path.join(PROJECTS_ROOT, projID, "_meta.json");
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          okOwner = meta.userID === user.id;
        }
      } catch { okOwner = true; }
      if (okOwner) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="EDL_${projID}.pdf"`);
        res.setHeader("X-FOXSCAN-PDF-Source", "native");
        return fs.createReadStream(nativePdfPath).pipe(res);
      }
    }
  }

  // Stratégie 1b : PDF uploadé par iOS via /exports/upload (inspectionBundle .pdf) ?
  // L'iOS génère son propre PDF (avec photos, logos, signatures) et l'uploade
  // directement — il est stocké dans store.exports avec kind="inspectionBundle".
  {
    const pdfExport = (store.exports || []).find(
      (e) =>
        e.userID === user.id &&
        (e.projectID === projID || e.reportID === reportID) &&
        (e.kind === "inspectionBundle" || e.kind === "inspectionPDF") &&
        typeof e.fileName === "string" &&
        e.fileName.toLowerCase().endsWith(".pdf") &&
        e.diskPath &&
        (e.sizeBytes || 0) > 50000 && // filtre les stubs < 50 KB
        fs.existsSync(e.diskPath)
    );
    if (pdfExport) {
      const safeFilename = (pdfExport.fileName || "rapport.pdf")
        .replace(/[^\w\-. À-ɏ]/g, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeFilename}"`
      );
      res.setHeader("X-FOXSCAN-PDF-Source", "export-bundle");
      // Si le PDF est stocké compressé (.gz), on envoie les octets gzip directement.
      // Le navigateur / URLSession iOS décompresse nativement (HTTP Content-Encoding).
      if (pdfExport.diskPath.endsWith(".gz")) {
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Vary", "Accept-Encoding");
      }
      return fs.createReadStream(pdfExport.diskPath).pipe(res);
    }
  }

  // Stratégie 2 : générer le PDF depuis le payload structuré du rapport.
  const payload = report.payload || {};

  // Certains reports sont créés via /exports/upload et n'ont qu'un payload
  // de métadonnées (fileName, contentHash, kind…) sans les données EDL.
  // Dans ce cas on récupère les vraies données depuis store.projects.
  const hasRoomData = Array.isArray(payload.roomConditions) && payload.roomConditions.length > 0;
  let projectReportData = {};
  if (!hasRoomData && report.projectID) {
    const proj = (store.projects || []).find((p) => p.id === report.projectID);
    if (proj) {
      // store.projects.payload peut être soit le body complet (inspections/sync)
      // soit directement le report iOS (exports/upload).
      projectReportData = (proj.payload || {}).report || proj.payload || {};
    }
  }

  const base = Object.keys(projectReportData).length
    ? { ...projectReportData, ...payload }
    : payload;
  const reportData = {
    ...base,
    address: base.address || report.address || "Bien immobilier",
    inspectionType: base.inspectionType || report.inspectionType || "other",
    inspectionDate:
      base.inspectionDate || base.finalizedAt || base.entryDate ||
      report.finalizedAt || report.createdAt || null,
    agentName: base.agentName || "FOXSCAN",
    tenantName: base.tenantName || report.tenantName || null,
  };

  try {
    generateInspectionPDF(reportData, { name: reportData.address }, res, [], loadPdfCustomization(store, user), loadAgencyProfile(store, user));
  } catch (err) {
    console.error("[/api/reports/:id/pdf] gen failed:", err);
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ ok: false, detail: "PDF generation failed: " + err.message });
    }
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

// ── ROUTE 5b : GET /api/projects/:projectID/photos ─────────────────────────
//
// Retourne la liste de toutes les photos disponibles pour ce projet :
//   A) Photos issues du bundle extrait (répertoire data/projects/<id>/)
//   B) Exports individuels de type image (kind=inspectionPhoto, mediaArchive,
//      ou fichier dont le nom se termine par .jpg/.jpeg/.png/.heic/.heif)
// Chaque entrée a { fileName, filePath, kind, exportID?, mimeType? }
// Le client utilise ensuite GET /api/projects/:id/files/<fileName> pour
// récupérer le binaire avec authentification.
app.get("/api/projects/:projectID/photos", requireCurrentUser, (req, res) => {
  const projectID = safeProjectID(req.params.projectID);
  if (!projectID) {
    return res.status(400).json({ ok: false, detail: "Invalid projectID" });
  }
  const user = req._user;
  const photoExts = /\.(jpe?g|png|heic|heif|webp|gif|bmp)$/i;
  const photos = [];

  // Source A : bundle extrait (arborescence sur disque)
  const projectDir = path.join(PROJECTS_ROOT, projectID);
  if (fs.existsSync(projectDir)) {
    try {
      const metaPath = path.join(projectDir, "_meta.json");
      let ownerOk = false;
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          ownerOk = meta.userID === user.id;
        } catch { /* ignore */ }
      }
      if (ownerOk) {
        const walk = (dir, rel) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { walk(path.join(dir, entry.name), relPath); continue; }
            if (photoExts.test(entry.name)) {
              photos.push({ fileName: relPath, filePath: relPath, kind: "bundlePhoto", source: "bundle" });
            }
          }
        };
        walk(projectDir, "");
      }
    } catch { /* fall through */ }
  }

  // Source B : exports individuels
  try {
    const store = req._store;
    const project = (store.projects || []).find(
      (p) => p.id === projectID && p.userID === user.id
    );
    if (!project && photos.length === 0) {
      return res.status(404).json({ ok: false, detail: "Project not found" });
    }
    const exports = (store.exports || []).filter(
      (e) => e.projectID === projectID && e.userID === user.id && e.diskPath
    );
    for (const e of exports) {
      const isImage = photoExts.test(e.fileName || "") ||
        (e.mimeType || "").startsWith("image/") ||
        e.kind === "inspectionPhoto";
      if (!isImage) continue;
      // Évite les doublons (même fileName déjà trouvé via bundle)
      if (photos.some((p) => p.fileName === e.fileName)) continue;
      photos.push({
        fileName: e.fileName,
        filePath: e.fileName,
        kind: e.kind || "inspectionPhoto",
        exportID: e.id,
        mimeType: e.mimeType || null,
        source: "store",
        roomName: e.roomName || null,
        createdAt: e.createdAt || null,
      });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, detail: e.message });
  }

  return res.json({ ok: true, count: photos.length, photos });
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
    generateInspectionPDF(report, ctx.meta.project, res, ctx.meta.files || [], loadPdfCustomization(req._store, req._user), loadAgencyProfile(req._store, req._user));
  } catch (err) {
    console.error("[/api/projects/:id/report.pdf] gen failed:", err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, detail: "PDF generation failed: " + err.message });
    }
  }
});

// Charge la config PDF personnalisée (couleurs, titres, pied de page) de
// l'agence du user, fusionnée avec les valeurs par défaut. Retourne toujours
// un objet exploitable (defaults si rien de stocké). Défensif : ne throw jamais.
function loadPdfCustomization(store, user) {
  try {
    const ownerId = pdfCustOwnerId(user);
    if (!ownerId || !store) return PDF_CUSTOMIZATION_DEFAULTS;
    const entry = (store.pdfCustomizations || {})[ownerId];
    return entry?.payload
      ? pdfCustDeepMerge(PDF_CUSTOMIZATION_DEFAULTS, entry.payload)
      : PDF_CUSTOMIZATION_DEFAULTS;
  } catch {
    return PDF_CUSTOMIZATION_DEFAULTS;
  }
}

// Helper de génération PDF réutilisable (déjà extrait pour /exports/:id/generated-pdf)
// `cust` = config PDF personnalisée (cf. loadPdfCustomization). Si null/absent,
// les couleurs/titres retombent sur les valeurs d'origine → rendu inchangé.
function generateInspectionPDF(report, project, res, files = [], cust = null, agency = null) {
  // ── Branding personnalisé (configurateur « Personnaliser PDF ») ───────────
  const _hex = (v, fb) => "#" + String(v || fb).replace(/^#/, "");
  const ACCENT = _hex(cust?.colors?.accentHex, "0071E3"); // titres de section
  const INK = _hex(cust?.colors?.inkHex, "1D1D1F");       // texte courant
  const COVER_TITLE = (cust?.texts?.coverTitle || "ÉTAT DES LIEUX").toUpperCase();
  // Pied de page : la ligne personnalisée (configurateur) prime ; sinon on
  // compose automatiquement les coordonnées de l'agence (profil agence).
  const FOOTER_LINE =
    String(cust?.texts?.footerCustomLine || "").trim() || composeAgencyFooter(agency);

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
  // bufferPages: true → on peut revenir écrire le pied de page sur CHAQUE page
  // après coup (cf. _writeFooters avant doc.end()). Écrire le footer pendant le
  // flux provoquerait une récursion infinie (texte en bas → addPage → footer…).
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true, info: {
    Title: `EDL ${projectName} — ${fmtDate(report.inspectionDate)}`,
    Author: "FOXSCAN",
    Subject: "État des lieux",
  }});

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="EDL_${(report.address || projectName).replace(/[^A-Za-z0-9]/g, "_")}.pdf"`);
  res.setHeader("X-FOXSCAN-PDF-Source", "generated"); // header debug : généré côté serveur
  doc.pipe(res);
  // (Le pied de page — ligne agence personnalisée + numéros de page — est écrit
  //  sur toutes les pages à la fin, via la boucle bufferedPageRange.)

  // ── Logo agence (page de garde) ──────────────────────────────────────────
  // Rendu centré au-dessus du titre. Toute erreur de décodage est ignorée pour
  // ne jamais casser la génération du PDF.
  const logoBuf = decodeLogoDataUrl(cust?.branding?.logoDataUrl);
  if (logoBuf) {
    try {
      const LOGO_H = 64;
      doc.image(logoBuf, doc.page.margins.left, doc.y, {
        fit: [495, LOGO_H],
        align: "center",
      });
      doc.y += LOGO_H + 14;
    } catch (e) {
      console.error("[generateInspectionPDF] logo render failed:", e.message);
    }
  }

  // En-tête
  doc.fillColor(ACCENT).fontSize(28).font("Helvetica-Bold").text(COVER_TITLE, { align: "center" });
  doc.moveDown(0.3);
  doc.fillColor(INK).fontSize(14).font("Helvetica").text(inspectionTypeLabel(report.inspectionType), { align: "center" });
  doc.moveDown(2);

  const startY = doc.y;
  doc.rect(50, startY, 495, 110).fillAndStroke("#F5F5F7", "#E5E5EA");
  doc.fillColor(INK).fontSize(11).font("Helvetica");
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
  doc.moveDown(1).fillColor(ACCENT).fontSize(14).font("Helvetica-Bold").text("Parties");
  doc.fillColor(INK).fontSize(10).font("Helvetica").moveDown(0.5);
  doc.font("Helvetica-Bold").text("Locataire :");
  doc.font("Helvetica").text(`Nom : ${fmt(report.tenantName)}`)
     .text(`Email : ${fmt(report.tenantEmail)}`)
     .text(`Téléphone : ${fmt(report.tenantPhone)}`);
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").text("Bailleur :");
  doc.font("Helvetica").text(`Nom : ${fmt(report.landlordName)}`)
     .text(`Contact : ${fmt(report.landlordContact)}`);

  // Caractéristiques
  doc.moveDown(1).fillColor(ACCENT).fontSize(14).font("Helvetica-Bold").text("Caractéristiques");
  doc.fillColor(INK).fontSize(10).font("Helvetica").moveDown(0.4);
  doc.text(`Nombre de pièces : ${fmt(report.roomCount)}   ·   Meublé : ${fmt(report.furnished)}   ·   Cuisine équipée : ${fmt(report.kitchenEquipped)}`);
  doc.text(`Chauffage : ${fmt(report.heatingType)}   ·   Eau chaude : ${fmt(report.hotWaterType)}`);
  doc.text(`Cave : ${fmtBool(report.hasCellar)} (${fmt(report.cellarCount, 0)})   ·   Garage : ${fmtBool(report.hasGarage)} (${fmt(report.garageCount, 0)})   ·   Balcon : ${fmtBool(report.hasBalcony)}   ·   BAL : ${fmtBool(report.hasMailbox)}`);

  // Compteurs
  if (Array.isArray(report.meters) && report.meters.length > 0) {
    doc.moveDown(1).fillColor(ACCENT).fontSize(14).font("Helvetica-Bold").text("Relevés des compteurs");
    doc.fillColor(INK).fontSize(10).font("Helvetica").moveDown(0.4);
    report.meters.forEach((m) => doc.text(`• ${fmt(m.kind || m.type || m.label || "Compteur")} — N° ${fmt(m.meterNumber || m.serial || m.number)} — Index : ${fmt(m.indexValue)} ${fmt(m.unit || "")}`.trim()));
  }

  // V5 — Détecteur de fumée (obligation R129-12 CCH)
  // Section affichée systématiquement pour acter contradictoirement la
  // présence ou l'absence (ne pas omettre → faille légale).
  doc.moveDown(1).fillColor(ACCENT).fontSize(14).font("Helvetica-Bold")
    .text("Détecteurs de fumée");
  doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique")
    .text("Obligation légale R129-12 CCH (loi 2010-238). À vérifier dans les zones de circulation.")
    .moveDown(0.2);
  doc.fillColor(INK).fontSize(10).font("Helvetica");
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
        .text(`${smokePhotos} photo${smokePhotos > 1 ? "s" : ""} jointe${smokePhotos > 1 ? "s" : ""} au dossier.`)
        .fillColor(INK).font("Helvetica").fontSize(10);
    }
  } else {
    doc.fillColor("#FF3B30").text("Aucun détecteur de fumée mentionné — vérification à confirmer par le bailleur.")
       .fillColor(INK);
  }

  // V5 — Entretien chaudière (obligation R224-41-4 Code de l'environnement)
  doc.moveDown(1).fillColor(ACCENT).fontSize(14).font("Helvetica-Bold")
    .text("Entretien chaudière");
  doc.fillColor("#86868B").fontSize(8).font("Helvetica-Oblique")
    .text("Obligation d'entretien annuel — art. R224-41-4 Code de l'environnement (décret 2009-649).")
    .moveDown(0.2);
  doc.fillColor(INK).fontSize(10).font("Helvetica");
  const hasBoiler = report.hasBoiler === true;
  if (!hasBoiler) {
    doc.font("Helvetica-Oblique").fillColor("#86868B")
      .text("Aucune chaudière individuelle dans le logement (chauffage collectif, électrique ou autre).")
      .fillColor(INK).font("Helvetica");
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
    doc.fillColor(INK).font("Helvetica");
    if (report.boilerNotes) {
      doc.text(`Observations : ${fmt(report.boilerNotes)}`);
    }
    const boilerPhotos = Array.isArray(report.boilerPhotoFileNames)
      ? report.boilerPhotoFileNames.length : 0;
    if (boilerPhotos > 0) {
      doc.fillColor("#86868B").fontSize(9).font("Helvetica-Oblique")
        .text(`${boilerPhotos} photo${boilerPhotos > 1 ? "s" : ""} jointe${boilerPhotos > 1 ? "s" : ""} au dossier.`)
        .fillColor(INK).font("Helvetica").fontSize(10);
    }
  }

  // Pièces
  if (Array.isArray(report.roomConditions) && report.roomConditions.length > 0) {
    doc.addPage();
    doc.fillColor(ACCENT).fontSize(18).font("Helvetica-Bold").text("État pièce par pièce").moveDown(0.5);
    report.roomConditions.forEach((room, idx) => {
      if (doc.y > 680) doc.addPage();
      doc.moveDown(0.6);
      // iOS envoie `roomName` (Swift Codable), fallback sur `name`/`label` pour rétrocompat.
      doc.fillColor(INK).fontSize(13).font("Helvetica-Bold").text(`${idx + 1}. ${fmt(room.roomName || room.name || room.label || "Pièce")}`);
      if (Array.isArray(room.items)) {
        doc.fillColor(INK).fontSize(10).font("Helvetica");
        room.items.forEach((it) => {
          if (doc.y > 700) doc.addPage();
          // iOS : `designation` = nom de l'élément ; `conditionEntry`/`conditionExit` = état.
          const label = fmt(it.designation || it.element || it.label || it.name);
          const entry = it.conditionEntry || it.condition || it.state || it.value;
          const exit = it.conditionExit;
          const state = (entry && exit && exit !== entry)
            ? `${fmt(entry)} -> ${fmt(exit)}`
            : fmt(entry || exit);
          // iOS : `observation` = note libre ; fallback `note`/`comment`.
          const note = it.observation || it.note || it.comment;
          doc.text(`  * ${label} : ${state}${note ? " -- " + note : ""}`);
        });
      }
      // Observations de niveau pièce (iOS : `notes`)
      if (room.notes) {
        if (doc.y > 700) doc.addPage();
        doc.fillColor("#86868B").fontSize(9).font("Helvetica-Oblique")
          .text(`  Obs. : ${room.notes}`)
          .fillColor(INK).font("Helvetica").fontSize(10);
      }
    });
  }

  // Comparaison
  if (Array.isArray(report.comparisonItems) && report.comparisonItems.length > 0) {
    doc.addPage();
    doc.fillColor(ACCENT).fontSize(18).font("Helvetica-Bold").text("Comparaison entrée / sortie");
    doc.fillColor(INK).fontSize(10).font("Helvetica").moveDown(0.5);
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
    doc.fillColor(ACCENT).fontSize(14).font("Helvetica-Bold").text("Inventaire des clés");
    doc.fillColor(INK).fontSize(10).font("Helvetica").moveDown(0.5);
    report.keyInventory.forEach((k) => {
      const qty = k.quantityTotal || k.quantity || 0;
      doc.text(`• ${fmt(k.destination)} (${fmt(k.itemType || k.type, "clé")}) — État : ${fmt(k.functionality)}${qty ? ` (x${qty})` : ""}`);
    });
  }

  // Inventaire des fichiers extraits du bundle (utile quand le rapport est minimal)
  if (Array.isArray(files) && files.length > 0) {
    doc.moveDown(1).fillColor(ACCENT).fontSize(14).font("Helvetica-Bold").text("Fichiers du dossier");
    doc.fillColor(INK).fontSize(10).font("Helvetica").moveDown(0.5);
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
  doc.fillColor(INK).fontSize(10).font("Helvetica");
  if (tenantReserves) {
    doc.text(tenantReserves, { align: "justify" });
  } else {
    doc.fillColor("#86868B").font("Helvetica-Oblique")
      .text("Aucune réserve formulée par le locataire à l'issue de la visite.")
      .fillColor(INK).font("Helvetica");
  }

  // Signatures + mention légale
  doc.moveDown(2).fillColor(ACCENT).fontSize(14).font("Helvetica-Bold").text("Signatures");
  doc.fillColor(INK).fontSize(10).font("Helvetica").moveDown(0.5);
  doc.text(`Locataire signé : ${fmtBool(report.signedByTenant)}`)
     .text(`Bailleur signé : ${fmtBool(report.signedByOwner)}`)
     .text(`Lieu de clôture : ${fmt(report.closingLocation)}`);
  if (report.legalStatement) {
    doc.moveDown(1).fillColor("#86868B").fontSize(8).font("Helvetica-Oblique").text(report.legalStatement, { align: "justify" });
  }

  // Pied de page sur toutes les pages.
  // Si l'agence a défini une ligne personnalisée (configurateur PDF), on la
  // privilégie (rendu « white-label », sans mention FOXSCAN). Sinon on garde
  // l'attribution FOXSCAN par défaut. Les numéros de page sont toujours là.
  const pageRange = doc.bufferedPageRange();
  for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
    doc.switchToPage(i);
    const pageNum = `Page ${i + 1}/${pageRange.count}`;
    if (FOOTER_LINE) {
      doc.fillColor("#9AA0A6").fontSize(7).font("Helvetica")
        .text(FOOTER_LINE, 50, 792, { align: "center", width: 495, lineBreak: false });
      doc.fillColor("#9AA0A6").fontSize(7).font("Helvetica")
        .text(pageNum, 50, 804, { align: "center", width: 495, lineBreak: false });
    } else {
      doc.fillColor("#86868B").fontSize(8).font("Helvetica");
      doc.text(`Document généré par FOXSCAN — foxscan.fr — ${new Date().toLocaleDateString("fr-FR")} — ${pageNum}`,
        50, 800, { align: "center", width: 495 });
    }
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

// ─── F3 — /track/funnel : tracking public des étapes du funnel ──────────────
// Endpoint PUBLIC (sans auth) qui accepte les events trackés depuis la
// landing, les pages checkout, et tout autre point d'entrée non-authentifié.
// Permet de voir où les visiteurs décrochent (% landing → CTA → checkout).
//
// Body attendu : { step: string, sessionId?: string, meta?: object }
// Steps standardisés :
//   - "landing.viewed"
//   - "pricing.viewed"
//   - "founders.cta_clicked"
//   - "subscription.cta_clicked"
//   - "checkout.started"
//   - "checkout.success"
//   - "checkout.cancelled"
//   - (libre : tu peux ajouter d'autres step côté frontend sans changer ici)
//
// Anti-spam basique : déduplique par (IP, step, sessionId) sur 60s. N'arrête
// pas si le user envoie 1000 events différents, mais empêche le replay du
// MÊME event en boucle.
const _funnelDedupCache = new Map(); // key → expiresAtMs
app.post("/track/funnel", (req, res) => {
  const body = req.body || {};
  const step = String(body.step || "").trim();
  if (!step || step.length > 80) {
    return res.status(400).json({ ok: false, detail: "step required (max 80 chars)" });
  }
  const sessionId = String(body.sessionId || "").slice(0, 64);
  const ip = (req.ip || req.headers["x-forwarded-for"] || "").toString().slice(0, 45);

  // Dédup
  const dedupKey = `${ip}|${step}|${sessionId}`;
  const now = Date.now();
  // Garbage collect : purge entries expirées
  if (_funnelDedupCache.size > 5000) {
    for (const [k, exp] of _funnelDedupCache.entries()) {
      if (exp < now) _funnelDedupCache.delete(k);
    }
  }
  if (_funnelDedupCache.has(dedupKey) && _funnelDedupCache.get(dedupKey) > now) {
    return res.json({ ok: true, deduplicated: true });
  }
  _funnelDedupCache.set(dedupKey, now + 60 * 1000);

  const store = readStore();
  store.auditEvents.push({
    id: `aud_${crypto.randomBytes(4).toString("hex")}`,
    userID: null, // visiteur anonyme
    createdAt: nowIso(),
    type: `funnel.${step}`,
    payload: {
      step,
      sessionId,
      ipAddress: ip,
      userAgent: (req.headers["user-agent"] || "").slice(0, 200),
      referrer: (req.headers["referer"] || req.headers["referrer"] || "").slice(0, 200),
      meta: body.meta || {},
    },
  });
  writeStore(store);
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════
// PDF CUSTOMIZATION — Configuration remote du PDF EDL généré par l'app iOS.
// Spec complète : voir docs/PDF_CUSTOMIZATION_SPEC.md (repo iOS PIEM99/FOXSCAN).
//
// Architecture : l'agence personnalise depuis foxscan.fr/dashboard, l'app iOS
// fetch les valeurs et les applique automatiquement à la prochaine génération.
// ═════════════════════════════════════════════════════════════════════════

const PDF_CUSTOMIZATION_DEFAULTS = {
  texts: {
    coverTitle: "Constat d'état des lieux",
    preambleChipLabel: "PRÉAMBULE",
    relocationChipLabel: "RELOCATION DIRECTE",
    preambleParagraph: "Le présent constat est dressé entre {tenantName} et {landlordName} en présence de {agentName}.",
    relocationParagraph: "Le présent état des lieux fait suite à une relocation directe...",
    tocTitle: "SOMMAIRE DU RAPPORT",
    tocSubtitle: "Plan de navigation",
    sectionMandatoryReadingsTitle: "RELEVÉS OBLIGATOIRES",
    sectionMandatoryReadingsSubtitle: "Compteurs, détecteurs de fumée",
    sectionKeysTitle: "INVENTAIRE DES CLÉS",
    sectionKeysSubtitle: "Clés, badges",
    sectionObservationsTitle: "OBSERVATIONS ET SIGNATURES",
    sectionObservationsSubtitle: "Synthèse de fin de visite",
    sectionComparisonTitle: "COMPARATIF ENTRÉE / SORTIE",
    sectionPhotoMetersTitle: "REPORTAGE PHOTO DE COMPTEURS",
    sectionPhotoSmokeTitle: "REPORTAGE PHOTO DÉTECTEURS DE FUMÉE",
    sectionPhotoBoilerTitle: "REPORTAGE PHOTO CHAUDIÈRE",
    sectionPhotoKeysTitle: "REPORTAGE PHOTO DES CLÉS",
    sectionPhotoGeneralTitle: "REPORTAGE PHOTO GÉNÉRAL",
    bannerLabelDate: "Date du constat",
    bannerLabelTenant: "Locataire(s)",
    bannerLabelLandlord: "Bailleur",
    bannerLabelAgent: "Agent responsable",
    bannerLabelEntry: "Entrée",
    bannerLabelExit: "Sortie",
    bannerLabelHours: "Horaires de visite",
    bannerLabelTenantPresence: "Locataire au RDV",
    bannerPresenceMentionPresent: "Présent physiquement",
    bannerPresenceMentionRepresented: "Absent — représenté par {representative}",
    bannerPresenceMentionAbsentWithMandate: "Absent — voir pouvoir signé en annexe",
    labelMeterAdditional: "Informations complémentaires",
    labelObservations: "Observations",
    labelFinalObservations: "Observations",
    labelFinalRecommendations: "Travaux et recommandations",
    labelMissingPhoto: "Image manquante",
    signaturesTenantHeader: "Le locataire",
    signaturesOwnerHeader: "Pour le bailleur / représentant",
    footerCustomLine: "",
    conditionLabelOverrides: {},
  },
  colors: {
    accentHex: "1C4FD9",
    chipHex: "2B9D91",
    inkHex: "21283A",
  },
  sections: {
    showTableOfContents: true,
    showGeneralPhotoAnnex: true,
    showComparisonSection: true,
    showMetersPhotoReport: true,
    showKeysPhotoReport: true,
    showBoilerDetails: true,
  },
  layout: {
    useLargeCoverLogo: false,
    pageFormat: "a4",
    zebraStriping: "every2",
  },
  branding: {
    logoDataUrl: "",
  },
};

// Retourne l'org_id (alias agency_id) pour un user. Pour les solos = user.id.
function pdfCustOwnerId(user) {
  if (!user) return null;
  return user.parentUserId || user.teamId || user.agencyID || user.id;
}

// Détermine si un user peut MODIFIER (PUT) la config :
// - les owners (pas de parentUserId)
// - les admins globaux (role admin/superadmin ou isAdmin true)
function pdfCustCanWrite(user) {
  if (!user) return false;
  if (user.role === "admin" || user.role === "superadmin" || user.isAdmin === true) return true;
  return !user.parentUserId; // owner de son équipe
}

// Validation côté serveur — refuse les payloads malformés
const HEX_COLOR_RX = /^[0-9A-Fa-f]{6}$/;
const PAGE_FORMATS = new Set(["a4", "usLetter"]);
const ZEBRA_VALUES = new Set(["none", "every2", "every3"]);

function pdfCustValidate(payload) {
  if (!payload || typeof payload !== "object") {
    return "payload must be an object";
  }
  if (payload.colors) {
    for (const key of ["accentHex", "chipHex", "inkHex"]) {
      const v = payload.colors[key];
      if (v !== undefined && v !== null && !HEX_COLOR_RX.test(String(v).replace(/^#/, ""))) {
        return `colors.${key} doit être 6 chars hex`;
      }
    }
  }
  if (payload.texts) {
    if (payload.texts.preambleParagraph && String(payload.texts.preambleParagraph).length > 2000) {
      return "texts.preambleParagraph dépasse 2000 caractères";
    }
    if (payload.texts.relocationParagraph && String(payload.texts.relocationParagraph).length > 2000) {
      return "texts.relocationParagraph dépasse 2000 caractères";
    }
    if (payload.texts.signaturesTenantHeader && String(payload.texts.signaturesTenantHeader).length > 100) {
      return "texts.signaturesTenantHeader dépasse 100 caractères";
    }
    if (payload.texts.signaturesOwnerHeader && String(payload.texts.signaturesOwnerHeader).length > 100) {
      return "texts.signaturesOwnerHeader dépasse 100 caractères";
    }
    if (payload.texts.footerCustomLine && String(payload.texts.footerCustomLine).length > 200) {
      return "texts.footerCustomLine dépasse 200 caractères";
    }
  }
  if (payload.layout) {
    if (payload.layout.pageFormat && !PAGE_FORMATS.has(payload.layout.pageFormat)) {
      return "layout.pageFormat doit être 'a4' ou 'usLetter'";
    }
    if (payload.layout.zebraStriping && !ZEBRA_VALUES.has(payload.layout.zebraStriping)) {
      return "layout.zebraStriping doit être 'none', 'every2' ou 'every3'";
    }
  }
  if (payload.branding) {
    const logo = payload.branding.logoDataUrl;
    if (logo !== undefined && logo !== null && logo !== "") {
      if (typeof logo !== "string" || !/^data:image\/(png|jpe?g);base64,/.test(logo)) {
        return "branding.logoDataUrl doit être une data URL image/png ou image/jpeg";
      }
      // ~500 Ko décodé (base64 ≈ 1,37× la taille binaire)
      if (logo.length > 700000) {
        return "branding.logoDataUrl trop volumineux (max ~500 Ko)";
      }
    }
  }
  return null; // OK
}

// Décode une data URL image (png/jpeg) en Buffer pour PDFKit. Retourne null si
// invalide — le rendu PDF ne doit JAMAIS casser à cause d'un logo malformé.
function decodeLogoDataUrl(dataUrl) {
  try {
    if (typeof dataUrl !== "string") return null;
    const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
    if (!m) return null;
    const buf = Buffer.from(m[2], "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

// Deep merge defaults + saved payload (le client peut envoyer juste les diffs)
function pdfCustDeepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      out[key] = pdfCustDeepMerge(tv, sv);
    } else if (sv !== undefined) {
      out[key] = sv;
    }
  }
  return out;
}

// GET /api/agency/pdf-customization
// Returns the effective configuration (defaults merged with saved overrides).
// Cache headers : 5 min pour permettre à l'app iOS de re-fetch raisonnablement.
app.get("/api/agency/pdf-customization", requireCurrentUser, (req, res) => {
  const ownerId = pdfCustOwnerId(req._user);
  if (!ownerId) return res.status(400).json({ ok: false, detail: "Aucun org_id" });

  const store = req._store;
  store.pdfCustomizations = store.pdfCustomizations || {};
  const entry = store.pdfCustomizations[ownerId] || null;

  const merged = entry?.payload
    ? pdfCustDeepMerge(PDF_CUSTOMIZATION_DEFAULTS, entry.payload)
    : PDF_CUSTOMIZATION_DEFAULTS;

  res.set("Cache-Control", "max-age=300");
  res.json({
    ok: true,
    revision: entry?.revision || 0,
    lastUpdatedAt: entry?.updatedAt || null,
    ...merged,
  });
});

// PUT /api/agency/pdf-customization
// Persiste la config pour l'agence du user. Réservé aux owners et aux admins.
app.put("/api/agency/pdf-customization", requireCurrentUser, async (req, res) => {
  const user = req._user;
  if (!pdfCustCanWrite(user)) {
    return res.status(403).json({
      ok: false,
      detail: "Seul le propriétaire de l'agence ou un admin peut modifier la configuration PDF.",
    });
  }

  const ownerId = pdfCustOwnerId(user);
  if (!ownerId) return res.status(400).json({ ok: false, detail: "Aucun org_id" });

  const payload = req.body || {};

  // Le client peut envoyer une payload partielle — on accepte mais on valide
  // seulement ce qui est présent. La fusion avec les defaults se fait au GET.
  const err = pdfCustValidate(payload);
  if (err) return res.status(400).json({ ok: false, detail: err });

  // Écriture atomique (read-modify-write dans la file sérialisée) : évite qu'un
  // PUT concurrent n'écrase les modifs d'un autre (lost-update).
  let entry;
  await mutateStore((fresh) => {
    fresh.pdfCustomizations = fresh.pdfCustomizations || {};
    const prev = fresh.pdfCustomizations[ownerId];
    // Payload complète → remplace ; diff → merge avec ce qui était sauvé.
    const nextPayload = prev?.payload
      ? pdfCustDeepMerge(prev.payload, payload)
      : payload;
    entry = {
      payload: nextPayload,
      revision: (prev?.revision || 0) + 1,
      updatedAt: nowIso(),
      updatedBy: user.id,
    };
    fresh.pdfCustomizations[ownerId] = entry;
  });

  const merged = pdfCustDeepMerge(PDF_CUSTOMIZATION_DEFAULTS, entry.payload);
  res.json({
    ok: true,
    revision: entry.revision,
    lastUpdatedAt: entry.updatedAt,
    ...merged,
  });
});

// Endpoint utilitaire : reset aux defaults FOXSCAN (le dashboard l'utilise pour
// le bouton "Réinitialiser aux valeurs FOXSCAN").
app.delete("/api/agency/pdf-customization", requireCurrentUser, async (req, res) => {
  const user = req._user;
  if (!pdfCustCanWrite(user)) {
    return res.status(403).json({ ok: false, detail: "Forbidden" });
  }
  const ownerId = pdfCustOwnerId(user);
  if (!ownerId) return res.status(400).json({ ok: false, detail: "Aucun org_id" });

  await mutateStore((fresh) => {
    fresh.pdfCustomizations = fresh.pdfCustomizations || {};
    delete fresh.pdfCustomizations[ownerId];
  });

  res.json({ ok: true, revision: 0, lastUpdatedAt: null, ...PDF_CUSTOMIZATION_DEFAULTS });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROFIL AGENCE (coordonnées) — partagé PDF + app
// ─────────────────────────────────────────────────────────────────────────────
// store.agencyProfiles = { [ownerId]: { name, address, postalCode, city,
//   phone, email, updatedAt, updatedBy } }
// Sert notamment à composer automatiquement le pied de page du rapport PDF
// (cf. generateInspectionPDF → composeAgencyFooter).

const AGENCY_PROFILE_DEFAULT = {
  name: "",
  address: "",
  postalCode: "",
  city: "",
  phone: "",
  email: "",
};

const _agencyStr = (v, max) => String(v ?? "").slice(0, max);

function loadAgencyProfile(store, user) {
  try {
    const ownerId = pdfCustOwnerId(user);
    if (!ownerId || !store) return AGENCY_PROFILE_DEFAULT;
    const entry = (store.agencyProfiles || {})[ownerId];
    return entry ? { ...AGENCY_PROFILE_DEFAULT, ...entry } : AGENCY_PROFILE_DEFAULT;
  } catch {
    return AGENCY_PROFILE_DEFAULT;
  }
}

// Compose une ligne de pied de page à partir des coordonnées agence.
// Ex : « Agence Dupont · 12 rue X 75011 Paris · 01 23 45 67 89 · contact@x.fr »
function composeAgencyFooter(profile) {
  if (!profile) return "";
  const addr = [profile.address, [profile.postalCode, profile.city].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
  return [profile.name, addr, profile.phone, profile.email]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" · ");
}

// GET /api/agency/profile
app.get("/api/agency/profile", requireCurrentUser, (req, res) => {
  const ownerId = pdfCustOwnerId(req._user);
  if (!ownerId) return res.status(400).json({ ok: false, detail: "Aucun org_id" });
  const store = req._store;
  const entry = (store.agencyProfiles || {})[ownerId] || null;
  res.json({
    ok: true,
    profile: { ...AGENCY_PROFILE_DEFAULT, ...(entry || {}) },
    canEdit: pdfCustCanWrite(req._user),
    updatedAt: entry?.updatedAt || null,
  });
});

// PUT /api/agency/profile — réservé owner/admin, écriture atomique
app.put("/api/agency/profile", requireCurrentUser, async (req, res) => {
  const user = req._user;
  if (!pdfCustCanWrite(user)) {
    return res.status(403).json({
      ok: false,
      detail: "Seul le propriétaire de l'agence ou un admin peut modifier les coordonnées.",
    });
  }
  const ownerId = pdfCustOwnerId(user);
  if (!ownerId) return res.status(400).json({ ok: false, detail: "Aucun org_id" });

  const b = req.body || {};
  const email = _agencyStr(b.email, 160).trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, detail: "Email invalide" });
  }
  const profile = {
    name: _agencyStr(b.name, 160).trim(),
    address: _agencyStr(b.address, 200).trim(),
    postalCode: _agencyStr(b.postalCode, 12).trim(),
    city: _agencyStr(b.city, 120).trim(),
    phone: _agencyStr(b.phone, 40).trim(),
    email,
    updatedAt: nowIso(),
    updatedBy: user.id,
  };

  await mutateStore((fresh) => {
    fresh.agencyProfiles = fresh.agencyProfiles || {};
    fresh.agencyProfiles[ownerId] = profile;
  });

  res.json({ ok: true, profile, canEdit: true, updatedAt: profile.updatedAt });
});

// ─────────────────────────────────────────────────────────────────────────────
// TICKETS SUPPORT — store.tickets
// ─────────────────────────────────────────────────────────────────────────────
// { id, userId, email, userName, subject, status, relatedProjectID,
//   messages: [{ id, authorRole:'user'|'admin', authorName, body, createdAt }],
//   createdAt, updatedAt }

const TICKET_STATUSES = new Set(["open", "pending", "resolved"]);
const _tkStr = (v, max) => String(v ?? "").slice(0, max);

function ticketSummary(t) {
  const last = t.messages?.[t.messages.length - 1];
  return {
    id: t.id,
    ref: t.ref || "",
    source: t.source || "web",       // "web" (dashboard) | "app" (bug iOS)
    userId: t.userId,
    email: t.email,
    userName: t.userName,
    subject: t.subject,
    status: t.status,
    relatedProjectID: t.relatedProjectID || "",
    appMeta: t.appMeta || null,       // { appVersion, iosVersion, deviceModel }
    hasLog: !!(t.log && t.log.length), // le log complet est servi au détail
    messageCount: (t.messages || []).length,
    lastMessageAt: last?.createdAt || t.createdAt,
    lastAuthorRole: last?.authorRole || "user",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// Prochain identifiant lisible de ticket : T-0001, T-0002, …
function nextTicketRef(store) {
  const n = (store.ticketCounter || 0) + 1;
  store.ticketCounter = n;
  return `T-${String(n).padStart(4, "0")}`;
}

// Résout l'utilisateur depuis un éventuel Bearer, SANS échouer s'il est absent
// ou expiré (le rapport de bug doit passer même token périmé).
function resolveUserSoft(req) {
  try {
    const token = authHeaderToken(req);
    if (!token) return null;
    const payload = verifyJwt(token, settings.jwtSecret);
    if (!payload || payload.type !== "access") return null;
    return findUserById(readStore(), String(payload.sub || "")) || null;
  } catch {
    return null;
  }
}

// ── Côté utilisateur ────────────────────────────────────────────────────────

// POST /api/tickets — ouvre un ticket
app.post("/api/tickets", requireCurrentUser, express.json({ limit: "64kb" }), async (req, res) => {
  const user = req._user;
  const subject = _tkStr(req.body?.subject, 160).trim();
  const body = _tkStr(req.body?.message, 5000).trim();
  if (!subject) return res.status(400).json({ ok: false, detail: "Sujet requis" });
  if (!body) return res.status(400).json({ ok: false, detail: "Message requis" });

  const ticket = {
    id: `tkt_${crypto.randomBytes(5).toString("hex")}`,
    userId: user.id,
    email: user.email || "",
    userName: user.name || "",
    subject,
    status: "open",
    relatedProjectID: _tkStr(req.body?.relatedProjectID, 80).trim(),
    messages: [
      {
        id: `msg_${crypto.randomBytes(4).toString("hex")}`,
        authorRole: "user",
        authorName: user.name || user.email || "Utilisateur",
        body,
        createdAt: nowIso(),
      },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await mutateStore((fresh) => {
    fresh.tickets = fresh.tickets || [];
    fresh.tickets.push(ticket);
  });

  if (adminNotifEmail) {
    sendMail({
      to: adminNotifEmail,
      replyTo: user.email || undefined,
      subject: `🎫 Nouveau ticket · ${subject}`,
      html: emailLayout(
        "Nouveau ticket support",
        `<p><strong>${escapeHtml(user.name || "")}</strong> (${escapeHtml(user.email || "")}) a ouvert un ticket :</p>
         <p style="font-weight:600">${escapeHtml(subject)}</p>
         <pre style="background:#F5F5F7;padding:14px;border-radius:8px;font-size:13px;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
      ),
    }).catch((e) => console.error("[tickets] notif admin:", e.message));
  }

  res.status(201).json({ ok: true, ticket });
});

// ─────────────────────────────────────────────────────────────────────────────
// RAPPORTS DE BUG DEPUIS L'APP iOS — POST /api/support/tickets
// ─────────────────────────────────────────────────────────────────────────────
// Spec app : auth FACULTATIVE (le user a justement un bug, son token peut être
// expiré/absent → on accepte l'anonyme). Body { message, appVersion, iosVersion,
// deviceModel, userID, userEmail, createdAt, log }. Réponse { ok, ticketID }.
// Stocké dans la MÊME collection que les tickets dashboard (source:"app") pour
// une gestion unifiée, avec le log complet consultable côté admin.
const MAX_LOG_LEN = 600 * 1024; // ~600 Ko (la spec annonce ~512 Ko)

// ─────────────────────────────────────────────────────────────────────────────
// RELANCES D'ESSAI — emails automatiques avant / après expiration
// ─────────────────────────────────────────────────────────────────────────────
// Un essai qui s'éteint en silence ne convertit pas. Deux messages :
//   • J-2 avant la fin (ou quota d'EDL presque atteint)
//   • le jour de l'expiration
// Déclenchement OPPORTUNISTE (au fil des requêtes, au plus une fois par heure)
// : l'hébergement ne garantit pas de tâche planifiée, et un processus qui
// dort serait tué. Chaque relance n'est envoyée qu'UNE fois par compte.

const TRIAL_REMINDER_INTERVAL_MS = 60 * 60 * 1000; // 1 h
let _lastTrialSweep = 0;

function emailTrialEnding({ name, daysLeft, edlUsed, edlLimit }) {
  const hello = name ? `Bonjour ${escapeHtml(name)},` : "Bonjour,";
  const reste = daysLeft > 0
    ? `il vous reste <strong>${daysLeft} jour${daysLeft > 1 ? "s" : ""}</strong> d'essai`
    : "votre essai se termine aujourd'hui";
  return emailLayout(
    "Votre essai FOXSCAN se termine bientôt",
    `<p>${hello}</p>
     <p>Petit rappel : ${reste}, et vous avez réalisé
     <strong>${edlUsed} état${edlUsed > 1 ? "s" : ""} des lieux sur ${edlLimit}</strong>.</p>
     <p>Pour continuer à créer des états des lieux sans interruption, choisissez
     votre formule — à partir de <strong>49 €/mois</strong>, sans engagement.</p>
     <p style="margin:26px 0">
       <a href="https://foxscan.fr/#pricing"
          style="display:inline-block;background:#FF7A1A;color:#fff;text-decoration:none;
                 padding:13px 26px;border-radius:10px;font-weight:600">Voir les formules</a>
     </p>
     <p style="font-size:13px;color:#6B7280">
       Vos états des lieux déjà réalisés restent accessibles et exportables,
       même après la fin de l'essai.
     </p>`,
    `Il vous reste ${daysLeft} jour(s) d'essai — ${edlUsed}/${edlLimit} EDL utilisés.`,
  );
}

function emailTrialExpired({ name, reason }) {
  const hello = name ? `Bonjour ${escapeHtml(name)},` : "Bonjour,";
  const cause = reason === "quota"
    ? "vous avez utilisé vos 3 états des lieux gratuits"
    : "votre essai gratuit de 7 jours est arrivé à son terme";
  return emailLayout(
    "Votre essai FOXSCAN est terminé",
    `<p>${hello}</p>
     <p>${cause.charAt(0).toUpperCase() + cause.slice(1)}.</p>
     <p>La création de nouveaux états des lieux est suspendue, mais
     <strong>tout votre travail reste accessible</strong> : consultation, export
     et synchronisation de vos dossiers existants fonctionnent normalement.</p>
     <p>Pour reprendre là où vous en étiez :</p>
     <p style="margin:26px 0">
       <a href="https://foxscan.fr/#pricing"
          style="display:inline-block;background:#FF7A1A;color:#fff;text-decoration:none;
                 padding:13px 26px;border-radius:10px;font-weight:600">Choisir ma formule</a>
     </p>
     <p style="font-size:13px;color:#6B7280">
       Une question ou un besoin particulier ? Répondez simplement à cet email.
     </p>`,
    "Votre essai est terminé — vos états des lieux restent accessibles.",
  );
}

/** Parcourt les comptes en essai et envoie les relances dues. */
async function sweepTrialReminders() {
  const now = Date.now();
  if (now - _lastTrialSweep < TRIAL_REMINDER_INTERVAL_MS) return;
  _lastTrialSweep = now;

  try {
    const store = readStore();
    const due = [];

    for (const u of store.users || []) {
      if (!u.email || !u.trialEndsAt) continue;
      // On ne relance QUE les comptes qui n'ont jamais payé.
      if (u.foundersAccount || u.stripeSubscriptionId || u.legacyAccess || u.adminActivated) continue;

      const status = computeAccessStatus(u, store);
      const used = trialEdlUsed(store, u);
      const daysLeft = trialDaysRemaining(u);

      if (status === "trial" && daysLeft <= 2 && !u.trialEndingNotifiedAt) {
        due.push({ user: u, kind: "ending", daysLeft, used });
      } else if (
        (status === "expired" || status === "trial_quota") &&
        !u.trialExpiredNotifiedAt
      ) {
        due.push({ user: u, kind: "expired", reason: status === "trial_quota" ? "quota" : "time" });
      }
    }

    if (due.length === 0) return;
    console.log(`[relances] ${due.length} email(s) d'essai à envoyer`);

    for (const d of due) {
      const u = d.user;
      const html = d.kind === "ending"
        ? emailTrialEnding({ name: u.name, daysLeft: d.daysLeft, edlUsed: d.used, edlLimit: TRIAL_MAX_EDL })
        : emailTrialExpired({ name: u.name, reason: d.reason });
      const subject = d.kind === "ending"
        ? "Votre essai FOXSCAN se termine bientôt"
        : "Votre essai FOXSCAN est terminé";

      const sent = await sendMail({ to: u.email, subject, html });
      if (!sent?.sent) continue;

      // Marque APRÈS envoi réussi : un échec sera retenté au prochain passage.
      await mutateStore((fresh) => {
        const t = (fresh.users || []).find((x) => x.id === u.id);
        if (!t) return;
        if (d.kind === "ending") t.trialEndingNotifiedAt = nowIso();
        else t.trialExpiredNotifiedAt = nowIso();
      });
    }
  } catch (e) {
    console.error("[relances] échec du passage :", e.message);
  }
}

// Déclenchement manuel (admin) — utile pour tester sans attendre.
app.post("/admin/trial-reminders/run", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  _lastTrialSweep = 0; // force le passage
  await sweepTrialReminders();
  res.json({ ok: true, note: "Passage effectué — voir les logs serveur." });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROMPTS IA ÉDITABLES — store.aiPrompts
// ─────────────────────────────────────────────────────────────────────────────
// Permet de corriger une consigne d'analyse depuis le dashboard sans republier
// l'app. On ne stocke QUE les surcharges : une clé absente ⇒ l'app utilise son
// prompt embarqué. `version` s'incrémente à chaque écriture pour que l'app ne
// re-télécharge que si nécessaire.

const AI_PROMPT_KEYS = new Set([
  "common.preamble.residential", "common.rules.residential",
  "common.preamble.commercial", "common.rules.commercial",
  "room.chambre", "room.salon", "room.cuisine", "room.salleDeBain", "room.wc",
  "room.entree", "room.bureau", "room.rangement", "room.exterieur", "room.garage",
  "room.residentialGenerique",
  "room.openSpace", "room.salleReunion", "room.accueilReception",
  "room.cafeteriaDetente", "room.sanitairesCommercial", "room.localTechnique",
  "room.showroom", "room.commercialGenerique",
  // Niveaux d'exigence et contexte : ajoutés en fin de prompt par l'app, ils
  // priment sur les consignes de pièce en cas de divergence de seuil.
  "severity.standard", "severity.strict", "severity.maximum",
  "context.repossession",
]);

function aiPromptsState(store) {
  const st = store.aiPrompts || {};
  return {
    version: st.version || 0,
    updatedAt: st.updatedAt || null,
    updatedBy: st.updatedBy || null,
    prompts: st.prompts || {},
    baseline: st.baseline || {},
    history: st.history || [],
  };
}

// GET /ai/prompts — lu par l'app à chaque lancement (throttlé côté app)
app.get("/ai/prompts", requireCurrentUser, (req, res) => {
  const st = aiPromptsState(req._store);
  res.json({
    ok: true,
    version: st.version,
    updatedAt: st.updatedAt,
    prompts: st.prompts,   // uniquement les surcharges
  });
});

// GET /admin/ai/prompts — vue dashboard : surcharges + prompts d'origine + historique
app.get("/admin/ai/prompts", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const st = aiPromptsState(readStore());
  res.json({
    ok: true,
    version: st.version,
    updatedAt: st.updatedAt,
    updatedBy: st.updatedBy,
    keys: [...AI_PROMPT_KEYS],
    prompts: st.prompts,
    baseline: st.baseline,
    history: st.history.slice(-40).reverse(),
  });
});

// PUT /ai/prompts/:key — enregistre une surcharge (admin)
app.put("/ai/prompts/:key", express.json({ limit: "512kb" }), async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const key = String(req.params.key || "").trim();
  if (!AI_PROMPT_KEYS.has(key)) {
    return res.status(400).json({ ok: false, detail: "Clé de prompt inconnue" });
  }
  const content = String(req.body?.content ?? "");
  if (!content.trim()) {
    return res.status(400).json({ ok: false, detail: "Contenu vide — utilisez DELETE pour réinitialiser" });
  }

  let version = 0;
  await mutateStore((fresh) => {
    fresh.aiPrompts = fresh.aiPrompts || { version: 0, prompts: {}, baseline: {}, history: [] };
    const st = fresh.aiPrompts;
    st.prompts = st.prompts || {};
    st.history = st.history || [];
    // Historique : on conserve la valeur PRÉCÉDENTE pour pouvoir restaurer.
    st.history.push({
      id: `ph_${crypto.randomBytes(4).toString("hex")}`,
      key,
      previous: st.prompts[key] ?? null,
      at: nowIso(),
      by: req._user?.email || "cli",
    });
    if (st.history.length > 200) st.history = st.history.slice(-200);
    st.prompts[key] = content;
    st.version = (st.version || 0) + 1;
    st.updatedAt = nowIso();
    st.updatedBy = req._user?.email || "cli";
    version = st.version;
  });

  res.json({ ok: true, version });
});

// DELETE /ai/prompts/:key — retire la surcharge → retour au prompt embarqué
app.delete("/ai/prompts/:key", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const key = String(req.params.key || "").trim();
  if (!AI_PROMPT_KEYS.has(key)) {
    return res.status(400).json({ ok: false, detail: "Clé de prompt inconnue" });
  }

  let version = 0;
  await mutateStore((fresh) => {
    fresh.aiPrompts = fresh.aiPrompts || { version: 0, prompts: {}, baseline: {}, history: [] };
    const st = fresh.aiPrompts;
    st.history = st.history || [];
    st.history.push({
      id: `ph_${crypto.randomBytes(4).toString("hex")}`,
      key,
      previous: st.prompts?.[key] ?? null,
      at: nowIso(),
      by: req._user?.email || "cli",
      reset: true,
    });
    if (st.prompts) delete st.prompts[key];
    st.version = (st.version || 0) + 1;
    st.updatedAt = nowIso();
    st.updatedBy = req._user?.email || "cli";
    version = st.version;
  });

  res.json({ ok: true, version });
});

// POST /ai/prompts/baseline — l'app remonte ses prompts embarqués (référence)
app.post("/ai/prompts/baseline", requireCurrentUser, express.json({ limit: "2mb" }), async (req, res) => {
  const incoming = req.body?.prompts;
  if (!incoming || typeof incoming !== "object") {
    return res.status(400).json({ ok: false, detail: "prompts requis" });
  }
  const appVersion = String(req.body?.appVersion || "").slice(0, 40);

  // Tri en amont : l'app doit pouvoir constater qu'une clé a été ignorée
  // (faute de frappe, clé renommée) au lieu de croire l'envoi complet.
  const accepted = {};
  const ignored = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (AI_PROMPT_KEYS.has(k) && typeof v === "string") accepted[k] = v;
    else ignored.push(k);
  }

  await mutateStore((fresh) => {
    fresh.aiPrompts = fresh.aiPrompts || { version: 0, prompts: {}, baseline: {}, history: [] };
    const st = fresh.aiPrompts;
    st.baseline = { ...(st.baseline || {}), ...accepted };
    st.baselineAppVersion = appVersion;
    st.baselineAt = nowIso();
    // NB : la référence ne modifie PAS `version` — elle n'affecte pas l'app.
  });

  res.json({
    ok: true,
    count: Object.keys(accepted).length,
    expected: AI_PROMPT_KEYS.size,
    ignored: ignored.slice(0, 20),
  });
});

// POST /ai/usage — comptabilité de consommation IA remontée par l'app iOS.
// Body : { model?, inputTokens?, outputTokens?, calls?, feature? }
// Complète store.usageEvents : les analyses faites DANS l'app sont ainsi
// attribuées au compte, au même titre que les imports web.
app.post("/ai/usage", requireCurrentUser, express.json({ limit: "16kb" }), async (req, res) => {
  const b = req.body || {};
  const model = String(b.model || "gpt-4o-mini").slice(0, 60);
  const inputTokens = Math.max(0, parseInt(b.inputTokens ?? b.input_tokens ?? 0, 10) || 0);
  const outputTokens = Math.max(0, parseInt(b.outputTokens ?? b.output_tokens ?? 0, 10) || 0);
  const calls = Math.max(1, parseInt(b.calls || 1, 10) || 1);
  const feature = String(b.feature || "app").slice(0, 60);

  await recordUsage({
    userId: req._user.id,
    type: `app_${feature}`,
    totals: {
      calls,
      inputTokens,
      outputTokens,
      costMicros: costMicrosFor(model, inputTokens, outputTokens),
      byModel: { [model]: calls },
    },
  });

  res.json({ ok: true });
});

// GET /ai/usage/summary — ce que le client va payer en analyses.
//
// Depuis septembre 2026 l'abonnement est plat (29 €, utilisateurs illimités) et
// les analyses sont refacturées À LEUR COÛT RÉEL, sans marge. Facturer au coût
// réel oblige à le montrer : sans ce relevé, le client devrait croire sur
// parole un montant qu'il ne peut pas vérifier.
//
// `?from=YYYY-MM-DD&to=YYYY-MM-DD` pour une période donnée ; par défaut, le
// mois calendaire en cours.
app.get("/ai/usage/summary", requireCurrentUser, (req, res) => {
  const store = req._store;
  const uid = req._user.id;

  const now = new Date();
  const defFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const parse = (v, fallback) => {
    const d = new Date(String(v || ""));
    return Number.isNaN(d.getTime()) ? fallback : d;
  };
  const from = parse(req.query.from, defFrom);
  const to = parse(req.query.to, now);

  const mine = (store.usageEvents || []).filter((e) => {
    if ((e.userId || e.userID) !== uid) return false;
    const t = new Date(e.createdAt || 0);
    return t >= from && t <= to;
  });

  let calls = 0, inputTokens = 0, outputTokens = 0, costMicros = 0;
  const byType = {};
  for (const e of mine) {
    calls += e.calls || 0;
    inputTokens += e.inputTokens || 0;
    outputTokens += e.outputTokens || 0;
    costMicros += e.costMicros || 0;
    const k = e.type || "autre";
    byType[k] = byType[k] || { calls: 0, costMicros: 0 };
    byType[k].calls += e.calls || 0;
    byType[k].costMicros += e.costMicros || 0;
  }

  res.json({
    ok: true,
    period: { from: from.toISOString(), to: to.toISOString() },
    calls,
    inputTokens,
    outputTokens,
    // Le montant fait foi en micro-euros : l'arrondi à l'euro n'intervient
    // qu'au moment de la facture, jamais dans le cumul.
    costMicros,
    costEur: Math.round(costMicros / 10000) / 100,
    byType,
    // Le client doit pouvoir refaire le calcul lui-même.
    basis: {
      note: "Coût réel refacturé sans marge. Tarifs par million de jetons, en micro-euros.",
      prices: MODEL_PRICES,
    },
    events: mine.length,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS ADMIN DISTANTES — réparation d'un projet depuis le dashboard
// ─────────────────────────────────────────────────────────────────────────────
// L'app iOS gère nativement ce mécanisme (cf. spec app §2.6) :
//   1. le serveur pose `adminAction` + `adminActionID` sur le projet ;
//   2. l'app les lit à son prochain pull GET /projects, applique l'action UNE
//      fois, puis acquitte ici ;
//   3. le serveur efface l'action.
// Actions supportées par l'app : "unfinalize", "clearStatusOverride", et
// "delete" (ménage d'un dossier vide : l'app le met à SA corbeille — 30 jours —
// puis demande la suppression ici ; elle refuse si le dossier a du contenu
// chez elle que le serveur n'a jamais reçu).

const APP_ADMIN_ACTIONS = new Set(["unfinalize", "clearStatusOverride", "delete"]);

// POST /admin/projects/:projectID/action — programme une action (admin)
app.post("/admin/projects/:projectID/action", express.json({ limit: "4kb" }), async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const action = String(req.body?.action || "").trim();
  if (!APP_ADMIN_ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, detail: "Action inconnue" });
  }
  const projectID = String(req.params.projectID || "").trim();
  const actionID = `act_${crypto.randomBytes(6).toString("hex")}`;
  let found = false;

  await mutateStore((fresh) => {
    const p = (fresh.projects || []).find((x) => x.id === projectID);
    if (!p) return;
    found = true;
    p.adminAction = action;
    p.adminActionID = actionID;
    p.updatedAt = nowIso();
    fresh.auditEvents = fresh.auditEvents || [];
    fresh.auditEvents.push({
      id: `aud_${crypto.randomBytes(4).toString("hex")}`,
      type: "project.admin_action.queued",
      projectID, action, actionID,
      adminID: req._user?.id || "cli",
      createdAt: nowIso(),
    });
  });

  if (!found) return res.status(404).json({ ok: false, detail: "Projet introuvable" });
  res.json({ ok: true, action, actionID, note: "Sera appliquée au prochain pull de l'app." });
});

// POST /projects/:projectID/admin-actions/ack — acquittement par l'app
app.post("/projects/:projectID/admin-actions/ack", requireCurrentUser, express.json({ limit: "4kb" }), async (req, res) => {
  const actionID = String(req.body?.actionID || "").trim();
  if (!actionID) return res.status(400).json({ ok: false, detail: "actionID requis" });
  const projectID = String(req.params.projectID || "").trim();
  const user = req._user;
  let acked = false;

  await mutateStore((fresh) => {
    const p = (fresh.projects || []).find((x) => x.id === projectID && x.userID === user.id);
    if (!p || p.adminActionID !== actionID) return;
    const applied = p.adminAction;
    delete p.adminAction;
    delete p.adminActionID;
    p.adminActionAppliedAt = nowIso();
    p.updatedAt = nowIso();
    acked = true;
    fresh.auditEvents = fresh.auditEvents || [];
    fresh.auditEvents.push({
      id: `aud_${crypto.randomBytes(4).toString("hex")}`,
      type: "project.admin_action.acked",
      projectID, action: applied, actionID,
      userID: user.id,
      createdAt: nowIso(),
    });
  });

  // Idempotent : un ré-acquittement ne doit pas provoquer d'erreur côté app.
  res.json({ ok: true, acknowledged: acked });
});

const supportTicketHandler = async (req, res) => {
  const b = req.body || {};
  const message = _tkStr(b.message, 5000).trim();
  if (!message) return res.status(400).json({ ok: false, detail: "message requis" });

  // Enrichissement si un Bearer valide est présent ; sinon on retombe sur ce
  // que l'app fournit dans le corps (userID / userEmail), voire anonyme.
  const authed = resolveUserSoft(req);
  const userId = authed?.id || _tkStr(b.userID, 80).trim() || "";
  const email = (authed?.email || _tkStr(b.userEmail, 160)).toLowerCase().trim();
  const userName = authed?.name || (email ? email.split("@")[0] : "Utilisateur app");

  const appMeta = {
    appVersion: _tkStr(b.appVersion, 40),
    iosVersion: _tkStr(b.iosVersion, 40),
    deviceModel: _tkStr(b.deviceModel, 60),
  };
  const log = typeof b.log === "string" ? b.log.slice(0, MAX_LOG_LEN) : "";
  // Sujet lisible dérivé de la 1re ligne du message.
  const subject = message.split("\n")[0].slice(0, 120) || "Rapport de bug";

  let ticket = null;
  await mutateStore((fresh) => {
    fresh.tickets = fresh.tickets || [];
    const ref = nextTicketRef(fresh);
    ticket = {
      id: `tkt_${crypto.randomBytes(5).toString("hex")}`,
      ref,
      source: "app",
      userId,
      email,
      userName,
      subject,
      status: "open", // « nouveau »
      appMeta,
      log,
      relatedProjectID: "",
      messages: [
        {
          id: `msg_${crypto.randomBytes(4).toString("hex")}`,
          authorRole: "user",
          authorName: userName,
          body: message,
          createdAt: _tkStr(b.createdAt, 40) || nowIso(),
        },
      ],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    fresh.tickets.push(ticket);
  });

  if (adminNotifEmail) {
    sendMail({
      to: adminNotifEmail,
      replyTo: email || undefined,
      subject: `🐛 Bug app ${ticket.ref} · ${appMeta.appVersion || "?"}`,
      html: emailLayout(
        "Rapport de bug depuis l'app",
        `<p><strong>${escapeHtml(ticket.ref)}</strong> — ${escapeHtml(userName)}${email ? ` (${escapeHtml(email)})` : " (anonyme)"}</p>
         <p style="color:#6B7280;font-size:13px">App ${escapeHtml(appMeta.appVersion)} · iOS ${escapeHtml(appMeta.iosVersion)} · ${escapeHtml(appMeta.deviceModel)}</p>
         <pre style="background:#F5F5F7;padding:14px;border-radius:8px;font-size:13px;white-space:pre-wrap">${escapeHtml(message)}</pre>
         ${log ? `<p style="color:#6B7280;font-size:12px">Journal joint (${(log.length / 1024).toFixed(0)} Ko) — consultable dans le dashboard.</p>` : ""}`,
      ),
    }).catch((e) => console.error("[support] notif admin:", e.message));
  }

  // Réponse exacte attendue par l'app.
  res.status(201).json({ ok: true, ticketID: ticket.ref });
};

// Les deux chemins pointent sur le même handler (les specs iOS divergent
// sur le préfixe /api ; on accepte les deux pour ne pas dépendre du build).
app.post("/api/support/tickets", express.json({ limit: "2mb" }), supportTicketHandler);
app.post("/support/tickets", express.json({ limit: "2mb" }), supportTicketHandler);

// GET /api/tickets — les tickets de l'utilisateur courant
app.get("/api/tickets", requireCurrentUser, (req, res) => {
  const user = req._user;
  const mine = (req._store.tickets || [])
    .filter((t) => t.userId === user.id)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  res.json({ ok: true, tickets: mine.map(ticketSummary) });
});

// GET /api/tickets/:id — détail (propriétaire ou admin)
app.get("/api/tickets/:id", requireCurrentUser, (req, res) => {
  const user = req._user;
  const t = (req._store.tickets || []).find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ ok: false, detail: "Ticket introuvable" });
  if (t.userId !== user.id && !isAdmin(user)) {
    return res.status(403).json({ ok: false, detail: "Accès refusé" });
  }
  res.json({ ok: true, ticket: t });
});

// POST /api/tickets/:id/messages — répondre (propriétaire ou admin)
app.post("/api/tickets/:id/messages", requireCurrentUser, express.json({ limit: "64kb" }), async (req, res) => {
  const user = req._user;
  const body = _tkStr(req.body?.message, 5000).trim();
  if (!body) return res.status(400).json({ ok: false, detail: "Message requis" });

  const admin = isAdmin(user);
  let updated = null;
  let denied = false;
  let notFound = false;

  await mutateStore((fresh) => {
    const t = (fresh.tickets || []).find((x) => x.id === req.params.id);
    if (!t) { notFound = true; return; }
    if (t.userId !== user.id && !admin) { denied = true; return; }
    t.messages = t.messages || [];
    t.messages.push({
      id: `msg_${crypto.randomBytes(4).toString("hex")}`,
      authorRole: admin && t.userId !== user.id ? "admin" : "user",
      authorName: user.name || user.email || "Utilisateur",
      body,
      createdAt: nowIso(),
    });
    // Réponse admin → en attente du user ; réponse user → rouvre le ticket.
    t.status = admin && t.userId !== user.id ? "pending" : "open";
    t.updatedAt = nowIso();
    updated = t;
  });

  if (notFound) return res.status(404).json({ ok: false, detail: "Ticket introuvable" });
  if (denied) return res.status(403).json({ ok: false, detail: "Accès refusé" });

  // Notifie l'autre partie
  if (admin && updated.email) {
    sendMail({
      to: updated.email,
      subject: `Réponse à votre demande · ${updated.subject}`,
      html: emailLayout(
        "Réponse du support FOXSCAN",
        `<p>Votre demande <strong>${escapeHtml(updated.subject)}</strong> a reçu une réponse :</p>
         <pre style="background:#F5F5F7;padding:14px;border-radius:8px;font-size:13px;white-space:pre-wrap">${escapeHtml(body)}</pre>
         <p><a href="https://foxscan.fr/dashboard/support/">Voir la conversation</a></p>`,
      ),
    }).catch((e) => console.error("[tickets] notif user:", e.message));
  } else if (!admin && adminNotifEmail) {
    sendMail({
      to: adminNotifEmail,
      replyTo: updated.email || undefined,
      subject: `🎫 Réponse ticket · ${updated.subject}`,
      html: emailLayout(
        "Nouvelle réponse sur un ticket",
        `<p><strong>${escapeHtml(updated.userName || updated.email)}</strong> a répondu :</p>
         <pre style="background:#F5F5F7;padding:14px;border-radius:8px;font-size:13px;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
      ),
    }).catch(() => {});
  }

  res.json({ ok: true, ticket: updated });
});

// ── Côté admin ──────────────────────────────────────────────────────────────

// GET /admin/tickets — tous les tickets (filtre status optionnel)
app.get("/admin/tickets", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const store = readStore();
  const statusFilter = String(req.query.status || "").trim();
  let list = Array.isArray(store.tickets) ? store.tickets.slice() : [];
  if (statusFilter) list = list.filter((t) => t.status === statusFilter);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  const all = store.tickets || [];
  res.json({
    ok: true,
    tickets: list.map(ticketSummary),
    counts: {
      total: all.length,
      open: all.filter((t) => t.status === "open").length,
      pending: all.filter((t) => t.status === "pending").length,
      resolved: all.filter((t) => t.status === "resolved").length,
    },
  });
});

// PATCH /admin/tickets/:id — changer le statut
app.patch("/admin/tickets/:id", express.json({ limit: "4kb" }), async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const status = String(req.body?.status || "").trim();
  if (!TICKET_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, detail: "Statut invalide" });
  }
  let updated = null;
  await mutateStore((fresh) => {
    const t = (fresh.tickets || []).find((x) => x.id === req.params.id);
    if (!t) return;
    t.status = status;
    t.updatedAt = nowIso();
    updated = t;
  });
  if (!updated) return res.status(404).json({ ok: false, detail: "Ticket introuvable" });
  res.json({ ok: true, ticket: ticketSummary(updated) });
});

// ─────────────────────────────────────────────────────────────────────────────
// ASSISTANCE ADMIN — RÉOUVERTURE D'UN EDL FINALISÉ (versionnage conforme)
// ─────────────────────────────────────────────────────────────────────────────
// CADRE JURIDIQUE — à ne pas contourner :
// Une signature atteste d'un CONTENU précis à un instant précis (art. 3-2 loi
// du 6 juillet 1989 ; intégrité de l'acte exigée par eIDAS / art. 1367 C. civ.).
// On ne peut donc PAS rouvrir un EDL signé en conservant les signatures : le
// document signé ne correspondrait plus à ce que les parties ont accepté, ce
// qui l'invaliderait et pourrait relever du faux (art. 441-1 C. pénal).
//
// Conception retenue :
//   1. L'EDL signé d'origine est IMMUABLE — jamais modifié ni supprimé.
//   2. La réouverture crée une NOUVELLE VERSION en brouillon, contenu repris
//      mais SIGNATURES RETIRÉES → elle doit être re-signée contradictoirement.
//   3. Trace d'audit complète (qui, quand, pourquoi).

// Supprime récursivement toute trace de signature d'un payload copié.
function stripSignatures(value) {
  if (Array.isArray(value)) return value.map(stripSignatures);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Toute clé contenant "signature" / "signed" est écartée de la copie.
      if (/signature/i.test(k)) continue;
      if (/^signedBy/i.test(k) || /^signedAt$/i.test(k)) continue;
      out[k] = stripSignatures(v);
    }
    return out;
  }
  return value;
}

// POST /admin/reports/:reportID/reopen — body { reason }
app.post("/admin/reports/:reportID/reopen", express.json({ limit: "8kb" }), async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const admin = req._user || null;
  const reason = String(req.body?.reason || "").slice(0, 500).trim();
  if (!reason) {
    return res.status(400).json({ ok: false, detail: "Un motif est requis (traçabilité)." });
  }

  const reportID = String(req.params.reportID || "").trim();
  let created = null;
  let notFound = false;
  let notFinalized = false;

  await mutateStore((fresh) => {
    fresh.reports = fresh.reports || [];
    const orig = fresh.reports.find((r) => r.id === reportID);
    if (!orig) { notFound = true; return; }
    if (!(orig.isFinalized === true || orig.payload?.isFinalized === true)) {
      notFinalized = true;
      return;
    }

    const version = (orig.version || 1) + 1;
    const newId = `rep_${crypto.randomBytes(6).toString("hex")}`;
    const payload = stripSignatures(orig.payload || {});
    payload.isFinalized = false;
    payload.finalizedAt = null;
    payload.signedByTenant = false;
    payload.signedByOwner = false;

    const copy = {
      id: newId,
      userID: orig.userID,
      projectID: orig.projectID,
      address: orig.address,
      tenantName: orig.tenantName,
      folderID: orig.folderID || null,
      fileName: `${(orig.fileName || "rapport").replace(/\.pdf$/i, "")}_v${version}.pdf`,
      payload,
      isFinalized: false,
      finalizedAt: null,
      version,
      previousVersionID: orig.id,
      reopenedAt: nowIso(),
      reopenedBy: admin?.id || "admin",
      reopenReason: reason,
      requiresResignature: true,
      createdAt: nowIso(),
    };

    // L'original reste intact ; on note seulement qu'il a été remplacé.
    orig.supersededByID = newId;
    orig.supersededAt = nowIso();

    fresh.reports.push(copy);

    fresh.auditEvents = fresh.auditEvents || [];
    fresh.auditEvents.push({
      id: `aud_${crypto.randomBytes(4).toString("hex")}`,
      type: "report.reopened",
      reportID: orig.id,
      newReportID: newId,
      userID: orig.userID,
      adminID: admin?.id || "admin",
      reason,
      createdAt: nowIso(),
    });

    created = copy;
  });

  if (notFound) return res.status(404).json({ ok: false, detail: "Rapport introuvable" });
  if (notFinalized) {
    return res.status(400).json({
      ok: false,
      detail: "Ce rapport n'est pas finalisé — il est déjà modifiable.",
    });
  }

  res.status(201).json({
    ok: true,
    report: {
      id: created.id,
      version: created.version,
      previousVersionID: created.previousVersionID,
      requiresResignature: true,
    },
    notice:
      "Nouvelle version créée en brouillon, sans les signatures. L'original signé est conservé intact. La version corrigée devra être re-signée par les parties.",
  });
});

// ── Dossiers (folders) ───────────────────────────────────────────────────────
//
// store.folders = { [userID]: [{ id, name, color, createdAt }] }
// store.reports[].folderID (string | null)

const FOLDER_COLORS = ["#10A37F","#FF7A1A","#8B5CF6","#3B82F6","#EF4444","#F59E0B","#6B7280"];

function getFolders(store, userID) {
  return ((store.folders || {})[userID] || []);
}

app.get("/api/folders", requireCurrentUser, (req, res) => {
  const store = req._store;
  return res.json({ ok: true, folders: getFolders(store, req._user.id) });
});

app.post("/api/folders", requireCurrentUser, express.json({ limit: "4kb" }), async (req, res) => {
  const user = req._user;
  const name = String(req.body?.name || "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ ok: false, detail: "name requis" });
  const color = String(req.body?.color || FOLDER_COLORS[0]).trim();
  const folder = {
    id: `folder-${crypto.randomBytes(4).toString("hex")}`,
    name,
    color,
    createdAt: nowIso(),
  };
  // Append atomique : évite d'écraser un dossier créé en parallèle.
  await mutateStore((fresh) => {
    fresh.folders = fresh.folders || {};
    fresh.folders[user.id] = fresh.folders[user.id] || [];
    fresh.folders[user.id].push(folder);
  });
  return res.status(201).json({ ok: true, folder });
});

app.patch("/api/folders/:folderID", requireCurrentUser, express.json({ limit: "4kb" }), async (req, res) => {
  const user = req._user;
  const folderID = String(req.params.folderID || "").trim();
  let updated = null;
  let notFound = false;
  await mutateStore((fresh) => {
    const folders = getFolders(fresh, user.id);
    const idx = folders.findIndex((f) => f.id === folderID);
    if (idx === -1) { notFound = true; return; }
    if (req.body?.name != null) folders[idx].name = String(req.body.name).trim().slice(0, 80);
    if (req.body?.color != null) folders[idx].color = String(req.body.color).trim();
    fresh.folders = fresh.folders || {};
    fresh.folders[user.id] = folders;
    updated = folders[idx];
  });
  if (notFound) return res.status(404).json({ ok: false, detail: "Dossier introuvable" });
  return res.json({ ok: true, folder: updated });
});

app.delete("/api/folders/:folderID", requireCurrentUser, async (req, res) => {
  const user = req._user;
  const folderID = String(req.params.folderID || "").trim();
  await mutateStore((fresh) => {
    fresh.folders = fresh.folders || {};
    fresh.folders[user.id] = (fresh.folders[user.id] || []).filter((f) => f.id !== folderID);
    // Les rapports gardent leur folderID — ils apparaissent dans "Sans dossier"
  });
  return res.json({ ok: true });
});

app.patch("/api/reports/:reportID/folder", requireCurrentUser, express.json({ limit: "1kb" }), async (req, res) => {
  const user = req._user;
  const reportID = String(req.params.reportID || "").trim();
  let folderIDOut = null;
  let notFound = false;
  await mutateStore((fresh) => {
    const report = (fresh.reports || []).find((r) => r.id === reportID && r.userID === user.id);
    if (!report) { notFound = true; return; }
    const folderID = req.body?.folderID ?? null;
    report.folderID = folderID ? String(folderID) : null;
    folderIDOut = report.folderID;
  });
  if (notFound) return res.status(404).json({ ok: false, detail: "Rapport introuvable" });
  return res.json({ ok: true, folderID: folderIDOut });
});

// ── Import EDL externe (comparaison — sans sauvegarde store) ─────────────────
//
// Même pipeline que /imports/edl (PDF ou image → IA Vision → NormalizedEDL)
// mais retourne uniquement le payload normalisé, sans créer de projet ni de
// rapport dans store.json. Utilisé par le dashboard pour comparer un EDL
// tiers (SNEXI, papier scanné, photo) avec un EDL FOXSCAN.
//
// Accepte :
//   • Un seul PDF  → Content-Type: application/pdf
//   • Une ou plusieurs images → multipart/form-data (fieldname quelconque)
//   • Une seule image → binary + Content-Type: image/*
app.post(
  "/api/comparison/import-external",
  requireCurrentUser,
  express.raw({ type: "*/*", limit: "30mb" }),
  async (req, res, next) => {
    try {
      const user = req._user;
      const rawBuf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!rawBuf || rawBuf.length === 0) {
        return res.status(400).json({ ok: false, detail: "Fichier manquant" });
      }

      // Aperçus du document pour l'écran de validation (voir renderPagePreviews :
      // la CSP interdit <object>/<iframe blob:>, on passe donc par des images).
      const { renderPagePreviews } = require("./lib/pdfRaster.js");

      // Précisions saisies par l'utilisateur après une extraction incomplète.
      // Transmises via header base64 (jamais en URL : elles peuvent contenir
      // des données du bien / du locataire).
      let instructions = "";
      try {
        const raw = req.header("x-edl-instructions") || "";
        if (raw) instructions = Buffer.from(raw, "base64").toString("utf-8").slice(0, 2000);
      } catch (_) { instructions = ""; }

      let normalized;
      // Compteur de consommation (jetons réellement facturés) pour la marge/client.
      const metered = meteredOpenAI();
      const ct = req.headers["content-type"] || "";

      if (ct.toLowerCase().includes("multipart/form-data")) {
        // Plusieurs images (pages d'un EDL papier, plusieurs scans…)
        const parts = parseMultipart(rawBuf, ct);
        if (!parts || parts.length === 0) {
          return res.status(400).json({ ok: false, detail: "Aucun fichier dans le multipart" });
        }
        const images = parts
          .filter((p) => p.data && p.data.length > 0)
          .map((p) => ({
            mime: (p.contentType || "image/jpeg").split(";")[0].trim(),
            buffer: p.data,
          }));
        if (images.length === 0) {
          return res.status(400).json({ ok: false, detail: "Aucune image valide" });
        }
        normalized = await importEDLFromImagesImpl(images, {
          callOpenAI: metered.call,
          instructions,
        });
      } else {
        const detected = detectFileKind(rawBuf);
        if (!detected) {
          return res.status(400).json({
            ok: false,
            detail: "Format non reconnu. Formats acceptés : PDF, JPG, PNG, HEIC, WEBP.",
          });
        }
        if (detected.kind === "pdf") {
          normalized = await importEDLImpl(rawBuf, {
            callOpenAI: metered.call,
            instructions,
          });
        } else {
          normalized = await importEDLFromImagesImpl(
            [{ mime: detected.mime, buffer: rawBuf }],
            { callOpenAI: metered.call, instructions }
          );
        }
      }

      // Consommation réelle de ce traitement, attribuée au compte.
      recordUsage({ userId: user.id, type: "edl_import", totals: metered.totals })
        .catch(() => {});
      console.log(
        `[usage] import EDL user=${user.id} appels=${metered.totals.calls} ` +
        `coût=${(metered.totals.costMicros / 1_000_000).toFixed(4)} EUR`
      );

      // Aperçus : rendu serveur pour les PDF ; pour une image envoyée
      // directement, le navigateur affiche déjà le fichier d'origine.
      let pagePreviews = [];
      try {
        if (!ct.toLowerCase().includes("multipart/form-data") && detectFileKind(rawBuf)?.kind === "pdf") {
          pagePreviews = await renderPagePreviews(rawBuf);
        }
      } catch (e) {
        console.warn("[import-external] aperçus indisponibles :", e.message);
      }

      const reportID = `ext-${crypto.randomBytes(4).toString("hex")}`;
      const reportPayload = toFoxscanReport(normalized, { reportId: reportID, projectId: "external" });

      const meta = normalized.meta || {};
      const address = [
        [meta.address, meta.addressComplement].filter(Boolean).join(", "),
        [meta.postalCode, meta.city].filter(Boolean).join(" "),
      ]
        .filter((v) => v && v.trim().length)
        .join(", ") || null;

      console.log(
        `[/api/comparison/import-external] user=${user.id} format=${normalized.sourceFormat} ` +
        `rooms=${(normalized.rooms || []).length} confidence=${normalized.confidence}`
      );

      return res.json({
        ok: true,
        report: {
          id: reportID,
          projectID: null,
          fileName: "import-externe",
          createdAt: nowIso(),
          tenantName: reportPayload.tenantName || null,
          isFinalized: true,
          finalizedAt: reportPayload.inspectionDate || nowIso(),
          inspectionType: reportPayload.inspectionType || null,
          address,
          payload: reportPayload,
          _source: "external",
          _confidence: normalized.confidence,
          _sourceFormat: normalized.sourceFormat,
          // Diagnostic de l'extraction — alimente l'étape de validation
          // (nb de pièces/éléments, états non reconnus, méta manquantes).
          _quality: normalized.quality || null,
          // Images du document (data URL) pour l'aperçu côté validation.
          _pagePreviews: pagePreviews,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── Grille travaux (persistance serveur) ─────────────────────────────────────

app.get("/api/user/grille", requireCurrentUser, (req, res) => {
  const user = req._user;
  const store = req._store;
  const items = (store.grilles || {})[user.id] || null;
  return res.json({ ok: true, items });
});

app.put("/api/user/grille", requireCurrentUser, express.json({ limit: "512kb" }), (req, res) => {
  const user = req._user;
  const store = req._store;
  const items = req.body && req.body.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, detail: "items doit être un tableau" });
  }
  const valid = items.filter((it) =>
    it && typeof it === "object" &&
    typeof it.id === "string" &&
    typeof it.label === "string" &&
    typeof it.priceHT === "number"
  );
  store.grilles = store.grilles || {};
  store.grilles[user.id] = valid;
  writeStore(store);
  return res.json({ ok: true, count: valid.length });
});

// ── Prestataires / fiches entreprise (persistance serveur, par compte) ───────
// Chaque agence/intervenant gère son propre annuaire d'entreprises, auxquelles
// les interventions (postes de la grille) pourront être rattachées.
// ═══════════════════════════════════════════════════════════════════════════
// DEMANDES DE DEVIS ET MANDATS D'INTERVENTION
//
// Chaîne complète : un élément dégradé au comparatif → une demande de devis
// envoyée à plusieurs entreprises → les montants reçus → le mandat à celle
// qu'on retient.
//
// UN POINT DE CONCEPTION QUI N'EST PAS NÉGOCIABLE : rien ne part tout seul.
// Envoyer une demande engage le temps d'un tiers ; mandater engage de
// l'argent. Les deux sont donc des routes distinctes, appelées sur un geste
// explicite, jamais un effet de bord de la création. « Automatique » veut
// dire « en un clic », pas « à l'insu de celui qui signe ».
// ═══════════════════════════════════════════════════════════════════════════

const WORK_ORDER_STATUSES = new Set(["draft", "quoted", "mandated", "done", "cancelled"]);

function sanitizeWorkOrderLine(raw) {
  const element = String(raw?.element || "").trim().slice(0, 160);
  if (!element) return null;
  return {
    room: String(raw?.room || "").trim().slice(0, 120),
    element,
    category: String(raw?.category || "").trim().slice(0, 60),
    description: String(raw?.description || "").trim().slice(0, 400),
    estimateHT: Math.max(0, Math.round((Number(raw?.estimateHT) || 0) * 100) / 100),
  };
}

function workOrderSummary(wo) {
  const quotes = wo.quotes || [];
  const received = quotes.filter((q) => q.status === "received" && q.amountHT != null);
  const best = received.length
    ? received.reduce((a, b) => (b.amountHT < a.amountHT ? b : a))
    : null;
  return {
    ...wo,
    estimateHT: (wo.lines || []).reduce((n, l) => n + (l.estimateHT || 0), 0),
    quotesRequested: quotes.length,
    quotesReceived: received.length,
    bestQuote: best ? { providerId: best.providerId, providerName: best.providerName, amountHT: best.amountHT } : null,
  };
}

app.get("/work-orders", requireCurrentUser, (req, res) => {
  const store = req._store;
  const mine = (store.workOrders || [])
    .filter((w) => w.userID === req._user.id)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  res.json({ ok: true, total: mine.length, items: mine.map(workOrderSummary) });
});

app.post("/work-orders", requireCurrentUser, express.json({ limit: "128kb" }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const lines = (Array.isArray(b.lines) ? b.lines : []).map(sanitizeWorkOrderLine).filter(Boolean);
    if (!lines.length) {
      return res.status(400).json({ ok: false, detail: "Au moins un poste de travaux est requis." });
    }
    const wo = {
      id: `wo_${crypto.randomBytes(5).toString("hex")}`,
      userID: req._user.id,
      projectID: String(b.projectID || "").trim() || null,
      reportID: String(b.reportID || "").trim() || null,
      propertyLabel: String(b.propertyLabel || "").trim().slice(0, 200),
      tenantName: String(b.tenantName || "").trim().slice(0, 160),
      lines,
      quotes: [],
      status: "draft",
      mandatedProviderId: null,
      mandatedAt: null,
      mandateAmountHT: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await mutateStore((fresh) => {
      fresh.workOrders = fresh.workOrders || [];
      fresh.workOrders.push(wo);
    });
    res.json({ ok: true, workOrder: workOrderSummary(wo) });
  } catch (err) { return next(err); }
});

/**
 * Envoi des demandes de devis. Route séparée, appelée sur un geste explicite :
 * la création d'un dossier de travaux n'envoie rien par elle-même.
 */
app.post("/work-orders/:id/request-quotes", requireCurrentUser, express.json({ limit: "32kb" }), async (req, res, next) => {
  try {
    const store = req._store;
    const user = req._user;
    const wo = (store.workOrders || []).find((w) => w.id === req.params.id && w.userID === user.id);
    if (!wo) return res.status(404).json({ ok: false, detail: "Dossier introuvable" });

    const wanted = Array.isArray(req.body?.providerIds) ? req.body.providerIds.map(String) : [];
    const mine = (store.providers || {})[user.id] || [];
    const targets = mine.filter((p) => wanted.includes(String(p.id)) && p.email);
    if (!targets.length) {
      return res.status(400).json({ ok: false, detail: "Aucune entreprise sélectionnée avec une adresse e-mail." });
    }

    const totalHT = (wo.lines || []).reduce((n, l) => n + (l.estimateHT || 0), 0);
    const rows = (wo.lines || []).map((l) =>
      `<tr><td style="padding:7px 0;border-bottom:1px solid #E5E5EA">
         <strong>${escapeHtml(l.element)}</strong>${l.room ? ` — ${escapeHtml(l.room)}` : ""}
         ${l.description ? `<br><span style="color:#6E6E73;font-size:13px">${escapeHtml(l.description)}</span>` : ""}
       </td></tr>`).join("");

    const sent = [];
    const failed = [];
    for (const p of targets) {
      const body = `
        <h1 style="margin:0 0 14px;font-size:20px;font-weight:800">Demande de devis</h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6">
          Bonjour ${escapeHtml(p.contactName || p.companyName || "")},<br>
          Nous souhaitons recevoir un devis pour la remise en état suivante
          ${wo.propertyLabel ? `au <strong>${escapeHtml(wo.propertyLabel)}</strong>` : ""}.
        </p>
        <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0">${rows}</table>
        <p style="margin:16px 0 0;font-size:13px;color:#6E6E73">
          Merci de répondre directement à cet e-mail avec votre proposition chiffrée
          et vos délais d'intervention.
        </p>`;
      try {
        await sendMail({
          to: p.email,
          subject: `Demande de devis${wo.propertyLabel ? ` — ${wo.propertyLabel}` : ""}`,
          html: emailLayout("Demande de devis", body),
          replyTo: user.email || undefined,
        });
        sent.push(p.id);
      } catch (e) {
        console.error(`[devis] envoi échoué vers ${p.email}: ${e.message}`);
        failed.push({ id: p.id, company: p.companyName, reason: e.message });
      }
    }

    let updated = null;
    await mutateStore((fresh) => {
      const w = (fresh.workOrders || []).find((x) => x.id === wo.id);
      if (!w) return;
      w.quotes = w.quotes || [];
      for (const p of targets) {
        if (!sent.includes(p.id)) continue;
        if (w.quotes.some((q) => q.providerId === p.id)) continue;
        w.quotes.push({
          providerId: p.id,
          providerName: p.companyName || p.contactName || "",
          email: p.email,
          requestedAt: nowIso(),
          amountHT: null,
          receivedAt: null,
          note: "",
          status: "pending",
        });
      }
      if (w.status === "draft" && w.quotes.length) w.status = "quoted";
      w.updatedAt = nowIso();
      updated = w;
    });

    console.log(`[devis] ${wo.id} · ${sent.length} demande(s) envoyée(s), ${failed.length} échec(s) · total indicatif ${totalHT} €`);
    res.json({ ok: true, sent: sent.length, failed, workOrder: updated ? workOrderSummary(updated) : null });
  } catch (err) { return next(err); }
});

/** Consigne un devis reçu — saisi à la main depuis le tableau de bord. */
app.patch("/work-orders/:id/quote", requireCurrentUser, express.json({ limit: "16kb" }), async (req, res, next) => {
  try {
    const providerId = String(req.body?.providerId || "").trim();
    const raw = req.body?.amountHT;
    const amountHT = raw == null || raw === "" ? null : Math.max(0, Math.round(Number(raw) * 100) / 100);
    const declined = req.body?.declined === true;

    let updated = null;
    await mutateStore((fresh) => {
      const w = (fresh.workOrders || []).find((x) => x.id === req.params.id && x.userID === req._user.id);
      if (!w) return;
      const q = (w.quotes || []).find((x) => x.providerId === providerId);
      if (!q) return;
      if (declined) {
        q.status = "declined"; q.amountHT = null;
      } else if (amountHT != null && Number.isFinite(amountHT)) {
        q.status = "received"; q.amountHT = amountHT; q.receivedAt = nowIso();
      }
      q.note = String(req.body?.note || q.note || "").slice(0, 400);
      w.updatedAt = nowIso();
      updated = w;
    });
    if (!updated) return res.status(404).json({ ok: false, detail: "Dossier ou entreprise introuvable" });
    res.json({ ok: true, workOrder: workOrderSummary(updated) });
  } catch (err) { return next(err); }
});

/**
 * Mandate une entreprise. C'est l'acte qui engage : il envoie l'ordre de
 * mission et fige le montant. Il ne se déduit jamais d'un devis reçu — même
 * le moins-disant doit être choisi explicitement.
 */
app.post("/work-orders/:id/mandate", requireCurrentUser, express.json({ limit: "16kb" }), async (req, res, next) => {
  try {
    const store = req._store;
    const user = req._user;
    const wo = (store.workOrders || []).find((w) => w.id === req.params.id && w.userID === user.id);
    if (!wo) return res.status(404).json({ ok: false, detail: "Dossier introuvable" });
    if (wo.status === "mandated") {
      return res.status(409).json({ ok: false, detail: "Ce dossier est déjà mandaté." });
    }

    const providerId = String(req.body?.providerId || "").trim();
    const provider = ((store.providers || {})[user.id] || []).find((p) => String(p.id) === providerId);
    if (!provider || !provider.email) {
      return res.status(400).json({ ok: false, detail: "Entreprise introuvable ou sans e-mail." });
    }
    const quote = (wo.quotes || []).find((q) => q.providerId === providerId);
    const amountHT = quote?.amountHT ?? null;

    const rows = (wo.lines || []).map((l) =>
      `<tr><td style="padding:7px 0;border-bottom:1px solid #E5E5EA">
         <strong>${escapeHtml(l.element)}</strong>${l.room ? ` — ${escapeHtml(l.room)}` : ""}
       </td></tr>`).join("");
    const body = `
      <h1 style="margin:0 0 14px;font-size:20px;font-weight:800">Ordre d'intervention</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">
        Bonjour ${escapeHtml(provider.contactName || provider.companyName || "")},<br>
        Nous vous confirmons l'intervention suivante
        ${wo.propertyLabel ? `au <strong>${escapeHtml(wo.propertyLabel)}</strong>` : ""}
        ${amountHT != null ? `, sur la base de votre devis de <strong>${amountHT.toFixed(2)} € HT</strong>` : ""}.
      </p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0">${rows}</table>
      <p style="margin:16px 0 0;font-size:13px;color:#6E6E73">
        Merci de nous confirmer la date de passage en répondant à cet e-mail.
      </p>`;

    await sendMail({
      to: provider.email,
      subject: `Ordre d'intervention${wo.propertyLabel ? ` — ${wo.propertyLabel}` : ""}`,
      html: emailLayout("Ordre d'intervention", body),
      replyTo: user.email || undefined,
    });

    let updated = null;
    await mutateStore((fresh) => {
      const w = (fresh.workOrders || []).find((x) => x.id === wo.id);
      if (!w) return;
      w.status = "mandated";
      w.mandatedProviderId = providerId;
      w.mandatedAt = nowIso();
      w.mandateAmountHT = amountHT;
      w.updatedAt = nowIso();
      updated = w;
    });

    console.log(`[mandat] ${wo.id} → ${provider.companyName} · ${amountHT ?? "montant non figé"}`);
    res.json({ ok: true, workOrder: updated ? workOrderSummary(updated) : null });
  } catch (err) { return next(err); }
});

app.get("/api/user/providers", requireCurrentUser, (req, res) => {
  const user = req._user;
  const store = req._store;
  const items = (store.providers || {})[user.id] || [];
  return res.json({ ok: true, items });
});

app.put("/api/user/providers", requireCurrentUser, express.json({ limit: "512kb" }), async (req, res) => {
  const user = req._user;
  const items = req.body && req.body.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, detail: "items doit être un tableau" });
  }
  const str = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
  const valid = items
    .filter((it) => it && typeof it === "object" && typeof it.id === "string"
      && typeof it.companyName === "string" && it.companyName.trim().length)
    .map((it) => ({
      id: it.id,
      companyName: str(it.companyName, 120).trim(),
      contactName: str(it.contactName, 120),
      phone: str(it.phone, 40),
      email: str(it.email, 120),
      address: str(it.address, 200),
      specialties: Array.isArray(it.specialties)
        ? it.specialties.filter((x) => typeof x === "string").slice(0, 20)
        : [],
      notes: str(it.notes, 2000),
    }));
  await mutateStore((fresh) => {
    fresh.providers = fresh.providers || {};
    fresh.providers[user.id] = valid;
  });
  return res.json({ ok: true, count: valid.length });
});

// ── Grille vétusté (persistance serveur) ─────────────────────────────────────

const DEFAULT_VETUSTE = [
  { id: "v-peinture",       label: "Peintures intérieures",                        dureeVie: 7,  franchise: 0  },
  { id: "v-papier-peint",   label: "Papiers peints / revêtement mural",             dureeVie: 10, franchise: 0  },
  { id: "v-sols-souples",   label: "Revêtements sols souples (lino, moquette, PVC)",dureeVie: 10, franchise: 10 },
  { id: "v-parquet-cire",   label: "Parquet ciré / huilé",                          dureeVie: 30, franchise: 25 },
  { id: "v-parquet-vernis", label: "Parquet vitrifié / stratifié",                  dureeVie: 25, franchise: 25 },
  { id: "v-carrelage",      label: "Carrelage / faïence",                           dureeVie: 25, franchise: 25 },
  { id: "v-menuiserie-int", label: "Menuiseries intérieures (portes, placards)",    dureeVie: 25, franchise: 10 },
  { id: "v-menuiserie-ext", label: "Menuiseries extérieures (fenêtres, volets)",    dureeVie: 25, franchise: 25 },
  { id: "v-sanitaires",     label: "Appareils sanitaires (WC, baignoire, douche)",  dureeVie: 20, franchise: 25 },
  { id: "v-robinetterie",   label: "Robinetterie / mitigeurs",                      dureeVie: 15, franchise: 25 },
  { id: "v-electro",        label: "Électroménager (réfrigérateur, lave-linge…)",   dureeVie: 10, franchise: 20 },
  { id: "v-chauffe-eau",    label: "Chauffe-eau électrique / cumulus",              dureeVie: 15, franchise: 25 },
  { id: "v-chaudiere",      label: "Chaudière individuelle",                        dureeVie: 25, franchise: 0  },
  { id: "v-electricite",    label: "Installations électriques",                     dureeVie: 25, franchise: 25 },
  { id: "v-luminaires",     label: "Luminaires / appliques",                        dureeVie: 10, franchise: 10 },
];

app.get("/api/user/vetuste", requireCurrentUser, (req, res) => {
  const user = req._user;
  const store = req._store;
  const items = (store.vetuste || {})[user.id] || DEFAULT_VETUSTE;
  return res.json({ ok: true, items });
});

app.put("/api/user/vetuste", requireCurrentUser, express.json({ limit: "256kb" }), (req, res) => {
  const user = req._user;
  const store = req._store;
  const items = req.body && req.body.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, detail: "items doit être un tableau" });
  }
  const valid = items.filter((it) =>
    it && typeof it === "object" &&
    typeof it.id === "string" &&
    typeof it.label === "string" &&
    typeof it.dureeVie === "number" &&
    typeof it.franchise === "number"
  );
  store.vetuste = store.vetuste || {};
  store.vetuste[user.id] = valid;
  writeStore(store);
  return res.json({ ok: true, count: valid.length });
});

// ─── 404 — dernier recours, APRÈS toutes les routes ────────────────────────
// Sans lui, Express renvoie « Cannot GET /... » sur fond blanc : un visiteur
// qui suit un vieux lien tombe sur un message de développeur en anglais.
//
// Discrimination navigateur / app : un navigateur envoie toujours
// « text/html » dans Accept ; URLSession envoie « *&#47;* ». On sert donc du HTML
// aux humains et du JSON aux clients, sans casser le contrat de l'app.
app.use((req, res) => {
  const acceptsHtml = String(req.headers.accept || "").includes("text/html");
  if (!acceptsHtml) {
    return res.status(404).json({ ok: false, detail: "Not found" });
  }
  res.status(404).type("html").send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Page introuvable — FOXSCAN</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root{--bg:#F6F8F7;--surface:#fff;--ink:#131C1B;--muted:#566564;--line:#DCE3E1;--forest:#1B3A2F;--orange:#FF7A1A}
  @media (prefers-color-scheme:dark){
    :root{--bg:#0D1312;--surface:#151D1C;--ink:#E7EDEB;--muted:#93A3A1;--line:#26312F;--forest:#E7EDEB}
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:var(--bg);color:var(--ink);padding:2rem;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       line-height:1.6;-webkit-font-smoothing:antialiased}
  .card{max-width:32rem;width:100%;text-align:left}
  .mark{width:52px;height:52px;border-radius:13px;background:var(--forest);
        display:flex;align-items:center;justify-content:center;margin-bottom:1.6rem}
  .code{font-size:.72rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--orange);margin:0}
  h1{font-size:clamp(1.6rem,4vw,2.1rem);letter-spacing:-.02em;margin:.5rem 0 0;text-wrap:balance}
  p{color:var(--muted);margin:.9rem 0 0}
  ul{list-style:none;padding:0;margin:1.8rem 0 0;border-top:1px solid var(--line)}
  li{border-bottom:1px solid var(--line)}
  a{display:flex;justify-content:space-between;align-items:center;gap:1rem;
    padding:.85rem .2rem;color:var(--ink);text-decoration:none;font-weight:500}
  a:hover{color:var(--orange)}
  a span{color:var(--muted);font-weight:400;font-size:.88rem}
  a:focus-visible{outline:2px solid var(--orange);outline-offset:2px;border-radius:4px}
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 64 64" fill="none">
        <g stroke-linecap="round" stroke-width="7">
          <path d="M16 22h32" stroke="#FF7A1A"/>
          <path d="M16 34h22" stroke="#fff" opacity=".92"/>
          <path d="M16 46h26" stroke="#fff" opacity=".62"/>
        </g>
      </svg>
    </div>
    <p class="code">Erreur 404</p>
    <h1>Cette page n&rsquo;existe pas</h1>
    <p>
      Le lien est peut-&ecirc;tre p&eacute;rim&eacute;, ou l&rsquo;adresse comporte une faute de frappe.
      Voici o&ugrave; vous vouliez sans doute aller.
    </p>
    <ul>
      <li><a href="/">Accueil<span>foxscan.fr</span></a></li>
      <li><a href="/login.html">Mon espace<span>&Eacute;tats des lieux et exports</span></a></li>
      <li><a href="/aide">Centre d&rsquo;aide<span>Questions fr&eacute;quentes</span></a></li>
      <li><a href="/contact">Nous &eacute;crire<span>Une question, un probl&egrave;me</span></a></li>
    </ul>
  </main>
</body>
</html>`);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ ok: false, detail: err.message || "Internal server error" });
});

app.listen(settings.port, () => {
  console.log(`FOXSCAN API Node running on :${settings.port}`);
  // V6.2 — Lance les crons de sauvegarde et de cleanup APRÈS que le serveur soit up.
  startBackupCron();
  startCleanupCron();
});
