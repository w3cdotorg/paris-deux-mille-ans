/**
 * Buildings layer — le tissu bâti procédural de Paris.
 *
 * Modèle en trois étages :
 *
 *  1. **Grille de cellules 8x8 unités (80 m)** couvrant la zone urbanisable
 *     (ellipse du périphérique + grappe de La Défense). Chaque cellule
 *     urbanisée reçoit 4 à 9 bâtiments posés *en îlot périmétrique* : les
 *     façades s'alignent sur une ligne de rue à 3,25 unités du centre de
 *     cellule et la profondeur du bâtiment part vers l'intérieur, ce qui
 *     laisse une cour au milieu et une rue de ~15 m entre deux îlots. C'est
 *     la morphologie parisienne, et c'est ce qui fait « lire » la ville d'en
 *     haut, bien plus qu'un semis de boîtes.
 *
 *  2. **Modèle d'époques de (re)construction** (voir EPOCHS). Une cellule
 *     naît à `urbanYear`, mais son bâti est refait à chaque grande époque
 *     avec une probabilité donnée : c'est ce qui produit le « re-clad »
 *     haussmannien demandé par le brief (le bâti antérieur à 1850 intra-muros
 *     bascule en famille haussmann), tout en laissant survivre des poches de
 *     médiéval et de classique — et en évitant l'absurdité d'une île de la
 *     Cité (urbanYear = -250) couverte de huttes gauloises en 2026.
 *
 *  3. **LOD à deux niveaux**, avec le *même* drapeau de visibilité des deux
 *     côtés, donc jamais de trou ni de doublon : au-delà de DETAIL_RADIUS de
 *     la caméra, un quartier (64x64 unités) est rendu par des volumes
 *     simplifiés (boîte + toit coloré) ; en dessous, par les 22 archétypes
 *     détaillés. Voir la note « LOD » plus bas pour le choix instancing vs
 *     géométrie fusionnée.
 *
 * Contrat de layer : init(ctx) construit tout le statique ; update(dt, state)
 * ne fait que du ménage (bascule de LOD throttlée, zéro allocation par
 * frame). La tâche 8 branchera le temps dessus : toutes les métadonnées
 * par instance nécessaires (uYear de la cellule, graine déterministe, année
 * de construction du bâti courant) sont déjà stockées en Structure-of-Arrays
 * et `rebuildForYear(year)` est déjà le point d'entrée à appeler.
 *
 * Conventions héritées de geography.js : 1 unité = 10 m, x = est, z = sud.
 */

import * as THREE from "three";
import { urbanYear, distanceToSeine, RINGS, LANDMARKS } from "../geography.js";
import { lerp, smoothstep } from "../timeEngine.js";
import { groundHeightAt } from "./terrain.js";
import {
  ARCHETYPES,
  ARCHETYPES_BY_FAMILY,
  FAMILY_ORDER,
  FAMILY_TINTS,
  buildArchetypeGeometries,
  buildArchetypeLodGeometry,
} from "../archetypes.js";

// ============================================================================
// Tunables
// ============================================================================

export const CELL = 8; // taille de cellule (unités) = 80 m
const DISTRICT_CELLS = 8; // 8 cellules = quartier de 64 unités (unité de LOD)
const ORIENT_CELLS = 4; // 4 cellules partagent une orientation de rue

// Emprise de la grille : ellipse du périphérique + grappe de La Défense.
const GRID_X_MIN = -900;
const GRID_X_MAX = 444;
const GRID_Z_MIN = -516;
const GRID_Z_MAX = 356;

// Ligne de façade, mesurée depuis le centre de cellule. Deux îlots voisins se
// font donc face à 6,5 unités, soit une rue de 1,5 unité (15 m).
const FACADE_LINE = 3.25;
const EDGE_SPAN = 0.78; // fraction de l'arête utilisable (évite les angles pile)

const WATER_MARGIN = 9; // pas de bâti à moins de 9 unités de l'axe de la Seine
const SINK = 0.12; // enfoncement dans le sol, masque l'erreur d'échantillonnage

// Densité : maximale au coeur, décroissante vers les faubourgs.
const CORE = { x: -30, z: -40 };
const DENSITY_FULL_R = 130;
const DENSITY_ZERO_R = 640;

const VOID_CORE = 0.18; // part de cellules non bâties (rues larges, cours, places)
const VOID_EDGE = 0.52;
const COUNT_CORE = [4, 7]; // min/max de bâtiments par cellule bâtie, au coeur
const COUNT_EDGE = [3, 5]; // ... et en périphérie

// LOD. Le brief demande la bascule « au-delà de ~350 unités de caméra » ;
// 320 laisse une marge sous la cible tout en gardant le détail bien au-delà
// du champ utile en vue rapprochée (preset `cite` : distance 80).
const DETAIL_RADIUS = 320;
const LOD_INTERVAL = 0.12; // secondes entre deux réévaluations de la bascule

// ============================================================================
// Espaces ouverts et dégagements
// ============================================================================

// Grands vides parisiens (jardins, esplanades, faisceaux ferroviaires,
// cimetières). Coordonnées converties depuis le WGS84 avec les facteurs de
// geography.js (x = (lon - 2.3499) * 7325, z = (48.8530 - lat) * 11057).
const OPEN_SPACES = [
  { x: -93, z: 75, rx: 12, rz: 10 }, // jardin du Luxembourg
  { x: -164, z: -115, rx: 34, rz: 8 }, // jardin des Tuileries
  { x: -376, z: -29, rx: 12, rz: 26 }, // Champ-de-Mars
  { x: -270, z: -44, rx: 10, rz: 13 }, // esplanade des Invalides
  { x: -210, z: -139, rx: 6, rz: 6 }, // place de la Concorde
  { x: 241, z: -263, rx: 12, rz: 12 }, // Buttes-Chaumont
  { x: 319, z: -92, rx: 14, rz: 13 }, // Père-Lachaise
  { x: -85, z: 341, rx: 11, rz: 10 }, // parc Montsouris
  { x: 236, z: 197, rx: 9, rz: 9 }, // parc de Bercy
  { x: 40, z: -307, rx: 11, rz: 20 }, // faisceau des gares du Nord / de l'Est
  { x: 179, z: 96, rx: 8, rz: 16 }, // faisceau de la gare de Lyon
];

// Dégagements autour des monuments, pour que les maillages des tâches
// suivantes (repères, monuments) ne se plantent pas dans un îlot.
const LANDMARK_CLEARANCE = {
  notreDame: 7,
  louvre: 22,
  bastille: 6,
  tourEiffel: 12,
  sacreCoeur: 9,
  arenes: 5,
  thermes: 5,
  pantheon: 7,
  laDefense: 11,
  chezNous: 3, // volontairement minuscule : on veut le tissu du 18e autour
};

// ============================================================================
// Époques de (re)construction
// ============================================================================
//
// `year` : année de référence à partir de laquelle l'époque peut refaire du
// bâti (jitterée par `spread` cellule par cellule, ce qui donne à la tâche 8
// une vague de reconstruction étalée plutôt qu'un basculement d'un frame).
// `share` : probabilité qu'un bâtiment donné soit refait à cette époque,
// interpolée [faubourg, coeur] quand c'est un tableau.

const EPOCHS = [
  { family: "gaulois", year: -250, spread: 0, share: 1 },
  { family: "romain", year: 100, spread: 40, share: 0.88 },
  { family: "medieval", year: 1200, spread: 120, share: 0.92 },
  { family: "classique", year: 1650, spread: 90, share: 0.55 },
  { family: "haussmann", year: 1853, spread: 27, share: [0.45, 0.88] },
  { family: "moderne", year: 1955, spread: 30, share: [0.24, 0.05] },
];

const EPOCH_INDEX = {};
EPOCHS.forEach((e, i) => {
  EPOCH_INDEX[e.family] = i;
});

// Bandes d'origine du brief : la famille d'un bâti *neuf* dans une cellule
// née à `urbanYear`.
const ORIGIN_BANDS = [
  { below: 0, family: "gaulois" },
  { below: 500, family: "romain" },
  { below: 1550, family: "medieval" },
  { below: 1850, family: "classique" },
  { below: 1920, family: "haussmann" },
  { below: Infinity, family: "moderne" },
];

// ============================================================================
// Hachage déterministe (même famille que geography.js / terrain.js)
// ============================================================================

function hash01(a, b, seed) {
  let h = (a * 374761393 + b * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

/** Graine entière stable d'un emplacement (cellule + rang dans la cellule). */
function seedOf(ix, iz, slot) {
  let h = (ix * 374761393 + iz * 668265263 + slot * 1442695040) | 0;
  h = (h ^ (h >>> 15)) | 0;
  h = Math.imul(h, 2246822519);
  h = (h ^ (h >>> 13)) | 0;
  return h >>> 0;
}

/** Tirage dans [0,1) dérivé d'une graine et d'un sel (un sel = un usage). */
function roll(seed, salt) {
  let h = (seed ^ Math.imul(salt | 0, 2654435761)) | 0;
  h = (h ^ (h >>> 16)) | 0;
  h = Math.imul(h, 2246822519);
  h = (h ^ (h >>> 13)) | 0;
  return (h >>> 0) / 4294967296;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function insideEllipse(x, z, cx, cz, rx, rz) {
  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  return dx * dx + dz * dz <= 1;
}

/**
 * Tire un archétype dans `options` (indices dans ARCHETYPES), pondéré par le
 * champ optionnel `weight` de chaque archétype (défaut 1). Sans pondération,
 * les 4 archétypes `moderne` seraient tirés à parts égales et une tour de
 * 64-90 m deviendrait aussi fréquente qu'une barre de 28 m dans *chaque*
 * faubourg — or Paris hors La Défense n'a presque aucune tour. `moderne_tour`
 * / `contemporain_tour_verre` portent `weight: 0.12` pour rester des
 * ponctuations rares plutôt que la moitié du bâti moderne.
 * @param {number[]} options - indices ARCHETYPES de la famille
 * @param {number} seed
 * @returns {number} un des indices de `options`
 */
function pickArchetype(options, seed) {
  let total = 0;
  for (const idx of options) total += ARCHETYPES[idx].weight ?? 1;
  let r = roll(seed, 23) * total;
  for (const idx of options) {
    const w = ARCHETYPES[idx].weight ?? 1;
    if (r < w) return idx;
    r -= w;
  }
  return options[options.length - 1];
}

// ============================================================================
// Fonctions pures — décisions de tissu urbain, sans THREE ni scène. Exportées
// pour être testables directement sous `node --test`.
// ============================================================================

/** Centre monde de la cellule (ix, iz). */
export function cellCenterX(ix) {
  return (ix + 0.5) * CELL;
}
export function cellCenterZ(iz) {
  return (iz + 0.5) * CELL;
}

/**
 * Densité urbaine en (x, z) : 1 au coeur historique, 0 au-delà des faubourgs.
 * Pilote à la fois la part de cellules vides, le nombre de bâtiments par
 * cellule, l'ampleur du re-clad haussmannien et celle des insertions modernes.
 * @param {number} x
 * @param {number} z
 * @returns {number} dans [0, 1]
 */
export function densityAt(x, z) {
  const r = Math.hypot(x - CORE.x, z - CORE.z);
  return smoothstep(clamp01((DENSITY_ZERO_R - r) / (DENSITY_ZERO_R - DENSITY_FULL_R)));
}

/**
 * Famille d'origine d'un bâti neuf dans une cellule née à `uYear` — la table
 * de bandes du brief (gaulois < 0, romain < 500, medieval < 1550,
 * classique < 1850, haussmann < 1920, moderne au-delà).
 * @param {number} uYear
 * @returns {string}
 */
export function familyForUrbanYear(uYear) {
  for (const band of ORIGIN_BANDS) {
    if (uYear < band.below) return band.family;
  }
  return "moderne";
}

/**
 * Famille effectivement bâtie en `year` sur une parcelle née en `uYear`.
 *
 * Part de la famille d'origine, puis applique les époques de reconstruction
 * postérieures : chaque époque refait le bâtiment si son tirage tombe sous sa
 * part. Le cas emblématique est celui du brief : une parcelle antérieure à
 * 1850 intra-muros passe en `haussmann` en 2026 dans ~88 % des cas au coeur
 * (~45 % en faubourg), le reste survivant en médiéval / classique — c'est ce
 * qui garde un Marais et une Mouffetard au milieu du zinc.
 *
 * @param {number} uYear - urbanYear de la cellule
 * @param {number} year - année courante
 * @param {number} density - densityAt du centre de cellule, dans [0,1]
 * @param {boolean} insideRing - dans l'enceinte de Thiers (le périphérique)
 * @param {number} seed - graine du bâtiment (voir seedOf)
 * @returns {{family: string, born: number}} famille rendue et année de
 *   construction du bâti courant (utile à la tâche 8 pour l'animation).
 */
export function fabricAt(uYear, year, density, insideRing, seed) {
  let index = EPOCH_INDEX[familyForUrbanYear(uYear)];
  let born = Math.max(uYear, EPOCHS[index].year);

  for (let k = index + 1; k < EPOCHS.length; k++) {
    const epoch = EPOCHS[k];
    const gate = epoch.year + roll(seed, 900 + k * 7) * epoch.spread;
    if (gate > year || gate < uYear) continue;
    let share = Array.isArray(epoch.share)
      ? lerp(epoch.share[0], epoch.share[1], density)
      : epoch.share;
    // Le re-clad haussmannien est une opération intra-muros : hors enceinte
    // de Thiers, seuls quelques immeubles de rapport isolés y passent.
    if (epoch.family === "haussmann" && !insideRing) share = 0.1;
    if (roll(seed, 1300 + k * 11) < share) {
      index = k;
      born = gate;
    }
  }
  return { family: EPOCHS[index].family, born };
}

/**
 * Nombre de bâtiments de la cellule (ix, iz) : 0 si la cellule est « vide »
 * (rue large, place, cour, terrain), sinon 4 à 9 au coeur et 3 à 6 en
 * faubourg. Déterministe.
 * @param {number} ix
 * @param {number} iz
 * @param {number} density - densityAt du centre de cellule
 * @returns {number}
 */
export function cellBuildingCount(ix, iz, density) {
  const voidShare = lerp(VOID_EDGE, VOID_CORE, density);
  if (hash01(ix, iz, 101) < voidShare) return 0;
  const min = Math.round(lerp(COUNT_EDGE[0], COUNT_CORE[0], density));
  const max = Math.round(lerp(COUNT_EDGE[1], COUNT_CORE[1], density));
  return min + Math.floor(hash01(ix, iz, 202) * (max - min + 1));
}

/**
 * Cellule constructible ? Exclut l'eau, les grands espaces ouverts, les
 * dégagements de monuments, et tout ce qui n'est pas encore urbanisé.
 * @param {number} x - centre de cellule
 * @param {number} z
 * @param {number} uYear - urbanYear(x, z)
 * @param {number} year
 * @returns {boolean}
 */
export function isBuildableCell(x, z, uYear, year) {
  if (!(uYear <= year)) return false; // couvre aussi uYear === Infinity
  if (distanceToSeine(x, z) < WATER_MARGIN) return false;
  for (const space of OPEN_SPACES) {
    if (insideEllipse(x, z, space.x, space.z, space.rx, space.rz)) return false;
  }
  for (const name in LANDMARK_CLEARANCE) {
    const lm = LANDMARKS[name];
    const r = LANDMARK_CLEARANCE[name];
    if ((x - lm.x) * (x - lm.x) + (z - lm.z) * (z - lm.z) < r * r) return false;
  }
  return true;
}

/** Orientation de rue partagée par un bloc de ORIENT_CELLS cellules. */
export function streetOrientation(ix, iz) {
  const bx = Math.floor(ix / ORIENT_CELLS);
  const bz = Math.floor(iz / ORIENT_CELLS);
  return hash01(bx, bz, 303) * (Math.PI / 2) + (hash01(ix, iz, 404) - 0.5) * 0.12;
}

/**
 * Place les bâtiments d'une cellule en îlot périmétrique. Purement
 * déterministe : mêmes entrées => mêmes sorties, à tout instant et d'un
 * chargement à l'autre.
 *
 * @param {number} ix
 * @param {number} iz
 * @param {number} uYear - urbanYear du centre de cellule
 * @param {number} year
 * @param {number} density - densityAt du centre de cellule
 * @param {boolean} insideRing
 * @returns {Array<{x:number,z:number,rot:number,scale:number,scaleY:number,
 *   archetype:number,tint:number,family:string,born:number,seed:number}>}
 */
export function placeCell(ix, iz, uYear, year, density, insideRing) {
  const count = cellBuildingCount(ix, iz, density);
  if (count === 0) return [];

  const cx = cellCenterX(ix);
  const cz = cellCenterZ(iz);
  const cellRot = streetOrientation(ix, iz);
  const cosR = Math.cos(cellRot);
  const sinR = Math.sin(cellRot);
  const out = [];

  for (let slot = 0; slot < count; slot++) {
    const seed = seedOf(ix, iz, slot);
    const { family, born } = fabricAt(uYear, year, density, insideRing, seed);

    // Position sur le périmètre : les emplacements se répartissent
    // régulièrement sur les 4 arêtes, avec un petit décalage aléatoire.
    const u = ((slot + 0.5 + (roll(seed, 11) - 0.5) * 0.6) / count) * 4;
    const edge = Math.floor(u) & 3;
    const s = ((u - Math.floor(u)) * 2 - 1) * EDGE_SPAN;
    const atCorner = Math.abs(s) > 0.55 * EDGE_SPAN;

    const options = ARCHETYPES_BY_FAMILY[family];
    let archetype = pickArchetype(options, seed);
    // Un immeuble d'angle à pan coupé aux angles d'îlot haussmanniens.
    if (family === "haussmann" && atCorner && roll(seed, 29) < 0.55) {
      archetype = ARCHETYPES_BY_FAMILY.haussmann[4]; // haussmann_angle
    }
    const spec = ARCHETYPES[archetype];

    // Base relevé de 0.88 à 1.0 par rapport à l'origine : à la distance de LOD
    // (macro-quartier, boîte simplifiée), chaque bâtiment ne couvre que
    // quelques pixels — un socle trop timide se noie dans le sol crème et la
    // ville se lit comme un bruit de speckle plutôt qu'un tissu dense. Ce
    // socle plus généreux (+~28% de surface au sol en moyenne) referme les
    // interstices sans toucher le nombre d'instances (donc sans coût de perf).
    const scale = 1.0 + roll(seed, 31) * (family === "haussmann" ? 0.2 : 0.32);
    // Hauteur : jitter serré pour l'haussmannien (la ligne de corniche
    // uniforme EST la signature du centre de Paris), large pour le médiéval.
    const jitterY = family === "medieval" ? 0.3 : family === "haussmann" ? 0.09 : 0.18;
    const scaleY = scale * (1 - jitterY / 2 + roll(seed, 37) * jitterY);

    // Façade sur la ligne de rue, profondeur vers l'intérieur de l'îlot.
    const depth = (spec.d * scale) / 2;
    const inner = FACADE_LINE - depth;
    let lx;
    let lz;
    let yaw;
    if (edge === 0) {
      lx = s * FACADE_LINE;
      lz = -inner;
      yaw = Math.PI;
    } else if (edge === 1) {
      lx = inner;
      lz = s * FACADE_LINE;
      yaw = Math.PI / 2;
    } else if (edge === 2) {
      lx = -s * FACADE_LINE;
      lz = inner;
      yaw = 0;
    } else {
      lx = -inner;
      lz = -s * FACADE_LINE;
      yaw = -Math.PI / 2;
    }

    out.push({
      x: cx + lx * cosR - lz * sinR,
      z: cz + lx * sinR + lz * cosR,
      rot: yaw + cellRot + (roll(seed, 41) - 0.5) * 0.05,
      scale,
      scaleY,
      archetype,
      tint: Math.floor(roll(seed, 43) * 4) % 4,
      family,
      born,
      seed,
    });
  }
  return out;
}

// ============================================================================
// État du module (rempli par init, consommé par update)
// ============================================================================

/** Métadonnées par instance, en Structure-of-Arrays (aucune allocation par frame). */
const B = {
  count: 0,
  x: null, // Float32Array
  z: null,
  y: null, // altitude du sol échantillonnée sur le maillage de terrain
  rot: null,
  scale: null,
  scaleY: null,
  archetype: null, // Uint8Array
  tint: null, // Uint8Array
  family: null, // Uint8Array (index dans FAMILY_ORDER)
  uYear: null, // Float32Array — urbanYear de la cellule (tâche 8)
  born: null, // Float32Array — année de construction du bâti courant (tâche 8)
  seed: null, // Uint32Array — rejoue tous les tirages (tâche 8)
};

const districts = {
  nx: 0,
  nz: 0,
  ixMin: 0,
  izMin: 0,
  count: 0,
  cx: null, // Float32Array — centre monde du quartier
  cz: null,
  active: null, // Uint8Array — 1 = rendu en détail, 0 = rendu en LOD
};

// CSR (archetype, quartier) -> plage contiguë d'instances dans B.
const ranges = { start: null, len: null, archStart: null, archCount: null };

const meshes = { detail: [], lod: [] };
let material = null;
let overflow = 0; // instances détail sautées faute de capacité (diagnostic)
let lodTimer = 0;
let changedList = null;
let lastYear = null;

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

// ============================================================================
// Génération du tissu
// ============================================================================

function districtOf(ix, iz) {
  const dx = Math.floor((ix - districts.ixMin) / DISTRICT_CELLS);
  const dz = Math.floor((iz - districts.izMin) / DISTRICT_CELLS);
  return dz * districts.nx + dx;
}

/**
 * Parcourt la grille, place les bâtiments, puis range les instances par
 * (archétype, quartier) — un tri par comptage, pour que chaque paire soit une
 * plage contiguë : c'est ce qui rend la bascule de LOD triviale (une plage à
 * remettre à zéro) et le repack du détail séquentiel.
 * @param {number} year
 */
function generate(year) {
  const ixMin = Math.floor(GRID_X_MIN / CELL);
  const ixMax = Math.ceil(GRID_X_MAX / CELL);
  const izMin = Math.floor(GRID_Z_MIN / CELL);
  const izMax = Math.ceil(GRID_Z_MAX / CELL);

  districts.ixMin = ixMin;
  districts.izMin = izMin;
  districts.nx = Math.ceil((ixMax - ixMin + 1) / DISTRICT_CELLS);
  districts.nz = Math.ceil((izMax - izMin + 1) / DISTRICT_CELLS);
  districts.count = districts.nx * districts.nz;

  const { peripherique } = RINGS;
  const raw = [];

  for (let iz = izMin; iz <= izMax; iz++) {
    const cz = cellCenterZ(iz);
    for (let ix = ixMin; ix <= ixMax; ix++) {
      const cx = cellCenterX(ix);
      const uYear = urbanYear(cx, cz);
      if (!isBuildableCell(cx, cz, uYear, year)) continue;
      const density = densityAt(cx, cz);
      const insideRing = insideEllipse(
        cx,
        cz,
        peripherique.cx,
        peripherique.cz,
        peripherique.rx,
        peripherique.rz
      );
      const placed = placeCell(ix, iz, uYear, year, density, insideRing);
      for (const p of placed) {
        p.uYear = uYear;
        p.district = districtOf(ix, iz);
        raw.push(p);
      }
    }
  }

  // --- tri par comptage sur la clé (archétype, quartier) --------------------
  const nArch = ARCHETYPES.length;
  const nKeys = nArch * districts.count;
  const start = new Int32Array(nKeys);
  const len = new Int32Array(nKeys);
  for (const p of raw) len[p.archetype * districts.count + p.district]++;
  let acc = 0;
  for (let k = 0; k < nKeys; k++) {
    start[k] = acc;
    acc += len[k];
  }

  const n = raw.length;
  B.count = n;
  B.x = new Float32Array(n);
  B.z = new Float32Array(n);
  B.y = new Float32Array(n);
  B.rot = new Float32Array(n);
  B.scale = new Float32Array(n);
  B.scaleY = new Float32Array(n);
  B.archetype = new Uint8Array(n);
  B.tint = new Uint8Array(n);
  B.family = new Uint8Array(n);
  B.uYear = new Float32Array(n);
  B.born = new Float32Array(n);
  B.seed = new Uint32Array(n);

  const cursor = Int32Array.from(start);
  for (const p of raw) {
    const i = cursor[p.archetype * districts.count + p.district]++;
    B.x[i] = p.x;
    B.z[i] = p.z;
    B.y[i] = groundHeightAt(p.x, p.z) - SINK;
    B.rot[i] = p.rot;
    B.scale[i] = p.scale;
    B.scaleY[i] = p.scaleY;
    B.archetype[i] = p.archetype;
    B.tint[i] = p.tint;
    B.family[i] = FAMILY_ORDER.indexOf(p.family);
    B.uYear[i] = p.uYear;
    B.born[i] = p.born;
    B.seed[i] = p.seed;
  }

  const archStart = new Int32Array(nArch);
  const archCount = new Int32Array(nArch);
  for (let a = 0; a < nArch; a++) {
    archStart[a] = start[a * districts.count];
    let total = 0;
    for (let d = 0; d < districts.count; d++) total += len[a * districts.count + d];
    archCount[a] = total;
  }

  ranges.start = start;
  ranges.len = len;
  ranges.archStart = archStart;
  ranges.archCount = archCount;

  districts.cx = new Float32Array(districts.count);
  districts.cz = new Float32Array(districts.count);
  districts.active = new Uint8Array(districts.count);
  const half = (DISTRICT_CELLS * CELL) / 2;
  for (let dz = 0; dz < districts.nz; dz++) {
    for (let dx = 0; dx < districts.nx; dx++) {
      const d = dz * districts.nx + dx;
      districts.cx[d] = (ixMin + dx * DISTRICT_CELLS) * CELL + half;
      districts.cz[d] = (izMin + dz * DISTRICT_CELLS) * CELL + half;
    }
  }
  changedList = new Int32Array(districts.count);
}

/**
 * Capacité à allouer par archétype pour les InstancedMesh de détail : le pire
 * cas réel, c'est-à-dire le maximum, sur toutes les positions de caméra
 * plausibles, du nombre d'instances de cet archétype dans les quartiers à
 * portée. On échantillonne les centres de quartier comme positions candidates
 * (borne supérieure : la caméra étant toujours en hauteur, sa distance 3D à un
 * quartier est plus grande que la distance planaire testée ici).
 * @returns {Int32Array}
 */
function detailCapacities() {
  const nArch = ARCHETYPES.length;
  const nD = districts.count;
  const capacity = new Int32Array(nArch);
  const reach = DETAIL_RADIUS + (DISTRICT_CELLS * CELL) / 2;
  const reach2 = reach * reach;
  const acc = new Int32Array(nArch);

  for (let c = 0; c < nD; c++) {
    acc.fill(0);
    for (let d = 0; d < nD; d++) {
      const dx = districts.cx[d] - districts.cx[c];
      const dz = districts.cz[d] - districts.cz[c];
      if (dx * dx + dz * dz > reach2) continue;
      for (let a = 0; a < nArch; a++) acc[a] += ranges.len[a * nD + d];
    }
    for (let a = 0; a < nArch; a++) if (acc[a] > capacity[a]) capacity[a] = acc[a];
  }
  for (let a = 0; a < nArch; a++) {
    capacity[a] = Math.min(ranges.archCount[a], Math.ceil(capacity[a] * 1.05) + 8);
  }
  return capacity;
}

// ============================================================================
// Scène : InstancedMesh de détail + InstancedMesh de LOD
// ============================================================================
//
// Note LOD — le brief propose « une géométrie fusionnée par macro-quartier de
// 64x64 ». On garde le quartier comme *unité de bascule* (c'est bien ce qui
// est demandé), mais on rend ces volumes simplifiés en instancing plutôt qu'en
// géométries fusionnées : fusionner ~40 000 boîtes+toits produirait ~300
// BufferGeometry pour ~60 Mo de VRAM et ~300 draw calls, là où 22
// InstancedMesh coûtent 22 draw calls et ~4 Mo. Masquer un quartier consiste
// alors à écrire des matrices d'échelle nulle sur sa plage contiguë (triangles
// dégénérés, non rastérisés), avec une mise à jour partielle du buffer via
// addUpdateRange — c'est-à-dire aussi peu de travail qu'un `mesh.visible`.

function buildMeshes(ctx) {
  material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const geometries = buildArchetypeGeometries();
  const capacity = detailCapacities();

  for (let a = 0; a < ARCHETYPES.length; a++) {
    const detail = new THREE.InstancedMesh(geometries[a], material, Math.max(capacity[a], 1));
    detail.count = 0;
    detail.frustumCulled = false; // toujours à portée immédiate de la caméra
    detail.name = `buildings_detail_${ARCHETYPES[a].id}`;
    ctx.scene.add(detail);
    meshes.detail.push(detail);

    const total = Math.max(ranges.archCount[a], 1);
    const lod = new THREE.InstancedMesh(buildArchetypeLodGeometry(a), material, total);
    lod.count = ranges.archCount[a];
    lod.frustumCulled = false; // couvre toute la ville : un test global ne sert à rien
    lod.name = `buildings_lod_${ARCHETYPES[a].id}`;
    ctx.scene.add(lod);
    meshes.lod.push(lod);
  }
}

/** Compose la matrice monde de l'instance i dans _matrix. */
function composeInstance(i) {
  _quat.setFromAxisAngle(UP, B.rot[i]);
  _pos.set(B.x[i], B.y[i], B.z[i]);
  _scale.set(B.scale[i], B.scaleY[i], B.scale[i]);
  _matrix.compose(_pos, _quat, _scale);
}

/** Teinte d'instance : multiplicateur discret, 4 par famille. */
function setTint(mesh, slot, i) {
  const tints = FAMILY_TINTS[FAMILY_ORDER[B.family[i]]];
  const t = tints[B.tint[i]];
  _color.setRGB(t[0], t[1], t[2]);
  mesh.setColorAt(slot, _color);
}

/** Remplit une fois pour toutes les matrices/teintes de tous les LOD. */
function fillLod() {
  const nD = districts.count;
  for (let a = 0; a < ARCHETYPES.length; a++) {
    const mesh = meshes.lod[a];
    const base = ranges.archStart[a];
    for (let d = 0; d < nD; d++) {
      const k = a * nD + d;
      const from = ranges.start[k];
      const to = from + ranges.len[k];
      for (let i = from; i < to; i++) {
        composeInstance(i);
        mesh.setMatrixAt(i - base, _matrix);
        setTint(mesh, i - base, i);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

/** Écrit (ou efface) la plage LOD d'un quartier selon son drapeau `active`. */
function refreshLodDistrict(d) {
  const nD = districts.count;
  const hidden = districts.active[d] === 1;
  for (let a = 0; a < ARCHETYPES.length; a++) {
    const k = a * nD + d;
    const count = ranges.len[k];
    if (count === 0) continue;
    const mesh = meshes.lod[a];
    const base = ranges.archStart[a];
    const from = ranges.start[k] - base;
    for (let s = 0; s < count; s++) {
      if (hidden) {
        mesh.setMatrixAt(from + s, _zero);
      } else {
        composeInstance(ranges.start[k] + s);
        mesh.setMatrixAt(from + s, _matrix);
      }
    }
    mesh.instanceMatrix.addUpdateRange(from * 16, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Recompacte les InstancedMesh de détail sur les quartiers actifs. */
function repackDetail() {
  const nD = districts.count;
  overflow = 0;
  for (let a = 0; a < ARCHETYPES.length; a++) {
    const mesh = meshes.detail[a];
    const capacity = mesh.instanceMatrix.count;
    let slot = 0;
    for (let d = 0; d < nD; d++) {
      if (districts.active[d] === 0) continue;
      const k = a * nD + d;
      const from = ranges.start[k];
      const to = from + ranges.len[k];
      for (let i = from; i < to; i++) {
        if (slot >= capacity) {
          overflow++;
          continue;
        }
        composeInstance(i);
        mesh.setMatrixAt(slot, _matrix);
        setTint(mesh, slot, i);
        slot++;
      }
    }
    mesh.count = slot;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * Réévalue quels quartiers passent en détail. Un seul drapeau sert aux deux
 * niveaux, donc un quartier est toujours rendu exactement une fois — jamais
 * de trou pendant la transition, jamais de double dessin.
 * @param {THREE.Camera} camera
 */
function updateLod(camera) {
  const px = camera.position.x;
  const py = camera.position.y;
  const pz = camera.position.z;
  const reach = DETAIL_RADIUS;
  const reach2 = reach * reach;
  let changed = 0;

  for (let d = 0; d < districts.count; d++) {
    const dx = districts.cx[d] - px;
    const dz = districts.cz[d] - pz;
    const near = dx * dx + py * py + dz * dz <= reach2 ? 1 : 0;
    if (near !== districts.active[d]) {
      districts.active[d] = near;
      changedList[changed++] = d;
    }
  }
  if (changed === 0) return;
  for (let c = 0; c < changed; c++) refreshLodDistrict(changedList[c]);
  repackDetail();
}

// ============================================================================
// Point d'entrée « année » (tâche 8)
// ============================================================================

/**
 * Reconstruit tout le tissu pour une autre année. Aujourd'hui appelé une
 * seule fois, à l'init, pour 2026 : la tâche 8 le branchera sur les
 * changements d'année (et pourra n'en refaire qu'une partie, les métadonnées
 * par instance — uYear, seed, born — étant déjà là pour ça).
 * @param {number} year
 */
export function rebuildForYear(year) {
  lastYear = year;
  fillLod();
  districts.active.fill(0);
  repackDetail();
}

// ============================================================================
// Contrat de layer
// ============================================================================

// La caméra n'est pas dans `state` (voir main.js : `state` ne porte que les
// champs UI/temporels) : on la garde depuis `ctx` à l'init, pour que
// `update(dt, state)` respecte le contrat de layer standard sans avoir besoin
// que `state` transporte la caméra.
let _camera = null;

export function init(ctx) {
  // Dépend de terrain.init() (déjà exécuté : ordre du registre de layers dans
  // main.js) pour échantillonner l'altitude du sol *rendu* via groundHeightAt.
  _camera = ctx.camera;
  const year = 2026;
  generate(year);
  buildMeshes(ctx);
  rebuildForYear(year);
  lodTimer = LOD_INTERVAL; // première évaluation dès la première frame
}

export function update(dt) {
  lodTimer += dt;
  if (lodTimer < LOD_INTERVAL) return;
  lodTimer = 0;
  updateLod(_camera);
}

export function stats() {
  return {
    buildings: B.count,
    archetypes: ARCHETYPES.length,
    districts: districts.count,
    detailInstances: meshes.detail.reduce((s, m) => s + m.count, 0),
    detailCapacity: meshes.detail.reduce((s, m) => s + m.instanceMatrix.count, 0),
    activeDistricts: districts.active ? districts.active.reduce((s, v) => s + v, 0) : 0,
    overflow,
    year: lastYear,
  };
}
