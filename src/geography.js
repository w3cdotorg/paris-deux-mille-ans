/**
 * Pure geography for the Paris historical simulation.
 * No dependencies on three.js or the DOM — feeds terrain, buildings and walls.
 *
 * Conventions (shared with every layer): 1 scene unit = 10 m. Origin = parvis
 * de Notre-Dame (48.8530 N, 2.3499 E). x = east, z = south (north is -z).
 */

import { lerp, smoothstep } from "./timeEngine.js";

// ============================================================================
// Deterministic 2D value noise (no Math.random, no module-level state)
// ============================================================================

/**
 * Cheap deterministic hash of two integers into [0, 1).
 * Pure integer arithmetic (no Math.random) so the same (ix, iz) always
 * produces the same value, across calls and across page loads.
 * @param {number} ix
 * @param {number} iz
 * @returns {number} Pseudo-random value in [0, 1)
 */
function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return ((h >>> 0) % 1000000) / 1000000;
}

/**
 * Smooth 2D value noise: bilinear interpolation of the lattice hash,
 * eased with smoothstep. Deterministic function of (x, z).
 * @param {number} x
 * @param {number} z
 * @returns {number} Noise value in [0, 1)
 */
function valueNoise2D(x, z) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const sx = smoothstep(x - x0);
  const sz = smoothstep(z - z0);

  const n00 = hash2(x0, z0);
  const n10 = hash2(x0 + 1, z0);
  const n01 = hash2(x0, z0 + 1);
  const n11 = hash2(x0 + 1, z0 + 1);

  const nx0 = lerp(n00, n10, sx);
  const nx1 = lerp(n01, n11, sx);
  return lerp(nx0, nx1, sz);
}

/**
 * Deterministic noise in [-amplitude, +amplitude], decorrelated per seed so
 * several noise fields (relief, growth years, ...) don't look identical.
 * @param {number} x
 * @param {number} z
 * @param {number} seed - Arbitrary offset decorrelating this field from others
 * @param {number} amplitude
 * @returns {number}
 */
function seededNoise(x, z, seed, amplitude) {
  const n = valueNoise2D((x + seed) * 0.1, (z + seed) * 0.1);
  return (n * 2 - 1) * amplitude;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distance(x, z, cx, cz) {
  const dx = x - cx;
  const dz = z - cz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Whether (x, z) is inside the ellipse centered on (cx, cz) with radii (rx, rz).
 */
function insideEllipse(x, z, cx, cz, rx, rz) {
  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  return dx * dx + dz * dz <= 1;
}

// ============================================================================
// LANDMARKS — shared conventions table
// ============================================================================

export const LANDMARKS = {
  notreDame: { x: 0, z: 0 },
  louvre: { x: -90, z: -84 },
  bastille: { x: 141, z: 0 },
  tourEiffel: { x: -406, z: -60 },
  sacreCoeur: { x: -50, z: -375 },
  chezNous: { x: -131, z: -497 },
  arenes: { x: 22, z: 89 },
  thermes: { x: -43, z: 28 },
  pantheon: { x: -26, z: 76 },
  laDefense: { x: -834, z: -433 },
  // --- sites de monuments ajoutés par la tâche 10 -------------------------
  forum: { x: -30, z: 55 },
  // Sainte-Chapelle : le brief proposait (-5, -3), mais à notre échelle d'île
  // (rx=12, soit 240 m pour ~1 km réel) ce point tombe *dans* la façade
  // occidentale de Notre-Dame (dont la nef s'étend de x=-5,6 à x=+6,2, z ±2,8).
  // Reposée à l'ouest sur l'emplacement réel du palais de la Cité : à -9,2, la
  // chapelle (3,4 de long) laisse ~2 unités de dégagement devant les tours, et
  // l'île y est encore large de |z| ≤ 3,05 — la première capture montrait les
  // deux monuments collés, seule la flèche dorée dépassant du toit voisin.
  sainteChapelle: { x: -9.2, z: -0.6 },
  invalides: { x: -230, z: -20 },
  // --- sites de monuments ajoutés par la tâche 11 --------------------------
  operaGarnier: { x: -135, z: -135 },
  tourMontparnasse: { x: -120, z: 95 },
  // Pont au Change : calé pour franchir *réellement* le bras nord de la Seine
  // rendu par terrain.js. L'axe du fleuve passe par (0,0) puis (-40,-15) : la
  // normale « vers le nord » vaut donc (0,351 ; -0,937), et le pont suit cette
  // normale (voir `rotY` dans monuments.js).
  //
  // Post-v2 : recalé de (-8,6 ; -6,6) à (-7,8 ; -8,73) parce que le bras nord
  // s'élargit désormais à 12 unités autour de l'île (voir
  // `SEINE_ISLAND_HALF_WIDTH`). Mesuré le long de l'axe du pont, la rive de
  // l'île est à -4,15 et le bord nord de l'eau à +8,70 (origine : l'ancien
  // centre) : la travée à franchir vaut 12,85 unités, d'où un tablier de 15,6
  // (`BRIDGE_LEN`) centré au milieu de cette travée, qui prend appui 1,4 unité
  // dans l'île et 1,8 sur la rive droite.
  pontAuChange: { x: -7.8, z: -8.73 },
  // Tour Saint-Jacques (48,8580 N, 2,3488 E environ) : rive droite, au nord
  // du pont au Change, dans l'axe nord-sud de l'île. Repositionnée un peu à
  // l'écart de rueDeRivoli (roads.js) — le tracé Louvre→Bastille passe à
  // ~6 unités d'ici, largement hors du dégagement du site (voir
  // MONUMENT_FOOTPRINTS ci-dessous) — et loin de tout autre monument.
  tourSaintJacques: { x: -8, z: -56 },
};

/**
 * Emprise au sol réellement occupée par les maillages de monuments (tâche 10),
 * tous états confondus, en tant que disque {x, z, r} — la source unique
 * partagée entre `monuments.js` (qui pose les modèles) et `buildings.js` (qui
 * refuse d'y placer un bâtiment procédural). `LANDMARK_CLEARANCE` de
 * buildings.js opère à la maille de la *cellule* (8 unités) : c'est le bon
 * outil pour les grands monuments entourés de jardins, mais pas sur l'île de
 * la Cité, où écarter les 4 cellules de l'île supprimerait aussi les huttes
 * gauloises de -250 (voir la longue note de LANDMARK_CLEARANCE). Ce disque-ci
 * est donc testé bâtiment par bâtiment : la cathédrale garde son parvis net
 * *et* l'île garde ses maisons blotties autour.
 *
 * Rayons dérivés des modèles de `monumentModels.js` (demi-diagonale de
 * l'emprise + petite marge) ; centre légèrement décalé quand le monument n'est
 * pas centré sur son point d'ancrage (Notre-Dame s'étend vers l'est).
 */
export const MONUMENT_FOOTPRINTS = [
  // Rayons = demi-diagonale de la boîte englobante de *tous* les états du site,
  // mesurée sur les modèles eux-mêmes, plus ~0,3 de marge. Le test
  // « emprises : couvrent réellement l'étendue des modèles » de
  // test/monuments.test.js refait ce calcul et échoue si un modèle grandit
  // au-delà de son disque (ou si un disque devient inutilement large).
  { id: "notreDame", x: -0.2, z: 0, r: 7.2 },
  { id: "sainteChapelle", x: -8.8, z: -0.6, r: 2.9 },
  { id: "louvre", x: -96.2, z: -84, r: 15.4 },
  { id: "arenes", x: 21.9, z: 88.7, r: 9.8 },
  { id: "thermes", x: -43.15, z: 28, r: 5.2 },
  { id: "forum", x: -30.2, z: 55, r: 5.6 },
  { id: "pantheon", x: -26, z: 76.9, r: 5.5 },
  { id: "invalides", x: -230, z: -21, r: 8.0 },
  // --- tâche 11 : les grands monuments de fer, de verre et de béton --------
  // Rayons calibrés par le test « emprises : couvrent réellement l'étendue des
  // modèles du site, sans excès » (test/monuments.test.js) — il refait le
  // calcul depuis les modèles et échoue si l'un de ces disques dérive.
  { id: "tourEiffel", x: -406, z: -60, r: 9.6 },
  { id: "sacreCoeur", x: -50, z: -375.4, r: 5.7 },
  { id: "operaGarnier", x: -135, z: -135.1, r: 6.7 },
  { id: "tourMontparnasse", x: -120, z: 95, r: 6.3 },
  // La Défense est le seul site tourné (`rotY`, l'axe historique) : son disque
  // est donc centré *exactement* sur l'ancre du site, seule position invariante
  // par rotation — un disque calé sur la boîte englobante locale se décalerait
  // dès que le quartier pivote.
  { id: "laDefense", x: -834, z: -433, r: 17.0 },
  // Tâche 15 : la tour Saint-Jacques et l'église disparue qui l'accompagnait
  // (jusqu'en 1793). Centre décalé vers l'est de l'ancre du site : la tour
  // (à l'ancre) est plus étroite que la nef + le chevet, qui s'étendent vers
  // l'est — voir monumentModels.js.
  { id: "tourSaintJacques", x: -5.74, z: -56, r: 3.3 },
];

/**
 * Le point (x, z) tombe-t-il dans l'emprise d'un monument ?
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function insideMonumentFootprint(x, z) {
  for (const f of MONUMENT_FOOTPRINTS) {
    const dx = x - f.x;
    const dz = z - f.z;
    if (dx * dx + dz * dz < f.r * f.r) return true;
  }
  return false;
}

// ============================================================================
// RINGS — périphérique (Thiers) and petite ceinture ellipses
// ============================================================================
//
// Chosen rz values (430 / 415, i.e. only 15 units apart) were verified to
// already frame "chez nous" (-131, -497) as required: evaluating the two
// ellipses' northern arc at x = -131 gives z ~= -509.9 (périphérique) and
// z ~= -494.9 (petite ceinture). Chez nous' z = -497 falls strictly between
// them: south of (inside) the périphérique, north of (outside) the petite
// ceinture. See test/geography.test.js for the equivalent runtime check.

export const RINGS = {
  peripherique: { cx: -140, cz: -80, rx: 575, rz: 430 },
  petiteCeinture: { cx: -140, cz: -80, rx: 545, rz: 415 },
};

// ============================================================================
// Couloirs de transport — les deux anneaux ne peuvent pas traverser des maisons
// ============================================================================
//
// La petite ceinture (rails, 1852) et le périphérique (1958) sont rendus par
// `layers/rails.js` *sur* ces deux ellipses, à travers un tissu urbain que
// `buildings.js` a déjà densifié jusqu'au bord du périphérique. Sans
// dégagement, les rails et le ruban d'asphalte passeraient au milieu des
// façades. Ces deux couloirs sont donc la source unique partagée : `rails.js`
// y pose ses ouvrages, `buildings.js` refuse d'y placer un bâtiment.
//
// Volontairement **indépendants de l'année** (comme `MONUMENT_FOOTPRINTS`) :
// `placeCell` n'est appelé qu'une fois, à l'init, pour toute la frise. Ce n'est
// pas un compromis mais la réalité historique — la trouée de la petite
// ceinture n'a jamais été rebâtie, et le couloir du périphérique est l'ancienne
// zone non aedificandi des fortifications de Thiers (1841), qui occupe la même
// ellipse depuis. Avant 1840, ces deux anneaux traversent de toute façon des
// champs (cf. `urbanYear` : la ceinture des faubourgs ne s'urbanise qu'entre
// 1750 et 1900), donc aucun vide n'est visible dans le Paris ancien.

/** Demi-largeur du couloir de la petite ceinture (remblai + double voie). */
export const PETITE_CEINTURE_HALF_WIDTH = 1.5;
/** Demi-largeur du couloir du périphérique (deux chaussées + terre-plein). */
export const PERIPHERIQUE_HALF_WIDTH = 3.4;

/**
 * Le viaduc de Barbès (métro aérien, 1903) : même problème, en ligne droite. Le
 * tracé vit ici parce que `buildings.js` doit dégager son couloir *avant* que
 * `rails.js` n'existe (les bâtiments sont placés une fois pour toute la frise),
 * et parce que geography.js est le module de conventions partagées : `rails.js`
 * lit ces deux points pour poser ses piliers.
 */
export const VIADUC_AXIS = {
  a: { x: -20, z: -338 },
  b: { x: 120, z: -348 },
  halfWidth: 1.6,
};

/** Distance de (x, z) au segment [a, b]. */
function distanceToSegment(x, z, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 === 0 ? 0 : clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
  return distance(x, z, a.x + abx * t, a.z + abz * t);
}

/**
 * Distance approchée de (x, z) à une ellipse, mesurée **le long du rayon**
 * passant par le point. Exacte sur les deux axes, légèrement sur-estimée
 * ailleurs (elle majore la distance perpendiculaire), donc un couloir calculé
 * avec elle n'est jamais plus large que demandé. Suffisant ici : nos deux
 * ellipses sont peu excentriques (575/430 et 545/415).
 * @param {number} x
 * @param {number} z
 * @param {{cx:number, cz:number, rx:number, rz:number}} ring
 * @returns {number} distance en unités (0 = sur l'ellipse)
 */
export function distanceToRing(x, z, ring) {
  const dx = x - ring.cx;
  const dz = z - ring.cz;
  const k = Math.sqrt((dx / ring.rx) * (dx / ring.rx) + (dz / ring.rz) * (dz / ring.rz));
  if (k === 0) return Math.min(ring.rx, ring.rz);
  const radial = Math.hypot(dx, dz);
  return Math.abs(k - 1) * (radial / k);
}

/**
 * Le point (x, z) tombe-t-il dans le couloir de la petite ceinture ou du
 * périphérique ? Consommé par `buildings.js` (un bâtiment par un) et par
 * `rails.js` (qui, lui, y pose ses ouvrages).
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function insideRailCorridor(x, z) {
  if (distanceToRing(x, z, RINGS.petiteCeinture) < PETITE_CEINTURE_HALF_WIDTH) return true;
  if (distanceToRing(x, z, RINGS.peripherique) < PERIPHERIQUE_HALF_WIDTH) return true;
  if (distanceToSegment(x, z, VIADUC_AXIS.a, VIADUC_AXIS.b) < VIADUC_AXIS.halfWidth) return true;
  return false;
}

// ============================================================================
// SEINE_POINTS — river meander control points
// ============================================================================

// Number of leading points in SEINE_POINTS that trace the river across the
// playable map (the brief's 12 verbatim tuples). Everything after this index
// is the off-map return loop described in the brief ("+ boucle hors carte
// vers le NO ... atténué") — a stylized bend around Boulogne, north past
// Neuilly, just west of La Défense, exiting the map to the north-west.
// Renderers that need to fade this tail out (and heightAt's Seine valley,
// which only carves the on-map course) can slice on this constant.
export const SEINE_ONMAP_COUNT = 12;

export const SEINE_POINTS = [
  { x: 300, z: 315 },
  { x: 215, z: 170 },
  { x: 95, z: 60 },
  { x: 30, z: 15 },
  { x: 0, z: 0 },
  { x: -40, z: -15 },
  { x: -95, z: -50 },
  { x: -210, z: -140 },
  { x: -361, z: -122 },
  { x: -456, z: -31 },
  { x: -520, z: 33 },
  { x: -586, z: 292 },
  // --- off-map return loop (hors carte, atténué) ---
  { x: -660, z: 345 }, // Boulogne-like bend, continuing south-west
  { x: -742, z: 300 }, // westernmost bulge of the loop
  { x: -788, z: 110 }, // turning north
  { x: -812, z: -160 }, // flowing north past Neuilly
  { x: -855, z: -395 }, // just west of La Défense (-834, -433)
  { x: -905, z: -560 }, // exiting the map to the north-west
];

// ============================================================================
// ISLANDS — Cité, Saint-Louis, Louviers (died 1843, merged into the right bank)
// ============================================================================

export const ISLANDS = {
  cite: { x: 0, z: 0, rx: 12, rz: 5 },
  // Post-v2 (« l'île est une terre au milieu du fleuve ») : Saint-Louis était
  // en (35, 8), soit 8,6 unités *au nord* de l'axe du fleuve — donc hors de
  // l'eau (demi-largeur 7). Elle se lisait comme une bosse de berge, jamais
  // comme une île : aucun bras au nord, un bras au sud à peine amorcé. Elle est
  // désormais posée SUR l'axe, juste en amont (à l'est) de la Cité, exactement
  // comme le pont Saint-Louis relie les deux dans la réalité. Le point (24 ;
  // 11,5) est sur le tracé de `SEINE_POINTS` entre (30, 15) et (0, 0), à ~0,6
  // unité de la courbe Catmull-Rom réellement rendue par terrain.js ; il laisse
  // ~12 unités d'eau entre les deux îles. Écart assumé avec le WGS84 (l'île
  // réelle serait vers (52, 17)) : le tracé du fleuve, lui, est déjà stylisé et
  // passe à z ≈ 30 pour x = 52 — poser l'île à ses coordonnées « vraies » la
  // remettrait sur la berge, ce que ce correctif corrige précisément.
  saintLouis: { x: 24, z: 11.5, rx: 8, rz: 3 },
  louviers: { x: 120, z: 18, rx: 5, rz: 2, died: 1843 },
};

/** Les deux îles géographiques permanentes (Louviers meurt en 1843, cf. ISLANDS). */
const PERMANENT_ISLANDS = [ISLANDS.cite, ISLANDS.saintLouis];

/**
 * Fraction du rayon normalisé d'une île qui est du **plateau sec** : en deçà,
 * le sol rendu est plat, au franc-bord plein ; au-delà commence le talus de
 * rive, qui plonge sous le plan d'eau vers k = 1 (voir `islandProfile` dans
 * terrain.js, qui importe cette constante). C'est donc la limite géométrique
 * de « où l'on peut poser quelque chose sans qu'il ait les pieds dans l'eau »,
 * partagée par le maillage des îles (terrain.js) et la pose dispersée du bâti
 * insulaire (buildings.js, branche `island` de `placeCell`).
 */
export const ISLAND_PLATEAU_K = 0.82;

/**
 * L'île permanente (Cité ou Saint-Louis) dont la terre ferme contient (x, z),
 * ou `null`. Louviers en est volontairement exclue (bras mort + disparition
 * en 1843, cf. ISLANDS).
 * @param {number} x
 * @param {number} z
 * @returns {{x:number,z:number,rx:number,rz:number}|null}
 */
export function permanentIslandAt(x, z) {
  for (const isl of PERMANENT_ISLANDS) {
    if (insideEllipse(x, z, isl.x, isl.z, isl.rx, isl.rz)) return isl;
  }
  return null;
}

/**
 * Le point (x, z) est-il sur la terre ferme d'une île permanente (Cité ou
 * Saint-Louis) ? Source unique partagée : `buildings.js` s'en sert pour
 * exempter les îles de la marge d'eau, `life.js` pour laisser la foule y
 * marcher, `terrain.js` pour les surélever.
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function isOnPermanentIsland(x, z) {
  return permanentIslandAt(x, z) !== null;
}


// ============================================================================
// Largeur de la Seine — le lit s'élargit autour des îles
// ============================================================================
//
// Post-v2 : le ruban de Seine avait une demi-largeur constante de 7 (14 unités,
// 140 m), et l'île de la Cité — une ellipse 12×5 centrée SUR l'axe — occupait
// à elle seule 6,24 unités de part et d'autre de cet axe (sa demi-largeur
// mesurée le long de la normale au fleuve). Il ne restait donc que 0,76 unité
// d'eau de chaque côté : à l'écran, aucun bras, un unique bourrelet sombre.
//
// La Seine réelle est justement plus large à cet endroit (~250-300 m d'une rive
// à l'autre en comptant l'île, contre ~150 m en aval), donc élargir localement
// est à la fois le correctif visuel ET le fait géographique. À 12 unités de
// demi-largeur, chaque bras mesure ~6 unités (60 m) au plus étroit — lisible
// même sur un écran de téléphone.
//
// L'élargissement est une fonction **de la position**, pas du paramètre de
// courbe : c'est ce qui permet à tous les consommateurs (le ruban d'eau, la
// teinte du sol, les marges du bâti, de la foule, des arbres, des fenêtres
// éclairées) de poser exactement la même question — « où est le bord de
// l'eau ? » — sans qu'aucun ne garde sa propre copie de la géométrie.

/** Demi-largeur du lit de la Seine loin de toute île (largeur totale 14 = 140 m). */
export const SEINE_HALF_WIDTH = 7;
/** Demi-largeur du lit autour de la Cité et de Saint-Louis (largeur totale 24 = 240 m). */
export const SEINE_ISLAND_HALF_WIDTH = 12;
/** Longueur (unités) sur laquelle l'élargissement se résorbe autour d'une île. */
const SEINE_WIDENING_FADE = 18;

/**
 * Influence des îles sur le lit du fleuve en (x, z) : 1 sur toute l'emprise
 * d'une île (plus 2 unités de marge), 0 au-delà de `SEINE_WIDENING_FADE`, avec
 * un `smoothstep` entre les deux — donc un évasement progressif du fleuve,
 * jamais une marche. Mesurée en distance euclidienne au centre de l'île (et non
 * le long de l'axe) : moins cher, et l'écart est invisible puisque seul compte
 * ce que vaut cette fonction *dans* le lit du fleuve.
 * @param {number} x
 * @param {number} z
 * @returns {number} dans [0, 1]
 */
export function seineIslandInfluence(x, z) {
  let best = 0;
  for (const isl of PERMANENT_ISLANDS) {
    const d = distance(x, z, isl.x, isl.z);
    const full = isl.rx + 2;
    const fade = isl.rx + SEINE_WIDENING_FADE;
    const t = smoothstep(clamp((fade - d) / (fade - full), 0, 1));
    if (t > best) best = t;
  }
  return best;
}

/**
 * Demi-largeur du lit de la Seine « en face de » (x, z) : `SEINE_HALF_WIDTH`
 * partout, `SEINE_ISLAND_HALF_WIDTH` autour des deux îles.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function seineHalfWidthAt(x, z) {
  return (
    SEINE_HALF_WIDTH +
    (SEINE_ISLAND_HALF_WIDTH - SEINE_HALF_WIDTH) * seineIslandInfluence(x, z)
  );
}

/**
 * (x, z) est-il dans l'eau (bord de l'eau élargi de `margin`) ? La terre ferme
 * des deux îles n'est jamais « dans l'eau », quelle que soit la marge : c'est
 * ce qui permet aux huttes gauloises, à Notre-Dame et à la foule de tenir sur
 * une île entièrement entourée de fleuve.
 *
 * Loin des îles, `isOverSeineWater(x, z, 2)` équivaut exactement à l'ancien
 * `distanceToSeine(x, z) < 9` de buildings.js (7 + 2) : les marges historiques
 * des consommateurs sont conservées, elles suivent simplement l'élargissement.
 * @param {number} x
 * @param {number} z
 * @param {number} [margin] marge de berge ajoutée à la demi-largeur
 * @returns {boolean}
 */
export function isOverSeineWater(x, z, margin = 0) {
  if (isOnPermanentIsland(x, z)) return false;
  return distanceToSeine(x, z) < seineHalfWidthAt(x, z) + margin;
}

// ============================================================================
// heightAt — relief
// ============================================================================

const HILLS = [
  { x: -50, z: -375, height: 13, sigma: 60 }, // Montmartre
  { x: -26, z: 76, height: 6, sigma: 50 }, // Sainte-Geneviève
  { x: 180, z: -280, height: 10, sigma: 70 }, // Belleville
  { x: -300, z: -90, height: 6, sigma: 55 }, // Chaillot
];

// Post-v1 enhancement: at true scale the hills (13u peak over a sigma-60
// gaussian) were nearly invisible from the aerial ensemble view — "on ne voit
// pas le relief, notamment près de la basilique du Sacré-Cœur". The three
// exaggeration factors below are the *only* place relief gets scaled up;
// heightAt stays the single source of truth, so every consumer that samples
// it (directly or via terrain.js's groundHeightAt) inherits the change for
// free. Hills get the full ×2.6 (Montmartre's 13u peak -> ~34u, a real
// butte); the plain noise gets a mild ×1.5 lift so the base terrain doesn't
// look flat by comparison; the Seine valley is deliberately capped at ×1.3
// so the river banks rise slightly but the river never reads as a canyon.
const RELIEF_EXAGGERATION = 2.6;
const PLAIN_NOISE_EXAGGERATION = 1.5;
const SEINE_RELIEF_EXAGGERATION = 1.3;

const SEINE_TROUGH_DEPTH = 1.5;
const SEINE_TROUGH_SIGMA = 12.5; // ~half of the ~25-unit river width
const SEINE_BANK_HEIGHT = 0.25;
const SEINE_BANK_OFFSET = 16;
const SEINE_BANK_SIGMA = 6;

function gaussianHill(x, z, hill) {
  const d2 = (x - hill.x) * (x - hill.x) + (z - hill.z) * (z - hill.z);
  return hill.height * Math.exp(-d2 / (2 * hill.sigma * hill.sigma));
}

/** Distance from (x, z) to the closest segment of a polyline. */
function distanceToPolyline(x, z, points) {
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const abLen2 = abx * abx + abz * abz;
    let t = abLen2 === 0 ? 0 : ((x - a.x) * abx + (z - a.z) * abz) / abLen2;
    t = clamp(t, 0, 1);
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    const d = distance(x, z, cx, cz);
    if (d < min) min = d;
  }
  return min;
}

/** Riverbed slightly below 0, banks slightly above, fading out with distance. */
function seineRelief(x, z) {
  // Only the on-map course carves the terrain — the off-map return loop is
  // a stylized, attenuated flourish for renderers, not a real valley.
  const onMapPoints = SEINE_POINTS.slice(0, SEINE_ONMAP_COUNT);
  const d = distanceToPolyline(x, z, onMapPoints);
  const trough =
    -SEINE_TROUGH_DEPTH *
    Math.exp(-(d * d) / (2 * SEINE_TROUGH_SIGMA * SEINE_TROUGH_SIGMA));
  const bankD = d - SEINE_BANK_OFFSET;
  const bank =
    SEINE_BANK_HEIGHT *
    Math.exp(-(bankD * bankD) / (2 * SEINE_BANK_SIGMA * SEINE_BANK_SIGMA));
  return trough + bank;
}

// Precomputed once: the on-map slice is what every "is this over water?"
// caller actually wants (see distanceToSeine below) — slicing on every call
// would otherwise allocate a fresh array per query, and this runs per ground
// vertex / per cell.
const SEINE_ONMAP_POINTS = SEINE_POINTS.slice(0, SEINE_ONMAP_COUNT);

/**
 * Distance from (x, z) to the Seine centerline — the on-map meander only
 * (SEINE_ONMAP_COUNT points). Exported so that every layer needing a "is
 * this over water?" test — terrain colouring, the forest mask, the building
 * grid — asks the same question of the same polyline instead of each keeping
 * its own copy of the segment math.
 *
 * Deliberately excludes the off-map return loop: those points are a
 * stylized, attenuated flourish for the river ribbon's tail (see
 * SEINE_POINTS' comment), not a real waterway, but several of them pass
 * close to rendered ground (e.g. near La Défense) — including them here
 * used to paint a phantom second river swoosh across the western map and
 * wrongly exclude buildable land there. Use distanceToSeineFull if a caller
 * genuinely needs the complete polyline including the off-map tail.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function distanceToSeine(x, z) {
  return distanceToPolyline(x, z, SEINE_ONMAP_POINTS);
}

/**
 * Distance from (x, z) to the Seine centerline, full course included (the
 * off-map return loop as well as the on-map meander). Rarely needed — most
 * callers want distanceToSeine's on-map-only behavior above; this exists for
 * the rare case of a renderer that draws the off-map tail itself and needs
 * to know how close it runs to a given point.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function distanceToSeineFull(x, z) {
  return distanceToPolyline(x, z, SEINE_POINTS);
}

/**
 * Scene altitude at (x, z). 0 = Seine water level. Gentle deterministic
 * noise on a base plain, gaussian hills added, Seine valley subtracted.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function heightAt(x, z) {
  let h = seededNoise(x, z, 0, 0.4) * PLAIN_NOISE_EXAGGERATION; // base plain, ±0.6
  for (const hill of HILLS) {
    h += gaussianHill(x, z, hill) * RELIEF_EXAGGERATION;
  }
  h += seineRelief(x, z) * SEINE_RELIEF_EXAGGERATION;
  return h;
}

// ============================================================================
// urbanYear — urbanization field
// ============================================================================

const ROMAN_DISC = { x: 0, z: 60, r: 90 };
const MONTMARTRE_CORE = { x: -50, z: -340, r: 12 };
const CHEZ_NOUS_CORE = { x: -131, z: -497, r: 10 };
const CHEZ_NOUS_INFILL_R = 40; // comblement 1840-1900 around the village core
const LA_DEFENSE_CLUSTER = { x: -834, z: -433, r: 60 };

// Concentric growth bands (radius from the Roman core, biased by direction).
// Calibrated so Philippe-Auguste urbanizes 1100-1300, Charles V 1300-1500,
// Grands Boulevards 1600-1750 and the Thiers/faubourg belt 1750-1900.
const GROWTH_BANDS = [
  { rMin: 90, rMax: 100, yMin: 1100, yMax: 1300 }, // Philippe Auguste
  { rMin: 100, rMax: 180, yMin: 1300, yMax: 1500 }, // Charles V
  { rMin: 180, rMax: 260, yMin: 1500, yMax: 1600 }, // slow Renaissance growth
  { rMin: 260, rMax: 350, yMin: 1600, yMax: 1750 }, // Grands Boulevards
  { rMin: 350, rMax: 600, yMin: 1750, yMax: 1900 }, // Thiers / faubourgs
];

function bandYear(r) {
  const clamped = Math.max(r, GROWTH_BANDS[0].rMin);
  for (const band of GROWTH_BANDS) {
    if (clamped <= band.rMax) {
      const t = (clamped - band.rMin) / (band.rMax - band.rMin);
      return lerp(band.yMin, band.yMax, clamp(t, 0, 1));
    }
  }
  return GROWTH_BANDS[GROWTH_BANDS.length - 1].yMax;
}

/**
 * Deterministic, seeded urbanization year of the cell at (x, z).
 * Île de la Cité = -250 ; Roman rive gauche disc = ~100 ; medieval/modern
 * growth expands concentrically (with directional bias and noise) through
 * the historical wall belts ; satellite villages (Montmartre, Clignancourt/
 * chez nous) urbanize on their own clock ; beyond the périphérique nothing
 * urbanizes except the La Défense cluster (~1975).
 * @param {number} x
 * @param {number} z
 * @returns {number} Year (may be Infinity for land that never urbanizes)
 */
export function urbanYear(x, z) {
  const { peripherique } = RINGS;
  if (
    !insideEllipse(
      x,
      z,
      peripherique.cx,
      peripherique.cz,
      peripherique.rx,
      peripherique.rz
    )
  ) {
    const dDefense = distance(x, z, LA_DEFENSE_CLUSTER.x, LA_DEFENSE_CLUSTER.z);
    if (dDefense <= LA_DEFENSE_CLUSTER.r) {
      const year = 1975 + seededNoise(x, z, 2000.3, 15);
      return clamp(year, 1960, 2000);
    }
    return Infinity;
  }

  if (insideEllipse(x, z, ISLANDS.cite.x, ISLANDS.cite.z, ISLANDS.cite.rx, ISLANDS.cite.rz)) {
    return -250;
  }

  const dMontmartre = distance(x, z, MONTMARTRE_CORE.x, MONTMARTRE_CORE.z);
  if (dMontmartre <= MONTMARTRE_CORE.r) {
    const year = 1300 + seededNoise(x, z, 3000.9, 40);
    return clamp(year, 1250, 1350);
  }

  const dChezNous = distance(x, z, CHEZ_NOUS_CORE.x, CHEZ_NOUS_CORE.z);
  if (dChezNous <= CHEZ_NOUS_CORE.r) {
    const year = 1780 + seededNoise(x, z, 4000.5, 40);
    return clamp(year, 1750, 1900);
  }
  if (dChezNous <= CHEZ_NOUS_INFILL_R) {
    // Comblement: the fields between the village core and the surrounding
    // annexed neighborhood fill in progressively from 1840 to 1900.
    const t = (dChezNous - CHEZ_NOUS_CORE.r) / (CHEZ_NOUS_INFILL_R - CHEZ_NOUS_CORE.r);
    return Math.round(lerp(1840, 1900, t));
  }

  const dRoman = distance(x, z, ROMAN_DISC.x, ROMAN_DISC.z);
  if (dRoman <= ROMAN_DISC.r) {
    const year = 100 + seededNoise(x, z, 5000.1, 40);
    return Math.round(clamp(year, 50, 250));
  }

  // General medieval/modern growth: the west and the right bank push
  // outward faster (biais directionnel), so their effective radius shrinks.
  let bias = 1;
  if (x < 0) bias *= 1.15; // l'ouest
  if (z < 0) bias *= 1.1; // la rive droite (nord de la Seine)
  const effectiveRadius = dRoman / bias;

  const year = bandYear(effectiveRadius) + seededNoise(x, z, 1000.7, 80);
  return Math.round(year);
}
