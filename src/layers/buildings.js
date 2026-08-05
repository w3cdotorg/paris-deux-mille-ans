/**
 * Buildings layer — le tissu bâti procédural de Paris.
 *
 * Modèle en trois étages :
 *
 *  1. **Grille de cellules 8x8 unités (80 m)** couvrant la zone urbanisable
 *     (ellipse du périphérique + grappe de La Défense). Chaque cellule
 *     urbanisée reçoit 2 à 13 bâtiments posés *en îlot périmétrique* : les
 *     façades s'alignent sur une ligne de rue à 3,55 unités du centre de
 *     cellule et la profondeur du bâtiment part vers l'intérieur, ce qui
 *     laisse une cour au milieu et une rue de ~9 m entre deux îlots. Les
 *     bâtiments d'une même arête sont posés *contigus* (un curseur par arête,
 *     largeur réelle + mur mitoyen) plutôt qu'espacés uniformément, avec un
 *     repli borné (rétrécissement jusqu'à ~0,75× puis abandon de l'instance)
 *     si une arête est déjà pleine — voir `placeCell`/`fitOnEdge` pour le
 *     détail. C'est la morphologie parisienne, et c'est ce qui fait « lire »
 *     la ville d'en haut, bien plus qu'un semis de boîtes.
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
import { urbanYear, distanceToSeine, RINGS, LANDMARKS, ISLANDS } from "../geography.js";
import { lerp, smoothstep, lifecycle, easeOutBack } from "../timeEngine.js";
import { YEAR_MIN, YEAR_MAX } from "../timeline.js";
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

// Ligne de façade, mesurée depuis le centre de cellule. Relevée de 3,25 à
// 3,55 (review Critical 1b) : à 3,25, l'enveloppe périmétrique ne pouvait
// physiquement pas dépasser ~52% de la surface de cellule, quel que soit le
// nombre de bâtiments posés dessus — un plafond bien en-deçà de la cible de
// couverture. Deux îlots voisins se font donc face à 4,9 unités, soit une
// rue de 0,9 unité (9 m, une rue étroite mais plausible dans le tissu ancien).
const FACADE_LINE = 3.55;
// Relevé de 0,78 à 0,92 (fix-of-fix du débordement de curseur, voir
// `fitOnEdge` plus bas) : borner chaque pose à l'espace réellement
// disponible de son arête (au lieu de laisser le curseur déborder dans la
// cellule voisine) fait aussi baisser la couverture du coeur sous la cible
// de 60% (50,4% mesuré juste après le plafonnement) — une arête plus longue
// laisse plus de bâtiments s'y poser à taille nominale avant d'avoir besoin
// de rétrécir ou d'abandonner une instance, ce qui restaure la couverture
// sans jamais dépasser la moitié physique de la cellule (4 unités).
const EDGE_SPAN = 0.92; // fraction de l'arête utilisable (évite les angles pile)
const PARTY_WALL_SEAM = 0.04; // interstice entre deux bâtiments contigus (mur mitoyen)

const WATER_MARGIN = 9; // pas de bâti à moins de 9 unités de l'axe de la Seine
const SINK = 0.12; // enfoncement dans le sol, masque l'erreur d'échantillonnage

// Densité : maximale au coeur, décroissante vers les faubourgs.
const CORE = { x: -30, z: -40 };
const DENSITY_FULL_R = 130;
const DENSITY_ZERO_R = 640;

// Rééquilibré vers le coeur (review Critical 1c) : COUNT_CORE relevé et
// COUNT_EDGE/VOID_EDGE resserrés pour que le budget total d'instances
// (≤40 000, voir detailCapacities) finance surtout le tissu haussmannien
// dense du centre plutôt que d'être dilué uniformément jusqu'aux faubourgs.
// Retunés une seconde fois après le plafonnement du curseur d'arête
// (`fitOnEdge`) : borner/rétrécir/abandonner les poses qui ne rentraient pas
// a coûté de la couverture (61,7% → un COUNT_CORE plus haut la restaure) ;
// VOID_EDGE/COUNT_EDGE resserrés en retour pour rester sous le budget malgré
// un COUNT_CORE plus généreux.
const VOID_CORE = 0.18; // part de cellules non bâties (rues larges, cours, places)
const VOID_EDGE = 0.84;
const COUNT_CORE = [10, 13]; // min/max de bâtiments par cellule bâtie, au coeur
const COUNT_EDGE = [2, 2]; // ... et en périphérie

// LOD. Le brief demande la bascule « au-delà de ~350 unités de caméra ».
// Resserré de 320 à 240 (review Critical 1) : le rééquilibrage du budget vers
// le coeur (COUNT_CORE relevé ci-dessus) déplace des instances des faubourgs
// vers le coeur, mais ne change rien au *rayon* auquel le coeur bascule en
// détail — à 320, la vue toits (`cite`, distance 80) englobait ~27k instances
// de détail (contre ~18,4k dans le budget d'origine avant ce fix), ce qui
// dégradait le fps mesuré. 240 ramène ce nombre à ~18,5k.
//
// Resserré une deuxième fois à 150 (tâche 8, régression temporaire), puis
// **restauré à 240** (correctif de revue Important 3) : le vrai problème
// n'était pas le rayon, c'était `repackDetail` qui compactait, par quartier
// actif, *tout* l'historique d'une parcelle (chaque étape de `expandHistory`,
// y compris les étapes déjà démolies — masquées par une matrice à échelle
// nulle, mais toujours dans `mesh.count`, donc toujours transformées par le
// vertex shader), au lieu du bâti réellement *présent* (`B.visGrow[i] > 0`) à
// l'année courante. `repackDetail` est désormais présence-consciente (voir
// plus bas) et `detailCapacities` dimensionne les buffers sur le pic de
// présence *simultanée* (au plus 2 étapes par parcelle, le temps d'un
// crossgrow) plutôt que sur le total de l'historique — ~19-20k instances
// détail au preset `cite` avec ce rayon 240, contre ~42,7k avant ce correctif
// pour le même rayon (mesure tâche 8 initiale) et ~84,3k si tout l'historique
// devait être compacté sans filtrage de présence.
const DETAIL_RADIUS = 240;
const LOD_INTERVAL = 0.12; // secondes entre deux réévaluations de la bascule

// Tâche 8 — cycle de vie temporel. Un bâtiment met BUILD_YEARS à sortir de
// terre (scale Y 0→1, léger overshoot) et RAZE_YEARS à disparaître quand il
// est remplacé ; en choisissant la même durée pour les deux et en faisant
// coïncider exactement `died` de l'ancien bâti avec `born` du nouveau (voir
// `expandHistory`), la présence de l'ancien (1→0) et celle du nouveau (0→1)
// se somment à *exactement* 1 tout au long de la fenêtre : un crossgrow, pas
// un crossfade — l'ancien rétrécit pendant que le nouveau pousse à sa place.
export const BUILD_YEARS = 8;
export const RAZE_YEARS = 8;
const GROWTH_OVERSHOOT = 1.2; // "léger overshoot" — voir easeOutBack (timeEngine.js)

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
//
// notreDame abaissé de 7 à 5,5 (tâche 8) : sur une île de la Cité large de
// seulement ~10 unités (rz=5, voir ISLANDS dans geography.js), un dégagement
// de 7 recouvrait la totalité des cellules dont le centre tombe dans
// l'ellipse -250 de la Cité (distance mesurée : 5,657 pour les 4 cellules
// candidates) — aucune ne restait constructible, donc aucune hutte gauloise
// n'apparaissait *jamais*, à aucune année, y compris 2026. Or c'est
// précisément là que la ville commence (voir aussi l'exemption d'île
// ci-dessous) : sans ce fix, le premier bâtiment de tout Paris n'apparaît que
// vers l'an 100 (le disque romain rive gauche), laissant les 300 premières
// années de la frise (-250 à ~50, 13% de toute la ligne du temps) sans la
// moindre construction — pas franchement « spectaculaire ». 5,5 reste un
// dégagement confortable (55 m) pour le futur maillage de la cathédrale tout
// en laissant les 4 cellules de la Cité constructibles.
const LANDMARK_CLEARANCE = {
  notreDame: 5.5,
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
  const history = fabricHistoryAt(uYear, density, insideRing, seed, year);
  const last = history[history.length - 1];
  return { family: last.family, born: last.born };
}

/**
 * Jitter (tâche 8) appliqué à l'année de naissance du bâti *d'origine* d'une
 * parcelle : une parcelle n'est pas bâtie littéralement l'année où le sol
 * devient urbanisable (`urbanYear`), mais dans les décennies qui suivent —
 * d'où `born = uYear + jitter(0..40 ans)`, déterministe par graine. C'est ce
 * décalage qui, agrégé sur toute la grille, étale la vague de construction
 * plutôt que de la faire apparaître d'un coup à chaque année de urbanYear.
 * @param {number} seed
 * @returns {number} dans [0, 40)
 */
export function originJitter(seed) {
  return roll(seed, 977) * 40;
}

/**
 * Historique complet du bâti d'une parcelle, de sa construction d'origine
 * jusqu'à `endYear` (par défaut YEAR_MAX = 2026, c'est-à-dire *tout* ce que
 * cette parcelle aura jamais vu) : une naissance (bâti d'origine, dont
 * l'année suit `originJitter` ci-dessus) puis zéro ou plusieurs reconstructions
 * — une entrée par époque de EPOCHS dont le tirage a réussi, dans l'ordre
 * chronologique. C'est le même mécanisme de tirage que `fabricAt` (dont c'est
 * maintenant la brique de base, voir plus haut), généralisé pour *garder*
 * chaque étape plutôt que de n'en renvoyer que la dernière : la tâche 8 a
 * besoin de savoir qu'une parcelle médiévale a pu être romaine avant, pas
 * seulement de son état final en 2026.
 *
 * `died` de chaque entrée (ajouté par l'appelant, voir `expandHistory`) sera
 * exactement `born` de l'entrée suivante : c'est ce qui fait du re-clad un
 * *crossgrow* (l'ancien rétrécit pendant que le nouveau pousse, la somme des
 * deux présences valant exactement 1 tout au long de la transition) plutôt
 * qu'un crossfade ou qu'un trou.
 * @param {number} uYear - urbanYear de la cellule
 * @param {number} density - densityAt du centre de cellule, dans [0,1]
 * @param {boolean} insideRing - dans l'enceinte de Thiers (le périphérique)
 * @param {number} seed - graine du bâtiment (voir seedOf)
 * @param {number} [endYear] - n'inclut aucune reconstruction postérieure
 * @returns {Array<{family: string, born: number}>} au moins une entrée
 */
export function fabricHistoryAt(uYear, density, insideRing, seed, endYear = YEAR_MAX) {
  const index0 = EPOCH_INDEX[familyForUrbanYear(uYear)];
  let born0 = uYear + originJitter(seed); // originJitter >= 0, so born0 >= uYear always
  // Correctif de revue (Critical 1, tâche 8) : à uYear === YEAR_MIN (l'île de
  // la Cité, seule origine du tout premier instant de la frise), le jitter
  // strictement positif fait que `born0` ne peut jamais être <= YEAR_MIN —
  // le bâti d'origine n'a donc jamais fini ses BUILD_YEARS à YEAR_MIN lui-même,
  // rendant le village fondateur structurellement invisible à l'instant
  // d'ouverture de toute la frise. On recule `born0` (un léger étalement
  // avant YEAR_MIN ne pose aucun problème : rien ne s'affiche avant YEAR_MIN
  // de toute façon) pour que le village soit pleinement debout dès YEAR_MIN.
  // Ne déclenche qu'aux cellules d'origine de la frise ; le schéma de jitter
  // général reste inchangé pour tout `uYear` postérieur.
  if (uYear <= YEAR_MIN) {
    born0 = Math.min(born0, YEAR_MIN - BUILD_YEARS);
  }
  const history = [{ family: EPOCHS[index0].family, born: born0 }];

  for (let k = index0 + 1; k < EPOCHS.length; k++) {
    const epoch = EPOCHS[k];
    const gate = epoch.year + roll(seed, 900 + k * 7) * epoch.spread;
    if (gate > endYear || gate < uYear) continue;
    let share = Array.isArray(epoch.share)
      ? lerp(epoch.share[0], epoch.share[1], density)
      : epoch.share;
    // Le re-clad haussmannien est une opération intra-muros : hors enceinte
    // de Thiers, seuls quelques immeubles de rapport isolés y passent.
    if (epoch.family === "haussmann" && !insideRing) share = 0.1;
    // Réciproquement (review Critical 2) : la reconstruction « moderne » est
    // une opération de périphérie/banlieue — le coeur historique intra-muros
    // est protégé (secteur sauvegardé de facto). Sans ce verrou, le seul
    // decay par densité (share = [0.24 faubourg, 0.05 coeur]) laissait encore
    // 5-15% de tours de verre sur du bâti d'origine médiévale *dans* l'enceinte
    // de Thiers — des tours à Notre-Dame. Le même facteur ×0.1 que le
    // re-clad haussmannien hors enceinte, en miroir : quelques opérations
    // isolées restent possibles, mais plus l'écrasante majorité.
    if (epoch.family === "moderne" && insideRing) share *= 0.06;
    if (roll(seed, 1300 + k * 11) < share) {
      history.push({ family: epoch.family, born: gate });
    }
  }
  return history;
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
  // Rééquilibrage du budget vers le coeur (review Critical 1c) : un lerp
  // *linéaire* en densité étale le relèvement de COUNT_CORE sur toute la
  // moitié haute de la densité, ce qui regonfle aussi le nombre moyen de
  // bâtiments des faubourgs à densité moyenne — exactement ce qu'on essaie
  // d'éviter. En élevant la densité au carré avant l'interpolation, la bande
  // coeur (densité proche de 1) reçoit l'essentiel du relèvement tandis que
  // les faubourgs (densité ~0,3-0,7) restent proches de COUNT_EDGE/VOID_EDGE.
  const t = density * density;
  const voidShare = lerp(VOID_EDGE, VOID_CORE, t);
  if (hash01(ix, iz, 101) < voidShare) return 0;
  const min = Math.round(lerp(COUNT_EDGE[0], COUNT_CORE[0], t));
  const max = Math.round(lerp(COUNT_EDGE[1], COUNT_CORE[1], t));
  return min + Math.floor(hash01(ix, iz, 202) * (max - min + 1));
}

/**
 * Île de la Cité / Saint-Louis : terrain sec en permanence (voir
 * `constantIslandDelta` dans terrain.js, qui les surélève indépendamment du
 * relief de base), pas une berge boueuse — `WATER_MARGIN` ci-dessous, pensé
 * pour tenir le bâti à distance de l'eau *courante*, exclurait sinon la
 * totalité de ces îles (elles sont, par nature, à moins de 9 unités de l'axe
 * du fleuve de tous les côtés). Louviers (île « morte » en 1843, voir
 * ISLANDS) volontairement exclue de cette exemption : son bras mort et sa
 * disparition programmée en font un cas à part, pas un simple confort de
 * berge.
 */
function onPermanentIsland(x, z) {
  return (
    insideEllipse(x, z, ISLANDS.cite.x, ISLANDS.cite.z, ISLANDS.cite.rx, ISLANDS.cite.rz) ||
    insideEllipse(
      x,
      z,
      ISLANDS.saintLouis.x,
      ISLANDS.saintLouis.z,
      ISLANDS.saintLouis.rx,
      ISLANDS.saintLouis.rz
    )
  );
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
  if (distanceToSeine(x, z) < WATER_MARGIN && !onPermanentIsland(x, z)) return false;
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

  // Empaquetage contigu par arête (review Critical 1a) : chaque arête a son
  // propre curseur, qui avance de la largeur réelle du bâtiment (w*scale)
  // plus un interstice de mur mitoyen à chaque pose — au lieu de répartir
  // uniformément 1/count le long du périmètre sans égard à la largeur des
  // bâtiments, ce qui laissait ~46% de la façade vide entre des bâtiments
  // étroits. Les bâtiments sont distribués aux 4 arêtes en tournant (round
  // robin) selon leur rang de pose.
  //
  // Correctif de revue (nouvelle casse « Important ») : ce curseur n'était
  // borné par rien — avec COUNT_CORE relevé jusqu'à 12, jusqu'à 3 bâtiments
  // peuvent tomber sur la même arête par le round-robin, et 3 haussmanniens
  // (2,0-2,5 u × échelle ≤1,2) totalisent 7,5-8,7 u sur une arête utile de
  // ~5,54 u (2×edgeHalf) — un débordement mesuré jusqu'à +2,35 u, soit ~30 %
  // d'une cellule, dans la cellule voisine. `fitOnEdge` borne chaque pose :
  // plein gabarit sur l'arête visée, puis plein gabarit sur les 3 autres
  // arêtes (« essayer l'arête suivante »), puis, seulement si aucune arête
  // n'a de place à taille nominale, un gabarit réduit jusqu'au plancher
  // SCALE_FLOOR sur l'arête visée puis les autres — et seulement si même le
  // plancher ne rentre nulle part, le bâtiment est abandonné (rare,
  // déterministe, borné). Diagnostic ci-dessus daté de la casse trouvée par
  // la revue (COUNT_CORE=[9,12], EDGE_SPAN=0,78) ; EDGE_SPAN et COUNT_CORE
  // ont depuis été retunés une seconde fois (voir leurs commentaires plus
  // haut) pour retrouver ≥60% de couverture coeur une fois le plafonnement
  // en place — le principe et le mécanisme de `fitOnEdge` restent les mêmes.
  const edgeHalf = FACADE_LINE * EDGE_SPAN;
  const cursor = [-edgeHalf, -edgeHalf, -edgeHalf, -edgeHalf];
  const SCALE_FLOOR = 0.75;

  /**
   * Facteur de réduction (dans [SCALE_FLOOR, 1]) permettant de faire entrer
   * un bâtiment de largeur nominale `alongNominal` dans l'espace restant de
   * cette arête, mur mitoyen inclus ; `null` si même le plancher ne rentre
   * pas (ou si l'arête est déjà pleine).
   */
  function fitOnEdge(remaining, alongNominal) {
    if (remaining <= 0) return null;
    const required = alongNominal + PARTY_WALL_SEAM;
    if (required <= remaining) return 1;
    const availableAlong = remaining - PARTY_WALL_SEAM;
    if (availableAlong <= 0) return null;
    const shrink = availableAlong / alongNominal;
    return shrink >= SCALE_FLOOR ? shrink : null;
  }

  for (let slot = 0; slot < count; slot++) {
    const seed = seedOf(ix, iz, slot);
    const { family, born } = fabricAt(uYear, year, density, insideRing, seed);
    const primaryEdge = slot & 3;

    const options = ARCHETYPES_BY_FAMILY[family];
    let archetype = pickArchetype(options, seed);
    const pickedSpec = ARCHETYPES[archetype];

    // Base relevé de 0.88 à 1.0 par rapport à l'origine : à la distance de LOD
    // (macro-quartier, boîte simplifiée), chaque bâtiment ne couvre que
    // quelques pixels — un socle trop timide se noie dans le sol crème et la
    // ville se lit comme un bruit de speckle plutôt qu'un tissu dense. Ce
    // socle plus généreux (+~28% de surface au sol en moyenne) referme les
    // interstices sans toucher le nombre d'instances (donc sans coût de perf).
    const nominalScale = 1.0 + roll(seed, 31) * (family === "haussmann" ? 0.2 : 0.32);
    const alongNominal = pickedSpec.w * nominalScale;

    // Cherche une arête où ce bâtiment rentre : l'arête visée par le
    // round-robin d'abord, puis les 3 autres dans l'ordre — à taille
    // nominale (pass 1), puis, seulement si aucune arête n'a assez de place
    // à taille nominale, en acceptant un rétrécissement jusqu'à SCALE_FLOOR
    // (pass 2).
    let edge = -1;
    let shrink = null;
    for (let pass = 0; pass < 2 && shrink === null; pass++) {
      for (let k = 0; k < 4 && shrink === null; k++) {
        const e = (primaryEdge + k) & 3;
        const fit = fitOnEdge(edgeHalf - cursor[e], alongNominal);
        if (fit === null) continue;
        if (pass === 0 && fit < 1) continue; // pass 1 : plein gabarit seulement
        edge = e;
        shrink = fit;
      }
    }
    if (shrink === null) continue; // aucune arête, même au plancher : abandonné

    const scale = nominalScale * shrink;
    // Hauteur : jitter serré pour l'haussmannien (la ligne de corniche
    // uniforme EST la signature du centre de Paris), large pour le médiéval.
    // Appliqué à l'échelle *finale* (post-rétrécissement) pour que la hauteur
    // reste proportionnée à un bâtiment qu'on a dû faire rentrer plus petit.
    const jitterY = family === "medieval" ? 0.3 : family === "haussmann" ? 0.09 : 0.18;
    const scaleY = scale * (1 - jitterY / 2 + roll(seed, 37) * jitterY);

    // Avance le curseur de l'arête retenue de la largeur réelle du bâtiment
    // (avant tout remplacement d'archétype d'angle ci-dessous) + le mur
    // mitoyen : c'est ce qui rend le mur de rue contigu, désormais sans
    // jamais dépasser l'espace disponible de cette arête.
    const along = pickedSpec.w * scale;
    const s = cursor[edge] + along / 2;
    cursor[edge] += along + PARTY_WALL_SEAM;
    const atCorner = Math.abs(s) > 0.72 * edgeHalf;

    // Un immeuble d'angle à pan coupé aux angles d'îlot haussmanniens.
    if (family === "haussmann" && atCorner && roll(seed, 29) < 0.55) {
      archetype = ARCHETYPES_BY_FAMILY.haussmann[4]; // haussmann_angle
    }
    const spec = ARCHETYPES[archetype];

    // Façade sur la ligne de rue, profondeur vers l'intérieur de l'îlot.
    const depth = (spec.d * scale) / 2;
    const inner = FACADE_LINE - depth;
    let lx;
    let lz;
    let yaw;
    if (edge === 0) {
      lx = s;
      lz = -inner;
      yaw = Math.PI;
    } else if (edge === 1) {
      lx = inner;
      lz = s;
      yaw = Math.PI / 2;
    } else if (edge === 2) {
      lx = -s;
      lz = inner;
      yaw = 0;
    } else {
      lx = -inner;
      lz = -s;
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
  uYear: null, // Float32Array — urbanYear de la cellule
  born: null, // Float32Array — année de naissance de *cette* étape du bâti
  died: null, // Float32Array — année de remplacement (Infinity = dernière étape, tient jusqu'en 2026)
  seed: null, // Uint32Array — rejoue tous les tirages
  visGrow: null, // Float32Array — facteur de croissance courant (easeOutBack(presence)), 0 = invisible
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

// Index triés par born / died (tâche 8) : permettent de ne visiter, à chaque
// changement d'année, que les instances dont la fenêtre de construction
// [born, born+BUILD_YEARS) ou de démolition [died, died+RAZE_YEARS) recoupe
// le balayage [ancienne année, nouvelle année] — tout le reste a une présence
// prouvablement inchangée sur ce balayage (voir `applyYear`), donc jamais
// visité. Deux Int32Array d'indices dans B, chacun trié par la valeur
// correspondante.
let bornOrder = null;
let diedOrder = null;
// -1 si l'instance n'est pas actuellement compactée dans le mesh de détail de
// son archétype ; sinon son slot dans ce mesh. Rempli par `repackDetail`,
// consommé par `applyYear` pour savoir si une instance modifiée doit aussi
// être réécrite dans le détail (en plus du LOD, toujours à jour).
let detailSlotOf = null;
let lastAppliedYear = -Infinity; // force un balayage complet au premier appel
// Dernière année (arrondie) pour laquelle `repackDetail` a tourné (tâche 8,
// correctif Important 3) : un changement de quartiers actifs déclenche déjà
// un repack (voir `updateLod`), mais la présence peut aussi changer *à
// l'intérieur* d'un quartier déjà actif (une construction qui se termine, un
// re-clad qui s'achève) sans toucher `districts.active` — `update` compare
// `Math.round(state.year)` à cette valeur pour détecter ce cas, au même
// rythme throttlé que la bascule de LOD.
let lastRepackYear = null;

const meshes = { detail: [], lod: [] };
let material = null;
let overflow = 0; // instances détail sautées faute de capacité (diagnostic)
let lodTimer = 0;
let changedList = null;

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

// Scratch pour `debugCounts` (tâche 8, correctif Important 2) : lit la
// matrice réellement écrite dans le mesh LOD (pas B lui-même) pour vérifier
// l'état *appliqué*, jamais alloué par frame (debugCounts n'est jamais dans
// le chemin per-frame).
const _readMatrix = new THREE.Matrix4();
const _readPos = new THREE.Vector3();
const _readQuat = new THREE.Quaternion();
const _readScale = new THREE.Vector3();

// ============================================================================
// Génération du tissu
// ============================================================================

function districtOf(ix, iz) {
  const dx = Math.floor((ix - districts.ixMin) / DISTRICT_CELLS);
  const dz = Math.floor((iz - districts.izMin) / DISTRICT_CELLS);
  return dz * districts.nx + dx;
}

/**
 * Étend un bâtiment placé (une position/orientation/gabarit fixes, voir
 * `placeCell`) en une ou plusieurs *étapes* — son historique complet de
 * `fabricHistoryAt` — chacune devenant une entrée séparée dans `raw` avec
 * son propre archétype/teinte/hauteur/born/died. Toutes les étapes d'une
 * même parcelle partagent x/z/rot/scale (même empreinte au sol : le re-clad
 * remplace un bâtiment par un autre au même endroit, il ne déplace rien) ;
 * seule la *dernière* étape réutilise l'archétype déjà choisi par `placeCell`
 * (celui sur lequel l'ajustement de largeur d'arête s'est basé) — les étapes
 * antérieures piochent leur propre archétype dans leur propre famille.
 * `died` de chaque étape est le `born` de la suivante (ou Infinity pour la
 * dernière) : c'est ce qui garantit le crossgrow (voir `fabricHistoryAt`).
 * @param {object} p - un élément retourné par `placeCell`
 * @param {number} density
 * @param {boolean} insideRing
 * @returns {Array<object>} une ou plusieurs "lignes" prêtes pour B
 */
function expandHistory(p, density, insideRing) {
  const history = fabricHistoryAt(p.uYear, density, insideRing, p.seed);
  const rows = [];
  for (let s = 0; s < history.length; s++) {
    const stage = history[s];
    const isFinal = s === history.length - 1;
    const archetype = isFinal
      ? p.archetype
      : pickArchetype(ARCHETYPES_BY_FAMILY[stage.family], p.seed);
    const tint = isFinal ? p.tint : Math.floor(roll(p.seed, 1500 + s * 19) * 4) % 4;
    let scaleY;
    if (isFinal) {
      scaleY = p.scaleY;
    } else {
      const jitterY =
        stage.family === "medieval" ? 0.3 : stage.family === "haussmann" ? 0.09 : 0.18;
      scaleY = p.scale * (1 - jitterY / 2 + roll(p.seed, 1600 + s * 19) * jitterY);
    }
    const died = s + 1 < history.length ? history[s + 1].born : Infinity;
    rows.push({
      x: p.x,
      z: p.z,
      rot: p.rot,
      scale: p.scale,
      scaleY,
      archetype,
      tint,
      family: stage.family,
      uYear: p.uYear,
      born: stage.born,
      died,
      seed: p.seed,
      district: p.district,
    });
  }
  return rows;
}

/**
 * Parcourt la grille, place les bâtiments (une fois pour toutes, sur la base
 * du tissu *final*, YEAR_MAX = 2026 — la position/le gabarit d'une parcelle
 * ne changent pas dans le temps, seul son habillage change, voir
 * `expandHistory`), développe l'historique de chacun, puis range les
 * instances par (archétype, quartier) — un tri par comptage, pour que chaque
 * paire soit une plage contiguë : c'est ce qui rend la bascule de LOD
 * triviale (une plage à remettre à zéro) et le repack du détail séquentiel.
 *
 * Contrairement à la tâche 7, ceci ne s'exécute plus qu'une seule fois, à
 * l'init : le temps (tâche 8) ne touche plus qu'à la *présence* de chaque
 * instance déjà générée (voir `applyYear`), jamais à la géométrie elle-même.
 */
function generate() {
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
      if (!isBuildableCell(cx, cz, uYear, YEAR_MAX)) continue;
      const density = densityAt(cx, cz);
      const insideRing = insideEllipse(
        cx,
        cz,
        peripherique.cx,
        peripherique.cz,
        peripherique.rx,
        peripherique.rz
      );
      const placed = placeCell(ix, iz, uYear, YEAR_MAX, density, insideRing);
      const district = districtOf(ix, iz);
      for (const p of placed) {
        p.uYear = uYear;
        p.district = district;
        for (const row of expandHistory(p, density, insideRing)) raw.push(row);
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
  B.died = new Float32Array(n);
  B.seed = new Uint32Array(n);
  B.visGrow = new Float32Array(n);

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
    B.died[i] = p.died;
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

  // --- pic de présence *simultanée* par (archétype, quartier) ---------------
  // Correctif de revue (Important 3, tâche 8) : `len[k]` (ci-dessus) compte
  // *tout* l'historique d'un bucket, le majorant qu'utilisait l'ancien
  // `detailCapacities` pour dimensionner le mesh de détail — correct pour un
  // `repackDetail` qui compactait tout, mais très large pour le nouveau
  // `repackDetail` présence-consciente (voir plus bas), qui ne pack plus que
  // les étapes dont `B.visGrow[i] > 0` à l'année courante. Le majorant qu'il
  // faut désormais, c'est le nombre maximal d'étapes *simultanément*
  // présentes à une même année — jamais plus de 2 par parcelle (le temps d'un
  // crossgrow, l'ancienne qui rétrécit + la nouvelle qui pousse), donc bien
  // inférieur au total d'historique. Calculé par balayage d'événements
  // (naissance = +1, fin de démolition = born+RAZE_YEARS = -1) par bucket :
  // le pic exact de la somme courante, sans avoir à énumérer les années.
  const presentCap = new Int32Array(nKeys);
  {
    const events = [];
    for (let k = 0; k < nKeys; k++) {
      const from = start[k];
      const to = from + len[k];
      if (from === to) continue;
      events.length = 0;
      for (let i = from; i < to; i++) {
        events.push([B.born[i], 1]);
        if (Number.isFinite(B.died[i])) events.push([B.died[i] + RAZE_YEARS, -1]);
      }
      events.sort((p, q) => p[0] - q[0] || p[1] - q[1]); // retraits avant ajouts à égalité
      let cur = 0;
      let max = 0;
      for (const [, delta] of events) {
        cur += delta;
        if (cur > max) max = cur;
      }
      presentCap[k] = max;
    }
  }
  ranges.presentCap = presentCap;

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

  // --- index temporels (tâche 8) : indices dans B triés par born / died -----
  bornOrder = Int32Array.from({ length: n }, (_, i) => i);
  bornOrder.sort((a, b) => B.born[a] - B.born[b]);
  diedOrder = Int32Array.from({ length: n }, (_, i) => i);
  diedOrder.sort((a, b) => B.died[a] - B.died[b]);
  detailSlotOf = new Int32Array(n).fill(-1);
}

/**
 * Capacité à allouer par archétype pour les InstancedMesh de détail : le pire
 * cas réel, c'est-à-dire le maximum, sur toutes les positions de caméra
 * plausibles *et* sur toutes les années plausibles, du nombre d'instances de
 * cet archétype *présentes en même temps* dans les quartiers à portée. On
 * échantillonne les centres de quartier comme positions candidates (borne
 * supérieure : la caméra étant toujours en hauteur, sa distance 3D à un
 * quartier est plus grande que la distance planaire testée ici), et
 * `ranges.presentCap` (voir `generate`) donne, par bucket, le pic déjà
 * maximisé sur l'année — la somme de majorants indépendants reste un
 * majorant valide de la somme réelle, même si les pics de buckets différents
 * ne tombent pas à la même année.
 *
 * Correctif de revue (Important 3, tâche 8) : utilisait `ranges.len`, le
 * total de *tout* l'historique d'un bucket (pertinent quand `repackDetail`
 * packait tout, ghosts compris) — désormais `ranges.presentCap`, le pic de
 * présence simultanée, cohérent avec le `repackDetail` présence-conscient.
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
      for (let a = 0; a < nArch; a++) acc[a] += ranges.presentCap[a * nD + d];
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

/**
 * Compose la matrice monde de l'instance i dans _matrix — la seule fonction
 * qui traduit l'état temporel (tâche 8, `B.visGrow`) en géométrie : un
 * `visGrow` <= 0 (absent avant sa naissance, ou disparu après sa démolition)
 * dégénère la matrice à l'échelle nulle (comme le fait déjà `_zero` pour le
 * LOD spatial) — footprint *et* hauteur nuls, donc rien à l'écran plutôt
 * qu'une empreinte plate posée sur le sol. Entre les deux, l'empreinte au sol
 * (x/z, voir `placeCell`) reste toujours à sa taille pleine — seule la
 * hauteur (y) grossit avec `visGrow`, « poussent depuis leurs fondations ».
 */
function composeInstance(i) {
  const grow = B.visGrow[i];
  if (grow <= 0) {
    _matrix.copy(_zero);
    return;
  }
  _quat.setFromAxisAngle(UP, B.rot[i]);
  _pos.set(B.x[i], B.y[i], B.z[i]);
  _scale.set(B.scale[i], B.scaleY[i] * grow, B.scale[i]);
  _matrix.compose(_pos, _quat, _scale);
}

/** Teinte d'instance : multiplicateur discret, 4 par famille. */
function setTint(mesh, slot, i) {
  const tints = FAMILY_TINTS[FAMILY_ORDER[B.family[i]]];
  const t = tints[B.tint[i]];
  _color.setRGB(t[0], t[1], t[2]);
  mesh.setColorAt(slot, _color);
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

/**
 * Recompacte les InstancedMesh de détail sur les quartiers actifs. Remplit
 * aussi `detailSlotOf` (tâche 8) : c'est ce qui permet à `applyYear` de savoir
 * quelles instances, en plus de leur plage LOD (toujours à jour), doivent
 * aussi être réécrites dans le mesh de détail quand leur croissance change.
 *
 * Présence-consciente (correctif de revue Important 3, tâche 8) : une
 * instance dont `B.visGrow[i] <= 0` (pas encore née, ou déjà démolie à
 * l'année en cours d'application) est *ignorée* du compactage plutôt que
 * packée quand même sous forme de matrice à échelle nulle — c'est ce qui
 * évite de payer un travail de vertex shader pour les ghosts déjà démolis
 * d'une parcelle (chaque étape d'`expandHistory` autre que la courante).
 * Suppose que `B.visGrow` est déjà à jour pour l'année en cours au moment de
 * l'appel (vrai dans les trois chemins d'appel : `updateLod` après
 * `applyYear` dans `update`, la resynchronisation forcée de `rebuildForYear`,
 * et le déclenchement au changement d'année arrondie dans `update`).
 */
function repackDetail() {
  const nD = districts.count;
  overflow = 0;
  detailSlotOf.fill(-1);
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
        if (B.visGrow[i] <= 0) continue; // pas présent à l'année en cours : ne pas packer
        if (slot >= capacity) {
          overflow++;
          continue;
        }
        composeInstance(i);
        mesh.setMatrixAt(slot, _matrix);
        setTint(mesh, slot, i);
        detailSlotOf[i] = slot;
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
//
// La géométrie est figée pour toujours par `generate()` (appelé une seule
// fois, à l'init) : ce qui change avec l'année, c'est uniquement la
// *présence* de chaque instance déjà générée — `B.visGrow`, lu par
// `composeInstance`. `applyYear` ne visite que les instances dont la présence
// a pu changer entre l'ancienne et la nouvelle année (dirty-tracking par
// plage, voir `bornOrder`/`diedOrder`), ce qui le rend assez bon marché pour
// être appelé à *chaque frame* avec l'année exacte (non arrondie — la
// croissance doit rester lisse pendant un scrub, pas saccadée par palier
// d'année entière) plutôt que débattu comme le rescan de terrain.js.

/** Première position dans `order` où `values[order[idx]] >= target`. */
function lowerBound(order, values, target) {
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[order[mid]] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Recompose et réécrit la matrice LOD (toujours) et détail (si compactée) de l'instance i. */
function writeInstance(i) {
  const a = B.archetype[i];
  composeInstance(i);
  meshes.lod[a].setMatrixAt(i - ranges.archStart[a], _matrix);
  meshes.lod[a].instanceMatrix.needsUpdate = true;
  const slot = detailSlotOf[i];
  if (slot >= 0) {
    meshes.detail[a].setMatrixAt(slot, _matrix);
    meshes.detail[a].instanceMatrix.needsUpdate = true;
  }
}

/**
 * Visite toutes les instances dont la présence a pu changer entre `a` et `b`
 * (une fenêtre de construction [born, born+BUILD_YEARS) ou de démolition
 * [died, died+RAZE_YEARS) recoupant [a, b]) et recalcule leur `visGrow` *pour
 * l'année `year`* — toujours l'année cible réelle, jamais `a` ni `b` : en
 * scrub arrière (year < lastAppliedYear), `b` vaut l'*ancienne* année, pas la
 * nouvelle, et évaluer la présence à `b` dans ce cas serait un vrai bug
 * (démolition inverse calculée à la mauvaise date).
 *
 * Correction (pourquoi ne visiter que [a, b] suffit) : une instance dont ni
 * la fenêtre de construction ni celle de démolition ne recoupe [a, b] a une
 * présence *nécessairement* constante sur tout [a, b] (la présence, fonction
 * de l'année pour une instance donnée, ne varie qu'à l'intérieur de ces deux
 * fenêtres) — sa `visGrow` déjà en place reste donc exacte pour n'importe
 * quelle année de [a, b], y compris `year`, sans la revisiter.
 * @param {number} a
 * @param {number} b
 * @param {number} year - année à laquelle évaluer la présence des instances touchées
 */
function sweep(a, b, year) {
  const bornFrom = lowerBound(bornOrder, B.born, a - BUILD_YEARS - 1e-6);
  const bornTo = lowerBound(bornOrder, B.born, b + 1e-6);
  for (let k = bornFrom; k < bornTo; k++) touch(bornOrder[k], year);

  const diedFrom = lowerBound(diedOrder, B.died, a - RAZE_YEARS - 1e-6);
  const diedTo = lowerBound(diedOrder, B.died, b + 1e-6);
  for (let k = diedFrom; k < diedTo; k++) touch(diedOrder[k], year);
}

function touch(i, year) {
  const presence = lifecycle(year, {
    born: B.born[i],
    buildYears: BUILD_YEARS,
    died: B.died[i],
    razeYears: RAZE_YEARS,
  }).presence;
  B.visGrow[i] = presence > 0 ? easeOutBack(presence, GROWTH_OVERSHOOT) : 0;
  writeInstance(i);
}

/**
 * Applique `year` : balaie [lastAppliedYear, year] (voir `sweep`), évalué à
 * `year`, puis avance `lastAppliedYear`. Bon marché pour un petit delta
 * (scrub) ; un grand saut (setYear) balaie proportionnellement plus
 * d'instances mais reste correct — même mécanisme, pas de cas spécial.
 * @param {number} year
 */
function applyYear(year) {
  if (year === lastAppliedYear) return;
  const a = Math.min(lastAppliedYear, year);
  const b = Math.max(lastAppliedYear, year);
  sweep(a, b, year);
  lastAppliedYear = year;
}

/**
 * Force une resynchronisation complète pour `year` : balaie *tout* B (bornes
 * -Infinity/+Infinity, donc [0, count) sur `bornOrder` comme sur
 * `diedOrder`), sans dépendre de l'ancien `lastAppliedYear` — c'est le point
 * qui distingue ceci d'un simple `applyYear` : réutiliser `lastAppliedYear`
 * comme borne (une version antérieure de ce fichier le faisait, à tort)
 * ne balaie que [ancienne année, nouvelle année], qui peut être un
 * intervalle *étroit* ne recoupant la fenêtre de presque aucune instance —
 * exactement l'inverse d'une resynchronisation complète. Filet de sécurité
 * peu coûteux (appelé seulement depuis `window.__paris.setYear`, jamais par
 * frame) contre un `update` sauté ou un futur bug du dirty-tracking : un
 * scrub violent (2026↔−250 ×5) reste garanti sans instance orpheline même si
 * l'incrémental avait un trou quelque part.
 * @param {number} year
 */
export function rebuildForYear(year) {
  sweep(-Infinity, Infinity, year);
  lastAppliedYear = year;
  // `repackDetail` est désormais présence-consciente (correctif Important 3,
  // tâche 8) : un grand saut peut donc changer *quelles* instances doivent
  // être compactées dans le détail, pas seulement leur croissance — une
  // resynchronisation complète doit forcer un repack, pas seulement un
  // balayage de présence.
  repackDetail();
  lastRepackYear = Math.round(year);
}

/**
 * Compte, sans muter l'état affiché, les instances présentes (`presence`>0)
 * à `year`, et — correctif de revue (Important 2, tâche 8) — vérifie que
 * l'état réellement *appliqué* (celui que la scène affiche) correspond à
 * cette vérité terrain. La première version de cette fonction ne faisait que
 * ré-évaluer `lifecycle` elle-même et compter : un `applyYear`/`sweep` cassé
 * (mauvais index touché, `writeInstance` sauté, `B.visGrow` jamais écrit...)
 * pouvait laisser une scène complètement fausse tout en passant ce diagnostic
 * haut la main, puisqu'il ne regardait jamais l'état appliqué — c'est
 * exactement ce que la revue a signalé (le stress ×5 « sans orphelin » ne
 * prouvait rien sur `applyYear`/`sweep`). Deux vérités appliquées sont
 * comparées à la vérité terrain recalculée :
 *  - `B.visGrow[i]` (écrit par `touch`) ;
 *  - la matrice réellement présente dans le mesh LOD (écrite par
 *    `writeInstance`, toujours à jour — `sweep` visite `writeInstance` pour
 *    *toute* instance dont la fenêtre recoupe le balayage), dont on relit le
 *    facteur d'échelle Y.
 * Un écart sur l'un ou l'autre est une vraie divergence entre le modèle et ce
 * qui est affiché : `mismatches` doit valoir 0 après tout scrub, si violent
 * soit-il. Exposé via `window.__paris.debugCounts`.
 * @param {number} year
 * @returns {{year:number, totalInstances:number, presentAtYear:number,
 *   detailInstances:number, activeDistricts:number, overflow:number,
 *   visGrowMismatches:number, lodMatrixMismatches:number, mismatches:number}}
 */
export function debugCounts(year) {
  const TOL = 1e-4;
  let presentAtYear = 0;
  let visGrowMismatches = 0;
  let lodMatrixMismatches = 0;
  for (let i = 0; i < B.count; i++) {
    const presence = lifecycle(year, {
      born: B.born[i],
      buildYears: BUILD_YEARS,
      died: B.died[i],
      razeYears: RAZE_YEARS,
    }).presence;
    if (presence > 0) presentAtYear++;
    const expectedGrow = presence > 0 ? easeOutBack(presence, GROWTH_OVERSHOOT) : 0;

    if (Math.abs(B.visGrow[i] - expectedGrow) > TOL) visGrowMismatches++;

    const a = B.archetype[i];
    meshes.lod[a].getMatrixAt(i - ranges.archStart[a], _readMatrix);
    _readMatrix.decompose(_readPos, _readQuat, _readScale);
    const liveGrow = B.scaleY[i] > 0 ? _readScale.y / B.scaleY[i] : 0;
    if (Math.abs(liveGrow - expectedGrow) > TOL) lodMatrixMismatches++;
  }
  return {
    year,
    totalInstances: B.count,
    presentAtYear,
    detailInstances: meshes.detail.reduce((s, m) => s + m.count, 0),
    activeDistricts: districts.active ? districts.active.reduce((s, v) => s + v, 0) : 0,
    overflow,
    visGrowMismatches,
    lodMatrixMismatches,
    mismatches: visGrowMismatches + lodMatrixMismatches,
  };
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
  generate();
  buildMeshes(ctx);
  // État spatial de départ : tout en LOD, rien en détail — `rebuildForYear`
  // (appelé juste après) fait à la fois le balayage complet de présence et un
  // premier `repackDetail` (désormais présence-conscient, voir plus haut) :
  // `detailSlotOf` en sort déjà cohérent avec `B.visGrow` pour YEAR_MAX (ici
  // un no-op puisqu'aucun quartier n'est encore actif) ; le premier `update`
  // (lodTimer pré-armé ci-dessous) réévaluera la caméra dès la première frame
  // et repeuplera le détail des quartiers proches avec la croissance déjà
  // juste.
  districts.active.fill(0);
  rebuildForYear(YEAR_MAX);
  lodTimer = LOD_INTERVAL; // première évaluation dès la première frame
}

export function update(dt, state) {
  applyYear(state.year); // bon marché (dirty-tracking) — voir plus haut

  lodTimer += dt;
  if (lodTimer < LOD_INTERVAL) return;
  lodTimer = 0;
  updateLod(_camera); // repack déjà si des quartiers ont changé d'état actif

  // Correctif de revue (Important 3, tâche 8) : la présence peut aussi changer
  // *à l'intérieur* d'un quartier déjà actif (une construction qui se termine,
  // un re-clad qui s'achève) sans que `districts.active` bouge — ce
  // déclencheur, au même rythme throttlé que la bascule de LOD ci-dessus,
  // couvre ce cas. L'arrondi à l'année entière suffit : BUILD_YEARS et
  // RAZE_YEARS valent tous deux 8, une transition ne peut donc pas se
  // terminer puis redémarrer au sein de la même année entière.
  const roundedYear = Math.round(state.year);
  if (roundedYear !== lastRepackYear) {
    lastRepackYear = roundedYear;
    repackDetail();
  }
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
    year: lastAppliedYear,
  };
}
