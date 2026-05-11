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

// V5.2.1 — On require directement le module interne pour éviter le code
// de "debug mode" de l'index.js de pdf-parse qui essaie de lire un PDF
// de test si `module.parent === null`. Sur Passenger/Hostinger ce bug
// fait crasher tout le serveur au démarrage (ENOENT sur test/data/...).
// Voir https://gitlab.com/autokent/pdf-parse/-/issues/19
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

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

function mapStateLabel(label) {
  if (!label) return null;
  const l = label.toLowerCase();
  if (l.includes("bon état")) return "BE";
  if (l.includes("état moyen")) return "EM";
  if (l.includes("usage normal")) return "EU"; // état d'usage
  if (l.includes("mauvais état")) return "DE"; // dégradé
  return null;
}

// ─── Parser IA Vision (OpenAI Responses API avec input_file PDF) ──────
//
// On envoie le PDF directement à GPT-4o-mini via input_file (base64).
// L'API Responses gère la lecture multipage (vision + texte).
//
// Le `text.format.json_schema` force la sortie à matcher notre schéma →
// pas de post-parsing fragile.

async function parseVision({ pdfBuffer, callOpenAI }) {
  const base64 = pdfBuffer.toString("base64");

  const payload = {
    model: "gpt-4o-mini",
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
            text: USER_PROMPT_VISION,
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

  const json = await callOpenAI(payload);
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
  return { ...parsed, sourceFormat: "vision", confidence: 0.75 };
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

const SYSTEM_PROMPT_VISION = `Tu es un expert en immobilier français spécialisé dans l'analyse des états des lieux (EDL).
Tu reçois un PDF d'EDL qui peut être : un PDF scanné, un formulaire à cases à cocher rempli à la main, ou un PDF généré numériquement.
Ton job : extraire TOUTES les informations utiles dans un JSON strict respectant le schéma fourni.

Règles de lecture :
- Les cases à cocher : ✗ / ✓ / X / croix manuscrite = cochée. Vide = non cochée.
- États : BE = Bon état, EM = État moyen, DE = Dégradé, HS = Hors service, EU = État d'usage, Ma = Mauvais, NF = Neuf, B = Bon, P = Propre, S = Sale.
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
                stateEntry: { type: ["string", "null"] },
                stateExit: { type: ["string", "null"] },
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
  required: ["meta", "meters", "boiler", "smokeDetector", "keys", "rooms"],
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
async function importEDL(pdfBuffer, { callOpenAI }) {
  let text = "";
  try {
    const pdf = await pdfParse(pdfBuffer);
    text = pdf.text || "";
  } catch (e) {
    text = "";  // PDF illisible côté texte → on bascule en vision
  }

  const format = classifyFormat(text);
  if (format === "snexi") {
    const parsed = parseSnexi(text);
    // Si le parser n'a pas vu de pièces (variation de format), on retombe
    // sur l'IA pour ne pas livrer un import quasi-vide à l'agent.
    if (parsed.rooms.length === 0) {
      return await parseVision({ pdfBuffer, callOpenAI });
    }
    return parsed;
  }
  // Tous les autres formats → IA Vision (scanné, formulaire, manuscrit).
  return await parseVision({ pdfBuffer, callOpenAI });
}

// ─── Conversion NormalizedEDL → payload.report FOXSCAN ────────────────
//
// Le `payload.report` est ce que l'iPhone consomme. On y mappe ce qu'on
// peut depuis le JSON normalisé. Les autres champs (signatures, etc.)
// resteront vides côté projet importé — l'agent les remplit sur place.

function toFoxscanReport(edl, { reportId, projectId }) {
  const meta = edl.meta || {};
  const insp = meta.inspectionType === "exit" ? "Sortie"
            : meta.inspectionType === "inventory" ? "Inventaire"
            : "Entrée";

  const tenantName = meta.tenantEntrantName || meta.tenantSortantName || "";

  const roomConditions = (edl.rooms || []).map((r) => ({
    roomName: r.name,
    items: (r.items || []).map((it) => ({
      label: `${it.category} - ${it.nature}`.replace(/ - $/, ""),
      conditionExit: it.stateExit || null,
      conditionEntry: it.stateEntry || null,
      notes: [it.notes, it.working ? `Fonctionnement : ${it.working}` : ""]
        .filter(Boolean).join(" — "),
    })),
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
    landlordName: meta.landlordName || "",
    agencyName: meta.agencyName || "",
    surfaceM2: meta.surfaceM2 || null,
    inspectionDate: meta.date || null,
    roomConditions,
    inspectionPhotoFileNames: [],
    notes: `Importé depuis PDF externe (${edl.sourceFormat}). Vérifier et compléter sur place.`,
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
  toFoxscanReport,
  classifyFormat,         // exporté pour tests
  parseSnexi,             // exporté pour tests
  VISION_JSON_SCHEMA,
};
