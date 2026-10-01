// V5.2 — Import d'EDL existants (PDFs d'autres prestataires).
//
// Pipeline :
//   1) pdf-parse → on tente d'extraire le texte natif
//   2) Si le texte est structuré (>1000 chars + signaux SNEXI/Oracio/etc.)
//      → parser dédié déterministe (gratuit, fiable)
//   3) Sinon (PDF scanné, formulaire à checkbox, manuscrit, …)
//      → IA Vision via Responses API (GPT-4o-mini) avec structured outputs
//
// Tous les parsers retournent le MÊME schéma normalisé (NormalizedEDL),
// que l'appelant convertit ensuite en payload.report FOXSCAN.

"use strict";

// V5.2.1 — Require de pdf-parse rendu LAZY + OPTIONNEL.
//
// 2 problèmes connus sur Hostinger / Passenger :
//   1) `pdf-parse/index.js` exécute du code de debug au require si
//      `module.parent === null` → ENOENT sur un fichier de test absent
//      → crash de tout le process → API en 503.
//      Mitigation : on require le module interne `lib/pdf-parse.js`
//      qui n'a pas ce code.
//   2) `npm install` n'a parfois pas tourné côté Hostinger SSH
//      (npm pas dans le PATH) → `pdf-parse` peut ne pas être installé
//      du tout → require throw MODULE_NOT_FOUND → 503.
//      Mitigation : on tente le require au moment de l'utilisation
//      seulement, et on tolère son absence (fallback Vision-only).
//
// Voir https://gitlab.com/autokent/pdf-parse/-/issues/19
// Rasterisation Ghostscript : indispensable pour les scans denses (formulaires
// A3 à cocher), où l'envoi du PDF brut perd la quasi-totalité des coches.
const { rasterizePdf } = require("./pdfRaster.js");

// ─── Arbitrage qualité / coût ─────────────────────────────────────────────
//
// Mesuré sur un formulaire A3 scanné dense :
//   • une seule passe sur tout le document           → 69 % (1 pièce sur 8)
//   • découpe en tuiles + extraction parallèle       → 81 %   (gpt-4o-mini)
//   • + modèle gpt-4o                                → 85 %
// Le gain vient donc de l'ARCHITECTURE, pas du modèle : +12 pts pour la
// découpe (gratuite, Ghostscript local) contre +4 pts pour un modèle ~20× plus
// cher. On garde donc le modèle économique pour le gros du travail.
const VISION_MODEL = process.env.EDL_VISION_MODEL || "gpt-4o-mini";

// Seule exception : le cartouche d'identité (noms, adresse, date) est
// manuscrit et ne tolère pas l'à-peu-près. C'est UN SEUL appel par import,
// donc on s'y autorise le modèle précis (~1,5 centime).
const META_MODEL = process.env.EDL_META_MODEL || "gpt-4o";

// Tours de rattrapage des sections manquantes. Le modèle économique est plus
// variable d'une exécution à l'autre : les tours rattrapent les pièces
// oubliées pour quelques millimes (appels `mini`). La boucle s'arrête d'elle-
// même dès qu'un tour n'apporte rien OU que le budget de temps est épuisé.
const MAX_COMPLETION_ROUNDS = Number(process.env.EDL_MAX_ROUNDS || 2);

// Garde-fous ANTI-504. Le proxy devant le Node coupe la requête HTTP au bout
// d'~60 s : on borne donc l'import pour rendre TOUJOURS une réponse avant.
//   • EDL_CALL_TIMEOUT_MS : chaque appel OpenAI abandonne au bout de ce délai
//     (résultat partiel plutôt que blocage).
//   • EDL_BUDGET_MS : budget total ; on ne démarre pas un tour de rattrapage
//     si le temps restant est insuffisant.
const EDL_CALL_TIMEOUT_MS = Number(process.env.EDL_CALL_TIMEOUT_MS || 38000);
const EDL_BUDGET_MS = Number(process.env.EDL_BUDGET_MS || 48000);

let _pdfParse = null;
let _pdfParseLoadAttempted = false;
function getPdfParse() {
  if (_pdfParseLoadAttempted) return _pdfParse;
  _pdfParseLoadAttempted = true;
  try {
    _pdfParse = require("pdf-parse/lib/pdf-parse.js");
  } catch (e) {
    // pdf-parse pas installé → on n'aura pas de détection de format.
    // L'import basculera systématiquement en IA Vision (plus coûteux
    // mais fonctionnel). On log pour diagnostic mais on ne crashe pas.
    console.warn("[edlImport] pdf-parse non disponible — fallback Vision pour tous les imports : " + e.message);
    _pdfParse = null;
  }
  return _pdfParse;
}

// ─── Schéma JSON commun retourné par tous les parsers ─────────────────
//
// On n'utilise PAS une lib de validation (ajv etc.) pour rester sans
// dépendances lourdes : la validation se fait par défensive coding et
// par le schema JSON envoyé à OpenAI (qui garantit la forme côté IA).
//
// {
//   meta: {
//     address, addressComplement, postalCode, city,
//     propertyType,           // "studio" | "T1" | "T2" | ... | "maison"
//     surfaceM2,              // nombre
//     inspectionType,         // "entry" | "exit" | "inventory"
//     date,                   // ISO YYYY-MM-DD
//     tenantSortantName,
//     tenantEntrantName,
//     landlordName,
//     agencyName,
//   },
//   meters: {
//     waterCold:   { index, location, notes },
//     waterHot:    { index, location, notes },
//     electricity: { hp, hc, location, notes },
//     gas:         { index, location, notes, present },
//   },
//   boiler: { brand, lastMaintenance, maintenanceDone },
//   smokeDetector: { present, rooms: ["Cuisine", ...] },
//   keys: [
//     { type: "Appartement", count: 2, state: "OK" }, ...
//   ],
//   rooms: [
//     {
//       name: "Séjour",
//       items: [
//         {
//           category: "Sol",     // "Sol" | "Mur" | "Plafond" | "Plinthe" | "Porte" | "Fenêtre" | …
//           nature: "Parquet",   // matériau / précision
//           stateEntry: "BE",    // null si format sortie seul
//           stateExit:  "EM",    // "BE" | "EM" | "DE" | "HS" | "Bon" | …
//           working: "OK",       // "OK" | "KO" | null
//           notes: "Rayé, trace de peinture",
//           quantity: 1,
//         }, ...
//       ],
//       globalComment: "..."
//     }
//   ],
//   sourceFormat: "snexi" | "vision" | "fallback",
//   confidence: 0..1,
// }

// ─── Détection du format ──────────────────────────────────────────────

const SNEXI_SIGNALS = [
  /SNEXI/i,
  /ORACIO/i,
  /État des lieux d['e](?:entr[ée]e|sortie)/i,
  /Reportage photo de/i,
  /Inventaire et remise des cl[ée]s/i,
];

const GASPERIS_SIGNALS = [
  /de\s*gasperis/i,
  /CONSTAT\s+D['e]ETAT\s+DES\s+LIEUX/i,
  /LEGENDE\s*:.*NF\s*:\s*Neuf/i,
];

function classifyFormat(text) {
  if (!text || text.length < 200) return "scanned";  // peu de texte → PDF image
  if (SNEXI_SIGNALS.some((re) => re.test(text))) return "snexi";
  if (GASPERIS_SIGNALS.some((re) => re.test(text))) return "gasperis";
  // Heuristique générique : si on a un volume significatif de texte mais
  // pas un format reconnu, on bascule en IA Vision avec un prompt
  // générique (plus prudent qu'un parser bricolé).
  return "unknown_native";
}

// ─── Parser SNEXI (texte natif) ───────────────────────────────────────
//
// Le format SNEXI / Oracio est très régulier :
//   - Header bloc en haut : "État des lieux de [type]", "LOCATAIRE(S) : ...",
//     "Date : DD/MM/YYYY", puis ligne avec "N° OS : XXX", puis bloc adresse.
//   - Sections globales : Compteurs / Contrats / Détecteurs de fumée /
//     Inventaire et remise des clés.
//   - Puis pour chaque pièce : ligne "<Nom pièce>", puis tableau
//     "Eléments | À l'entrée | À la sortie", puis lignes "<libellé>  <état entrée>  <état sortie>".

function parseSnexi(text) {
  const out = {
    meta: {},
    meters: {},
    boiler: {},
    smokeDetector: { present: null, rooms: [] },
    keys: [],
    rooms: [],
    sourceFormat: "snexi",
    confidence: 0.9,
  };

  // Type d'EDL
  const typeMatch = text.match(/État des lieux\s+(?:d['e]\s*)?(entr[ée]e|sortie)/i);
  if (typeMatch) {
    out.meta.inspectionType = typeMatch[1].toLowerCase().startsWith("e") ? "entry" : "exit";
  }

  // Date au format "Date : DD/MM/YYYY"
  const dateMatch = text.match(/Date\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (dateMatch) {
    out.meta.date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  }

  // Locataire(s)
  const tenantMatch = text.match(/LOCATAIRE\(S\)\s*:\s*([^\n]+)/i);
  if (tenantMatch) {
    const name = tenantMatch[1].trim();
    if (out.meta.inspectionType === "exit") {
      out.meta.tenantSortantName = name;
    } else {
      out.meta.tenantEntrantName = name;
    }
  }

  // Propriétaire (souvent "le propriétaire <NOM> représenté par...")
  const ownerMatch = text.match(/propriétaire\s+([A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ\s-]+?)\s+représenté/i);
  if (ownerMatch) out.meta.landlordName = ownerMatch[1].trim();

  // Agence
  const agencyMatch = text.match(/la société\s+([A-ZÀ-Ÿ][\w\s-]+?)\s+pour le bien/i);
  if (agencyMatch) out.meta.agencyName = agencyMatch[1].trim();

  // Adresse (bloc tableau)
  const addrLine = text.match(/Adresse\s*:\s*([^\n]+)/);
  if (addrLine) out.meta.address = addrLine[1].replace(/Complément.*$/i, "").trim();
  const addrComplement = text.match(/Complément\s*:\s*([^\n]+)/);
  if (addrComplement) {
    const v = addrComplement[1].trim();
    if (v && v !== "-") out.meta.addressComplement = v;
  }
  const cityLine = text.match(/Ville\s*:\s*(\d{4,5})\s+([^\n]+)/);
  if (cityLine) {
    out.meta.postalCode = cityLine[1];
    out.meta.city = cityLine[2].trim();
  }

  // Type de logement (T1 / T2 / ...)
  const typeMatchProp = text.match(/Type\s*:\s*Appartement\s+(T\d\+?)/i);
  if (typeMatchProp) out.meta.propertyType = typeMatchProp[1];
  else if (/Type\s*:\s*Maison/i.test(text)) out.meta.propertyType = "maison";
  else if (/Type\s*:\s*Studio/i.test(text)) out.meta.propertyType = "studio";
  else if (/Type\s*:\s*Local/i.test(text)) out.meta.propertyType = "local-commercial";

  // Compteurs
  const waterColdMatch = text.match(/Eau froide[\s\S]*?Index\s*:\s*(\d+)\s*m³/i);
  if (waterColdMatch) out.meters.waterCold = { index: waterColdMatch[1] };
  const waterHotMatch = text.match(/Eau chaude[\s\S]*?Index\s*:\s*(\d+)\s*m³/i);
  if (waterHotMatch) out.meters.waterHot = { index: waterHotMatch[1] };
  const elecHPMatch = text.match(/Heures pleines[\s\S]*?Index\s*:\s*(\d+)\s*kwh/i);
  if (elecHPMatch) out.meters.electricity = { hp: elecHPMatch[1] };
  const elecHCMatch = text.match(/Heures creuses[\s\S]*?Index\s*:\s*(\d+)\s*kwh/i);
  if (elecHCMatch) {
    out.meters.electricity = out.meters.electricity || {};
    out.meters.electricity.hc = elecHCMatch[1];
  }
  if (/Gaz\s+En service\s*:\s*OUI/i.test(text)) {
    const gasIdx = text.match(/Gaz[\s\S]{0,400}?Index\s*:\s*([\d.]+)/i);
    out.meters.gas = { present: true, index: gasIdx ? gasIdx[1] : null };
  } else if (/Gaz\s+En service\s*:\s*NON/i.test(text)) {
    out.meters.gas = { present: false };
  }

  // Chaudière
  const boilerMatch = text.match(/Marque de la chaudière\s*:\s*([^\n]+)/i);
  if (boilerMatch) out.boiler.brand = boilerMatch[1].trim();
  const maintMatch = text.match(/Entretien effectué\s*:\s*(OUI|NON)/i);
  if (maintMatch) out.boiler.maintenanceDone = maintMatch[1].toUpperCase() === "OUI";

  // Détecteurs de fumée
  const smokeMatch = text.match(/Présence d['']un détecteur de fumée\s*:\s*(OUI|NON)/i);
  if (smokeMatch) out.smokeDetector.present = smokeMatch[1].toUpperCase() === "OUI";
  const smokeRoomsMatch = text.match(/Détecteur de fumée présent dans les pièces suivantes\s*:\s*([^\n]+)/i);
  if (smokeRoomsMatch) {
    out.smokeDetector.rooms = smokeRoomsMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Pièces : on cherche les sections "<Nom> Eléments À l'entrée À la sortie"
  // puis on capture les lignes jusqu'à la prochaine section ou la fin.
  parseSnexiRooms(text, out);

  return out;
}

const KNOWN_ROOM_NAMES = [
  "Boite aux lettres", "Boîte aux lettres", "Cuisine", "Séjour", "Sejour",
  "Salon", "Salle de bains", "Salle de bain", "Salle d'eau", "WC", "Wc",
  "Toilettes", "Chambre", "Bureau", "Entrée", "Hall", "Couloir", "Dégagement",
  "Buanderie", "Cellier", "Dressing", "Cave", "Garage", "Balcon", "Terrasse",
  "Jardin", "Loggia", "Palier",
];

function parseSnexiRooms(text, out) {
  // On scanne ligne par ligne. Une "pièce" SNEXI commence par son nom
  // EXACT en début de ligne (ex: "Cuisine", "Chambre 1", "Salle de bains")
  // suivi de la ligne d'en-tête "Eléments  À l'entrée  À la sortie".
  // Heuristique solide : chercher la séquence "<nom>\nEléments" — le nom
  // est sur sa propre ligne courte.
  const lines = text.split(/\r?\n/);
  let currentRoom = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = (lines[i + 1] || "").trim();
    // Détection début de pièce
    if (isLikelyRoomTitle(line) && /^Eléments\b/.test(next)) {
      if (currentRoom) out.rooms.push(currentRoom);
      currentRoom = { name: line, items: [], globalComment: "" };
      continue;
    }
    if (!currentRoom) continue;
    // Détection d'une ligne d'item au sein de la pièce.
    // Pattern : "<Catégorie> [Nature]  - / -  <X état moyen - détails> / NV/F"
    // En texte natif SNEXI, la ligne contient l'élément suivi de l'état.
    const itemMatch = line.match(/^([A-ZÀ-Ÿa-zà-ÿ][\w\s'\-éèêàâîôûç]+?)\s+(?:-\s+)?(\d+)\s+(Bon état|Mauvais état|État moyen|Usage normal)\b(.*)$/);
    if (itemMatch) {
      const label = itemMatch[1].trim();
      const qty = parseInt(itemMatch[2], 10);
      const stateLabel = itemMatch[3];
      const rest = itemMatch[4].trim();
      // Catégorie déduite des préfixes connus
      const category = guessCategory(label);
      currentRoom.items.push({
        category,
        nature: label,
        stateEntry: null,
        stateExit: mapStateLabel(stateLabel),
        working: null,
        notes: rest.replace(/^[-\s]*/, "").trim(),
        quantity: qty,
      });
      continue;
    }
    // Fin de pièce détectée si on retombe sur un nouveau titre.
  }
  if (currentRoom) out.rooms.push(currentRoom);
}

function isLikelyRoomTitle(line) {
  if (!line || line.length > 40) return false;
  // "Chambre 1", "Chambre 2", etc.
  if (/^(Chambre|Bureau|Pièce|Salle|WC|Wc)\s*\d?$/i.test(line)) return true;
  return KNOWN_ROOM_NAMES.some((n) => n.toLowerCase() === line.toLowerCase());
}

function guessCategory(label) {
  const l = label.toLowerCase();
  if (/^sol\b/.test(l) || /parquet|carrelage|moquette|lino|stratifi/.test(l)) return "Sol";
  if (/^plinthe/.test(l)) return "Plinthe";
  if (/^mur/.test(l) || /toile de verre|tapisserie|peinture mur/.test(l)) return "Mur";
  if (/^plafond/.test(l)) return "Plafond";
  if (/porte|encadrement|poignée|serrure/.test(l)) return "Menuiserie";
  if (/fenêtre|vitrage|volet|garde-corps|store/.test(l)) return "Menuiserie";
  if (/placard|étagère|rayon|tiroir/.test(l)) return "Rangement";
  if (/prise|interrupteur|plafonnier|lustre|boitier|thermostat|tableau électrique/.test(l)) return "Électricité";
  if (/évier|robinetterie|bonde|joint|siphon|baignoire|lavabo|douche|chasse|wc cuvette|abattant|faïence|crédence/.test(l)) return "Plomberie";
  if (/chaudière|radiateur|chauffage|convecteur|cheminée/.test(l)) return "Chauffage";
  if (/meuble|élément haut|élément bas|plan de travail|tablette|miroir/.test(l)) return "Ameublement";
  return "Autre";
}

// Renvoie directement le libellé canonique (plus d'abréviations en sortie).
function mapStateLabel(label) {
  if (!label) return null;
  return canonicalCondition(label);
}

// ─── Parser IA Vision (OpenAI Responses API avec input_file PDF) ──────
//
// On envoie le PDF directement à GPT-4o-mini via input_file (base64).
// L'API Responses gère la lecture multipage (vision + texte).
//
// Le `text.format.json_schema` force la sortie à matcher notre schéma →
// pas de post-parsing fragile.

// Concatène le prompt utilisateur avec d'éventuelles précisions saisies dans
// l'écran de relecture (« telle pièce a été oubliée », « les annexes comptent »…).
function buildUserPrompt(basePrompt, instructions) {
  const extra = String(instructions || "").trim();
  if (!extra) return basePrompt;
  return `${basePrompt}

PRÉCISIONS DE L'UTILISATEUR — à respecter impérativement, elles corrigent une
extraction précédente jugée incomplète :
${extra.slice(0, 2000)}

Reprends l'analyse COMPLÈTE du document en tenant compte de ces précisions.
N'omets aucune pièce ni aucune section mentionnée.`;
}

async function parseVision({ pdfBuffer, callOpenAI, instructions }) {
  const base64 = pdfBuffer.toString("base64");

  const payload = {
    model: VISION_MODEL,
    // Pas de detail "high" : pour un PDF entier on garde le coût en main.
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: SYSTEM_PROMPT_VISION,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildUserPrompt(USER_PROMPT_VISION, instructions),
          },
          {
            type: "input_file",
            filename: "edl.pdf",
            file_data: `data:application/pdf;base64,${base64}`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "NormalizedEDL",
        strict: true,
        schema: VISION_JSON_SCHEMA,
      },
    },
    // Pas de raisonnement long → on garde la latence basse.
    max_output_tokens: 8000,
  };

  const json = await callOpenAI(payload, EDL_CALL_TIMEOUT_MS);
  // L'API renvoie soit `output_text` (concat des content json), soit
  // un message structuré. On extrait défensivement.
  const text = extractResponseText(json);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const err = new Error("Réponse IA non JSON : " + (text || "").slice(0, 200));
    err.status = 502;
    throw err;
  }
  // Plafond 0.85 : une lecture visuelle ne prétend jamais à la certitude.
  return withConfidence({ ...parsed, sourceFormat: "vision" }, 0.85);
}

// V6.4 — Analyse Vision sur des IMAGES (photos d'EDL, scans).
// `images` : array de { mime, buffer } — pour gérer les EDL multi-pages
// photographiés en plusieurs clichés.
// ─── Passe de CONTRÔLE D'EXHAUSTIVITÉ ─────────────────────────────────────
//
// Sur un formulaire dense, une extraction en une passe oublie régulièrement
// des pièces entières. On demande donc au modèle, EN PARALLÈLE de l'extraction
// (donc sans coût de latence), la simple LISTE des intitulés de pièces visibles
// — tâche bien plus facile et fiable que l'extraction complète. On compare
// ensuite, et on ne relance une extraction ciblée que sur ce qui manque.
const SECTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sections: {
      type: "array",
      description: "Intitulés EXACTS de toutes les pièces/sections du document",
      items: { type: "string" },
    },
  },
  required: ["sections"],
};

async function listSections({ images, callOpenAI }) {
  try {
    const payload = {
      model: VISION_MODEL,
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: "Tu inventories les intitulés de sections d'un état des lieux. Tu ne décris rien d'autre.",
          }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Liste TOUS les intitulés de pièces / sections présents dans ce document d'état des lieux (ex : ENTRÉE, CUISINE, SÉJOUR 1, CHAMBRE 1, CHAMBRE 2, SALLE DE BAIN, TOILETTE 1, HALL/COULOIR, DÉPENDANCES…).
Le document peut être pivoté de 90° : lis-le dans le bon sens.
N'invente rien, ne déduis rien : uniquement les intitulés réellement imprimés.`,
            },
            ...images.map((img) => ({
              type: "input_image",
              image_url: `data:${img.mime || "image/jpeg"};base64,${img.buffer.toString("base64")}`,
              detail: "high",
            })),
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "Sections", strict: true, schema: SECTIONS_SCHEMA } },
      max_output_tokens: 1200,
    };
    const json = await callOpenAI(payload, EDL_CALL_TIMEOUT_MS);
    const parsed = JSON.parse(extractResponseText(json) || "{}");
    return Array.isArray(parsed.sections) ? parsed.sections.filter(Boolean) : [];
  } catch (e) {
    console.warn("[edlImport] passe d'exhaustivité indisponible :", e.message);
    return [];
  }
}

// ─── Passe MÉTA dédiée ────────────────────────────────────────────────────
//
// Les identités (locataire, adresse, date) sont manuscrites et concentrées
// dans le cartouche d'en-tête. En extraction par tuile, la fusion « première
// valeur non vide » laissait gagner une mauvaise lecture venue d'une tuile
// périphérique. On interroge donc le cartouche séparément, et cette lecture
// fait autorité.
const META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    address: { type: ["string", "null"] },
    postalCode: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    inspectionType: { type: ["string", "null"], enum: ["entry", "exit", "inventory", null] },
    date: { type: ["string", "null"], description: "ISO YYYY-MM-DD" },
    tenantEntrantName: { type: ["string", "null"] },
    tenantSortantName: { type: ["string", "null"] },
    landlordName: { type: ["string", "null"] },
    agencyName: { type: ["string", "null"] },
    // Les relevés de compteurs sont un petit bloc chiffré dense, voisin du
    // cartouche : en extraction par tuile ils se perdaient ou ressortaient
    // faux (un « 3 » au lieu de « 5343 »). On les lit ici, avec attention.
    meterElectricityHP: { type: ["string", "null"] },
    meterElectricityHC: { type: ["string", "null"] },
    meterGasIndex: { type: ["string", "null"] },
    meterWaterColdIndex: { type: ["string", "null"] },
    meterWaterHotIndex: { type: ["string", "null"] },
  },
  required: [
    "address", "postalCode", "city", "inspectionType", "date",
    "tenantEntrantName", "tenantSortantName", "landlordName", "agencyName",
    "meterElectricityHP", "meterElectricityHC", "meterGasIndex",
    "meterWaterColdIndex", "meterWaterHotIndex",
  ],
};

async function extractMeta({ images, callOpenAI }) {
  try {
    const payload = {
      model: META_MODEL,
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: "Tu lis le cartouche d'identité d'un état des lieux français. Tu ne remplis que ces champs.",
          }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Repère le cartouche d'en-tête de cet état des lieux et lis UNIQUEMENT :
adresse du logement, code postal, ville, type (entrée/sortie), date, locataire entrant,
locataire sortant, bailleur, agence, ET les relevés de compteurs.
Ces champs sont MANUSCRITS : lis-les caractère par caractère, avec la plus grande attention.
Le document peut être pivoté de 90°.
La date est souvent écrite JJ/MM/AAAA (ex : 26 08 2025) → convertis en AAAA-MM-JJ.

COMPTEURS — cherche le bloc « COMPTEURS » / « RELEVÉ ». Chaque ligne (Électrique,
Gaz, Eau Chaude, Eau Froide) porte un index chiffré manuscrit, généralement de 4 à
6 chiffres (ex : 5343, 2888, 20211). Recopie le nombre ENTIER, tous les chiffres —
ne tronque jamais à un seul chiffre. Si une ligne n'a pas d'index lisible, mets null.

Si un champ est absent ou illisible, mets null — n'invente jamais.`,
            },
            ...images.map((img) => ({
              type: "input_image",
              image_url: `data:${img.mime || "image/jpeg"};base64,${img.buffer.toString("base64")}`,
              detail: "high",
            })),
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "EdlMeta", strict: true, schema: META_SCHEMA } },
      max_output_tokens: 800,
    };
    const json = await callOpenAI(payload, EDL_CALL_TIMEOUT_MS);
    const parsed = JSON.parse(extractResponseText(json) || "{}");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.warn("[edlImport] passe méta indisponible :", e.message);
    return null;
  }
}

function normLabel(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Sections annoncées par le contrôle mais absentes de l'extraction. */
function findMissingSections(sections, rooms) {
  const have = (rooms || []).map((r) => normLabel(r.name));
  return sections.filter((s) => {
    const n = normLabel(s);
    if (!n) return false;
    return !have.some((h) => h === n || h.includes(n) || n.includes(h));
  });
}

async function parseVisionImages({ images, callOpenAI, instructions, sourceFormat, tiled, tileLabel }) {
  if (!Array.isArray(images) || images.length === 0) {
    const err = new Error("Aucune image fournie");
    err.status = 400;
    throw err;
  }

  // Construit le tableau de blocs image pour le user message
  const imageBlocks = images.map((img, idx) => ({
    type: "input_image",
    // OpenAI Responses : data URL inline accepté pour les images
    image_url: `data:${img.mime || "image/jpeg"};base64,${img.buffer.toString("base64")}`,
    // detail "auto" : laisse OpenAI décider — économique sur petites images, précis sur grandes
    detail: "high", // important : on veut lire les annotations manuscrites précisément
  }));

  const payload = {
    model: VISION_MODEL,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: SYSTEM_PROMPT_VISION }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildUserPrompt(
              tiled
                ? `Cette image est une DÉCOUPE HAUTE RÉSOLUTION${tileLabel ? ` (portion ${tileLabel})` : ""} d'un formulaire d'état des lieux organisé en grille pièces × éléments.
Le document peut être pivoté de 90° : lis-le dans le bon sens.
Extrais TOUT ce qui est visible dans CETTE portion, et RIEN d'autre — n'invente aucune pièce qui n'y figure pas.
Pour chaque bloc de pièce visible (ENTRÉE, CUISINE, SÉJOUR, CHAMBRE, SALLE DE BAIN, TOILETTE, HALL…), parcours chacune de ses lignes : MURS, SOLS, PLAFONDS, HUISSERIES, ÉLECTRICITÉ, ÉQUIPEMENTS, ROBINETTERIE…
Les états sont des coches manuscrites dans les colonnes BE / EM / D / HS :
BE = "Bon état", EM = "État moyen", D = "Mauvais état", HS = "Hors service".
Une pièce partiellement visible doit quand même être remontée avec ce qu'on en voit.
Si le bloc COMPTEURS / RELEVÉ apparaît dans cette portion, relève les index
chiffrés manuscrits (électricité HP/HC, gaz, eau froide, eau chaude) dans meters.
Reprends IMPÉRATIVEMENT toutes les annotations manuscrites :
 • celles rattachées à un élément précis → champ notes de cet élément ;
 • celles d'un bloc « Observations : » d'une pièce → globalComment de la pièce ;
 • les blocs généraux (OBSERVATIONS, CONTRATS DIVERS, remarques en marge)
   → champ generalObservations.
Ces commentaires portent souvent l'essentiel du constat : ne les ignore jamais.
TRANSCRIS-LES LITTÉRALEMENT, mot pour mot. Ne reformule pas, ne résume pas, et
n'ajoute aucun commentaire de ton cru : si aucune annotation n'est écrite, laisse
le champ vide plutôt que d'inventer une description.`
                : images.length > 1
                  ? `Analyse ces ${images.length} photos/scans qui forment ensemble un EDL multi-pages. Extrais TOUTES les informations dans le JSON imposé. Lis les annotations manuscrites en plus du texte imprimé.`
                  : USER_PROMPT_VISION,
              instructions,
            ),
          },
          ...imageBlocks,
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "NormalizedEDL",
        strict: true,
        schema: VISION_JSON_SCHEMA,
      },
    },
    max_output_tokens: 8000,
  };

  const json = await callOpenAI(payload, EDL_CALL_TIMEOUT_MS);
  const text = extractResponseText(json);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const err = new Error("Réponse IA non JSON : " + (text || "").slice(0, 200));
    err.status = 502;
    throw err;
  }
  return withConfidence(
    {
      ...parsed,
      sourceFormat:
        sourceFormat || (images.length > 1 ? "vision-multi-image" : "vision-image"),
    },
    0.85,
  );
}

/** Fusionne plusieurs extractions partielles en un seul NormalizedEDL. */
function mergeEdls(parts) {
  const out = {
    meta: {}, meters: {}, boiler: {}, smokeDetector: { present: null, rooms: [] },
    keys: [], rooms: [],
  };
  const byRoom = new Map();

  for (const part of parts) {
    if (!part) continue;
    // Méta : la première valeur non vide gagne.
    for (const [k, v] of Object.entries(part.meta || {})) {
      if (out.meta[k] === undefined || out.meta[k] === null || out.meta[k] === "") {
        if (v !== null && v !== undefined && v !== "") out.meta[k] = v;
      }
    }
    for (const [k, v] of Object.entries(part.meters || {})) {
      if (v && !out.meters[k]) out.meters[k] = v;
    }
    if (part.boiler && Object.keys(part.boiler).length && !Object.keys(out.boiler).length) {
      out.boiler = part.boiler;
    }
    if (part.smokeDetector?.present !== null && part.smokeDetector?.present !== undefined) {
      out.smokeDetector = part.smokeDetector;
    }
    if (Array.isArray(part.keys)) out.keys.push(...part.keys);
    // Observations libres : on concatène celles trouvées sur chaque tuile.
    if (part.generalObservations && String(part.generalObservations).trim()) {
      const txt = String(part.generalObservations).trim();
      if (!out.generalObservations) out.generalObservations = txt;
      else if (!out.generalObservations.includes(txt)) out.generalObservations += "\n" + txt;
    }

    // Pièces : dédup par nom normalisé, fusion des éléments.
    for (const room of part.rooms || []) {
      const key = normLabel(room.name);
      if (!key) continue;
      if (!byRoom.has(key)) {
        byRoom.set(key, { ...room, items: [...(room.items || [])] });
      } else {
        const tgt = byRoom.get(key);
        const seen = new Set(
          (tgt.items || []).map((i) => normLabel(`${i.category} ${i.nature}`)),
        );
        for (const it of room.items || []) {
          const ik = normLabel(`${it.category} ${it.nature}`);
          if (!seen.has(ik)) { seen.add(ik); tgt.items.push(it); }
        }
        if (!tgt.globalComment && room.globalComment) tgt.globalComment = room.globalComment;
      }
    }
  }
  out.rooms = Array.from(byRoom.values());
  return out;
}

/**
 * Lecture d'un PDF scanné.
 *
 * Stratégie : rasterisation haute définition, découpe en tuiles, puis
 * extraction TUILE PAR TUILE **en parallèle**. Une passe unique sur un
 * formulaire dense sature le modèle et lui fait omettre des pièces entières ;
 * en restreignant chaque appel à une zone, la lecture devient nettement plus
 * fiable — et le parallélisme garde le temps de réponse d'un seul appel.
 * Un inventaire des sections tourne simultanément et déclenche, si besoin, un
 * rattrapage ciblé des pièces manquantes.
 */
async function visionFromPdf({ pdfBuffer, callOpenAI, instructions }) {
  const deadline = Date.now() + EDL_BUDGET_MS;
  let tiles = [];
  try {
    tiles = await rasterizePdf(pdfBuffer);
  } catch (e) {
    console.warn("[edlImport] rasterisation échouée :", e.message);
  }

  if (tiles.length === 0) {
    // Pas de Ghostscript → ancien chemin (PDF brut, moins précis).
    return await parseVision({ pdfBuffer, callOpenAI, instructions });
  }

  const sourceFormat = `vision-raster-${tiles.length}tuiles`;

  // Extractions par tuile + inventaire des sections + lecture du cartouche,
  // tous menés en parallèle.
  const [parts, sections, metaPass] = await Promise.all([
    Promise.all(
      tiles.map((t, i) =>
        parseVisionImages({
          images: [t],
          callOpenAI,
          instructions,
          tiled: true,
          tileLabel: `${i + 1}/${tiles.length}`,
          sourceFormat,
        }).catch((e) => {
          console.warn(`[edlImport] tuile ${i + 1} échouée : ${e.message}`);
          return null;
        }),
      ),
    ),
    listSections({ images: tiles, callOpenAI }),
    extractMeta({ images: tiles, callOpenAI }),
  ]);

  const merged = mergeEdls(parts);
  merged.sourceFormat = sourceFormat;

  // La passe dédiée fait autorité sur le cartouche d'identité ET sur les
  // relevés de compteurs (lecture ciblée, modèle précis).
  if (metaPass) {
    const METER_KEYS = new Set([
      "meterElectricityHP", "meterElectricityHC", "meterGasIndex",
      "meterWaterColdIndex", "meterWaterHotIndex",
    ]);
    for (const [k, v] of Object.entries(metaPass)) {
      if (v === null || v === undefined || String(v).trim() === "") continue;
      if (METER_KEYS.has(k)) continue; // traités juste après
      merged.meta[k] = v;
    }
    merged.meters = merged.meters || {};
    const set = (path, val) => {
      if (val === null || val === undefined || String(val).trim() === "") return;
      const [grp, key] = path;
      merged.meters[grp] = { ...(merged.meters[grp] || {}), [key]: String(val).trim() };
    };
    set(["electricity", "hp"], metaPass.meterElectricityHP);
    set(["electricity", "hc"], metaPass.meterElectricityHC);
    set(["gas", "index"], metaPass.meterGasIndex);
    set(["waterCold", "index"], metaPass.meterWaterColdIndex);
    set(["waterHot", "index"], metaPass.meterWaterHotIndex);
  }
  console.log(
    `[edlImport] tuiles=${tiles.length} pièces=${merged.rooms.length} sections détectées=${sections.length}`,
  );

  // ── Boucle de complétion ────────────────────────────────────────────────
  // On relance un rattrapage ciblé tant que l'inventaire signale des pièces
  // absentes ET que chaque tour apporte du nouveau. On privilégie ici
  // l'exhaustivité au temps de réponse.
  const MAX_ROUNDS = MAX_COMPLETION_ROUNDS;
  let current = merged;
  const recovered = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const missing = findMissingSections(sections, current.rooms);
    if (missing.length === 0) break;

    // Garde-fou anti-504 : ne pas démarrer un tour qui risque de dépasser le
    // budget → on rend le résultat partiel (l'écran de validation permet
    // d'ajouter/relancer les pièces manquantes à la main).
    const remaining = deadline - Date.now();
    if (remaining < EDL_CALL_TIMEOUT_MS + 3000) {
      console.warn(
        `[edlImport] budget épuisé (${Math.round(remaining / 1000)}s restantes) — rattrapage interrompu, ${missing.length} section(s) non traitée(s)`,
      );
      break;
    }

    console.log(`[edlImport] complétion tour ${round} — manquantes : ${missing.join(", ")}`);
    let patches;
    try {
      patches = await Promise.all(
        tiles.map((t, i) =>
          parseVisionImages({
            images: [t],
            callOpenAI,
            tiled: true,
            tileLabel: `${i + 1}/${tiles.length}`,
            sourceFormat,
            instructions: `Extrais UNIQUEMENT les pièces suivantes si elles apparaissent dans cette portion : ${missing.join(", ")}.
Relis chacune de leurs lignes (MURS, SOLS, PLAFONDS, HUISSERIES, ÉLECTRICITÉ, ÉQUIPEMENTS…) et leurs coches d'état.
Si aucune de ces pièces n'apparaît dans cette portion, renvoie rooms vide.`,
          }).catch(() => null),
        ),
      );
    } catch (e) {
      console.warn(`[edlImport] tour ${round} échoué : ${e.message}`);
      break;
    }

    const before = current.rooms.length;
    const next = mergeEdls([current, ...patches.filter(Boolean)]);
    next.sourceFormat = sourceFormat;
    const added = next.rooms
      .map((r) => r.name)
      .filter((n) => !current.rooms.some((m) => normLabel(m.name) === normLabel(n)));
    current = next;
    recovered.push(...added);

    // Aucun apport → inutile d'insister, l'information n'est pas lisible.
    if (current.rooms.length === before) {
      console.log(`[edlImport] tour ${round} sans nouvelle pièce — arrêt`);
      break;
    }
  }

  const stillMissing = findMissingSections(sections, current.rooms);
  console.log(
    `[edlImport] final : ${current.rooms.length} pièces (${recovered.length} récupérées, ${stillMissing.length} introuvables)`,
  );

  return withConfidence(
    {
      ...current,
      detectedSections: sections,
      recoveredSections: recovered,
      missingSections: stillMissing,
    },
    0.85,
  );
}

// Wrapper helper : import à partir d'images (auto-route vers parseVisionImages)
async function importEDLFromImages(images, { callOpenAI, instructions }) {
  return await parseVisionImages({ images, callOpenAI, instructions });
}

function extractResponseText(json) {
  if (!json) return "";
  if (typeof json.output_text === "string") return json.output_text;
  if (Array.isArray(json.output)) {
    for (const block of json.output) {
      if (Array.isArray(block.content)) {
        for (const c of block.content) {
          if (typeof c.text === "string") return c.text;
          if (c.type === "output_text" && c.text) return c.text;
        }
      }
    }
  }
  return "";
}

// ─── Vocabulaire d'états CONTRÔLÉ ─────────────────────────────────────────
//
// Le moteur de comparaison (et les suggestions de travaux) classe les états
// par gravité. Si l'extraction renvoie des abréviations brutes ("BE", "EU",
// "HS"…), rien n'est reconnu et AUCUNE dégradation n'est détectée.
// On impose donc une liste fermée, unique pour toutes les routes d'import.
const CANONICAL_CONDITIONS = [
  "Neuf",
  "Bon état",
  "État moyen",
  "État d'usage",
  "Mauvais état",
  "Hors service",
];

// Table de correspondance : abréviations et variantes → libellé canonique.
const CONDITION_ALIASES = {
  nf: "Neuf", neuf: "Neuf",
  be: "Bon état", b: "Bon état", bon: "Bon état", "bon etat": "Bon état",
  "tres bon etat": "Bon état", p: "Bon état", propre: "Bon état",
  em: "État moyen", moyen: "État moyen", "etat moyen": "État moyen",
  passable: "État moyen", acceptable: "État moyen",
  eu: "État d'usage", "usage normal": "État d'usage", "etat d usage": "État d'usage",
  "etat d'usage": "État d'usage", use: "État d'usage", usage: "État d'usage",
  s: "État d'usage", sale: "État d'usage",
  de: "Mauvais état", degrade: "Mauvais état", ma: "Mauvais état",
  mauvais: "Mauvais état", "mauvais etat": "Mauvais état",
  "tres degrade": "Mauvais état", abime: "Mauvais état",
  hs: "Hors service", "hors service": "Hors service", casse: "Hors service",
  ko: "Hors service", "a remplacer": "Hors service",
};

/**
 * Ramène n'importe quel libellé d'état vers le vocabulaire canonique.
 * Retourne la valeur d'origine si elle n'est pas reconnue (on ne perd rien).
 */
function canonicalCondition(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (CANONICAL_CONDITIONS.includes(s)) return s;
  const key = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (CONDITION_ALIASES[key]) return CONDITION_ALIASES[key];
  // Recherche par inclusion (ex. "BE (quelques traces)" → "Bon état")
  for (const [alias, canon] of Object.entries(CONDITION_ALIASES)) {
    if (alias.length >= 2 && new RegExp(`\\b${alias}\\b`).test(key)) return canon;
  }
  return s; // inconnu → conservé tel quel, signalé comme non reconnu en aval
}

// ─── Score de fiabilité RÉEL ──────────────────────────────────────────────
//
// Auparavant codé en dur (0.75 pour toute extraction vision), ce qui affichait
// la même fiabilité pour un scan impeccable et pour un EDL manuscrit illisible.
// On mesure désormais la couverture effective de l'extraction :
//   • complétude des méta (adresse, date, type, locataire)
//   • présence d'une vraie structure de pièces
//   • part des éléments dont l'état est reconnu (le plus discriminant)
// `ceiling` plafonne le score selon la route : un parser déterministe peut
// approcher la certitude, une lecture visuelle ne le doit jamais.
function computeConfidence(edl, ceiling) {
  const meta = edl.meta || {};
  const rooms = Array.isArray(edl.rooms) ? edl.rooms : [];
  const items = rooms.flatMap((r) => (Array.isArray(r.items) ? r.items : []));

  const metaFields = [
    meta.address,
    meta.date,
    meta.inspectionType,
    meta.tenantEntrantName || meta.tenantSortantName,
  ];
  const metaScore = metaFields.filter(Boolean).length / metaFields.length;

  // 4 pièces ou plus = structure jugée complète.
  const roomScore = rooms.length === 0 ? 0 : Math.min(1, rooms.length / 4);

  const recognized = items.filter((it) => {
    const s = canonicalCondition(it.stateExit) || canonicalCondition(it.stateEntry);
    return s && CANONICAL_CONDITIONS.includes(s);
  });
  const stateScore = items.length === 0 ? 0 : recognized.length / items.length;

  const raw = 0.25 * metaScore + 0.25 * roomScore + 0.5 * stateScore;
  const confidence = Math.max(0.05, Math.round(raw * ceiling * 100) / 100);

  return {
    confidence,
    quality: {
      roomsCount: rooms.length,
      itemsCount: items.length,
      recognizedStates: recognized.length,
      unrecognizedStates: items.length - recognized.length,
      missingMeta: ["address", "date", "inspectionType", "tenant"].filter(
        (_, i) => !metaFields[i],
      ),
    },
  };
}

/** Attache un score de fiabilité mesuré à un NormalizedEDL. */
function withConfidence(edl, ceiling) {
  const { confidence, quality } = computeConfidence(edl, ceiling);
  return { ...edl, confidence, quality };
}

const SYSTEM_PROMPT_VISION = `Tu es un expert en immobilier français spécialisé dans l'analyse des états des lieux (EDL).
Tu reçois un PDF d'EDL qui peut être : un PDF scanné, un formulaire à cases à cocher rempli à la main, ou un PDF généré numériquement.
Ton job : extraire TOUTES les informations utiles dans un JSON strict respectant le schéma fourni.

Règles de lecture :
- Les cases à cocher : ✗ / ✓ / X / croix manuscrite = cochée. Vide = non cochée.
- États — IMPÉRATIF : pour stateEntry / stateExit tu dois répondre avec EXACTEMENT
  l'un de ces six libellés, jamais l'abréviation lue dans le document :
  "Neuf" | "Bon état" | "État moyen" | "État d'usage" | "Mauvais état" | "Hors service".
  Conversion à appliquer : NF/Neuf → "Neuf" ; BE/B/Bon/Propre → "Bon état" ;
  EM/Moyen/Passable → "État moyen" ; EU/"usage normal"/Sale → "État d'usage" ;
  DE/Dégradé/Ma/Mauvais/Abîmé → "Mauvais état" ; HS/Cassé/"à remplacer" → "Hors service".
  Si l'état est illisible ou absent, mets null (jamais d'invention).
- Fonctionnement : OUI / NON / Non testé / F (fonctionne) / NF (ne fonctionne pas) / NV (non vérifiable).
- Les commentaires manuscrits SONT importants : associe-les à l'item concerné dans la colonne notes.
- Si un champ n'est pas lisible ou absent, mets null (jamais d'invention).
- Pour propertyType, utilise EXACTEMENT : "studio" | "T1" | "T2" | "T3" | "T4" | "T5+" | "maison" | "local-commercial".
- Pour inspectionType, utilise EXACTEMENT : "entry" | "exit" | "inventory".
- date au format ISO "YYYY-MM-DD".`;

const USER_PROMPT_VISION = `Analyse ce PDF d'état des lieux et extrais TOUTES les informations utiles, pièce par pièce, dans le schéma JSON imposé. Lis les annotations manuscrites en plus du texte imprimé.`;

const VISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    meta: {
      type: "object",
      additionalProperties: false,
      properties: {
        address: { type: ["string", "null"] },
        addressComplement: { type: ["string", "null"] },
        postalCode: { type: ["string", "null"] },
        city: { type: ["string", "null"] },
        propertyType: { type: ["string", "null"], enum: ["studio", "T1", "T2", "T3", "T4", "T5+", "maison", "local-commercial", null] },
        surfaceM2: { type: ["number", "null"] },
        inspectionType: { type: ["string", "null"], enum: ["entry", "exit", "inventory", null] },
        date: { type: ["string", "null"], description: "ISO YYYY-MM-DD" },
        tenantSortantName: { type: ["string", "null"] },
        tenantEntrantName: { type: ["string", "null"] },
        landlordName: { type: ["string", "null"] },
        agencyName: { type: ["string", "null"] },
      },
      required: [
        "address", "addressComplement", "postalCode", "city", "propertyType",
        "surfaceM2", "inspectionType", "date", "tenantSortantName",
        "tenantEntrantName", "landlordName", "agencyName",
      ],
    },
    meters: {
      type: "object",
      additionalProperties: false,
      properties: {
        waterCold: meterSchema(),
        waterHot: meterSchema(),
        electricity: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            hp: { type: ["string", "null"] },
            hc: { type: ["string", "null"] },
            location: { type: ["string", "null"] },
            notes: { type: ["string", "null"] },
          },
          required: ["hp", "hc", "location", "notes"],
        },
        gas: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            present: { type: ["boolean", "null"] },
            index: { type: ["string", "null"] },
            location: { type: ["string", "null"] },
            notes: { type: ["string", "null"] },
          },
          required: ["present", "index", "location", "notes"],
        },
      },
      required: ["waterCold", "waterHot", "electricity", "gas"],
    },
    boiler: {
      type: "object",
      additionalProperties: false,
      properties: {
        brand: { type: ["string", "null"] },
        lastMaintenance: { type: ["string", "null"] },
        maintenanceDone: { type: ["boolean", "null"] },
      },
      required: ["brand", "lastMaintenance", "maintenanceDone"],
    },
    smokeDetector: {
      type: "object",
      additionalProperties: false,
      properties: {
        present: { type: ["boolean", "null"] },
        rooms: { type: "array", items: { type: "string" } },
      },
      required: ["present", "rooms"],
    },
    // Blocs d'observations libres du document (OBSERVATIONS, CONTRATS DIVERS,
    // remarques manuscrites générales). Sans ce champ, ces commentaires — qui
    // portent souvent l'essentiel du constat — n'étaient tout simplement pas
    // retranscrits.
    generalObservations: { type: ["string", "null"] },
    keys: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string" },
          count: { type: ["integer", "null"] },
          state: { type: ["string", "null"] },
        },
        required: ["type", "count", "state"],
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          globalComment: { type: ["string", "null"] },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                category: {
                  type: "string",
                  enum: ["Sol", "Mur", "Plafond", "Plinthe", "Menuiserie", "Rangement", "Électricité", "Plomberie", "Chauffage", "Ameublement", "Autre"],
                },
                nature: { type: "string" },
                // Vocabulaire CONTRÔLÉ : le moteur de comparaison classe les
                // états via ces libellés exacts. Toute abréviation lue dans le
                // document (BE, EU, HS…) doit être convertie ici.
                stateEntry: { type: ["string", "null"], enum: [...CANONICAL_CONDITIONS, null] },
                stateExit: { type: ["string", "null"], enum: [...CANONICAL_CONDITIONS, null] },
                working: { type: ["string", "null"] },
                notes: { type: ["string", "null"] },
                quantity: { type: ["integer", "null"] },
              },
              required: ["category", "nature", "stateEntry", "stateExit", "working", "notes", "quantity"],
            },
          },
        },
        required: ["name", "globalComment", "items"],
      },
    },
  },
  required: ["meta", "meters", "boiler", "smokeDetector", "generalObservations", "keys", "rooms"],
};

function meterSchema() {
  return {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
      index: { type: ["string", "null"] },
      location: { type: ["string", "null"] },
      notes: { type: ["string", "null"] },
    },
    required: ["index", "location", "notes"],
  };
}

// ─── Orchestrateur ────────────────────────────────────────────────────

/**
 * Importe un PDF d'EDL et retourne le JSON normalisé.
 *
 * @param {Buffer} pdfBuffer
 * @param {{ callOpenAI: function }} options
 * @returns {Promise<NormalizedEDL>}
 */
async function importEDL(pdfBuffer, { callOpenAI, instructions }) {
  // Si l'utilisateur fournit des précisions, c'est qu'une extraction précédente
  // était incomplète : on force la lecture visuelle (plus souple qu'un parser
  // à règles, et seule capable de tenir compte des consignes).
  if (String(instructions || "").trim()) {
    return await visionFromPdf({ pdfBuffer, callOpenAI, instructions });
  }

  let text = "";
  const pdfParse = getPdfParse();
  if (pdfParse) {
    try {
      const pdf = await pdfParse(pdfBuffer);
      text = pdf.text || "";
    } catch (e) {
      text = "";  // PDF illisible côté texte → on bascule en vision
    }
  }
  // Si pdf-parse n'est pas chargé, `text` reste vide → classifyFormat
  // retourne "scanned" → on bascule directement en Vision (fonctionnel
  // mais coûte ~0,20 € par EDL contre 0 € pour le parser dédié).

  const format = classifyFormat(text);
  if (format === "snexi") {
    const parsed = parseSnexi(text);
    // Si le parser n'a pas vu de pièces (variation de format), on retombe
    // sur la lecture visuelle pour ne pas livrer un import quasi-vide.
    if (parsed.rooms.length === 0) {
      return await visionFromPdf({ pdfBuffer, callOpenAI });
    }
    // Parser déterministe sur format connu → plafond de confiance élevé.
    return withConfidence(parsed, 0.98);
  }
  // Tous les autres formats (scanné, formulaire à cocher, manuscrit) →
  // rasterisation haute définition + lecture visuelle + contrôle d'exhaustivité.
  return await visionFromPdf({ pdfBuffer, callOpenAI });
}

// ─── Conversion NormalizedEDL → payload.report FOXSCAN ────────────────
//
// Le `payload.report` est ce que l'iPhone consomme. On y mappe ce qu'on
// peut depuis le JSON normalisé. Les autres champs (signatures, etc.)
// resteront vides côté projet importé — l'agent les remplit sur place.

// V5.2.4 — Split d'un champ "locataires" multi-personnes ("CHILLA Sofiane
// et Alice" / "MR DUPONT et MME MARTIN" / "X, Y et Z") en :
//   principal : 1er nom complet
//   additional : array d'objets { name, phone:"", email:"" }
//
// Heuristique :
//   • séparateurs : " et ", " & ", " ET ", ",", "/"
//   • si le 1er token contient un mot dont la majeure partie des
//     caractères sont en MAJUSCULES (probable nom de famille), on
//     préfixe les tokens suivants avec ce nom pour reconstituer
//     "CHILLA Sofiane et Alice" → ["CHILLA Sofiane", "CHILLA Alice"].
//     Pour les "MR LELIEVRE et MME COLAS" (couple avec noms distincts),
//     le 2e token a déjà sa propre majuscule ⇒ on le laisse tel quel.
function splitTenants(rawName) {
  if (!rawName || typeof rawName !== "string") return { principal: "", additional: [] };
  const cleaned = rawName.trim();
  if (!cleaned) return { principal: "", additional: [] };

  const tokens = cleaned
    .split(/\s+(?:et|ET|&)\s+|\s*[,/]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (tokens.length <= 1) return { principal: cleaned, additional: [] };

  // Détection du nom de famille partagé : 1er token = "<NOM EN MAJ> <Prénom>"
  // et token suivant = "<Prénom seul>" (pas de majuscule longue).
  const firstParts = tokens[0].split(/\s+/);
  const firstWordIsAllCaps = firstParts[0] && firstParts[0].length >= 3 &&
    firstParts[0] === firstParts[0].toUpperCase() &&
    /[A-ZÀ-Ÿ]/.test(firstParts[0]);
  const sharedSurname = firstWordIsAllCaps ? firstParts[0] : null;

  const principal = tokens[0];
  const additional = tokens.slice(1).map((t) => {
    // Si le token suivant n'a pas de mot en majuscules → on lui préfixe
    // le nom de famille détecté (si présent).
    if (sharedSurname && !/\b[A-ZÀ-Ÿ]{3,}\b/.test(t)) {
      return { name: `${sharedSurname} ${t}`.trim(), phone: "", email: "" };
    }
    return { name: t, phone: "", email: "" };
  });

  return { principal, additional };
}

/**
 * Convertit les compteurs du schéma d'extraction vers le tableau `meters`
 * attendu par FOXSCAN : [{ kind, indexValue, unit, location, notes }].
 *
 * Sans cette conversion, les relevés extraits restaient dans des champs plats
 * (meterWaterColdIndex…) que ni le PDF ni l'app ne lisent — ils étaient donc
 * invisibles bien que correctement lus sur le document.
 */
function buildMetersArray(meters) {
  const m = meters || {};
  const out = [];
  const push = (kind, index, unit, src) => {
    const val = String(index ?? "").trim();
    if (!val) return;
    out.push({
      kind,
      indexValue: val,
      unit: unit || "",
      location: src?.location || "",
      notes: src?.notes || "",
      meterNumber: src?.number || src?.serial || "",
    });
  };
  push("Eau froide", m.waterCold?.index, "m³", m.waterCold);
  push("Eau chaude", m.waterHot?.index, "m³", m.waterHot);
  push("Électricité (HP)", m.electricity?.hp, "kWh", m.electricity);
  push("Électricité (HC)", m.electricity?.hc, "kWh", m.electricity);
  if (m.gas?.present !== false) push("Gaz", m.gas?.index, "m³", m.gas);
  return out;
}

function toFoxscanReport(edl, { reportId, projectId }) {
  const meta = edl.meta || {};
  const insp = meta.inspectionType === "exit" ? "Sortie"
            : meta.inspectionType === "inventory" ? "Inventaire"
            : "Entrée";

  // V5.2.4 — Split du locataire principal qui peut contenir plusieurs
  // personnes ("X et Y", "X, Y et Z") en principal + additionalTenants.
  const rawTenantName = meta.tenantEntrantName || meta.tenantSortantName || "";
  const splitResult = splitTenants(rawTenantName);
  const tenantName = splitResult.principal;
  const additionalTenants = splitResult.additional;

  const roomConditions = (edl.rooms || []).map((r) => ({
    roomName: r.name,
    items: (r.items || []).map((it) => {
      // ALIGNEMENT sur la structure FOXSCAN native pour que le comparateur
      // apparie les éléments : FOXSCAN nomme l'élément dans `designation`
      // (+ `category`) et les remarques dans `observation`. On reproduit ce
      // schéma. La clé d'appariement est `designation` — donc SANS le préfixe
      // de catégorie, qui empêchait tout match (« Menuiserie - Porte » ≠ « Porte »).
      const nature = String(it.nature || "").trim();
      const designation = nature || String(it.category || "").trim();
      const notes = [it.notes, it.working ? `Fonctionnement : ${it.working}` : ""]
        .filter(Boolean).join(" — ");
      return {
        designation,
        category: it.category || "",
        label: designation, // affichage écran de validation
        // États dans le vocabulaire canonique compris par le comparateur.
        conditionExit: canonicalCondition(it.stateExit),
        conditionEntry: canonicalCondition(it.stateEntry),
        observation: notes,
        notes,
      };
    }),
    photoFileNames: [],
    globalNotes: r.globalComment || "",
  }));

  const propertyTypeMap = {
    studio: "Studio", T1: "T1", T2: "T2", T3: "T3", T4: "T4", "T5+": "T5+",
    maison: "Maison", "local-commercial": "Local commercial",
  };

  return {
    id: reportId,
    projectID: projectId,
    inspectionType: insp,
    propertyType: propertyTypeMap[meta.propertyType] || "Appartement",
    address: meta.address || "",
    addressComplement: meta.addressComplement || "",
    postalCode: meta.postalCode || "",
    city: meta.city || "",
    tenantName,
    tenantEmail: "",
    // V5.2.4 — Co-locataires (couple, colocation). Compatible avec le
    // modèle iOS PropertyInspectionReport.AdditionalTenant.
    additionalTenants,
    landlordName: meta.landlordName || "",
    agencyName: meta.agencyName || "",
    surfaceM2: meta.surfaceM2 || null,
    inspectionDate: meta.date || null,
    roomConditions,
    inspectionPhotoFileNames: [],
    // Observations libres du document (blocs OBSERVATIONS / CONTRATS DIVERS,
    // remarques manuscrites en marge) — remontées telles quelles.
    generalObservations: edl.generalObservations || "",
    notes: [
      edl.generalObservations || "",
      `Importé depuis PDF externe (${edl.sourceFormat}). Vérifier et compléter sur place.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    isFinalized: false,
    signedByTenant: false,
    signedByOwner: false,
    // V5 — Champs DAAF / chaudière / réserves
    smokeDetectorPresent: edl.smokeDetector?.present ?? null,
    smokeDetectorLocations: (edl.smokeDetector?.rooms || []).join(", "),
    smokeDetectorPhotoFileNames: [],
    smokeDetectorNotes: "",
    hasBoiler: Boolean(edl.boiler?.brand),
    boilerBrand: edl.boiler?.brand || "",
    boilerLastMaintenanceDate: edl.boiler?.lastMaintenance || "",
    boilerMaintenancePerformed: edl.boiler?.maintenanceDone ?? null,
    boilerPhotoFileNames: [],
    boilerNotes: "",
    tenantReserves: "",
    // V5 — Compteurs
    // Tableau `meters` au format FOXSCAN — c'est CE champ que lisent le
    // générateur PDF et l'app ; les champs plats ci-dessous ne sont exploités
    // par personne et ne servent qu'à la rétrocompatibilité.
    meters: buildMetersArray(edl.meters),
    meterWaterColdIndex: edl.meters?.waterCold?.index || "",
    meterWaterHotIndex: edl.meters?.waterHot?.index || "",
    meterElectricityHP: edl.meters?.electricity?.hp || "",
    meterElectricityHC: edl.meters?.electricity?.hc || "",
    meterGasIndex: edl.meters?.gas?.index || "",
    // Clés
    keysHandedOver: (edl.keys || []).map((k) =>
      `${k.count || ""} ${k.type}${k.state ? " (" + k.state + ")" : ""}`.trim()
    ).filter(Boolean).join(", "),
  };
}

module.exports = {
  importEDL,
  importEDLFromImages,    // V6.4 — Import depuis photos/scans
  toFoxscanReport,
  classifyFormat,         // exporté pour tests
  parseSnexi,             // exporté pour tests
  parseVisionImages,      // exporté pour tests
  VISION_JSON_SCHEMA,
  CANONICAL_CONDITIONS,   // vocabulaire d'états contrôlé (partagé avec l'API)
  canonicalCondition,
  computeConfidence,
};
