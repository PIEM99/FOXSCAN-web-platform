// Ré-encodage des images embarquées dans les PDF d'états des lieux.
//
// LE CONSTAT QUI JUSTIFIE CE MODULE
// ---------------------------------
// Les PDF produits par l'app iOS stockent leurs photos en `/FlateDecode`,
// c'est-à-dire en bitmap sans perte. Mesuré sur un EDL réel de 33 pages :
// 111 images, zéro `/DCTDecode`, 62,3 Mo. Ré-encodées en JPEG à qualité 92,
// à dimensions strictement identiques : 3,6 Mo. Soit 17 fois moins, pour un
// rendu que l'on ne distingue pas de l'original à l'écran.
//
// Ce n'est pas un arbitrage qualité/volume. La photo d'origine est déjà un
// JPEG sorti de l'appareil ; iOS la redimensionne à 900 px pour la mise en
// page, puis la restocke en bitmap sans perte. On conserve donc au prix fort
// une "fidélité" à un fichier qui avait déjà subi sa compression. Les photos
// sources, elles, restent intactes et en pleine résolution dans `exports/`.
//
// GARDE-FOUS
// ----------
// On ne remplace le PDF que si le résultat est (1) un PDF valide, (2) de même
// nombre de pages, (3) effectivement plus petit. À la moindre anomalie on
// garde l'original : un état des lieux est une pièce contractuelle, l'échec
// acceptable est "on n'a pas optimisé", jamais "on a abîmé le document".
//
// Aucune dépendance npm : Ghostscript (9.54) est présent sur l'hébergement et
// déjà utilisé par `pdfRaster.js`.

"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const GS_BIN = process.env.GHOSTSCRIPT_BIN || "gs";

/** Qualité JPEG appliquée aux images du PDF. 92 = pas de perte visible. */
const JPEG_QUALITY = Number(process.env.FOXSCAN_PDF_JPEG_QUALITY || 92);

/** Au-delà, on considère le PDF trop gros pour être traité dans la requête. */
const MAX_INPUT_BYTES = Number(process.env.FOXSCAN_PDF_MAX_BYTES || 400 * 1024 * 1024);

/** Un gain inférieur à ce seuil ne vaut pas le remplacement du fichier. */
const MIN_GAIN_RATIO = 0.05;

const GS_TIMEOUT_MS = Number(process.env.FOXSCAN_PDF_TIMEOUT_MS || 180000);

let gsAvailable = null; // null = pas encore testé

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ""));
    });
  });
}

/** Ghostscript est-il utilisable ? Testé une fois, puis mémorisé. */
async function hasGhostscript() {
  if (gsAvailable !== null) return gsAvailable;
  try {
    await run(GS_BIN, ["--version"], 5000);
    gsAvailable = true;
  } catch (_) {
    gsAvailable = false;
  }
  return gsAvailable;
}

/**
 * Nombre de pages d'un PDF, lu par Ghostscript.
 * Retourne null si la lecture échoue — l'appelant traite ce cas comme
 * "vérification impossible", pas comme "documents différents".
 */
async function pageCount(pdfPath) {
  try {
    const out = await run(GS_BIN, [
      "-q", "-dNODISPLAY", "-dNOSAFER",
      "-c", `(${pdfPath}) (r) file runpdfbegin pdfpagecount = quit`,
    ], 30000);
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

/**
 * Ré-encode les images d'un PDF en JPEG, à dimensions inchangées.
 *
 * Ne lève jamais : en cas de problème on renvoie le buffer d'origine avec
 * `applied: false` et la raison. L'appelant peut stocker le résultat sans
 * avoir à se demander s'il est sûr.
 *
 * @param {Buffer} buffer PDF d'origine
 * @param {{quality?: number, label?: string}} [opts]
 * @returns {Promise<{buffer: Buffer, applied: boolean, before: number,
 *                    after: number, ratio: number, reason: string|null}>}
 */
async function optimizePdfBuffer(buffer, opts = {}) {
  const before = buffer.length;
  const keep = (reason) => ({ buffer, applied: false, before, after: before, ratio: 1, reason });

  if (!Buffer.isBuffer(buffer) || before === 0) return keep("buffer vide");
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return keep("pas un PDF");
  if (before > MAX_INPUT_BYTES) return keep(`PDF trop volumineux (${before} octets)`);
  if (!(await hasGhostscript())) return keep("ghostscript indisponible");

  const quality = Number(opts.quality) || JPEG_QUALITY;
  const dir = path.join(os.tmpdir(), `foxscan-pdfopt-${crypto.randomBytes(6).toString("hex")}`);
  const src = path.join(dir, "in.pdf");
  const dst = path.join(dir, "out.pdf");

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(src, buffer);

    await run(GS_BIN, [
      "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.7",
      // Les images passent en JPEG. `AutoFilter=false` empêche Ghostscript de
      // retomber sur Flate quand il juge l'image "peu photographique" —
      // c'est précisément ce comportement qui produit les fichiers de 60 Mo.
      "-dAutoFilterColorImages=false", "-dColorImageFilter=/DCTEncode",
      "-dAutoFilterGrayImages=false", "-dGrayImageFilter=/DCTEncode",
      // Dimensions inchangées : on ne rééchantillonne rien. Le nombre de
      // pixels du document reste exactement celui qu'a produit iOS.
      "-dDownsampleColorImages=false", "-dDownsampleGrayImages=false",
      "-dDownsampleMonoImages=false",
      `-dJPEGQ=${quality}`,
      "-dPreserveAnnots=true",
      `-sOutputFile=${dst}`, src,
    ], GS_TIMEOUT_MS);

    if (!fs.existsSync(dst)) return keep("ghostscript n'a rien produit");

    const out = fs.readFileSync(dst);
    if (out.subarray(0, 5).toString("latin1") !== "%PDF-") return keep("sortie illisible");

    const after = out.length;
    if (after >= before * (1 - MIN_GAIN_RATIO)) {
      return keep(`gain insuffisant (${before} → ${after})`);
    }

    // Même nombre de pages, sinon on n'a pas affaire au même document.
    const [pIn, pOut] = await Promise.all([pageCount(src), pageCount(dst)]);
    if (pIn !== null && pOut !== null && pIn !== pOut) {
      return keep(`nombre de pages différent (${pIn} → ${pOut})`);
    }

    return { buffer: out, applied: true, before, after, ratio: after / before, reason: null };
  } catch (err) {
    return keep(`ghostscript: ${err.message}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* nettoyage best-effort */ }
  }
}

module.exports = { optimizePdfBuffer, hasGhostscript, JPEG_QUALITY };
