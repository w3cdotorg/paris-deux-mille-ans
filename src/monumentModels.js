/**
 * monumentModels.js — les monuments de Paris, construits à la main.
 *
 * Chaque constructeur renvoie un `THREE.Group` de primitives (boîtes,
 * cylindres, cônes, voûtes, dômes). Priorité absolue à la **silhouette** : vu
 * du ciel, un enfant de 4 ans doit reconnaître « l'église avec les deux tours »
 * ou « la pyramide en verre » avant de voir le moindre détail. Les proportions
 * suivent les vraies dimensions (1 unité = 10 m) quand elles servent la
 * lecture, et sont volontairement forcées quand elles ne suffisent pas (les
 * murs sont plus épais, les flèches plus larges qu'en réalité, sinon elles
 * disparaissent à l'échelle de la vue d'ensemble).
 *
 * ============================================================================
 * Deux mécanismes portés par `userData`, lus par `layers/monuments.js` :
 *
 *  - **Étagement (`stage: [a, b]`)** : chaque pièce indique dans quelle
 *    fenêtre de la présence [0,1] du chantier elle apparaît. Notre-Dame en est
 *    la raison d'être : la nef monte d'abord (0 → 0,35), le transept et le
 *    chevet suivent, la façade ensuite, et les **tours terminent** (0,72 → 1),
 *    soit ~1293-1343 pour un chantier `born: 1163, buildYears: 180`. Sans
 *    `stage`, une pièce est présente dès que la présence est > 0.
 *  - **Animation (`spin`)** : un sous-groupe marqué `spin: {axis, speed, phase}`
 *    tourne avec `state.time` — les 2 grues en bois du chantier de Notre-Dame
 *    (axe Y) et les 4 roues à aubes du pont au Change (axe X, dans le sens du
 *    courant). Immobiles sous `reducedMotion`.
 *
 * Chaque pièce porte aussi `{ y0, h, sx, sz }` (base, hauteur, empreinte) pour
 * que le layer puisse la faire *pousser depuis le sol* : `scale.y = h * t` et
 * `position.y = y0 + h * t / 2`. Les pièces inclinées (arcs-boutants) ou non
 * prismatiques (dômes) portent `grow: false` et apparaissent d'un coup.
 *
 * ============================================================================
 * Géométries : un petit jeu de primitives *unitaires* partagées (boîte 1×1×1,
 * cylindres à 6/8/12/16 côtés, cônes, prisme à deux pentes, voûte en berceau,
 * demi-sphère), instanciées par `mesh.scale` — donc une poignée de buffers pour
 * tous les monuments, et un `scale.y` de croissance qui compose directement
 * avec l'échelle de la pièce.
 */

import * as THREE from "three";

// ============================================================================
// Palette — famille commune (pierre calcaire chaude parisienne), chaque
// monument se distinguant par sa silhouette et un accent : brique/tuile
// romaine, plomb bleuté gothique, or des dômes, verre de la pyramide.
// ============================================================================

export const MONUMENT_COLORS = {
  stone: 0xdccfb2, // calcaire de Paris
  stoneLight: 0xe9e0c8, // pierre neuve (Sainte-Chapelle, Panthéon)
  stoneShadow: 0xc2b795,
  ruin: 0x847a6b, // pierre patinée des ruines (thermes, arènes du square)
  romanStucco: 0xe3d9c2,
  romanTile: 0xb0603c,
  romanBrick: 0xa96a4c,
  lead: 0x77848c, // couverture de plomb (toits gothiques)
  leadNew: 0x93a1a8, // plomb neuf (flèche restaurée 2024)
  slate: 0x4e5766,
  tile: 0x8f5a43,
  wood: 0x6d5236,
  woodLight: 0x8a6a44,
  plaster: 0xd9ccb1,
  plasterPink: 0xd6bfa8,
  gold: 0xd8ac35,
  glassDark: 0x54617e, // vitraux / rosace vus de loin
  glass: 0xa9cddc,
  sand: 0xd6c9a5,
  grass: 0x6f8f52,
  metal: 0x9aa0a6, // échafaudage 2019-2024
  // --- tâche 11 -----------------------------------------------------------
  iron: 0x7a5f47, // « brun tour Eiffel » (la vraie teinte du fer peint)
  ironDark: 0x5c4634, // treillis dans l'ombre, membrures fines
  travertine: 0xf2ede2, // le calcaire de Château-Landon du Sacré-Cœur, qui blanchit
  travertineShadow: 0xdcd6c6,
  copper: 0x6f9f88, // cuivre oxydé (toits de l'Opéra)
  operaStone: 0xe3d6b9,
  darkGlass: 0x3b414b, // Tour Montparnasse
  darkGlassLight: 0x4c545f,
  towerGlassA: 0x7e8d9e, // La Défense — trois verres pour varier le cluster
  towerGlassB: 0x67788a,
  towerGlassC: 0x94a1ac,
  concrete: 0xdcd8d0, // marbre blanc de la Grande Arche
};

// Matériaux partagés : créés une fois, réutilisés par tous les modèles.
const MATS = {};

function mat(key, extra) {
  if (MATS[key]) return MATS[key];
  const color = MONUMENT_COLORS[key];
  MATS[key] = new THREE.MeshLambertMaterial({ color, ...extra });
  return MATS[key];
}

/** Or « qui brille » : Lambert + une pointe d'émissif (Invalides, flèches). */
function goldMat() {
  if (MATS.goldEmissive) return MATS.goldEmissive;
  MATS.goldEmissive = new THREE.MeshLambertMaterial({
    color: MONUMENT_COLORS.gold,
    emissive: 0x4a3405,
  });
  return MATS.goldEmissive;
}

/** Verre translucide de la pyramide (1988). */
function glassMat() {
  if (MATS.glassTranslucent) return MATS.glassTranslucent;
  MATS.glassTranslucent = new THREE.MeshPhongMaterial({
    color: MONUMENT_COLORS.glass,
    transparent: true,
    // 0,58 et non 0,42 : à 0,42, vue du ciel au-dessus d'un sol crème clair, la
    // pyramide disparaissait presque (constat de capture task10-louvre-2026).
    opacity: 0.58,
    shininess: 90,
    specular: 0xffffff,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return MATS.glassTranslucent;
}

// ============================================================================
// Primitives unitaires partagées
// ============================================================================

const GEO = {};

function unitBox() {
  if (!GEO.box) GEO.box = new THREE.BoxGeometry(1, 1, 1);
  return GEO.box;
}

/** Cylindre unitaire (diamètre 1, hauteur 1) à `segs` côtés. */
function unitCyl(segs) {
  const key = `cyl${segs}`;
  if (!GEO[key]) GEO[key] = new THREE.CylinderGeometry(0.5, 0.5, 1, segs);
  return GEO[key];
}

/** Coque cylindrique ouverte (gradins d'amphithéâtre), éventuellement partielle. */
function unitShell(segs, thetaLength) {
  const key = `shell${segs}_${Math.round(thetaLength * 100)}`;
  if (!GEO[key]) {
    GEO[key] = new THREE.CylinderGeometry(0.5, 0.5, 1, segs, 1, true, 0, thetaLength);
  }
  return GEO[key];
}

/** Cône unitaire (diamètre de base 1, hauteur 1). */
function unitCone(segs) {
  const key = `cone${segs}`;
  if (!GEO[key]) GEO[key] = new THREE.ConeGeometry(0.5, 1, segs);
  return GEO[key];
}

/** Demi-sphère unitaire : rayon 0,5 (donc diamètre 1, hauteur 0,5). */
function unitDome(segs) {
  const key = `dome${segs}`;
  if (!GEO[key]) {
    GEO[key] = new THREE.SphereGeometry(0.5, segs, Math.max(4, segs / 2), 0, Math.PI * 2, 0, Math.PI / 2);
  }
  return GEO[key];
}

/**
 * Toit à deux pentes unitaire : base 1×1 dans le plan (x, z), faîtage à y = 1
 * le long de x. Construit à la main (aucun addon de fusion), non indexé, donc
 * `computeVertexNormals` donne bien des normales *par face* — le rendu
 * facetté low-poly voulu.
 */
function unitGable() {
  if (GEO.gable) return GEO.gable;
  const A = [-0.5, 0, -0.5];
  const B = [0.5, 0, -0.5];
  const C = [0.5, 0, 0.5];
  const D = [-0.5, 0, 0.5];
  const R0 = [-0.5, 1, 0];
  const R1 = [0.5, 1, 0];
  const pos = [];
  const push = (...pts) => {
    for (const p of pts) pos.push(p[0], p[1], p[2]);
  };
  // pente nord, pente sud (quads), puis les deux pignons (triangles)
  push(B, A, R0, B, R0, R1);
  push(D, C, R1, D, R1, R0);
  push(A, D, R0);
  push(C, B, R1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  GEO.gable = g;
  return g;
}

/**
 * Voûte en berceau unitaire : demi-cylindre d'axe x, longueur 1 (x ∈
 * [-0.5, 0.5]), largeur 1 (z ∈ [-0.5, 0.5]), montant de y = 0 à y = 0,5.
 * Mettre `h` à l'échelle double de la hauteur d'arc voulue (voir `vault`).
 */
function unitVault() {
  if (GEO.vault) return GEO.vault;
  // thetaStart 0 / thetaLength π => la moitié x > 0 du cylindre ; après
  // rotateZ(+90°), (x, y) -> (-y, x), donc cette moitié passe en y > 0 (l'arc
  // s'ouvre vers le haut) et l'axe du cylindre s'aligne sur +x.
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, false, 0, Math.PI);
  g.rotateZ(Math.PI / 2);
  GEO.vault = g;
  return g;
}

// ============================================================================
// Helpers de pose — chaque pièce mémorise sa base et sa hauteur
// ============================================================================

/**
 * Pose une pièce dans le groupe.
 *
 * Deux ancrages, parce que les primitives de three.js ne s'accordent pas :
 * boîte/cylindre/cône sont *centrés* sur leur origine (y ∈ [-0,5, 0,5]) tandis
 * que le toit à deux pentes, la voûte et la demi-sphère sont posés *sur leur
 * base* (y ∈ [0, 1] ou [0, 0,5]). `anchor` mémorise lequel, pour que la pousse
 * du layer (`scale.y = h·t`) reste correcte dans les deux cas. `yc` force une
 * position absolue (pièce flottante : rosace, flèche de grue) — elle ne pousse
 * alors pas.
 *
 * @param {THREE.Group} g
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} material
 * @param {object} o - {x, z, y0, w, h, d, rotX, rotY, rotZ, stage, grow, yc, anchor}
 * @returns {THREE.Mesh}
 */
function piece(g, geometry, material, o) {
  const m = new THREE.Mesh(geometry, material);
  const w = o.w ?? 1;
  const h = o.h ?? 1;
  const d = o.d ?? 1;
  const x = o.x ?? 0;
  const z = o.z ?? 0;
  const y0 = o.y0 ?? 0;
  const floating = o.yc !== undefined;
  const anchor = floating ? "fixed" : o.anchor ?? "center";
  m.scale.set(w, h, d);
  m.position.set(x, floating ? o.yc : anchor === "base" ? y0 : y0 + h / 2, z);
  if (o.rotY) m.rotation.y = o.rotY;
  if (o.rotX) m.rotation.x = o.rotX;
  if (o.rotZ) m.rotation.z = o.rotZ;
  m.userData = {
    y0,
    h,
    sx: w,
    sz: d,
    anchor,
    stage: o.stage ?? null,
    // `temporary` : la pièce n'existe *que* dans sa fenêtre `stage` et
    // disparaît au-delà — c'est ce qui distingue un échafaudage (qu'on démonte)
    // d'une nef (qui, une fois montée, reste montée). Sans ce drapeau, `stage`
    // veut seulement dire « commence à pousser à a, finie à b ».
    temporary: o.temporary === true,
    // Une pièce inclinée ou flottante ne peut pas « pousser » par un simple
    // scale.y autour de sa base : elle apparaît d'un coup.
    grow: o.grow !== false && !o.rotX && !o.rotZ && !floating,
  };
  g.add(m);
  return m;
}

const resolveMat = (m) => (typeof m === "string" ? mat(m) : m);

const box = (g, m, o) => piece(g, unitBox(), resolveMat(m), o);
const cyl = (g, m, o) => piece(g, unitCyl(o.segs ?? 12), resolveMat(m), o);
const cone = (g, m, o) => piece(g, unitCone(o.segs ?? 8), resolveMat(m), o);

/** Toit à deux pentes : géométrie posée sur sa base (y ∈ [0, 1]). */
const gable = (g, m, o) => piece(g, unitGable(), resolveMat(m), { ...o, anchor: "base" });

/** Voûte : `h` est la hauteur d'arc réelle (la géométrie unitaire monte à 0,5). */
const vault = (g, m, o) => piece(g, unitVault(), resolveMat(m), { ...o, h: o.h * 2, anchor: "base" });

/** Dôme : `h` est la hauteur réelle (la géométrie unitaire monte à 0,5). */
const dome = (g, m, o) =>
  piece(g, unitDome(o.segs ?? 16), resolveMat(m), { ...o, h: o.h * 2, anchor: "base" });

/** Coque de gradins elliptique (amphithéâtre). */
function shell(g, m, o) {
  return piece(g, unitShell(o.segs ?? 24, o.thetaLength ?? Math.PI * 2), resolveMat(m), o);
}

/** Colonnade : `n` colonnes régulièrement espacées le long de x. */
function colonnade(g, matKey, { x0, x1, z, y0, h, r, n, stage, segs = 6 }) {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    cyl(g, matKey, { x: x0 + (x1 - x0) * t, z, y0, w: r * 2, h, d: r * 2, segs, stage });
  }
}

/** Sous-groupe animé (grue, roue). */
function spinner(parent, { x, y, z, axis, speed, phase = 0, stage = null }) {
  const s = new THREE.Group();
  s.position.set(x, y, z);
  s.userData = { spin: { axis, speed, phase }, stage };
  parent.add(s);
  return s;
}

function newModel(id) {
  const g = new THREE.Group();
  g.name = `monument_${id}`;
  g.visible = false;
  return g;
}

// ============================================================================
// NOTRE-DAME — les quatre âges du même lieu
// ============================================================================

/**
 * Temple gallo-romain (150-540) : podium, péristyle de colonnes, cella,
 * toit à deux pentes de tuiles romaines. Axe est-ouest comme la cathédrale
 * qui lui succédera.
 */
export function buildTempleRomain() {
  const g = newModel("templeRomain");
  // podium + emmarchement
  box(g, "romanStucco", { x: 0, z: 0, y0: 0, w: 5.0, h: 0.55, d: 3.4 });
  box(g, "stoneShadow", { x: -2.7, z: 0, y0: 0, w: 0.45, h: 0.3, d: 3.0 });
  // colonnes : 6 en façade (ouest), 3 de chaque côté
  for (let i = 0; i < 6; i++) {
    const z = -1.4 + (i / 5) * 2.8;
    cyl(g, "romanStucco", { x: -2.3, z, y0: 0.55, w: 0.32, h: 1.7, d: 0.32, segs: 6 });
  }
  for (const z of [-1.4, 1.4]) {
    for (const x of [-0.9, 0.5, 1.9]) {
      cyl(g, "romanStucco", { x, z, y0: 0.55, w: 0.32, h: 1.7, d: 0.32, segs: 6 });
    }
  }
  // cella
  box(g, "romanStucco", { x: 0.4, z: 0, y0: 0.55, w: 3.2, h: 1.9, d: 2.2 });
  // entablement + toit
  box(g, "stoneLight", { x: 0, z: 0, y0: 2.25, w: 5.0, h: 0.28, d: 3.4 });
  gable(g, "romanTile", { x: 0, z: 0, y0: 2.53, w: 5.0, h: 0.95, d: 3.4 });
  return g;
}

/**
 * Basilique Saint-Étienne (540-1163) : longue nef basse romane, bas-côtés,
 * absidiole en demi-cylindre à l'est, clocher trapu à l'ouest.
 */
export function buildBasilique() {
  const g = newModel("basilique");
  // nef
  box(g, "stone", { x: 0, z: 0, y0: 0, w: 6.8, h: 1.9, d: 2.6 });
  gable(g, "tile", { x: 0, z: 0, y0: 1.9, w: 6.8, h: 1.1, d: 2.6 });
  // bas-côtés
  for (const z of [-1.9, 1.9]) {
    box(g, "stoneShadow", { x: 0, z, y0: 0, w: 6.8, h: 1.15, d: 1.2 });
    gable(g, "tile", { x: 0, z, y0: 1.15, w: 6.8, h: 0.45, d: 1.2 });
  }
  // chevet arrondi
  cyl(g, "stone", { x: 3.6, z: 0, y0: 0, w: 2.6, h: 1.7, d: 2.6, segs: 12 });
  cone(g, "tile", { x: 3.6, z: 0, y0: 1.7, w: 3.0, h: 1.0, segs: 12 });
  // clocher-porche
  box(g, "stone", { x: -3.9, z: 0, y0: 0, w: 1.6, h: 3.3, d: 1.6 });
  cone(g, "tile", { x: -3.9, z: 0, y0: 3.3, w: 2.0, h: 1.0, segs: 4 });
  return g;
}

/**
 * Cathédrale gothique (chantier 1163-1343, puis pour toujours).
 *
 * Étagement (`stage`) : nef → bas-côtés → arcs-boutants → transept → chevet →
 * façade → **tours en dernier**. Deux grues en bois tournent tant que la
 * présence est < 1, et un échafaudage de chantier les accompagne.
 */
export function buildCathedraleGothique() {
  const g = newModel("cathedraleGothique");
  const NAVE_H = 4.3;
  const ROOF_TOP = NAVE_H + 1.5;

  // --- nef (x de -5,05 à +3,2) --------------------------------------------
  box(g, "stone", { x: -0.9, z: 0, y0: 0, w: 8.25, h: NAVE_H, d: 3.0, stage: [0, 0.32] });
  gable(g, "lead", { x: -0.9, z: 0, y0: NAVE_H, w: 8.25, h: 1.5, d: 3.0, stage: [0.28, 0.42] });

  // --- bas-côtés ----------------------------------------------------------
  for (const z of [-2.15, 2.15]) {
    box(g, "stoneShadow", { x: -0.9, z, y0: 0, w: 8.25, h: 2.5, d: 1.3, stage: [0.06, 0.38] });
    gable(g, "lead", { x: -0.9, z, y0: 2.5, w: 8.25, h: 0.5, d: 1.3, stage: [0.1, 0.42] });
  }

  // --- arcs-boutants : la signature de Notre-Dame vue du ciel -------------
  // Un pilier vertical dehors + une volée inclinée qui vient épauler le haut
  // de la nef. `rotX` => `grow: false` (apparition franche, pas de pousse).
  for (let i = 0; i < 5; i++) {
    const x = -3.4 + i * 1.7;
    for (const side of [-1, 1]) {
      // Le pilier extérieur, planté au sol...
      box(g, "stoneShadow", {
        x,
        z: side * 3.2,
        y0: 0,
        w: 0.4,
        h: 3.2,
        d: 0.55,
        stage: [0.34, 0.52],
      });
      // ... et la volée inclinée qui va épauler le haut de la nef. Dalle mince
      // *portée sur sa longueur locale z* (2,1 unités) et basculée autour de x
      // de ±0,59 rad : elle relie exactement (z = 3,2 ; y = 3,2) au pilier à
      // (z = 1,5 ; y = 4,3) sur le mur haut. Une dalle inclinée sans contact
      // aux deux bouts lisait comme une planche jetée là (constat de capture).
      box(g, "stone", {
        x,
        z: side * 2.35,
        y0: 0,
        w: 0.3,
        h: 0.24,
        d: 2.1,
        yc: 3.78,
        rotX: side * 0.59,
        stage: [0.36, 0.54],
      });
      // pinacle sur le pilier
      cone(g, "stoneLight", {
        x,
        z: side * 3.2,
        y0: 3.2,
        w: 0.5,
        h: 0.7,
        segs: 6,
        stage: [0.4, 0.56],
      });
    }
  }

  // --- transept (bras nord-sud) -------------------------------------------
  box(g, "stone", { x: 1.3, z: 0, y0: 0, w: 1.9, h: NAVE_H, d: 5.9, stage: [0.4, 0.55] });
  gable(g, "lead", { x: 1.3, z: 0, y0: NAVE_H, w: 5.9, h: 1.5, d: 1.9, rotY: Math.PI / 2, stage: [0.44, 0.58] });

  // --- chevet (est) -------------------------------------------------------
  // Chevet à 7 pans, plus étroit et plus bas que la nef : à 3,0 de diamètre et
  // 3,9 de haut il lisait comme un silo posé derrière la cathédrale (constat de
  // capture) ; à 2,5 il redevient une absidiole qui prolonge la nef.
  cyl(g, "stone", { x: 3.5, z: 0, y0: 0, w: 2.5, h: 3.5, d: 2.5, segs: 7, stage: [0.46, 0.62] });
  cone(g, "lead", { x: 3.5, z: 0, y0: 3.5, w: 2.75, h: 1.1, segs: 7, stage: [0.5, 0.64] });

  // --- façade occidentale -------------------------------------------------
  box(g, "stone", { x: -4.55, z: 0, y0: 0, w: 1.0, h: 4.6, d: 3.0, stage: [0.55, 0.72] });
  // rosace : disque sombre plaqué sur la façade (axe sur x => rotZ)
  cyl(g, "glassDark", {
    x: -5.08,
    z: 0,
    y0: 0,
    w: 1.5,
    h: 0.12,
    d: 1.5,
    segs: 12,
    yc: 3.1,
    rotZ: Math.PI / 2,
    stage: [0.66, 0.74],
  });
  // galerie des rois
  box(g, "stoneLight", { x: -4.9, z: 0, y0: 2.2, w: 0.36, h: 0.3, d: 3.0, stage: [0.6, 0.72] });

  // --- LES DEUX TOURS, en dernier ----------------------------------------
  // 7,4 unités (74 m) : légèrement au-dessus des 69 m réels, pour que les tours
  // dominent franchement le faîtage (5,8) depuis la vue aérienne — la lecture
  // « l'église aux deux tours » passe avant la cote exacte.
  for (const z of [-1.1, 1.1]) {
    box(g, "stone", { x: -4.55, z, y0: 0, w: 1.6, h: 7.4, d: 1.6, stage: TOWER_STAGE });
    box(g, "stoneLight", { x: -4.55, z, y0: 7.4, w: 1.85, h: 0.38, d: 1.85, stage: [0.9, 1.0] });
  }

  // --- chantier : 2 grues en bois qui tournent + échafaudages -------------
  // Visibles tant que le chantier n'est pas fini (voir CRANE_STAGE).
  // Les socles restent dans l'emprise du site (MONUMENT_FOOTPRINTS.notreDame,
  // r = 7,2) pour ne pas écraser une maison ; seules les flèches des grues
  // débordent, et elles surplombent alors les toits, 45 m plus haut.
  buildCrane(g, { x: 4.7, z: -2.2, speed: 0.16, phase: 0.0, mastH: 5.2 });
  buildCrane(g, { x: -5.1, z: 2.1, speed: -0.12, phase: 1.7, mastH: 4.6 });
  buildScaffoldCluster(g, { x: -5.0, z: -2.3, w: 1.6, d: 1.4, h: 5.2 });
  buildScaffoldCluster(g, { x: 4.2, z: 2.4, w: 1.4, d: 1.2, h: 4.0 });

  return g;
}

/** Fenêtre de présence pendant laquelle grues/échafaudages sont visibles. */
export const CHANTIER_STAGE = [0.02, 0.985];

/**
 * Fenêtre de présence des **deux tours** de Notre-Dame : elles sont la dernière
 * pièce du chantier. Pour `born: 1163, buildYears: 180`, cela place leur montée
 * entre ~1293 et ~1341 — la lecture voulue par le brief (« les tours émergent
 * en dernier, achevées vers 1250-1345 »). Exportée pour être vérifiable.
 */
export const TOWER_STAGE = [0.72, 0.99];

/**
 * Une grue de chantier médiévale : plateau, mât, flèche inclinée, contre-flèche
 * lestée, câble et roue de treuil. Le sous-groupe tourne autour de Y.
 */
function buildCrane(parent, { x, z, speed, phase, mastH }) {
  const s = spinner(parent, { x, y: 0, z, axis: "y", speed, phase, stage: CHANTIER_STAGE });
  // plateau + mât
  box(s, "wood", { x: 0, z: 0, y0: 0, w: 1.5, h: 0.22, d: 1.5 });
  cyl(s, "wood", { x: 0, z: 0, y0: 0.22, w: 0.26, h: mastH, d: 0.26, segs: 6 });
  // haubans
  for (const sign of [-1, 1]) {
    box(s, "woodLight", {
      x: sign * 0.45,
      z: 0,
      y0: 0,
      w: 0.12,
      h: mastH * 0.95,
      d: 0.12,
      yc: mastH * 0.5,
      rotZ: sign * 0.18,
    });
  }
  // flèche + contre-flèche (inclinées => grow:false)
  box(s, "woodLight", {
    x: 1.25,
    z: 0,
    y0: 0,
    w: 2.9,
    h: 0.16,
    d: 0.2,
    yc: mastH * 0.92,
    rotZ: 0.3,
  });
  box(s, "wood", { x: -0.8, z: 0, y0: 0, w: 1.5, h: 0.16, d: 0.18, yc: mastH * 0.78, rotZ: -0.12 });
  box(s, "wood", { x: -1.5, z: 0, y0: 0, w: 0.4, h: 0.4, d: 0.4, yc: mastH * 0.74 });
  // câble + crochet
  box(s, "woodLight", { x: 2.5, z: 0, y0: 0, w: 0.06, h: 2.2, d: 0.06, yc: mastH * 0.92 - 1.1 });
  box(s, "wood", { x: 2.5, z: 0, y0: 0, w: 0.36, h: 0.24, d: 0.36, yc: mastH * 0.92 - 2.3 });
  // roue de treuil (les ouvriers marchaient dedans)
  cyl(s, "woodLight", {
    x: 0,
    z: 0.55,
    y0: 0,
    w: 1.1,
    h: 0.3,
    d: 1.1,
    segs: 8,
    yc: 0.75,
    rotZ: Math.PI / 2,
  });
  return s;
}

/**
 * Petit bouquet d'échafaudage : 4 poteaux, 3 étages de lisses et un plancher de
 * travail en haut. Tout est `temporary` : démonté avec la dernière pierre.
 */
function buildScaffoldCluster(parent, { x, z, w, d, h }) {
  const chantier = { stage: CHANTIER_STAGE, temporary: true };
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(parent, "woodLight", {
        x: x + (sx * w) / 2,
        z: z + (sz * d) / 2,
        y0: 0,
        w: 0.1,
        h,
        d: 0.1,
        ...chantier,
      });
    }
  }
  for (let i = 1; i <= 3; i++) {
    box(parent, "wood", { x, z, y0: (h * i) / 4, w: w + 0.1, h: 0.07, d: 0.07, ...chantier });
    box(parent, "wood", { x, z, y0: (h * i) / 4, w: 0.07, h: 0.07, d: d + 0.1, ...chantier });
  }
  // plancher de travail (volontairement court : débordant, il lisait comme une
  // table posée sur pilotis au-dessus des toits)
  box(parent, "wood", { x, z, y0: h - 0.1, w: w + 0.08, h: 0.1, d: d + 0.08, ...chantier });
}

/**
 * Flèche de la croisée du transept (Viollet-le-Duc, 1859 ; reconstruite 2024).
 * Posée sur le faîtage : socle octogonal, flèche élancée, 4 pinacles, coq.
 * @param {{bright?: boolean}} [opts] - `bright` = plomb neuf (2024)
 */
export function buildFleche(opts = {}) {
  const g = newModel(opts.bright ? "flecheNeuve" : "fleche");
  const leadKey = opts.bright ? "leadNew" : "lead";
  const BASE = 5.8; // faîtage de la nef
  box(g, leadKey, { x: 1.3, z: 0, y0: BASE, w: 1.15, h: 0.5, d: 1.15 });
  cyl(g, leadKey, { x: 1.3, z: 0, y0: BASE + 0.5, w: 1.0, h: 0.7, d: 1.0, segs: 8 });
  cone(g, leadKey, { x: 1.3, z: 0, y0: BASE + 1.2, w: 0.95, h: 2.6, segs: 8 });
  for (const [dx, dz] of [
    [-0.5, -0.5],
    [-0.5, 0.5],
    [0.5, -0.5],
    [0.5, 0.5],
  ]) {
    cone(g, leadKey, { x: 1.3 + dx, z: dz, y0: BASE + 0.5, w: 0.3, h: 0.9, segs: 6 });
  }
  // le coq doré du sommet
  cone(g, goldMat(), { x: 1.3, z: 0, y0: BASE + 3.8, w: 0.22, h: 0.45, segs: 6 });
  return g;
}

export function buildFlecheNeuve() {
  return buildFleche({ bright: true });
}

/**
 * Échafaudage de la restauration (2019-2024) : cage métallique discrète sur la
 * croisée, là où la flèche a brûlé.
 */
export function buildEchafaudage() {
  const g = newModel("echafaudage");
  const BASE = 5.6;
  const H = 2.6;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(g, "metal", { x: 1.3 + sx * 0.75, z: sz * 0.75, y0: BASE, w: 0.11, h: H, d: 0.11 });
    }
  }
  for (let i = 0; i <= 3; i++) {
    const y = BASE + (H * i) / 3;
    box(g, "metal", { x: 1.3, z: -0.75, y0: y, w: 1.6, h: 0.07, d: 0.07 });
    box(g, "metal", { x: 1.3, z: 0.75, y0: y, w: 1.6, h: 0.07, d: 0.07 });
    box(g, "metal", { x: 0.55, z: 0, y0: y, w: 0.07, h: 0.07, d: 1.6 });
    box(g, "metal", { x: 2.05, z: 0, y0: y, w: 0.07, h: 0.07, d: 1.6 });
  }
  return g;
}

// ============================================================================
// LOUVRE — forteresse, palais, pyramide
// ============================================================================

/**
 * Forteresse de Philippe Auguste (1190-1566) : enceinte carrée à 4 tours
 * d'angle, châtelet d'entrée, et la Grosse Tour (donjon) au milieu de la cour.
 */
export function buildLouvreForteresse() {
  const g = newModel("louvreForteresse");
  const R = 5.0; // demi-côté de l'enceinte
  const WH = 2.3;
  // courtines
  box(g, "stoneShadow", { x: 0, z: -R, y0: 0, w: R * 2, h: WH, d: 0.6 });
  box(g, "stoneShadow", { x: 0, z: R, y0: 0, w: R * 2, h: WH, d: 0.6 });
  box(g, "stoneShadow", { x: -R, z: 0, y0: 0, w: 0.6, h: WH, d: R * 2 });
  box(g, "stoneShadow", { x: R, z: 0, y0: 0, w: 0.6, h: WH, d: R * 2 });
  // tours d'angle
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cyl(g, "stone", { x: sx * R, z: sz * R, y0: 0, w: 1.9, h: 2.9, d: 1.9, segs: 10 });
      cone(g, "slate", { x: sx * R, z: sz * R, y0: 2.9, w: 2.2, h: 1.1, segs: 10 });
    }
  }
  // châtelet d'entrée (à l'est, vers la ville)
  for (const sz of [-1, 1]) {
    cyl(g, "stone", { x: R, z: sz * 1.3, y0: 0, w: 1.4, h: 2.7, d: 1.4, segs: 10 });
    cone(g, "slate", { x: R, z: sz * 1.3, y0: 2.7, w: 1.7, h: 0.9, segs: 10 });
  }
  // la Grosse Tour
  cyl(g, "stone", { x: -0.6, z: 0, y0: 0, w: 3.6, h: 4.2, d: 3.6, segs: 12 });
  box(g, "stoneLight", { x: -0.6, z: 0, y0: 4.2, w: 4.0, h: 0.3, d: 4.0 });
  cone(g, "slate", { x: -0.6, z: 0, y0: 4.5, w: 3.8, h: 1.7, segs: 12 });
  return g;
}

/**
 * Palais Renaissance puis classique (1546-1666) : la Cour Carrée se ferme aile
 * par aile, pavillons d'angle plus hauts, puis la grande galerie file vers
 * l'ouest (vers les Tuileries).
 */
export function buildLouvrePalais() {
  const g = newModel("louvrePalais");
  const C = 7.0; // demi-côté extérieur de la cour carrée
  const WING = 2.4; // profondeur d'une aile
  const H = 3.2;

  /** Une aile + son comble mansardé. */
  function wing(cx, cz, w, d, stage) {
    box(g, "stoneLight", { x: cx, z: cz, y0: 0, w, h: H, d, stage });
    const alongX = w > d;
    gable(g, "slate", {
      x: cx,
      z: cz,
      y0: H,
      w: alongX ? w : d,
      h: 1.15,
      d: alongX ? d : w,
      rotY: alongX ? 0 : Math.PI / 2,
      stage: [stage[0] + 0.03, Math.min(1, stage[1] + 0.03)],
    });
  }

  // aile est (la première, Lescot), puis nord et sud, puis l'ouest
  wing(C - WING / 2, 0, WING, C * 2, [0, 0.26]);
  wing(0, -(C - WING / 2), C * 2, WING, [0.22, 0.5]);
  wing(0, C - WING / 2, C * 2, WING, [0.26, 0.54]);
  wing(-(C - WING / 2), 0, WING, C * 2, [0.5, 0.72]);

  // pavillons d'angle + pavillon central (plus hauts, combles à quatre pentes)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(g, "stone", {
        x: sx * (C - 1.3),
        z: sz * (C - 1.3),
        y0: 0,
        w: 2.6,
        h: 4.0,
        d: 2.6,
        stage: [0.56, 0.8],
      });
      cone(g, "slate", {
        x: sx * (C - 1.3),
        z: sz * (C - 1.3),
        y0: 4.0,
        w: 3.0,
        h: 1.5,
        segs: 4,
        rotY: Math.PI / 4,
        stage: [0.6, 0.84],
      });
    }
  }
  box(g, "stone", { x: -(C - 1.2), z: 0, y0: 0, w: 2.4, h: 4.4, d: 3.4, stage: [0.62, 0.86] });
  cone(g, "slate", {
    x: -(C - 1.2),
    z: 0,
    y0: 4.4,
    w: 3.6,
    h: 1.8,
    segs: 4,
    rotY: Math.PI / 4,
    stage: [0.66, 0.9],
  });

  // grande galerie vers l'ouest, le long de la Seine (z positif = sud ici)
  box(g, "stoneLight", { x: -13.5, z: 4.6, y0: 0, w: 12.0, h: 2.9, d: 2.2, stage: [0.72, 1.0] });
  gable(g, "slate", { x: -13.5, z: 4.6, y0: 2.9, w: 12.0, h: 0.95, d: 2.2, stage: [0.78, 1.0] });
  return g;
}

/**
 * Pyramide de verre (1988) : la grande pyramide translucide au centre de la
 * cour Napoléon, plus trois petites. `rotY = π/4` aligne les 4 faces sur les
 * ailes du palais.
 */
export function buildPyramide() {
  const g = newModel("pyramide");
  const glass = glassMat();
  const CX = -11.0;
  // 35 m de côté => 3,5 unités, soit 4,95 de diagonale : `w` est le diamètre du
  // cercle circonscrit du cône à 4 pans, donc 5,0. Hauteur réelle 21,6 m.
  cone(g, glass, { x: CX, z: 0, y0: 0, w: 5.0, h: 2.3, segs: 4, rotY: Math.PI / 4 });
  // Arêtes métalliques : 4 fines poutres sur les diagonales, qui donnent à la
  // pyramide un contour lisible même quand le verre se fond dans le sol clair.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    box(g, "metal", {
      x: CX + Math.cos(a) * 1.2,
      z: Math.sin(a) * 1.2,
      y0: 0,
      w: 0.12,
      h: 2.6,
      d: 0.12,
      yc: 1.15,
      rotZ: Math.cos(a) * 0.82,
      rotX: -Math.sin(a) * 0.82,
    });
  }
  for (const [dx, dz] of [
    [-3.9, -2.9],
    [-3.9, 2.9],
    [1.9, 0],
  ]) {
    cone(g, glass, { x: CX + dx, z: dz, y0: 0, w: 1.6, h: 0.7, segs: 4, rotY: Math.PI / 4 });
  }
  // bassins sombres qui asseyent la pyramide sur la cour Napoléon
  cyl(g, "stoneShadow", { x: CX, z: 0, y0: 0, w: 7.0, h: 0.12, d: 7.0, segs: 16 });
  return g;
}

// ============================================================================
// ARÈNES DE LUTÈCE
// ============================================================================

/**
 * Arènes (80-380, puis square depuis 1896) : gradins elliptiques en coques
 * concentriques décroissantes, arène sableuse, contreforts d'arcades.
 * @param {{partial?: boolean}} [opts] - `partial` = l'état « square » de 1896,
 *   plus bas, tribunes en partie disparues, arène engazonnée.
 */
export function buildArenes(opts = {}) {
  const partial = !!opts.partial;
  const g = newModel(partial ? "arenesSquare" : "arenes");
  const RX = 7.0;
  const RZ = 5.5;
  const stoneKey = partial ? "ruin" : "romanStucco";
  // 3 rangs de gradins : ouverture au nord (la scène/podium), donc thetaLength
  // partiel sur le rang extérieur du square.
  const tiers = partial
    ? [
        { rx: RX, rz: RZ, h: 0.85, theta: Math.PI * 1.55 },
        { rx: RX * 0.78, rz: RZ * 0.76, h: 0.55, theta: Math.PI * 1.7 },
      ]
    : [
        { rx: RX, rz: RZ, h: 1.9, theta: Math.PI * 2 },
        { rx: RX * 0.85, rz: RZ * 0.83, h: 1.35, theta: Math.PI * 2 },
        { rx: RX * 0.68, rz: RZ * 0.64, h: 0.8, theta: Math.PI * 2 },
      ];
  // Pas de rotY ici : l'échelle est appliquée *avant* la rotation, donc tourner
  // la coque échangerait le grand et le petit axe de l'ellipse (le grand axe des
  // arènes court d'est en ouest). L'ouverture des gradins partiels du square
  // tombe donc du côté sud-ouest, ce qui convient (la ville est au nord).
  for (const t of tiers) {
    shell(g, stoneKey, {
      x: 0,
      z: 0,
      y0: 0,
      w: t.rx * 2,
      h: t.h,
      d: t.rz * 2,
      segs: 24,
      thetaLength: t.theta,
    });
  }
  // arène (sable ou pelouse)
  cyl(g, partial ? "grass" : "sand", {
    x: 0,
    z: 0,
    y0: 0,
    w: RX * 0.96,
    h: 0.16,
    d: RZ * 0.9,
    segs: 20,
  });
  // contreforts d'arcades sur le pourtour extérieur
  const buttresses = partial ? 5 : 10;
  for (let i = 0; i < buttresses; i++) {
    const a = (i / buttresses) * Math.PI * 2 * (partial ? 0.55 : 1) + 0.3;
    const x = Math.cos(a) * RX;
    const z = Math.sin(a) * RZ;
    box(g, stoneKey, {
      x,
      z,
      y0: 0,
      w: 0.7,
      h: partial ? 1.0 : 2.2,
      d: 0.7,
      rotY: -a,
    });
  }
  if (partial) {
    // quelques arbres du square (1896)
    for (const [x, z] of [
      [-6.4, -3.4],
      [6.2, 3.6],
      [0.4, -6.0],
    ]) {
      cyl(g, "wood", { x, z, y0: 0, w: 0.2, h: 0.7, d: 0.2, segs: 6 });
      cone(g, "grass", { x, z, y0: 0.7, w: 1.5, h: 1.7, segs: 7 });
    }
  }
  return g;
}

export function buildArenesSquare() {
  return buildArenes({ partial: true });
}

// ============================================================================
// THERMES DE CLUNY
// ============================================================================

/** Thermes romains (200-300) : frigidarium voûté + salles annexes. */
export function buildThermes() {
  const g = newModel("thermes");
  // frigidarium
  box(g, "romanBrick", { x: 0, z: 0, y0: 0, w: 4.4, h: 1.9, d: 3.2 });
  vault(g, "romanStucco", { x: 0, z: 0, y0: 1.9, w: 4.4, h: 1.1, d: 3.2 });
  // salles chaudes, plus basses
  for (const [x, z, w, d] of [
    [-3.2, -1.0, 2.0, 1.8],
    [-3.2, 1.4, 2.0, 1.4],
    [3.0, 0.2, 1.8, 2.2],
  ]) {
    box(g, "romanBrick", { x, z, y0: 0, w, h: 1.25, d });
    vault(g, "romanStucco", { x, z, y0: 1.25, w, h: 0.55, d });
  }
  // mur de clôture de la palestre
  box(g, "romanStucco", { x: 0, z: -2.6, y0: 0, w: 6.0, h: 0.7, d: 0.35 });
  box(g, "romanStucco", { x: 0, z: 2.6, y0: 0, w: 6.0, h: 0.7, d: 0.35 });
  return g;
}

/**
 * La ruine qui reste — le mur du frigidarium tient toujours debout aujourd'hui.
 * Volontairement plus sombre (pierre patinée) et déchiquetée : deux pans de mur
 * de hauteurs différentes, une demi-voûte, un moignon de mur au sol.
 */
export function buildThermesRuine() {
  const g = newModel("thermesRuine");
  box(g, "ruin", { x: -0.4, z: 0, y0: 0, w: 3.2, h: 1.9, d: 3.0 });
  // arase déchiquetée : trois créneaux irréguliers
  box(g, "ruin", { x: -1.5, z: 0, y0: 1.9, w: 0.9, h: 0.5, d: 3.0 });
  box(g, "ruin", { x: -0.1, z: 0, y0: 1.9, w: 0.7, h: 0.25, d: 3.0 });
  box(g, "ruin", { x: 0.9, z: 0, y0: 1.9, w: 0.5, h: 0.65, d: 3.0 });
  // moitié de voûte encore en place
  vault(g, "ruin", { x: -1.5, z: 0, y0: 2.4, w: 1.4, h: 0.9, d: 3.0 });
  // moignons de murs au sol
  box(g, "ruin", { x: 2.0, z: -1.1, y0: 0, w: 1.6, h: 0.85, d: 0.5 });
  box(g, "ruin", { x: 2.4, z: 1.0, y0: 0, w: 0.5, h: 1.3, d: 1.4 });
  return g;
}

// ============================================================================
// FORUM ROMAIN
// ============================================================================

/** Forum (100-600) : esplanade dallée, double portique, petit temple à l'ouest. */
export function buildForum() {
  const g = newModel("forum");
  box(g, "romanStucco", { x: 0, z: 0, y0: 0, w: 8.0, h: 0.35, d: 6.0 });
  // portiques nord et sud
  for (const z of [-2.5, 2.5]) {
    colonnade(g, "stoneLight", { x0: -3.4, x1: 3.4, z, y0: 0.35, h: 1.6, r: 0.16, n: 6 });
    box(g, "romanStucco", { x: 0, z, y0: 1.95, w: 7.4, h: 0.3, d: 0.7 });
    gable(g, "romanTile", { x: 0, z, y0: 2.25, w: 7.4, h: 0.4, d: 1.5 });
  }
  // temple à l'ouest, sur podium
  box(g, "romanStucco", { x: -3.2, z: 0, y0: 0.35, w: 1.9, h: 0.4, d: 2.6 });
  for (const z of [-0.9, 0, 0.9]) {
    cyl(g, "stoneLight", { x: -3.9, z, y0: 0.75, w: 0.34, h: 1.5, d: 0.34, segs: 6 });
  }
  box(g, "romanStucco", { x: -2.9, z: 0, y0: 0.75, w: 1.3, h: 1.6, d: 1.8 });
  gable(g, "romanTile", { x: -3.3, z: 0, y0: 2.35, w: 2.3, h: 0.7, d: 2.6 });
  return g;
}

// ============================================================================
// PONT AU CHANGE + LES MOULINS
// ============================================================================

const BRIDGE_LEN = 8.4;
const BRIDGE_W = 1.9;
// Tablier haut de 1,4 (14 m au-dessus du niveau de l'eau, contre ~10 m en vrai).
// Volontairement exagéré : la bosse gaussienne de l'île (terrain.js,
// ISLAND_BUMP_AMPLITUDE) remonte le bras nord de la Seine quasiment au niveau de
// l'eau, donc un tablier bas s'y écrasait — arches invisibles, roues à moitié
// enterrées, l'ensemble lisant comme une rue bordée de maisons (constat des
// captures task10-pont-*). Surélevé, le pont retrouve sa silhouette d'arches.
const DECK_TOP = 1.4;

/** Le pont de pierre nu — il reste après 1786. */
export function buildPont() {
  const g = newModel("pont");
  // tablier
  box(g, "stone", { x: 0, z: 0, y0: DECK_TOP - 0.3, w: BRIDGE_LEN, h: 0.3, d: BRIDGE_W });
  // piles + arches
  for (const x of [-2.8, 0, 2.8]) {
    box(g, "stoneShadow", { x, z: 0, y0: -0.5, w: 0.85, h: 1.6, d: BRIDGE_W + 0.3 });
  }
  // Arches : voûtes en berceau d'axe *travers* du pont (rotY = π/2), donc
  // `w` est la portée mesurée le long du tablier et `d` la largeur franchie.
  for (const x of [-1.4, 1.4, 4.2, -4.2]) {
    vault(g, "stoneShadow", {
      x,
      z: 0,
      y0: 0.25,
      w: 2.0,
      h: 0.85,
      d: BRIDGE_W + 0.1,
      rotY: Math.PI / 2,
    });
  }
  // parapets
  for (const z of [-BRIDGE_W / 2 + 0.12, BRIDGE_W / 2 - 0.12]) {
    box(g, "stoneLight", { x: 0, z, y0: DECK_TOP, w: BRIDGE_LEN, h: 0.22, d: 0.22 });
  }
  return g;
}

/**
 * Les maisons du pont + les 4 roues à aubes (1100-1791). Les roues tournent
 * autour de leur axe (parallèle au tablier, donc perpendiculaire au courant).
 */
export function buildPontMoulins() {
  const g = newModel("pontMoulins");
  // deux rangées de maisons étroites, faîtage perpendiculaire au pont
  const houseColors = ["plaster", "plasterPink", "plaster", "plasterPink", "plaster"];
  for (let i = 0; i < 5; i++) {
    const x = -3.2 + i * 1.6;
    for (const sz of [-1, 1]) {
      const key = houseColors[(i + (sz > 0 ? 1 : 0)) % houseColors.length];
      const z = sz * 0.66;
      box(g, key, { x, z, y0: DECK_TOP, w: 1.2, h: 0.9, d: 0.52 });
      gable(g, "tile", {
        x,
        z,
        y0: DECK_TOP + 0.9,
        w: 0.52,
        h: 0.4,
        d: 1.2,
        rotY: Math.PI / 2,
      });
      // colombage sommaire
      box(g, "wood", { x, z: z + sz * 0.28, y0: DECK_TOP + 0.42, w: 1.2, h: 0.07, d: 0.05 });
    }
  }
  // 4 roues à aubes, côté amont
  for (let i = 0; i < 4; i++) {
    const x = -2.7 + i * 1.8;
    const wheel = spinner(g, {
      x,
      // 0,78 : moitié basse de la roue dans le courant, moyeu juste sous le
      // tablier. À 0,28, la roue disparaissait dans le sol du bras nord.
      y: 0.78,
      z: BRIDGE_W / 2 + 0.42,
      axis: "x",
      speed: 0.55 + i * 0.06,
      phase: i * 0.8,
    });
    // Jante : disque d'axe x (rotZ envoie l'axe Y du cylindre sur X), 12,5 m de
    // diamètre — un peu plus que les ~10 m réels, sinon la roue est illisible à
    // la distance du preset « cite ».
    cyl(wheel, "woodLight", {
      x: 0,
      z: 0,
      y0: 0,
      w: 1.25,
      h: 0.26,
      d: 1.25,
      segs: 8,
      yc: 0,
      rotZ: Math.PI / 2,
    });
    // 4 aubes croisées
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI;
      const m = new THREE.Mesh(unitBox(), mat("wood"));
      m.scale.set(0.34, 1.32, 0.1);
      m.rotation.x = a;
      m.userData = { y0: 0, h: 1.32, sx: 0.34, sz: 0.1, anchor: "center", stage: null, grow: false };
      wheel.add(m);
    }
    // charpente du moulin qui porte l'axe
    box(g, "wood", { x, z: BRIDGE_W / 2 + 0.2, y0: 0.2, w: 0.2, h: 1.15, d: 0.2 });
    box(g, "wood", { x, z: BRIDGE_W / 2 + 0.42, y0: 1.25, w: 0.24, h: 0.16, d: 1.0 });
  }
  return g;
}

// ============================================================================
// SAINTE-CHAPELLE
// ============================================================================

/** Sainte-Chapelle (1242) : vaisseau de verre, toit très pentu, flèche dorée. */
export function buildSainteChapelle() {
  const g = newModel("sainteChapelle");
  const H = 2.7;
  // chapelle basse + chapelle haute
  box(g, "stoneLight", { x: 0, z: 0, y0: 0, w: 3.4, h: 1.0, d: 1.7 });
  box(g, "stoneLight", { x: 0, z: 0, y0: 1.0, w: 3.2, h: H - 1.0, d: 1.55 });
  // les immenses verrières : un bandeau sombre de chaque côté
  for (const sz of [-1, 1]) {
    box(g, "glassDark", { x: 0.1, z: sz * 0.81, y0: 1.25, w: 2.7, h: 1.3, d: 0.08 });
  }
  // contreforts
  for (let i = 0; i < 4; i++) {
    const x = -1.35 + i * 0.9;
    for (const sz of [-1, 1]) {
      box(g, "stone", { x, z: sz * 0.92, y0: 0, w: 0.22, h: 2.4, d: 0.3 });
      cone(g, "stone", { x, z: sz * 0.92, y0: 2.4, w: 0.26, h: 0.45, segs: 6 });
    }
  }
  // chevet à pans coupés
  cyl(g, "stoneLight", { x: 1.8, z: 0, y0: 0, w: 1.55, h: H, d: 1.55, segs: 7 });
  // toiture très pentue
  gable(g, "lead", { x: -0.1, z: 0, y0: H, w: 3.4, h: 1.25, d: 1.6 });
  cone(g, "lead", { x: 1.8, z: 0, y0: H, w: 1.7, h: 1.1, segs: 7 });
  // flèche dorée élancée
  const gold = goldMat();
  cyl(g, gold, { x: -0.4, z: 0, y0: H + 1.25, w: 0.34, h: 0.4, d: 0.34, segs: 8 });
  cone(g, gold, { x: -0.4, z: 0, y0: H + 1.65, w: 0.4, h: 2.3, segs: 8 });
  cone(g, gold, { x: -0.4, z: 0, y0: H + 3.95, w: 0.14, h: 0.4, segs: 6 });
  return g;
}

// ============================================================================
// PANTHÉON
// ============================================================================

/** Panthéon (1758-1790) : croix grecque, portique à colonnes, grand dôme. */
export function buildPantheon() {
  const g = newModel("pantheon");
  const BODY_H = 3.0;
  // corps en croix
  box(g, "stoneLight", { x: 0, z: 0, y0: 0, w: 6.2, h: BODY_H, d: 4.4, stage: [0, 0.4] });
  box(g, "stoneLight", { x: 0, z: 0, y0: 0, w: 4.0, h: BODY_H, d: 6.2, stage: [0.05, 0.45] });
  box(g, "stoneShadow", { x: 0, z: 0, y0: BODY_H, w: 6.4, h: 0.28, d: 4.6, stage: [0.3, 0.5] });
  box(g, "stoneShadow", { x: 0, z: 0, y0: BODY_H, w: 4.2, h: 0.28, d: 6.4, stage: [0.3, 0.5] });
  // portique au sud (vers la Seine... en fait vers la rue Soufflot, +z)
  box(g, "stoneLight", { x: 0, z: 4.1, y0: 0, w: 4.6, h: 0.5, d: 1.9, stage: [0.3, 0.55] });
  for (let i = 0; i < 6; i++) {
    const x = -1.85 + (i / 5) * 3.7;
    cyl(g, "stoneLight", { x, z: 4.4, y0: 0.5, w: 0.46, h: 2.5, d: 0.46, segs: 8, stage: [0.35, 0.6] });
  }
  box(g, "stoneShadow", { x: 0, z: 4.3, y0: 3.0, w: 4.6, h: 0.3, d: 1.5, stage: [0.45, 0.62] });
  gable(g, "stoneLight", { x: 0, z: 4.3, y0: 3.3, w: 4.6, h: 0.8, d: 1.5, stage: [0.5, 0.66] });
  // tambour + colonnade circulaire
  cyl(g, "stoneLight", { x: 0, z: 0, y0: 3.28, w: 3.8, h: 1.7, d: 3.8, segs: 16, stage: [0.55, 0.75] });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    cyl(g, "stoneLight", {
      x: Math.cos(a) * 2.1,
      z: Math.sin(a) * 2.1,
      y0: 3.28,
      w: 0.34,
      h: 1.7,
      d: 0.34,
      segs: 6,
      stage: [0.6, 0.8],
    });
  }
  box(g, "stoneShadow", { x: 0, z: 0, y0: 4.98, w: 4.6, h: 0.24, d: 4.6, stage: [0.7, 0.84] });
  // dôme + lanterne
  dome(g, "stoneLight", { x: 0, z: 0, y0: 5.22, w: 3.7, h: 2.2, segs: 16, stage: [0.78, 0.92] });
  cyl(g, "stoneLight", { x: 0, z: 0, y0: 7.4, w: 1.0, h: 0.85, d: 1.0, segs: 12, stage: [0.88, 0.97] });
  cone(g, "lead", { x: 0, z: 0, y0: 8.25, w: 0.85, h: 0.65, segs: 12, stage: [0.92, 1.0] });
  cone(g, goldMat(), { x: 0, z: 0, y0: 8.9, w: 0.2, h: 0.4, segs: 6, stage: [0.96, 1.0] });
  return g;
}

// ============================================================================
// INVALIDES
// ============================================================================

/** Dôme des Invalides (1671-1706) : le dôme DORÉ, l'accent le plus brillant. */
export function buildInvalides() {
  const g = newModel("invalides");
  const gold = goldMat();
  // ailes basses de l'hôtel (au nord de l'église)
  for (const sx of [-1, 1]) {
    box(g, "stoneLight", { x: sx * 4.6, z: -1.2, y0: 0, w: 3.2, h: 1.9, d: 5.2, stage: [0, 0.45] });
    gable(g, "slate", {
      x: sx * 4.6,
      z: -1.2,
      y0: 1.9,
      w: 5.2,
      h: 0.75,
      d: 3.2,
      rotY: Math.PI / 2,
      stage: [0.05, 0.5],
    });
  }
  box(g, "stoneLight", { x: 0, z: -4.4, y0: 0, w: 6.4, h: 1.9, d: 2.4, stage: [0.1, 0.5] });
  gable(g, "slate", { x: 0, z: -4.4, y0: 1.9, w: 6.4, h: 0.7, d: 2.4, stage: [0.15, 0.55] });
  // église du dôme : base carrée + portique
  box(g, "stoneLight", { x: 0, z: 0.8, y0: 0, w: 4.4, h: 2.6, d: 4.4, stage: [0.2, 0.6] });
  for (let i = 0; i < 4; i++) {
    const x = -1.4 + i * 0.93;
    cyl(g, "stoneLight", { x, z: 3.1, y0: 0, w: 0.42, h: 2.4, d: 0.42, segs: 8, stage: [0.3, 0.65] });
  }
  gable(g, "stoneLight", { x: 0, z: 3.1, y0: 2.6, w: 3.6, h: 0.6, d: 1.2, stage: [0.4, 0.7] });
  // tambour
  cyl(g, "stoneLight", { x: 0, z: 0.8, y0: 2.6, w: 3.4, h: 1.6, d: 3.4, segs: 16, stage: [0.5, 0.72] });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    cyl(g, "stoneLight", {
      x: Math.cos(a) * 1.85,
      z: 0.8 + Math.sin(a) * 1.85,
      y0: 2.6,
      w: 0.3,
      h: 1.6,
      d: 0.3,
      segs: 6,
      stage: [0.55, 0.76],
    });
  }
  box(g, "stoneShadow", { x: 0, z: 0.8, y0: 4.2, w: 4.1, h: 0.22, d: 4.1, stage: [0.62, 0.8] });
  // LE dôme doré + lanterne + flèche
  // Dôme large et plein plutôt qu'un bulbe surmonté d'une longue aiguille : à la
  // première capture, une flèche de 2,2 unités transformait le dôme en minaret.
  dome(g, gold, { x: 0, z: 0.8, y0: 4.42, w: 3.9, h: 2.9, segs: 16, stage: [0.7, 0.9] });
  cyl(g, gold, { x: 0, z: 0.8, y0: 7.3, w: 1.1, h: 0.9, d: 1.1, segs: 12, stage: [0.86, 0.95] });
  cone(g, gold, { x: 0, z: 0.8, y0: 8.2, w: 0.95, h: 1.5, segs: 12, stage: [0.92, 1.0] });
  cone(g, gold, { x: 0, z: 0.8, y0: 9.7, w: 0.2, h: 0.45, segs: 6, stage: [0.97, 1.0] });
  return g;
}

// ============================================================================
// ÉGLISE SAINT-JACQUES-DE-LA-BOUCHERIE + SA TOUR — l'histoire d'une survivante
// ============================================================================
//
// Un seul site (rive droite, près du pont au Change), deux modèles qui ne
// meurent pas ensemble : l'église paroissiale (1300-1793, vendue et démolie
// pierre par pierre à la Révolution) et son clocher flamboyant (1509-1523),
// qui lui *survit* — depuis 1797 il se dresse seul au milieu d'un square, la
// seule pièce du site qui n'a jamais été rasée.
//
// Les deux modèles partagent la même ancre de site (x, z) — comme la flèche
// de Notre-Dame partage l'ancre de la cathédrale : l'offset entre les deux
// est *baked* dans les modèles, pas dans le registre. Ici, la tour est
// centrée sur l'ancre (c'était son pied réel, à l'angle ouest de la nef) et
// la nef de l'église s'étend vers l'est à partir de ce même point, contre le
// pied de la tour — exactement la convention ouest-tour / est-chevet déjà
// utilisée par `buildCathedraleGothique`.

/** Demi-côté du fût de la tour — partagé avec l'église pour caler sa façade
 * ouest exactement contre le pied de la tour. */
const TSJ_TOWER_HALF = 0.5;

/**
 * L'église Saint-Jacques-de-la-Boucherie (1300-1793) : nef modeste, deux
 * chapelles latérales en légère saillie, chevet à pans coupés — une paroisse
 * de quartier, pas une cathédrale (d'où une nef bien plus basse et bien plus
 * courte que celle de Notre-Dame). Démolie sous la Révolution — vendue comme
 * carrière de pierre —, il n'en reste rien aujourd'hui, sauf sa tour,
 * modélisée à part par `buildTourSaintJacques`.
 */
export function buildEgliseSaintJacques() {
  const g = newModel("egliseSaintJacques");
  const NAVE_LEN = 3.4;
  const NAVE_H = 2.2;
  const NAVE_W = 1.5;
  // Façade ouest : contre le pied de la tour, avec un petit jeu pour éviter
  // que les deux modèles ne s'interpénètrent visuellement.
  const naveX0 = TSJ_TOWER_HALF + 0.05;
  const naveCx = naveX0 + NAVE_LEN / 2;

  // nef
  box(g, "stone", { x: naveCx, z: 0, y0: 0, w: NAVE_LEN, h: NAVE_H, d: NAVE_W });
  gable(g, "slate", { x: naveCx, z: 0, y0: NAVE_H, w: NAVE_LEN, h: 0.9, d: NAVE_W });

  // deux chapelles latérales, en légère saillie sur les bas-côtés
  for (const sz of [-1, 1]) {
    const z = sz * (NAVE_W / 2 + 0.18);
    box(g, "stoneShadow", { x: naveCx, z, y0: 0, w: 1.0, h: 1.3, d: 0.36 });
    gable(g, "slate", { x: naveCx, z, y0: 1.3, w: 0.36, h: 0.4, d: 1.0, rotY: Math.PI / 2 });
  }

  // petit portail sur la façade ouest, juste contre la tour
  box(g, "stoneLight", { x: naveX0 + 0.12, z: 0, y0: 0, w: 0.24, h: 1.05, d: NAVE_W * 0.55 });

  // chevet à pans coupés, à l'est — même traitement que celui de la
  // cathédrale gothique (cyl + cône à 7 pans), en plus modeste.
  const apseX = naveX0 + NAVE_LEN + 0.5;
  cyl(g, "stone", { x: apseX, z: 0, y0: 0, w: 1.3, h: 1.8, d: 1.3, segs: 7 });
  cone(g, "slate", { x: apseX, z: 0, y0: 1.8, w: 1.45, h: 0.7, segs: 7 });

  return g;
}

/**
 * La tour Saint-Jacques (1509-1523) : clocher gothique flamboyant élancé —
 * fût carré à contreforts d'angle, un beffroi ajouré (le dernier étage,
 * suggéré par deux bandeaux sombres, même procédé que les verrières de la
 * Sainte-Chapelle), quatre pinacles d'angle et une flèche centrale sur la
 * terrasse des statues. 52 m réels ; volontairement lue à ~5,4 unités (un peu
 * au-dessus de l'échelle stricte) pour qu'elle domine franchement le tissu
 * urbain environnant à cette distance de vue, sans pour autant rivaliser avec
 * les tours de Notre-Dame (7,4 unités) — c'est un clocher de paroisse, pas
 * une cathédrale. Ne meurt jamais : seule pièce du site encore debout
 * aujourd'hui, seule au milieu de son square.
 */
export function buildTourSaintJacques() {
  const g = newModel("tourSaintJacques");
  const W = TSJ_TOWER_HALF * 2;
  const SHAFT_H = 3.8;
  const BELFRY_H = 0.9;
  const BELFRY_W = 0.82;
  const TERRACE_H = 0.18;
  const TERRACE_W = 0.95;
  const CORNERS = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];

  // fût carré
  box(g, "stoneLight", { x: 0, z: 0, y0: 0, w: W, h: SHAFT_H, d: W });
  // 4 lignes de contreforts verticaux, aux angles — filent du sol jusqu'au
  // sommet du beffroi, la signature « gothique » vue de près.
  for (const [sx, sz] of CORNERS) {
    box(g, "stoneShadow", {
      x: sx * (TSJ_TOWER_HALF + 0.08),
      z: sz * (TSJ_TOWER_HALF + 0.08),
      y0: 0,
      w: 0.16,
      h: SHAFT_H + BELFRY_H,
      d: 0.16,
    });
  }

  // le beffroi (dernier étage, ajouré) — deux bandeaux sombres plaqués sur
  // les faces est/ouest suggèrent les baies ouvertes du clocher.
  box(g, "stoneLight", { x: 0, z: 0, y0: SHAFT_H, w: BELFRY_W, h: BELFRY_H, d: BELFRY_W });
  for (const sx of [-1, 1]) {
    box(g, "glassDark", {
      x: sx * (BELFRY_W / 2 + 0.02),
      z: 0,
      y0: SHAFT_H + 0.15,
      w: 0.05,
      h: 0.6,
      d: 0.42,
    });
  }

  // terrasse des statues (légère corniche en surplomb) + pinacles d'angle +
  // flèche centrale.
  const terraceY = SHAFT_H + BELFRY_H;
  box(g, "stoneShadow", { x: 0, z: 0, y0: terraceY, w: TERRACE_W, h: TERRACE_H, d: TERRACE_W });
  const pinnacleY = terraceY + TERRACE_H;
  for (const [sx, sz] of CORNERS) {
    cone(g, "stoneLight", {
      x: sx * (TERRACE_W / 2 - 0.1),
      z: sz * (TERRACE_W / 2 - 0.1),
      y0: pinnacleY,
      w: 0.26,
      h: 0.42,
      segs: 6,
    });
  }
  cone(g, "stoneLight", { x: 0, z: 0, y0: pinnacleY, w: 0.34, h: 0.55, segs: 8 });

  return g;
}

// ============================================================================
// TOUR EIFFEL (1887-1889) — le monument qui monte ÉTAGE PAR ÉTAGE
// ============================================================================
//
// C'est le cas d'école de l'étagement (`stage`). La tour ne grandit pas d'un
// scale global : ses quatre quarts de chantier sont des *ensembles de pièces*
// distincts qui apparaissent l'un après l'autre, exactement comme les tours de
// Notre-Dame arrivent en dernier.
//
//   [0    , 0.25] les 4 piliers évasés + la grande arche      → 1887,0-1887,6
//   [0.25 , 0.5 ] le 1er étage (plateforme + montants)        → 1887,6-1888,2
//   [0.5  , 0.75] le 2e étage                                 → 1888,2-1888,7
//   [0.75 , 1   ] le fût supérieur, le campanile, l'antenne    → 1888,7-1889,3
//
// Ces bornes ne sont pas arbitraires : avec `born: 1887, buildYears: 2.3`
// elles tombent sur les vraies dates du chantier (1er étage avril 1888, 2e
// étage août 1888, sommet mars 1889). Le test de la tâche 11 les vérifie.
//
// Cotes réelles (1 unité = 10 m) : 125 m de côté au sol (demi-portée 6,25),
// 1er étage à 57 m, 2e à 115 m, 3e à 276 m, pointe à 300 m. Rien n'est
// exagéré ici — la tour écrase déjà tout le reste de la scène par sa vraie
// hauteur, qui est précisément ce que la tâche demande de faire sentir.

export const EIFFEL_TOP = 30.0;
export const EIFFEL_FLOOR1 = 5.7;
export const EIFFEL_FLOOR2 = 11.5;
export const EIFFEL_FLOOR3 = 27.6;

/** Les 4 quarts de chantier, exportés pour être vérifiables. */
export const EIFFEL_STAGES = [
  [0, 0.25],
  [0.25, 0.5],
  [0.5, 0.75],
  [0.75, 1],
];

/** Nombre de points scintillants et année à partir de laquelle ils s'allument. */
export const EIFFEL_SPARKLE_COUNT = 80;
export const EIFFEL_SPARKLE_FROM_YEAR = 2000;

/** Demi-portée (demi-côté du carré) de la tour à l'altitude y — profil concave. */
export function eiffelHalfSpanAt(y) {
  const knots = [
    [0, 6.0],
    [EIFFEL_FLOOR1, 3.5],
    [EIFFEL_FLOOR2, 1.5],
    [EIFFEL_FLOOR3, 0.6],
  ];
  if (y <= 0) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    if (y <= knots[i][0]) {
      const [y0, s0] = knots[i - 1];
      const [y1, s1] = knots[i];
      return s0 + ((s1 - s0) * (y - y0)) / (y1 - y0);
    }
  }
  return knots[knots.length - 1][1];
}

/** Hash déterministe local (même famille que geography.js) — points scintillants. */
function hash01(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

/**
 * Une membrure radiale inclinée (un tronçon de pilier) : elle relie le rayon
 * `r0` à l'altitude `y0` au rayon `r1` à l'altitude `y1`, sur la diagonale
 * d'azimut `phi`.
 *
 * Repère : la pièce est posée à mi-hauteur, son axe local +X pointe *vers
 * l'extérieur* (d'où `rotY = -phi`, puisque Ry(a) envoie +X sur
 * (cos a, 0, -sin a)) et un `rotZ = +t` fait basculer son sommet vers
 * l'intérieur — c'est l'évasement de la tour.
 */
function eiffelLeg(g, matKey, { phi, y0, y1, r0, r1, thick, stage }) {
  const dy = y1 - y0;
  const dr = r0 - r1; // > 0 : le haut rentre
  const len = Math.hypot(dy, dr);
  const tilt = Math.atan2(dr, dy);
  const rc = (r0 + r1) / 2;
  box(g, matKey, {
    x: Math.cos(phi) * rc,
    z: Math.sin(phi) * rc,
    y0: 0,
    w: thick,
    h: len,
    d: thick,
    yc: (y0 + y1) / 2,
    rotY: -phi,
    rotZ: tilt,
    stage,
  });
}

/**
 * Membrure diagonale générique entre deux points quelconques de l'espace —
 * généralisation d'`eiffelLeg` pour les croisillons des registres ouverts :
 * les côtés d'un registre ne passent pas par l'axe de la tour, donc la
 * paramétrisation radiale (azimut + rayon) d'`eiffelLeg` ne s'applique pas
 * ici. Même méthode : `rotY` aligne la projection horizontale du segment,
 * `rotZ` bascule ensuite le long axe local (Y) vers la pente réelle.
 */
function diagBrace(g, matKey, { x0, y0, z0, x1, y1, z1, thick, stage }) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const horiz = Math.hypot(dx, dz);
  const phi = Math.atan2(dz, dx);
  const len = Math.hypot(horiz, dy);
  const tilt = Math.atan2(-horiz, dy);
  box(g, matKey, {
    x: (x0 + x1) / 2,
    z: (z0 + z1) / 2,
    y0: 0,
    yc: (y0 + y1) / 2,
    w: thick,
    h: len,
    d: thick,
    rotY: -phi,
    rotZ: tilt,
    stage,
  });
}

/**
 * Registre OUVERT (garde-corps en treillis) à l'altitude y0 : quatre poteaux
 * d'angle + un croisillon en X par côté, rien d'autre. Remplace l'ancienne
 * `eiffelBelt` — quatre boîtes pleines qui refermaient tout le pourtour et,
 * empilées avec le plateau (aucun jeu vertical), fusionnaient en un disque
 * opaque : c'est le défaut « pagode/tabouret » repéré sur la capture 1888 de
 * la revue de la tâche 11. Ici le ciel doit rester visible entre les poteaux
 * et à travers chaque X, à toutes les étapes du chantier.
 */
function eiffelLattice(g, matKey, { y0, h, half, postThick = 0.14, braceThick = 0.12, stage }) {
  const yTop = y0 + h;
  const corners = [
    [half, half],
    [half, -half],
    [-half, -half],
    [-half, half],
  ];
  for (const [x, z] of corners) {
    box(g, matKey, { x, z, y0, w: postThick, h, d: postThick, stage });
  }
  for (let i = 0; i < 4; i++) {
    const [xa, za] = corners[i];
    const [xb, zb] = corners[(i + 1) % 4];
    diagBrace(g, matKey, { x0: xa, y0, z0: za, x1: xb, y1: yTop, z1: zb, thick: braceThick, stage });
    diagBrace(g, matKey, { x0: xb, y0, z0: zb, x1: xa, y1: yTop, z1: za, thick: braceThick, stage });
  }
}

/**
 * Le champ de points scintillants (après 2000) : un `InstancedMesh` de petits
 * cubes émissifs plaqués sur les quatre faces de la tour. Les positions sont
 * calculées une fois ici et gardées dans `userData.positions` ; c'est le layer
 * qui les allume/éteint (nuit seulement) et les fait clignoter avec
 * `state.time`. Marqué `sparkle` pour que `applyEntry` ne le traite pas comme
 * une pièce de maçonnerie.
 */
function buildEiffelSparkle(g) {
  const material = new THREE.MeshBasicMaterial({ color: 0xffe7a6 });
  const mesh = new THREE.InstancedMesh(unitBox(), material, EIFFEL_SPARKLE_COUNT);
  mesh.name = "eiffel_sparkle";
  mesh.frustumCulled = false;
  mesh.visible = false;
  const positions = new Float32Array(EIFFEL_SPARKLE_COUNT * 3);
  for (let i = 0; i < EIFFEL_SPARKLE_COUNT; i++) {
    // Réparti sur la hauteur avec un biais vers le bas (la tour est plus large
    // en bas : c'est là qu'il y a de la structure à éclairer).
    const t = hash01(i, 11);
    const y = 0.8 + Math.sqrt(t) * (EIFFEL_FLOOR3 - 0.8);
    const half = eiffelHalfSpanAt(y);
    const side = Math.floor(hash01(i, 22) * 4) % 4;
    const u = (hash01(i, 33) - 0.5) * 1.9 * half;
    let x;
    let z;
    if (side === 0) {
      x = u;
      z = -half;
    } else if (side === 1) {
      x = u;
      z = half;
    } else if (side === 2) {
      x = -half;
      z = u;
    } else {
      x = half;
      z = u;
    }
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  mesh.userData = {
    sparkle: true,
    fromYear: EIFFEL_SPARKLE_FROM_YEAR,
    positions,
    // Le contrat de pièce reste rempli (le layer et les tests le lisent) même
    // si cette pièce ne pousse pas et n'a pas d'étage.
    y0: 0,
    h: 0.12,
    sx: 1,
    sz: 1,
    anchor: "fixed",
    stage: null,
    temporary: false,
    grow: false,
  };
  g.add(mesh);
  return mesh;
}

/** La tour de fer, ses quatre quarts de chantier et son scintillement. */
export function buildTourEiffel() {
  const g = newModel("tourEiffel");
  const S = EIFFEL_STAGES;
  const rad = (half) => half * Math.SQRT2; // demi-portée -> rayon sur la diagonale
  const PHIS = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];

  // --- QUART 1 : les 4 piliers évasés + la grande arche -------------------
  // Chaque pilier monte en 3 tronçons, dans 3 sous-fenêtres du quart : la tour
  // sort du sol par le bas, pas d'un bloc.
  const legCuts = [
    { y0: 0, y1: 2.0, thick: 1.5, stage: [0.0, 0.09] },
    { y0: 2.0, y1: 3.9, thick: 1.2, stage: [0.07, 0.17] },
    { y0: 3.9, y1: EIFFEL_FLOOR1, thick: 0.95, stage: [0.14, 0.24] },
  ];
  for (const phi of PHIS) {
    for (const c of legCuts) {
      eiffelLeg(g, "iron", {
        phi,
        y0: c.y0,
        y1: c.y1,
        r0: rad(eiffelHalfSpanAt(c.y0)),
        r1: rad(eiffelHalfSpanAt(c.y1)),
        thick: c.thick,
        stage: c.stage,
      });
    }
  }
  // La grande arche : quatre voûtes entre piliers voisins, sous le 1er étage,
  // plus la frise horizontale qui les couronne. Même usage de `vault` que les
  // arches du pont au Change (axe en travers => rotY sur les deux côtés).
  const archHalf = eiffelHalfSpanAt(2.4);
  for (let i = 0; i < 4; i++) {
    const alongX = i < 2;
    const sign = i % 2 === 0 ? -1 : 1;
    vault(g, "ironDark", {
      x: alongX ? 0 : sign * archHalf,
      z: alongX ? sign * archHalf : 0,
      y0: 2.4,
      w: archHalf * 1.85,
      h: 1.5,
      d: 0.9,
      rotY: alongX ? 0 : Math.PI / 2,
      stage: [0.15, 0.25],
    });
  }
  eiffelLattice(g, "ironDark", {
    y0: 4.5,
    half: eiffelHalfSpanAt(4.5),
    h: 0.45,
    stage: [0.18, 0.25],
  });

  // --- QUART 2 : le 1er étage ---------------------------------------------
  // Le plateau **déborde** franchement des piliers (8,4 contre ±3,5 pour les
  // montants) : à la première capture, un plateau juste à l'aplomb des piliers
  // ne se lisait pas du tout — la tour n'avait visiblement pas d'étages, juste
  // un tronc qui s'affine. Mais la revue de la tâche 11 a trouvé pire : les
  // deux garde-corps + le plateau, empilés SANS le moindre jeu vertical et
  // pleins sur tout le pourtour, fusionnaient en un disque opaque (« pagode/
  // tabouret »). Trois corrections : (1) de vrais jeux verticaux entre les
  // trois registres, (2) les garde-corps sont maintenant des treillis OUVERTS
  // (`eiffelLattice` : poteaux d'angle + X, le ciel passe entre), (3) le
  // plateau est aminci à un vrai plancher fin (0,18 contre 0,55 avant).
  eiffelLattice(g, "ironDark", {
    y0: EIFFEL_FLOOR1 - 0.55,
    half: 4.3,
    h: 0.4,
    stage: [0.25, 0.34],
  });
  box(g, "iron", {
    x: 0,
    z: 0,
    y0: EIFFEL_FLOOR1,
    w: 8.4,
    h: 0.18,
    d: 8.4,
    stage: [0.26, 0.38],
  });
  eiffelLattice(g, "ironDark", {
    y0: EIFFEL_FLOOR1 + 0.35,
    half: 4.15,
    h: 0.4,
    stage: [0.3, 0.42],
  });
  for (const phi of PHIS) {
    for (const c of [
      { y0: EIFFEL_FLOOR1, y1: 8.6, thick: 0.8, stage: [0.34, 0.44] },
      { y0: 8.6, y1: EIFFEL_FLOOR2, thick: 0.65, stage: [0.4, 0.5] },
    ]) {
      eiffelLeg(g, "iron", {
        phi,
        y0: c.y0,
        y1: c.y1,
        r0: rad(eiffelHalfSpanAt(c.y0)),
        r1: rad(eiffelHalfSpanAt(c.y1)),
        thick: c.thick,
        stage: c.stage,
      });
    }
  }
  eiffelLattice(g, "ironDark", {
    y0: 8.6,
    half: eiffelHalfSpanAt(8.6),
    h: 0.3,
    stage: [0.42, 0.5],
  });

  // --- QUART 3 : le 2e étage ----------------------------------------------
  // Même correction qu'au 1er étage : jeux réels + treillis ouverts + plateau
  // aminci.
  eiffelLattice(g, "ironDark", {
    y0: EIFFEL_FLOOR2 - 0.45,
    half: 2.45,
    h: 0.3,
    stage: [0.5, 0.58],
  });
  box(g, "iron", {
    x: 0,
    z: 0,
    y0: EIFFEL_FLOOR2,
    w: 4.8,
    h: 0.18,
    d: 4.8,
    stage: [0.51, 0.62],
  });
  eiffelLattice(g, "ironDark", {
    y0: EIFFEL_FLOOR2 + 0.35,
    half: 2.35,
    h: 0.3,
    stage: [0.56, 0.68],
  });
  // Amorce du fût au-dessus du 2e étage (le reste monte au quart suivant).
  box(g, "iron", { x: 0, z: 0, y0: 11.92, w: 2.1, h: 1.9, d: 2.1, stage: [0.62, 0.75] });

  // --- QUART 4 : le fût supérieur, le campanile, l'antenne ----------------
  box(g, "iron", { x: 0, z: 0, y0: 13.82, w: 1.7, h: 5.4, d: 1.7, stage: [0.75, 0.84] });
  box(g, "iron", { x: 0, z: 0, y0: 19.22, w: 1.15, h: 5.2, d: 1.15, stage: [0.8, 0.9] });
  box(g, "iron", { x: 0, z: 0, y0: 24.42, w: 0.8, h: 3.18, d: 0.8, stage: [0.85, 0.94] });
  // Les 4 membrures d'angle qui donnent la courbe concave du fût.
  for (const phi of PHIS) {
    eiffelLeg(g, "ironDark", {
      phi,
      y0: 11.92,
      y1: EIFFEL_FLOOR3,
      r0: rad(eiffelHalfSpanAt(11.92)),
      r1: rad(eiffelHalfSpanAt(EIFFEL_FLOOR3)),
      thick: 0.33,
      stage: [0.77, 0.92],
    });
  }
  // Le campanile du sommet, la coupole, l'antenne.
  box(g, "iron", { x: 0, z: 0, y0: EIFFEL_FLOOR3, w: 1.5, h: 1.0, d: 1.5, stage: [0.9, 0.97] });
  cone(g, "ironDark", { x: 0, z: 0, y0: 28.6, w: 1.3, h: 0.62, segs: 8, stage: [0.93, 0.99] });
  cyl(g, goldMat(), {
    x: 0,
    z: 0,
    y0: 29.22,
    w: 0.16,
    h: EIFFEL_TOP - 29.22,
    d: 0.16,
    segs: 6,
    stage: [0.96, 1.0],
  });

  buildEiffelSparkle(g);
  return g;
}

// ============================================================================
// SACRÉ-CŒUR (1875-1914) — les dômes blancs au-dessus du quartier de Raphaël
// ============================================================================

/**
 * Basilique du Sacré-Cœur : nef, porche à trois arches tourné vers Paris
 * (+z, le sud), quatre coupoles secondaires, la grande coupole centrale
 * (83 m) et le campanile derrière (84 m), monté en dernier — c'est
 * historiquement juste (1904-1914) et cela donne au chantier de 39 ans une
 * lecture progressive vue depuis la butte.
 */
export function buildSacreCoeur() {
  const g = newModel("sacreCoeur");
  const NAVE_H = 2.9;

  // corps en croix
  box(g, "travertine", { x: 0, z: 0, y0: 0, w: 5.0, h: NAVE_H, d: 3.6, stage: [0, 0.3] });
  box(g, "travertine", { x: 0, z: 0, y0: 0, w: 3.4, h: NAVE_H, d: 5.0, stage: [0.05, 0.34] });
  box(g, "travertineShadow", { x: 0, z: 0, y0: NAVE_H, w: 5.2, h: 0.28, d: 3.8, stage: [0.26, 0.38] });
  box(g, "travertineShadow", { x: 0, z: 0, y0: NAVE_H, w: 3.6, h: 0.28, d: 5.2, stage: [0.26, 0.38] });

  // porche à trois arches, face à Paris (+z)
  box(g, "travertine", { x: 0, z: 3.3, y0: 0, w: 4.6, h: 1.9, d: 1.5, stage: [0.2, 0.45] });
  for (const x of [-1.4, 0, 1.4]) {
    vault(g, "travertineShadow", {
      x,
      z: 3.3,
      y0: 0.9,
      w: 1.05,
      h: 0.6,
      d: 1.6,
      rotY: Math.PI / 2,
      stage: [0.28, 0.48],
    });
  }
  box(g, "travertineShadow", { x: 0, z: 3.3, y0: 1.9, w: 4.8, h: 0.26, d: 1.7, stage: [0.34, 0.5] });

  // quatre coupoles secondaires aux angles
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cyl(g, "travertine", {
        x: sx * 1.85,
        z: sz * 1.85,
        y0: NAVE_H,
        w: 1.5,
        h: 0.7,
        d: 1.5,
        segs: 12,
        stage: [0.4, 0.56],
      });
      dome(g, "travertine", {
        x: sx * 1.85,
        z: sz * 1.85,
        y0: NAVE_H + 0.7,
        w: 1.6,
        h: 0.95,
        segs: 12,
        stage: [0.46, 0.6],
      });
    }
  }

  // tambour + LA grande coupole
  cyl(g, "travertine", { x: 0, z: 0, y0: NAVE_H, w: 3.1, h: 1.9, d: 3.1, segs: 16, stage: [0.5, 0.68] });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    cyl(g, "travertineShadow", {
      x: Math.cos(a) * 1.62,
      z: Math.sin(a) * 1.62,
      y0: NAVE_H,
      w: 0.26,
      h: 1.9,
      d: 0.26,
      segs: 6,
      stage: [0.54, 0.7],
    });
  }
  box(g, "travertineShadow", { x: 0, z: 0, y0: 4.8, w: 3.5, h: 0.22, d: 3.5, stage: [0.62, 0.74] });
  dome(g, "travertine", { x: 0, z: 0, y0: 5.02, w: 3.2, h: 2.35, segs: 16, stage: [0.66, 0.84] });
  cyl(g, "travertine", { x: 0, z: 0, y0: 7.37, w: 0.85, h: 0.6, d: 0.85, segs: 12, stage: [0.8, 0.9] });
  dome(g, "travertine", { x: 0, z: 0, y0: 7.97, w: 0.8, h: 0.35, segs: 12, stage: [0.84, 0.93] });
  // la croix du sommet (83 m)
  box(g, goldMat(), { x: 0, z: 0, y0: 8.32, w: 0.1, h: 0.5, d: 0.1, stage: [0.88, 0.96] });

  // le campanile, monté en dernier (1904-1914)
  box(g, "travertine", { x: 0, z: -4.2, y0: 0, w: 1.7, h: 6.6, d: 1.7, stage: [0.82, 0.97] });
  box(g, "travertineShadow", { x: 0, z: -4.2, y0: 6.6, w: 1.95, h: 0.3, d: 1.95, stage: [0.9, 0.99] });
  dome(g, "travertine", { x: 0, z: -4.2, y0: 6.9, w: 1.6, h: 1.1, segs: 12, stage: [0.92, 1.0] });
  cone(g, goldMat(), { x: 0, z: -4.2, y0: 8.0, w: 0.16, h: 0.4, segs: 6, stage: [0.96, 1.0] });
  return g;
}

// ============================================================================
// OPÉRA GARNIER (1861-1875) — toitures de cuivre vert et accents dorés
// ============================================================================

/**
 * L'Opéra : le grand vestibule à colonnes face au boulevard (+z, le sud), la
 * coupole plate de la salle au centre, la cage de scène (le plus haut volume,
 * en arrière) et sa toiture en pavillon triangulaire. 173 × 125 m réels, soit
 * ~9 × 6 unités : l'un des plus gros volumes de la scène.
 */
export function buildOperaGarnier() {
  const g = newModel("operaGarnier");
  const H = 2.7;
  // masse principale
  box(g, "operaStone", { x: 0, z: 0, y0: 0, w: 8.6, h: H, d: 5.4, stage: [0, 0.34] });
  box(g, "copper", { x: 0, z: 0, y0: H, w: 8.7, h: 0.4, d: 5.5, stage: [0.3, 0.45] });

  // façade sud : soubassement à arcades, colonnade, attique
  box(g, "operaStone", { x: 0, z: 3.1, y0: 0, w: 7.4, h: 1.5, d: 1.3, stage: [0.18, 0.42] });
  for (let i = 0; i < 7; i++) {
    const x = -2.7 + i * 0.9;
    cyl(g, "operaStone", {
      x,
      z: 3.45,
      y0: 1.5,
      w: 0.4,
      h: 1.35,
      d: 0.4,
      segs: 8,
      stage: [0.34, 0.56],
    });
  }
  box(g, "operaStone", { x: 0, z: 3.2, y0: 2.85, w: 7.6, h: 0.75, d: 1.5, stage: [0.46, 0.64] });
  // les groupes dorés de l'attique (Poésie et Harmonie) + la lyre
  for (const x of [-3.1, 3.1]) {
    cyl(g, goldMat(), { x, z: 3.2, y0: 3.6, w: 0.42, h: 0.75, d: 0.42, segs: 8, stage: [0.6, 0.74] });
  }
  box(g, goldMat(), { x: 0, z: 3.2, y0: 3.6, w: 1.1, h: 0.22, d: 0.3, stage: [0.62, 0.76] });

  // coupole plate de la salle (cuivre vert)
  cyl(g, "operaStone", { x: 0, z: 0.2, y0: H + 0.4, w: 3.4, h: 0.55, d: 3.4, segs: 16, stage: [0.5, 0.68] });
  dome(g, "copper", { x: 0, z: 0.2, y0: H + 0.95, w: 3.5, h: 1.05, segs: 16, stage: [0.62, 0.8] });
  cyl(g, goldMat(), { x: 0, z: 0.2, y0: H + 2.0, w: 0.5, h: 0.35, d: 0.5, segs: 8, stage: [0.74, 0.86] });

  // cage de scène (le plus haut) + son toit à deux pentes, en arrière (-z)
  box(g, "operaStone", { x: 0, z: -2.5, y0: 0, w: 5.2, h: 4.3, d: 3.4, stage: [0.6, 0.84] });
  gable(g, "copper", { x: 0, z: -2.5, y0: 4.3, w: 5.2, h: 1.15, d: 3.4, stage: [0.72, 0.92] });
  box(g, goldMat(), { x: 0, z: -2.5, y0: 5.45, w: 0.7, h: 0.3, d: 0.7, stage: [0.86, 1.0] });
  // pavillons latéraux de l'Empereur et des abonnés
  for (const sx of [-1, 1]) {
    box(g, "operaStone", { x: sx * 4.5, z: -0.6, y0: 0, w: 1.4, h: 2.2, d: 3.0, stage: [0.4, 0.7] });
    gable(g, "copper", {
      x: sx * 4.5,
      z: -0.6,
      y0: 2.2,
      w: 3.0,
      h: 0.6,
      d: 1.4,
      rotY: Math.PI / 2,
      stage: [0.55, 0.8],
    });
  }
  return g;
}

// ============================================================================
// TOUR MONTPARNASSE (1969-1973) — la dalle noire
// ============================================================================

/** 210 m (21 unités), 50 × 36 m d'emprise : la vraie cote, sans exagération. */
export function buildTourMontparnasse() {
  const g = newModel("tourMontparnasse");
  const H = 21.0;
  // socle + esplanade
  cyl(g, "stoneShadow", { x: 0, z: 0, y0: 0, w: 9.5, h: 0.14, d: 8.0, segs: 12, stage: [0, 0.2] });
  box(g, "darkGlassLight", { x: 0, z: 0, y0: 0.14, w: 7.0, h: 0.7, d: 6.2, stage: [0.05, 0.3] });
  // le fût : une dalle aux petits côtés arrondis (deux demi-cylindres + un
  // corps rectangulaire), qui monte tout du long du chantier.
  box(g, "darkGlass", { x: 0, z: 0, y0: 0.84, w: 5.0, h: H, d: 3.6, stage: [0.1, 0.94] });
  for (const sx of [-1, 1]) {
    cyl(g, "darkGlass", {
      x: sx * 2.5,
      z: 0,
      y0: 0.84,
      w: 3.6,
      h: H,
      d: 3.6,
      segs: 12,
      stage: [0.12, 0.96],
    });
  }
  // nervures verticales claires (les meneaux, qui rendent la dalle lisible)
  for (const x of [-1.6, 0, 1.6]) {
    box(g, "darkGlassLight", {
      x,
      z: 1.82,
      y0: 0.84,
      w: 0.3,
      h: H,
      d: 0.1,
      stage: [0.2, 0.96],
    });
    box(g, "darkGlassLight", {
      x,
      z: -1.82,
      y0: 0.84,
      w: 0.3,
      h: H,
      d: 0.1,
      stage: [0.2, 0.96],
    });
  }
  // terrasse et locaux techniques
  box(g, "darkGlassLight", { x: 0, z: 0, y0: H + 0.84, w: 5.4, h: 0.35, d: 4.0, stage: [0.9, 1.0] });
  box(g, "metal", { x: 0.8, z: 0, y0: H + 1.19, w: 1.6, h: 0.5, d: 1.6, stage: [0.94, 1.0] });
  return g;
}

// ============================================================================
// LA DÉFENSE (1970-2014) — un cluster de 8 tours qui pousse l'une après l'autre
// ============================================================================
//
// Un seul état, mais 8 fenêtres d'étage : la tour n° i monte pendant
// [i·0,115 ; i·0,115+0,09] de la présence, soit — avec `born: 1970,
// buildYears: 44` — de 1970 à ~2010, une tour tous les cinq ans. C'est
// exactement le mécanisme des tours de Notre-Dame, appliqué à un quartier
// entier : aucun code de layer supplémentaire.

/** Les 8 tours du cluster, en coordonnées locales du site (axe local +X = vers Paris). */
export const DEFENSE_TOWERS = [
  { x: 1.5, z: -6.0, w: 2.6, d: 2.6, h: 8.5, mat: "towerGlassA" },
  { x: 2.0, z: 5.4, w: 2.2, d: 3.0, h: 10.5, mat: "towerGlassB" },
  { x: 7.0, z: -2.0, w: 3.0, d: 3.0, h: 13.0, mat: "towerGlassC" },
  { x: 6.4, z: 7.6, w: 2.4, d: 2.4, h: 9.5, mat: "towerGlassA" },
  { x: -3.5, z: 8.2, w: 2.8, d: 2.2, h: 11.5, mat: "towerGlassB" },
  { x: -4.0, z: -8.0, w: 2.4, d: 2.8, h: 15.0, mat: "towerGlassC" },
  { x: 10.5, z: 3.2, w: 2.6, d: 2.6, h: 17.5, mat: "towerGlassB" },
  { x: 9.0, z: -8.2, w: 3.2, d: 2.4, h: 20.0, mat: "towerGlassA" },
];

/** Fenêtre d'étage de la tour n° i (exportée pour le test). */
export function defenseTowerStage(i) {
  const a = i * 0.115;
  return [a, Math.min(1, a + 0.09)];
}

export function buildLaDefense() {
  const g = newModel("laDefense");
  DEFENSE_TOWERS.forEach((t, i) => {
    const stage = defenseTowerStage(i);
    box(g, t.mat, { x: t.x, z: t.z, y0: 0, w: t.w, h: t.h, d: t.d, stage });
    // couronnement technique + une nervure claire, pour que les 8 dalles ne
    // lisent pas comme 8 boîtes identiques
    box(g, "metal", {
      x: t.x,
      z: t.z,
      y0: t.h,
      w: t.w * 0.55,
      h: 0.4,
      d: t.d * 0.55,
      stage: [Math.min(0.99, stage[1] - 0.01), Math.min(1, stage[1] + 0.02)],
    });
    box(g, "darkGlassLight", {
      x: t.x,
      z: t.z + t.d / 2,
      y0: 0,
      w: t.w * 0.2,
      h: t.h,
      d: 0.08,
      stage,
    });
  });
  // la dalle piétonne qui porte le quartier
  box(g, "stoneShadow", { x: 3.0, z: 0, y0: 0, w: 20.0, h: 0.2, d: 20.0, stage: [0, 0.06] });
  return g;
}

/**
 * La Grande Arche (1985-1989) : un cube creux de 110 m. Quatre dalles de
 * marbre (deux jambages, un toit, un socle) laissant le jour passer au milieu
 * — l'ouverture est dans l'axe local +X, donc dans l'axe historique
 * Louvre-Concorde-Étoile-Défense (voir le `rotY` du site).
 */
export function buildGrandeArche() {
  const g = newModel("grandeArche");
  const SIDE = 11.0;
  const LEG = 2.1; // épaisseur des jambages
  const CX = -9.0;
  // jambages
  for (const sz of [-1, 1]) {
    box(g, "concrete", {
      x: CX,
      z: (sz * (SIDE - LEG)) / 2,
      y0: 0,
      w: LEG * 1.1,
      h: SIDE,
      d: LEG,
      stage: [0, 0.6],
    });
  }
  // socle et couronnement (le toit du cube)
  box(g, "concrete", { x: CX, z: 0, y0: 0, w: LEG * 1.1, h: 0.9, d: SIDE, stage: [0, 0.35] });
  box(g, "concrete", { x: CX, z: 0, y0: SIDE - 1.5, w: LEG * 1.1, h: 1.5, d: SIDE, stage: [0.6, 0.9] });
  // le « nuage » de toile tendu sous l'arche + les ascenseurs
  box(g, "metal", { x: CX, z: 0, y0: 3.6, w: 1.4, h: 0.18, d: 5.4, stage: [0.85, 1.0] });
  box(g, "darkGlassLight", { x: CX + 0.9, z: 0, y0: 0.9, w: 0.5, h: 8.4, d: 1.2, stage: [0.75, 1.0] });
  return g;
}

// ============================================================================
// Table des constructeurs — la clé `model` du registre de monuments.js
// ============================================================================

export const MODEL_BUILDERS = {
  templeRomain: buildTempleRomain,
  basilique: buildBasilique,
  cathedraleGothique: buildCathedraleGothique,
  fleche: buildFleche,
  flecheNeuve: buildFlecheNeuve,
  echafaudage: buildEchafaudage,
  louvreForteresse: buildLouvreForteresse,
  louvrePalais: buildLouvrePalais,
  pyramide: buildPyramide,
  arenes: buildArenes,
  arenesSquare: buildArenesSquare,
  thermes: buildThermes,
  thermesRuine: buildThermesRuine,
  forum: buildForum,
  pont: buildPont,
  pontMoulins: buildPontMoulins,
  sainteChapelle: buildSainteChapelle,
  pantheon: buildPantheon,
  invalides: buildInvalides,
  // --- tâche 15 -------------------------------------------------------------
  egliseSaintJacques: buildEgliseSaintJacques,
  tourSaintJacques: buildTourSaintJacques,
  // --- tâche 11 -----------------------------------------------------------
  tourEiffel: buildTourEiffel,
  sacreCoeur: buildSacreCoeur,
  operaGarnier: buildOperaGarnier,
  tourMontparnasse: buildTourMontparnasse,
  laDefense: buildLaDefense,
  grandeArche: buildGrandeArche,
};
