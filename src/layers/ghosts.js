/**
 * Ghosts layer — les repères fantômes.
 *
 * C'est la couche qui répond à la raison d'être du projet : la vidéo de
 * référence n'avait aucun point de repère, alors on en pose deux qui
 * traversent *tout* le temps.
 *
 *  - **La Tour Eiffel fantôme** : dès -250, sa silhouette complète (le même
 *    modèle que la vraie tour, `monumentModels.buildTourEiffel`) se tient déjà
 *    au-dessus des forêts gauloises — dorée, translucide, une promesse qui
 *    attend son siècle. De 1887 (naissance de la vraie tour dans
 *    `layers/monuments.js`) à 1889,3 (fin du chantier, `buildYears: 2,3`),
 *    le fantôme s'éteint exactement à la vitesse où le fer réel pousse :
 *    opacité = base · (1 − présence de construction). Une gerbe dorée fête le
 *    passage de 1889 (dans les deux sens du scrub).
 *  - **La balise « chez nous »** : une colonne de lumière fine à
 *    `LANDMARKS.chezNous`, visible à *toutes* les années — avant même que la
 *    ville n'atteigne le quartier. Une icône maison au sommet (texture canvas,
 *    aucun asset externe), un halo au sol. Un anneau de lumière fête 1860,
 *    l'année où la petite ceinture referme son premier tronçon dans le
 *    quartier (voir `layers/rails.js`).
 *
 * ============================================================================
 * Ce qui est réutilisé plutôt que réécrit
 *
 * Le modèle du fantôme est `buildTourEiffel()` **sans aucune retouche** : on
 * ne retouche que les matériaux (un seul, partagé, additif). Comme la pièce
 * `piece()` de `monumentModels.js` fixe `mesh.scale` à sa taille *finale* dès
 * la construction — c'est `layers/monuments.js` qui anime ensuite
 * `scale.y = h·t` pour faire pousser le chantier — ignorer cette étape laisse
 * chaque pièce à sa taille complète : le fantôme est donc, sans le moindre
 * calcul supplémentaire, la tour *entière*, jamais un chantier partiel.
 *
 * ============================================================================
 * Coût et discipline d'animation
 *
 * Tout est construit une fois à `init()` : un groupe (le fantôme), la
 * colonne de la balise (`BEACON_SEGMENT_COUNT` tronçons × cœur+halo, pour
 * éviter l'effet « sabre laser » d'un simple cylindre — voir `buildBeacon`),
 * son halo au sol, son icône, un pool fixe de 120 particules (gerbe de 1889)
 * et un anneau (1860). `update()` ne fait que déplacer/teinter des objets
 * déjà en scène — aucune allocation par frame. Repères et célébrations
 * disparaissent d'un coup (juste `visible = false`) quand `state.
 * showLandmarks` est faux : coût nul.
 */

import * as THREE from "three";
import { LANDMARKS } from "../geography.js";
import { lifecycle, lerp } from "../timeEngine.js";
import { groundHeightAt } from "./terrain.js";
import { buildTourEiffel, EIFFEL_TOP } from "../monumentModels.js";

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hash déterministe (même famille que geography.js/walls.js/rails.js). */
function hash01(a, b, seed) {
  let h = (a * 374761393 + b * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

// ============================================================================
// Configuration — exportée pour être testable
// ============================================================================

/**
 * Cycle de vie de la *vraie* tour, dupliqué depuis `layers/monuments.js`
 * (`MONUMENTS.tourEiffel.states[0]`) : c'est contre cette même courbe que le
 * fantôme s'éteint. Un test de configuration vérifie que les deux fichiers
 * restent d'accord.
 */
export const EIFFEL_GHOST = { born: 1887, buildYears: 2.3 };

export const GHOST_BASE_OPACITY = 0.18;
export const GHOST_COLOR = 0xe0a83f; // or riche, saturé (voir buildGhostEiffel)
export const SHIMMER_AMPLITUDE = 0.05;
export const SHIMMER_SPEED = 0.6; // rad/s — un scintillement doux, pas un clignotement

/** Fin du chantier réel (1887 + 2,3) : le fantôme y touche 0. */
export const CELEBRATION_1889_THRESHOLD = EIFFEL_GHOST.born + EIFFEL_GHOST.buildYears;
/** Bouclage du premier tronçon de la petite ceinture dans le quartier. */
export const CELEBRATION_1860_THRESHOLD = 1860;
/** Durée minimale entre deux célébrations d'une même balise (secondes sim). */
export const CELEBRATION_COOLDOWN = 3.0;

export const BEACON_HEIGHT = 40;
export const BEACON_COLOR = 0xffc266; // additif : plus saturé que la pierre pâle du fantôme

export const EIFFEL_BURST_COUNT = 120;
export const EIFFEL_BURST_LIFE = 2.4; // secondes, dans la fenêtre 2-3 s demandée
export const EIFFEL_BURST_GRAVITY = 3.0;

export const RING_LIFE = 3.0;
export const RING_MAX_SCALE = 9;

// ============================================================================
// Fonctions pures — testables sans WebGL
// ============================================================================

/**
 * Opacité de base du fantôme (sans scintillement) : pleine avant 1887, puis
 * `1 − présence de construction` pendant que la vraie tour pousse (1887 →
 * 1889,3), nulle après.
 * @param {number} year
 * @returns {number}
 */
export function eiffelGhostBaseOpacity(year) {
  const { presence } = lifecycle(year, EIFFEL_GHOST);
  return GHOST_BASE_OPACITY * (1 - presence);
}

/**
 * Opacité affichée du fantôme : la base + un scintillement doux (±0,05,
 * figé sous `reducedMotion`), toujours dans [0, 1].
 * @param {number} year
 * @param {number} time
 * @param {boolean} reducedMotion
 * @returns {number}
 */
export function eiffelGhostOpacity(year, time, reducedMotion) {
  const base = eiffelGhostBaseOpacity(year);
  if (base <= 0) return 0;
  const shimmer = reducedMotion ? 0 : Math.sin(time * SHIMMER_SPEED) * SHIMMER_AMPLITUDE;
  return Math.max(0, Math.min(1, base + shimmer));
}

/**
 * La balise « chez nous » n'a pas de cycle de vie : elle est là avant même la
 * ville. Présence constante, exportée pour que ce soit vérifiable — et pas
 * seulement affirmé — que rien n'y dépend de l'année.
 * @param {number} _year
 * @returns {number}
 */
export function beaconPresence(_year) {
  return 1;
}

/**
 * Le scrub a-t-il franchi `threshold` entre `prevYear` et `year`, dans un sens
 * ou dans l'autre ? Pas de mouvement => pas de franchissement.
 * @param {number} prevYear
 * @param {number} year
 * @param {number} threshold
 * @returns {boolean}
 */
export function didCross(prevYear, year, threshold) {
  if (prevYear === year) return false;
  return (prevYear < threshold && year >= threshold) || (prevYear > threshold && year <= threshold);
}

/**
 * Faut-il déclencher une célébration ? Combine le détecteur de franchissement,
 * le respect du bouton 📍/`reducedMotion` (`enabled`) et un throttle temporel
 * (`cooldown` secondes de simulation depuis le dernier déclenchement).
 * @param {{prevYear:number, year:number, threshold:number, lastTriggerTime:number, now:number, cooldown:number, enabled:boolean}} args
 * @returns {boolean}
 */
export function shouldCelebrate({ prevYear, year, threshold, lastTriggerTime, now, cooldown, enabled }) {
  if (!enabled) return false;
  if (!didCross(prevYear, year, threshold)) return false;
  return now - lastTriggerTime >= cooldown;
}

// ============================================================================
// Le fantôme de la Tour Eiffel
// ============================================================================

const ghost = { group: null, material: null, baseY: 0, topY: 0 };

function buildGhostEiffel(ctx) {
  const group = buildTourEiffel();
  // Alpha normale, pas additive : la silhouette est un treillis dense (des
  // centaines de membrures qui se croisent en projection, surtout près du
  // sommet/campanile). En additif, chaque croisement *ajoute* son opacité —
  // aucune borne — et les zones denses cramaient en blanc au lieu de lire
  // comme de l'or (constat de capture, première passe). L'alpha normale reste
  // bornée par la couleur du matériau : c'est ce qui rend « translucide et
  // doré », pas « lumineux et blanc ». L'additif reste le bon choix pour la
  // balise et les célébrations (de vraies sources de lumière, pas une
  // structure) : voir buildBeacon/buildBurst/buildRing plus bas.
  const material = new THREE.MeshBasicMaterial({
    color: GHOST_COLOR,
    transparent: true,
    opacity: GHOST_BASE_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Un seul matériau partagé pour toute la silhouette — sauf le champ
  // scintillant (InstancedMesh à part, réservé à la vraie tour après 2000,
  // jamais allumé ici) qu'on laisse invisible et intact.
  group.traverse((child) => {
    if (!child.isMesh || child.userData?.sparkle) return;
    child.material = material;
    child.castShadow = false;
    child.receiveShadow = false;
  });
  const baseY = groundHeightAt(LANDMARKS.tourEiffel.x, LANDMARKS.tourEiffel.z);
  group.position.set(LANDMARKS.tourEiffel.x, baseY, LANDMARKS.tourEiffel.z);
  group.visible = false;
  group.frustumCulled = false;
  ctx.scene.add(group);

  ghost.group = group;
  ghost.material = material;
  ghost.baseY = baseY;
  ghost.topY = baseY + EIFFEL_TOP;
}

function updateGhost(state) {
  if (!state.showLandmarks) {
    if (ghost.group.visible) ghost.group.visible = false;
    return;
  }
  const opacity = eiffelGhostOpacity(state.year, state.time, state.reducedMotion);
  if (opacity <= 0) {
    if (ghost.group.visible) ghost.group.visible = false;
    return;
  }
  ghost.group.visible = true;
  ghost.material.opacity = opacity;
}

// ============================================================================
// La balise « chez nous »
// ============================================================================

const beacon = { segments: null, halo: null, haloMat: null, icon: null, iconMat: null, baseY: 0 };

/**
 * Icône maison dessinée sur un canvas 2D (aucun asset externe) : un halo
 * doux derrière un pictogramme simple (toit + murs + porte), lisible en
 * silhouette de loin. `null` hors navigateur (tests Node sans DOM) — l'appelant
 * retombe alors sur un sprite de couleur unie.
 * @returns {THREE.CanvasTexture | null}
 */
function makeHomeIconTexture() {
  if (typeof document === "undefined") return null;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d");
  const grad = c.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, "rgba(255,240,205,0.95)");
  grad.addColorStop(0.55, "rgba(255,225,165,0.3)");
  grad.addColorStop(1, "rgba(255,225,165,0)");
  c.fillStyle = grad;
  c.fillRect(0, 0, size, size);
  c.translate(size / 2, size / 2 + 6);
  c.fillStyle = "#6b4a1e";
  c.beginPath();
  c.moveTo(-34, 4);
  c.lineTo(0, -34);
  c.lineTo(34, 4);
  c.lineTo(24, 4);
  c.lineTo(24, 30);
  c.lineTo(-24, 30);
  c.lineTo(-24, 4);
  c.closePath();
  c.fill();
  c.fillStyle = "#3a2810";
  c.fillRect(-8, 10, 16, 20);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * La colonne n'est PAS un unique cylindre de largeur et d'opacité constantes
 * — rendu, cela lit exactement comme un laser (constat de capture : un trait
 * dur du sol jusqu'en haut de l'écran). À la place, `BEACON_SEGMENT_COUNT`
 * tronçons empilés, qui *s'évasent* vers le bas (un vrai faisceau, large à
 * la base) et dont l'opacité de base décroît avec la hauteur — dense près du
 * sol, presque dissipée en haut. `update` ne fait qu'ajuster une opacité par
 * tronçon (pas d'allocation).
 */
const BEACON_SEGMENT_COUNT = 5;

/** Ajoute un tronçon (mesh + matériau additif) au tableau `out`. */
function addBeaconLayer(ctx, out, x, z, baseY, y0, y1, rBottom, rTop, opacityMul) {
  const h = y1 - y0;
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, 10, 1, true);
  const material = new THREE.MeshBasicMaterial({
    color: BEACON_COLOR,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, baseY + (y0 + y1) / 2, z);
  mesh.frustumCulled = false;
  mesh.visible = false;
  ctx.scene.add(mesh);
  const t = (y0 + y1) / 2 / BEACON_HEIGHT;
  // Décroissance en loi de puissance (pas linéaire) : le pied du faisceau
  // reste dense, le sommet se dissipe vite — sans ça, une colonne uniforme
  // lit comme un laser (constat de capture, première passe).
  const baseFade = Math.pow(1 - t, 1.7);
  out.push({ mesh, material, baseFade: baseFade * opacityMul });
}

function buildBeacon(ctx) {
  const { x, z } = LANDMARKS.chezNous;
  const baseY = groundHeightAt(x, z);
  beacon.baseY = baseY;

  // Deux épaisseurs superposées par tronçon : un cœur étroit et lumineux, un
  // halo large et très doux autour. C'est le halo — pas le dégradé vertical
  // seul — qui casse le bord dur d'un simple cylindre et évite l'effet
  // « sabre laser » (constat de capture, première passe : un dégradé de
  // hauteur seul restait un trait bien net vu de loin).
  beacon.segments = [];
  const segH = BEACON_HEIGHT / BEACON_SEGMENT_COUNT;
  for (let i = 0; i < BEACON_SEGMENT_COUNT; i++) {
    const t0 = i / BEACON_SEGMENT_COUNT;
    const t1 = (i + 1) / BEACON_SEGMENT_COUNT;
    const y0 = t0 * BEACON_HEIGHT;
    const y1 = t1 * BEACON_HEIGHT;
    // cœur : étroit, plus opaque
    addBeaconLayer(ctx, beacon.segments, x, z, baseY, y0, y1, lerp(0.55, 0.06, t0), lerp(0.55, 0.06, t1), 1.0);
    // halo : large, très transparent — c'est lui qui adoucit le bord
    addBeaconLayer(ctx, beacon.segments, x, z, baseY, y0, y1, lerp(1.9, 0.25, t0), lerp(1.9, 0.25, t1), 0.22);
  }

  const haloGeo = new THREE.CircleGeometry(6, 28);
  beacon.haloMat = new THREE.MeshBasicMaterial({
    color: BEACON_COLOR,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  beacon.halo = new THREE.Mesh(haloGeo, beacon.haloMat);
  beacon.halo.rotation.x = -Math.PI / 2;
  beacon.halo.position.set(x, baseY + 0.04, z);
  beacon.halo.frustumCulled = false;
  beacon.halo.visible = false;
  ctx.scene.add(beacon.halo);

  // `map` n'est passé que s'il existe : THREE.Material avertit sur toute clé
  // de constructeur valant explicitement `undefined` (cas des tests Node,
  // sans DOM — voir makeHomeIconTexture).
  const texture = makeHomeIconTexture();
  const spriteParams = { color: texture ? 0xffffff : BEACON_COLOR, transparent: true, depthWrite: false };
  if (texture) spriteParams.map = texture;
  beacon.iconMat = new THREE.SpriteMaterial(spriteParams);
  beacon.icon = new THREE.Sprite(beacon.iconMat);
  beacon.icon.scale.set(5, 5, 1);
  beacon.icon.position.set(x, baseY + BEACON_HEIGHT + 1.6, z);
  beacon.icon.frustumCulled = false;
  beacon.icon.visible = false;
  ctx.scene.add(beacon.icon);
}

function updateBeaconVisuals(state) {
  if (!state.showLandmarks) {
    if (beacon.halo.visible) {
      for (const seg of beacon.segments) seg.mesh.visible = false;
      beacon.halo.visible = false;
      beacon.icon.visible = false;
    }
    return;
  }
  beacon.halo.visible = true;
  beacon.icon.visible = true;
  // Pulsation douce (0..1), figée sous reducedMotion (dernière phase gelée = repos).
  const pulse = state.reducedMotion ? 0.5 : Math.sin(state.time * 0.9) * 0.5 + 0.5;
  const columnPeak = lerp(0.5, 0.62, pulse);
  for (const seg of beacon.segments) {
    seg.mesh.visible = true;
    seg.material.opacity = columnPeak * seg.baseFade;
  }
  beacon.haloMat.opacity = lerp(0.16, 0.26, pulse);
  const iconScale = 5 + (state.reducedMotion ? 0 : Math.sin(state.time * 0.9) * 0.25);
  beacon.icon.scale.set(iconScale, iconScale, 1);
}

// ============================================================================
// Célébration 1889 — gerbe dorée depuis le sommet du fantôme
// ============================================================================

const burst = { slots: [], active: false, startTime: 0, lastTriggerTime: -Infinity, prevYear: null };

function buildBurst(ctx) {
  burst.slots.length = 0; // reset : init() peut être rappelé (tests, une scène par cas)
  // 0,28 (première passe) était sub-pixel vu depuis les cadrages habituels
  // de la tour (100+ unités) — la gerbe existait dans les données mais restait
  // invisible à l'écran (constat de capture). Des étincelles plus grosses,
  // à l'échelle d'un feu d'artifice « raconté à un enfant » plutôt qu'à
  // l'échelle réelle d'une escarbille.
  const geo = new THREE.IcosahedronGeometry(0.75, 0);
  for (let i = 0; i < EIFFEL_BURST_COUNT; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffdd88,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
    burst.slots.push({
      mesh,
      material,
      // Vitesses assez généreuses pour que la gerbe s'ouvre franchement (un
      // vrai dôme qui déborde largement le fût) au lieu de rester un amas
      // compact au sommet — 120 étincelles superposées sur une poignée de
      // pixels cramaient en blanc pur (constat de capture, première passe) :
      // l'additif ne pardonne pas un tas serré.
      angle: (i / EIFFEL_BURST_COUNT) * Math.PI * 2 + (hash01(i, 3, 401) - 0.5) * 0.3,
      radialSpeed: 5 + hash01(i, 5, 409) * 10,
      riseSpeed: 4 + hash01(i, 7, 419) * 6,
      delay: hash01(i, 11, 431) * 0.35,
      active: false,
    });
  }
}

function triggerBurst(now) {
  burst.active = true;
  burst.startTime = now;
  for (const s of burst.slots) s.active = true;
}

function clearBurst() {
  burst.active = false;
  for (const s of burst.slots) {
    s.active = false;
    s.mesh.visible = false;
    s.material.opacity = 0;
  }
}

function updateBurst(state, visible) {
  if (!burst.active) return;
  if (!visible) {
    for (const s of burst.slots) {
      if (s.mesh.visible) s.mesh.visible = false;
    }
    return;
  }
  const originX = LANDMARKS.tourEiffel.x;
  const originZ = LANDMARKS.tourEiffel.z;
  const originY = ghost.topY;
  let anyActive = false;
  for (const s of burst.slots) {
    if (!s.active) continue;
    const t = state.time - burst.startTime - s.delay;
    if (t < 0) {
      s.mesh.visible = false;
      anyActive = true;
      continue;
    }
    if (t >= EIFFEL_BURST_LIFE) {
      s.active = false;
      s.mesh.visible = false;
      continue;
    }
    anyActive = true;
    const x = originX + Math.cos(s.angle) * s.radialSpeed * t;
    const z = originZ + Math.sin(s.angle) * s.radialSpeed * t;
    const y = originY + s.riseSpeed * t - 0.5 * EIFFEL_BURST_GRAVITY * t * t;
    s.mesh.visible = true;
    s.mesh.position.set(x, y, z);
    const life = clamp01(1 - t / EIFFEL_BURST_LIFE);
    s.mesh.scale.setScalar(lerp(1, 0.4, 1 - life));
    s.material.opacity = life;
  }
  burst.active = anyActive;
}

// ============================================================================
// Célébration 1860 — anneau de lumière depuis la balise
// ============================================================================

const ring = { mesh: null, material: null, active: false, startTime: 0, lastTriggerTime: -Infinity, prevYear: null };

function buildRing(ctx) {
  const geo = new THREE.RingGeometry(0.8, 1.15, 40);
  const material = new THREE.MeshBasicMaterial({
    color: 0xfff2c9,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.visible = false;
  mesh.frustumCulled = false;
  ctx.scene.add(mesh);
  ring.mesh = mesh;
  ring.material = material;
}

function triggerRing(now) {
  ring.active = true;
  ring.startTime = now;
}

function clearRing() {
  ring.active = false;
  ring.mesh.visible = false;
  ring.material.opacity = 0;
}

function updateRing(state, visible) {
  if (!ring.active) return;
  if (!visible) {
    if (ring.mesh.visible) ring.mesh.visible = false;
    return;
  }
  const t = (state.time - ring.startTime) / RING_LIFE;
  if (t >= 1) {
    ring.active = false;
    ring.mesh.visible = false;
    return;
  }
  const { x, z } = LANDMARKS.chezNous;
  ring.mesh.visible = true;
  ring.mesh.position.set(x, beacon.baseY + 0.06, z);
  const scale = lerp(0.6, RING_MAX_SCALE, t);
  ring.mesh.scale.set(scale, scale, 1);
  ring.material.opacity = (1 - t) * 0.55;
}

// ============================================================================
// Détection de franchissement + orchestration des deux célébrations
// ============================================================================

function updateCelebrations(state) {
  const enabled = state.showLandmarks && !state.reducedMotion;
  const now = state.time;

  if (burst.prevYear === null) burst.prevYear = state.year;
  if (
    shouldCelebrate({
      prevYear: burst.prevYear,
      year: state.year,
      threshold: CELEBRATION_1889_THRESHOLD,
      lastTriggerTime: burst.lastTriggerTime,
      now,
      cooldown: CELEBRATION_COOLDOWN,
      enabled,
    })
  ) {
    triggerBurst(now);
    burst.lastTriggerTime = now;
  }
  burst.prevYear = state.year;
  updateBurst(state, state.showLandmarks);

  if (ring.prevYear === null) ring.prevYear = state.year;
  if (
    shouldCelebrate({
      prevYear: ring.prevYear,
      year: state.year,
      threshold: CELEBRATION_1860_THRESHOLD,
      lastTriggerTime: ring.lastTriggerTime,
      now,
      cooldown: CELEBRATION_COOLDOWN,
      enabled,
    })
  ) {
    triggerRing(now);
    ring.lastTriggerTime = now;
  }
  ring.prevYear = state.year;
  updateRing(state, state.showLandmarks);
}

// ============================================================================
// Contrat de layer
// ============================================================================

export function init(ctx) {
  buildGhostEiffel(ctx);
  buildBeacon(ctx);
  buildBurst(ctx);
  buildRing(ctx);
  clearBurst();
  clearRing();
  burst.prevYear = null;
  ring.prevYear = null;
  burst.lastTriggerTime = -Infinity;
  ring.lastTriggerTime = -Infinity;
}

export function update(dt, state) {
  updateGhost(state);
  updateBeaconVisuals(state);
  updateCelebrations(state);
}

/** Diagnostic pour la vérification automatisée (window.__paris). */
export function debugState(state) {
  return {
    ghostOpacity: Math.round(eiffelGhostOpacity(state.year, state.time, state.reducedMotion) * 1000) / 1000,
    ghostVisible: ghost.group.visible,
    beaconVisible: beacon.halo.visible,
    burstActive: burst.active,
    burstParticlesVisible: burst.slots.filter((s) => s.mesh.visible).length,
    ringActive: ring.active,
  };
}

/** Nombre d'objets construits (coût de la couche). */
export function stats() {
  return {
    burstParticles: burst.slots.length,
  };
}
