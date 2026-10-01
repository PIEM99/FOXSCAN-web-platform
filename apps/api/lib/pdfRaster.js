// Rasterisation de PDF scannés via Ghostscript (présent sur l'hébergement).
//
// POURQUOI : un EDL scanné envoyé « tel quel » au modèle part en basse
// définition — sur un formulaire A3 dense (coches minuscules dans une matrice
// pièces × éléments), l'essentiel devient illisible et des sections entières
// sont omises. On rasterise donc en haute résolution, et on DÉCOUPE les
// grandes pages en tuiles : chaque tuile est envoyée en `detail: "high"`,
// ce qui multiplie la résolution utile par le nombre de tuiles.
//
// Aucune dépendance npm native (sharp/canvas indisponibles) : tout passe par
// le binaire `gs` et un mini-parseur d'en-tête JPEG.

"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const GS_BIN = process.env.GHOSTSCRIPT_BIN || "gs";

/** Taille en pixels d'un JPEG, lue dans le marqueur SOF (pas de lib externe). */
function jpegSize(buf) {
  try {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0..SOF15 hors DHT (C4), DNL (C8), DAC (CC)
      if (
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch (_) { /* header illisible */ }
  return null;
}

function runGs(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(GS_BIN, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function tmpDir() {
  const dir = path.join(os.tmpdir(), `foxscan-raster-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

/**
 * Mesure chaque page en POINTS. Astuce : rendu à 72 dpi ⇒ 1 pixel = 1 point,
 * on lit donc la géométrie directement dans les JPEG produits (évite les
 * incantations PostScript fragiles pour lire la MediaBox).
 */
async function probePages(pdfPath, dir, maxPages) {
  const out = path.join(dir, "probe-%03d.jpg");
  await runGs([
    "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dQUIET",
    "-sDEVICE=jpeg", "-r72", "-dJPEGQ=40",
    `-dLastPage=${maxPages}`,
    `-sOutputFile=${out}`,
    pdfPath,
  ]);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("probe-")).sort();
  return files.map((f) => {
    const size = jpegSize(fs.readFileSync(path.join(dir, f)));
    return { widthPts: size?.width || 595, heightPts: size?.height || 842 };
  });
}

/**
 * Grille de découpe — on vise ~400 pts par tuile.
 * Plus la tuile est petite, plus le modèle a de pixels par élément et moins il
 * omet de contenu : c'est le principal levier de qualité sur les formulaires
 * denses. A3 paysage → 3×2, A4 → 2×2.
 */
function gridFor(widthPts, heightPts) {
  const TARGET = 400;
  const clamp = (n) => Math.max(1, Math.min(4, Math.round(n)));
  return { cols: clamp(widthPts / TARGET), rows: clamp(heightPts / TARGET) };
}

/** Recouvrement entre tuiles : évite de couper un bloc de pièce en deux. */
const OVERLAP_RATIO = 0.08;

/**
 * Rasterise un PDF en JPEG haute définition, découpés en tuiles si besoin.
 *
 * @returns {Promise<Array<{mime:string, buffer:Buffer, page:number, tile:string}>>}
 *          Tableau vide si Ghostscript est indisponible → l'appelant retombe
 *          sur l'envoi du PDF brut.
 */
async function rasterizePdf(pdfBuffer, options = {}) {
  const {
    dpi = 250,          // résolution des tuiles (qualité > coût)
    maxPages = 6,       // garde-fou
    maxImages = 12,     // plafond total d'images envoyées au modèle
  } = options;

  const dir = tmpDir();
  const pdfPath = path.join(dir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);

    const pages = await probePages(pdfPath, dir, maxPages);
    if (pages.length === 0) return [];

    const out = [];
    for (let p = 0; p < pages.length; p++) {
      const { widthPts, heightPts } = pages[p];
      let { cols, rows } = gridFor(widthPts, heightPts);

      // Respecte le plafond global d'images.
      while (cols * rows * pages.length > maxImages && (cols > 1 || rows > 1)) {
        if (cols >= rows) cols -= 1; else rows -= 1;
        if (cols < 1) cols = 1;
        if (rows < 1) rows = 1;
        if (cols === 1 && rows === 1) break;
      }

      // Pas de grille, puis tuile élargie du recouvrement de chaque côté.
      const stepW = widthPts / cols;
      const stepH = heightPts / rows;
      const padW = cols > 1 ? stepW * OVERLAP_RATIO : 0;
      const padH = rows > 1 ? stepH * OVERLAP_RATIO : 0;
      const tileWpts = stepW + 2 * padW;
      const tileHpts = stepH + 2 * padH;
      const pxW = Math.round((tileWpts * dpi) / 72);
      const pxH = Math.round((tileHpts * dpi) / 72);

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // Coin bas-gauche de la tuile, borné à la page.
          const x0 = Math.max(0, Math.min(c * stepW - padW, widthPts - tileWpts));
          const y0 = Math.max(0, Math.min(heightPts - (r + 1) * stepH - padH, heightPts - tileHpts));
          // Décalage de la fenêtre de rendu vers la tuile voulue.
          // NB : avec -dFIXEDMEDIA, Ghostscript applique PageOffset dans le
          // sens INVERSE de l'intuition sur X (vérifié empiriquement : X négatif
          // et Y positif révèlent la bonne région).
          const offsetX = -x0;
          const offsetY = y0;
          const file = path.join(dir, `t-${p}-${r}-${c}.jpg`);
          try {
            // ORDRE CRITIQUE : Ghostscript traite les arguments séquentiellement.
            // `-sOutputFile` doit être posé AVANT `-c` / `-f`, sinon le device
            // démarre sans fichier de sortie et gs échoue.
            await runGs([
              "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dQUIET",
              "-sDEVICE=jpeg", `-r${dpi}`, "-dJPEGQ=85",
              "-dFIXEDMEDIA", `-g${pxW}x${pxH}`,
              `-dFirstPage=${p + 1}`, `-dLastPage=${p + 1}`,
              `-sOutputFile=${file}`,
              "-c", `<</PageOffset [${offsetX} ${offsetY}]>> setpagedevice`,
              "-f", pdfPath,
            ]);
            const buf = fs.readFileSync(file);
            if (buf.length > 0) {
              out.push({
                mime: "image/jpeg",
                buffer: buf,
                page: p + 1,
                tile: cols * rows > 1 ? `p${p + 1} ${r + 1}/${rows}×${c + 1}/${cols}` : `p${p + 1}`,
              });
            }
          } catch (e) {
            console.warn(`[pdfRaster] tuile p${p + 1} r${r} c${c} échouée : ${e.message}`);
          }
        }
      }
    }
    return out;
  } catch (e) {
    console.warn("[pdfRaster] rasterisation indisponible :", e.message);
    return [];
  } finally {
    cleanup(dir);
  }
}

/**
 * Rendus d'aperçu : une image par page, sans découpe, en basse définition.
 *
 * Sert à AFFICHER le document dans l'écran de validation. On ne peut pas s'y
 * contenter d'une balise <object>/<iframe> côté navigateur : la CSP du site
 * impose `object-src 'none'` et n'autorise pas `blob:` en frame-src. Les
 * images, elles, sont autorisées (`img-src ... data: blob:`) — d'où ce rendu
 * serveur renvoyé en data URL.
 *
 * @returns {Promise<string[]>} data URLs JPEG (vide si Ghostscript absent).
 */
async function renderPagePreviews(pdfBuffer, options = {}) {
  const { dpi = 110, maxPages = 4, jpegQ = 62 } = options;
  const dir = tmpDir();
  const pdfPath = path.join(dir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const out = path.join(dir, "prev-%03d.jpg");
    await runGs([
      "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dQUIET",
      "-sDEVICE=jpeg", `-r${dpi}`, `-dJPEGQ=${jpegQ}`,
      `-dLastPage=${maxPages}`,
      `-sOutputFile=${out}`,
      pdfPath,
    ]);
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("prev-"))
      .sort()
      .map((f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString("base64")}`);
  } catch (e) {
    console.warn("[pdfRaster] aperçus indisponibles :", e.message);
    return [];
  } finally {
    cleanup(dir);
  }
}

module.exports = { rasterizePdf, renderPagePreviews, jpegSize };
