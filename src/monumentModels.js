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
};
