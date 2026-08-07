/**
 * Narration — l'âme pédagogique du projet (tâche 15).
 *
 * Quatre morceaux, tous branchés sur le même `state` partagé et le même
 * `bus` que `ui.js` (voir main.js) :
 *
 *  1. **Carte-récit** : quand `state.year` entre dans ±8 ans d'une ancre de
 *     `MOMENTS`, une carte glisse en bas-gauche (année géante, titre, récit,
 *     ligne « chez nous », 🔊). Une hystérésis (`createCardTrigger`) garantit
 *     qu'elle n'apparaît qu'une fois par franchissement, pas à chaque frame
 *     passée dans la zone. Elle se replie en pastille après 12 s (ou au tap
 *     ailleurs, ou en quittant la zone) ; un tap sur la pastille la rouvre.
 *  2. **Voix** : `speechSynthesis`, voix française locale préférée, débit
 *     0,95. Le bouton global 🔊 (état partagé `state.voice`, déjà câblé par
 *     ui.js) déclenche la lecture automatique des cartes ; le bouton de la
 *     carte elle-même lit toujours, indépendamment du réglage global.
 *  3. **Monuments cliquables** : un tap court (< 200 ms, < 6 px — même
 *     discrimination tap/drag que controls.js pour ses propres gestes)
 *     raycaste contre les groupes de monuments *visibles* à l'année courante
 *     (`monuments.visibleGroups()` — three.js ne filtre pas lui-même sur
 *     `.visible`) et affiche une étiquette flottante.
 *  4. **✨ Montrer les zones** : fait pulser 3 s (émissif + échelle) tous les
 *     matériaux/groupes des monuments visibles ; sous `reducedMotion`, remplace
 *     l'animation par des anneaux de halo statiques.
 *  5. **Compteur d'habitants** : pastille discrète en haut à droite,
 *     interpolation log-échelle entre les populations de `MOMENTS`.
 *
 * Toute la logique *pure* (testable sans DOM ni WebGL) est exportée en haut
 * du fichier ; le reste (DOM, speechSynthesis, THREE) est le câblage vérifié
 * manuellement/par Playwright (voir task-15-report.md).
 */

import * as THREE from "three";
import { MOMENTS } from "./timeline.js";
import { momentBlend, lerp } from "./timeEngine.js";
import { monumentStatesAt, visibleGroups, MONUMENTS as MONUMENT_SITES } from "./layers/monuments.js";
import { MONUMENT_FOOTPRINTS } from "./geography.js";
import { groundHeightAt } from "./layers/terrain.js";
import { bus, formatYear } from "./ui.js";

// ============================================================================
// Constantes
// ============================================================================

export const CARD_THRESHOLD_YEARS = 8;
export const CARD_AUTO_COLLAPSE_SECONDS = 12;
export const ZONE_PULSE_SECONDS = 3;
const TAP_MAX_MS = 200;
const TAP_MAX_PX = 6;
/** Le scintillement/pulse n'a pas besoin de 60 recalculs de couleur par seconde. */
const PULSE_UPDATE_PERIOD = 1 / 20;

// ============================================================================
// Partie pure — hystérésis de la carte-récit
// ============================================================================

/**
 * Machine à état minimale : `evaluate(year)` renvoie l'index du moment
 * *nouvellement* entré (une fois par franchissement), ou `null` si rien de
 * neuf. `activeIndex` vaut -1 quand `year` n'est dans la zone ±`threshold`
 * d'aucune ancre — c'est ce qui « réarme » le prochain passage.
 * @param {Array<{year:number}>} [moments]
 * @param {number} [threshold] en années
 */
export function createCardTrigger(moments = MOMENTS, threshold = CARD_THRESHOLD_YEARS) {
  let activeIndex = -1;
  return {
    /**
     * @param {number} year
     * @returns {number|null} index dans `moments` d'une nouvelle entrée, sinon `null`
     */
    evaluate(year) {
      let nearest = -1;
      let best = Infinity;
      for (let i = 0; i < moments.length; i++) {
        const d = Math.abs(moments[i].year - year);
        if (d <= threshold && d < best) {
          best = d;
          nearest = i;
        }
      }
      if (nearest === -1) {
        activeIndex = -1;
        return null;
      }
      if (nearest === activeIndex) return null;
      activeIndex = nearest;
      return nearest;
    },
    get activeIndex() {
      return activeIndex;
    },
    reset() {
      activeIndex = -1;
    },
  };
}

// ============================================================================
// Partie pure — compteur d'habitants (interpolation log-échelle)
// ============================================================================

/**
 * Population interpolée à `year`, en échelle log entre les deux ancres de
 * `MOMENTS` qui l'entourent (`timeEngine.momentBlend`, déjà utilisé par la
 * frise pour la même segmentation). Exact aux ancres (t=0 par construction de
 * `momentBlend`), monotone à l'intérieur d'un segment (log1p/expm1 et lerp
 * sont tous deux monotones), constant avant -250 et après 2026 (comme
 * `momentBlend`).
 * @param {number} year
 * @param {Array<{year:number, population:number}>} [moments]
 * @returns {number}
 */
export function interpolatePopulation(year, moments = MOMENTS) {
  const anchors = moments.map((m) => m.year);
  const { i, j, t } = momentBlend(year, anchors);
  const pi = moments[i].population;
  if (i === j || t <= 0) return pi;
  const pj = moments[j].population;
  const li = Math.log1p(pi);
  const lj = Math.log1p(pj);
  return Math.expm1(lerp(li, lj, t));
}

/**
 * Arrondit une population à une précision "lisible" (10/100/1000/10000 selon
 * l'ordre de grandeur) avant affichage — sans ça, une valeur interpolée du
 * genre 111803,4 s'afficherait au chiffre près, ce qui trahirait
 * l'approximation que le « ≈ » promet déjà.
 * @param {number} n
 * @returns {number}
 */
export function roundPopulation(n) {
  const v = Math.max(0, n);
  if (v < 1000) return Math.round(v / 10) * 10;
  if (v < 10000) return Math.round(v / 100) * 100;
  if (v < 100000) return Math.round(v / 1000) * 1000;
  return Math.round(v / 10000) * 10000;
}

/** Ordre de grandeur (puissance de 10) — sert à détecter le changement qui déclenche le petit tick visuel. */
export function orderOfMagnitude(n) {
  return n > 0 ? Math.floor(Math.log10(n)) : 0;
}

/**
 * Texte final de la pastille, format français (espace fine insécable entre
 * les milliers via `toLocaleString('fr-FR')`).
 * @param {number} n
 * @returns {string}
 */
export function formatPopulation(n) {
  const rounded = roundPopulation(n);
  return `≈ ${rounded.toLocaleString("fr-FR")} habitants`;
}

// ============================================================================
// Partie pure — résolution d'un hit de raycast en entrée du registre
// ============================================================================

/**
 * Remonte la chaîne `parent` d'une intersection three.js jusqu'au premier
 * ancêtre portant `userData.monumentId` (posé par `monuments.js` sur le
 * groupe de premier niveau de chaque état), puis retrouve l'entrée du
 * registre (label/phrase) via `monumentStatesAt`. Pure au sens où elle
 * n'exige qu'un objet "intersection-like" — `{ object: { userData, parent } }`
 * — donc testable avec un mock sans three.js ni WebGL.
 * @param {{object: {userData?: object, parent?: object}}} intersection
 * @param {number} year
 * @param {Array} [entries] pour les tests — par défaut `monumentStatesAt(year)`
 * @returns {object|null}
 */
export function resolveMonumentHit(intersection, year, entries) {
  const list = entries ?? monumentStatesAt(year);
  let obj = intersection && intersection.object;
  while (obj) {
    const ud = obj.userData;
    if (ud && ud.monumentId) {
      return (
        list.find(
          (e) => e.monument === ud.monumentId && (!ud.stateId || e.state === ud.stateId)
        ) ?? null
      );
    }
    obj = obj.parent ?? null;
  }
  return null;
}

// ============================================================================
// Module state — DOM/THREE, non testé sous node --test (voir task-15-report.md)
// ============================================================================

let currentState = null;
let dom = null; // { storyCard, cardIcon, cardYear, cardTitre, cardRecit, cardCheznous, cardVoiceBtn, counter, label, labelTitle, labelPhrase, labelVoiceBtn }

const cardTrigger = createCardTrigger();
let cardShown = false;
let cardCollapsed = false;
let cardShownAt = 0;
let currentMoment = null;
let entryCount = 0; // diagnostic (hystérésis) — voir window.__paris.narration

let lastPopRounded = null;
let lastPopMagnitude = null;
let lastCounterWriteAt = -Infinity;
const COUNTER_MIN_PERIOD = 1 / 2; // "throttled ≥2/s max" = au plus 2 écritures par seconde

let currentLabelEntry = null;

// --- Voix -------------------------------------------------------------------

let voices = [];
let frVoice = null;

function hasSpeech() {
  return typeof window !== "undefined" && !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined";
}

function refreshVoices() {
  if (!hasSpeech()) return;
  voices = window.speechSynthesis.getVoices();
  frVoice =
    voices.find((v) => v.lang?.toLowerCase().startsWith("fr") && v.localService) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith("fr")) ||
    null;
  if (dom) {
    configureVoiceButton(dom.cardVoiceBtn);
    configureVoiceButton(dom.labelVoiceBtn);
  }
}

/**
 * Lit un texte en français si une voix fr est disponible. Annule toute
 * lecture en cours (`speechSynthesis.cancel()`) avant de démarrer — jamais de
 * file d'attente. @returns {boolean} true si une lecture a démarré.
 */
function speak(text) {
  if (!hasSpeech() || !frVoice) return false;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "fr-FR";
  utter.rate = 0.95;
  utter.voice = frVoice;
  window.speechSynthesis.speak(utter);
  return true;
}

function configureVoiceButton(btn) {
  if (!btn) return;
  const available = !!frVoice;
  btn.disabled = !available;
  btn.title = available ? "Écouter" : "voix française non disponible";
  btn.setAttribute("aria-label", btn.title);
  btn.classList.toggle("pdma-voice-unavailable", !available);
}

// --- Construction DOM --------------------------------------------------------

function buildCardDOM(root) {
  const storyCard = document.getElementById("story-card");
  storyCard.innerHTML = "";

  const top = document.createElement("div");
  top.className = "pdma-card-top";
  const icon = document.createElement("span");
  icon.className = "pdma-card-icon";
  const year = document.createElement("span");
  year.className = "pdma-card-year";
  top.appendChild(icon);
  top.appendChild(year);

  const body = document.createElement("div");
  body.className = "pdma-card-body";
  const titre = document.createElement("h3");
  titre.className = "pdma-card-titre";
  const recit = document.createElement("p");
  recit.className = "pdma-card-recit";
  const cheznous = document.createElement("p");
  cheznous.className = "pdma-card-cheznous";
  const voiceBtn = document.createElement("button");
  voiceBtn.type = "button";
  voiceBtn.className = "pdma-card-voice pdma-icon-btn";
  voiceBtn.textContent = "🔊";
  voiceBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (currentMoment) {
      speak(`${currentMoment.titre}. ${currentMoment.recit} ${currentMoment.chezNous}`);
    }
  });
  body.appendChild(titre);
  body.appendChild(recit);
  body.appendChild(cheznous);
  body.appendChild(voiceBtn);

  storyCard.appendChild(top);
  storyCard.appendChild(body);

  // Tap sur la pastille repliée : la rouvre (un tap sur la carte déjà
  // ouverte, lui, ne fait rien de spécial ici — le bouton voix gère son
  // propre stopPropagation pour ne pas être intercepté par ce handler).
  storyCard.addEventListener("click", () => {
    if (cardCollapsed) expandCard();
  });

  return { storyCard, cardIcon: icon, cardYear: year, cardTitre: titre, cardRecit: recit, cardCheznous: cheznous, cardVoiceBtn: voiceBtn };
}

function buildCounterDOM(root) {
  const counter = document.createElement("div");
  counter.className = "pdma-pop-counter";
  counter.setAttribute("aria-live", "polite");
  root.appendChild(counter);
  return counter;
}

function buildLabelDOM(root) {
  const label = document.createElement("div");
  label.className = "pdma-monument-label";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pdma-monument-label-close";
  closeBtn.setAttribute("aria-label", "Fermer");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeMonumentLabel();
  });

  const title = document.createElement("div");
  title.className = "pdma-monument-label-title";

  const phrase = document.createElement("div");
  phrase.className = "pdma-monument-label-phrase";

  const voiceBtn = document.createElement("button");
  voiceBtn.type = "button";
  voiceBtn.className = "pdma-monument-label-voice pdma-icon-btn";
  voiceBtn.textContent = "🔊";
  voiceBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (currentLabelEntry) speak(`${currentLabelEntry.label}. ${currentLabelEntry.phrase}`);
  });

  label.appendChild(closeBtn);
  label.appendChild(title);
  label.appendChild(phrase);
  label.appendChild(voiceBtn);
  root.appendChild(label);

  return { label, labelTitle: title, labelPhrase: phrase, labelVoiceBtn: voiceBtn };
}

// --- Carte-récit : affichage --------------------------------------------------

function showCard(moment) {
  cardShown = true;
  cardCollapsed = false;
  cardShownAt = currentState.time;
  currentMoment = moment;
  dom.cardIcon.textContent = moment.icon;
  dom.cardYear.textContent = formatYear(moment.year);
  dom.cardTitre.textContent = moment.titre;
  dom.cardRecit.textContent = moment.recit;
  dom.cardCheznous.textContent = `🏠 ${moment.chezNous}`;
  configureVoiceButton(dom.cardVoiceBtn);
  dom.storyCard.classList.add("pdma-shown");
  dom.storyCard.classList.remove("pdma-collapsed");
  if (currentState.voice) speak(`${moment.titre}. ${moment.recit} ${moment.chezNous}`);
}

function collapseCard() {
  cardCollapsed = true;
  dom.storyCard.classList.add("pdma-collapsed");
}

function expandCard() {
  if (!cardShown) return;
  cardCollapsed = false;
  cardShownAt = currentState.time; // rouvrir relance les 12 s
  dom.storyCard.classList.remove("pdma-collapsed");
}

function maybeTriggerCard() {
  const idx = cardTrigger.evaluate(currentState.year);
  if (idx !== null) {
    entryCount++;
    showCard(MOMENTS[idx]);
    return;
  }
  // `idx === null` recouvre deux cas bien différents : "toujours dans la même
  // zone" (ne rien faire — laisser vivre le minuteur de 12 s / l'état
  // replié/ouvert choisi par l'utilisateur) et "sorti de toute zone" (replier
  // si la carte était ouverte). `activeIndex` les distingue.
  if (cardTrigger.activeIndex === -1 && cardShown && !cardCollapsed) {
    collapseCard();
  }
}

function maybeAutoCollapse() {
  if (!cardShown || cardCollapsed) return;
  if (currentState.time - cardShownAt >= CARD_AUTO_COLLAPSE_SECONDS) collapseCard();
}

// --- Compteur d'habitants -----------------------------------------------------

function updateCounter(force) {
  const now = currentState.time;
  if (!force && now - lastCounterWriteAt < COUNTER_MIN_PERIOD) return;
  lastCounterWriteAt = now;
  const pop = interpolatePopulation(currentState.year);
  const rounded = roundPopulation(pop);
  if (rounded === lastPopRounded) return;
  lastPopRounded = rounded;
  dom.counter.textContent = formatPopulation(pop);
  const magnitude = orderOfMagnitude(rounded);
  if (lastPopMagnitude !== null && magnitude !== lastPopMagnitude && !currentState.reducedMotion) {
    dom.counter.classList.remove("pdma-pop-tick");
    // Force un reflow pour pouvoir rejouer l'animation même si elle vient de tourner.
    // eslint-disable-next-line no-unused-expressions
    dom.counter.offsetWidth;
    dom.counter.classList.add("pdma-pop-tick");
  }
  lastPopMagnitude = magnitude;
}

// --- Monuments cliquables : raycast -------------------------------------------

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let pointerDownInfo = null; // {x, y, t, id}

function closeMonumentLabel() {
  dom.label.classList.remove("pdma-open");
  currentLabelEntry = null;
}

function showMonumentLabel(entry, clientX, clientY) {
  dom.labelTitle.textContent = entry.label;
  dom.labelPhrase.textContent = entry.phrase;
  configureVoiceButton(dom.labelVoiceBtn);
  currentLabelEntry = entry;
  dom.label.classList.add("pdma-open");
  // Position clampée pour ne jamais déborder du viewport (approx. 300x150 —
  // le CSS a un max-width qui garantit que le débord réel, s'il y en a, reste
  // minime).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = 300;
  const h = 150;
  const left = Math.min(Math.max(8, clientX - w / 2), Math.max(8, vw - w - 8));
  const top = Math.min(Math.max(8, clientY - h - 24), Math.max(8, vh - h - 8));
  dom.label.style.left = `${left}px`;
  dom.label.style.top = `${top}px`;
}

function handleCanvasTap(clientX, clientY, ctx) {
  const rect = ctx.canvas.getBoundingClientRect();
  _ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  _raycaster.setFromCamera(_ndc, ctx.camera);
  const targets = visibleGroups();
  const hits = targets.length ? _raycaster.intersectObjects(targets, true) : [];
  if (!hits.length) {
    closeMonumentLabel();
    return;
  }
  const entry = resolveMonumentHit(hits[0], currentState.year);
  if (entry) showMonumentLabel(entry, clientX, clientY);
  else closeMonumentLabel();
}

function attachCanvasTap(ctx) {
  const canvas = ctx.canvas;
  canvas.addEventListener("pointerdown", (e) => {
    pointerDownInfo = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!pointerDownInfo || pointerDownInfo.id !== e.pointerId) return;
    const elapsed = performance.now() - pointerDownInfo.t;
    const dist = Math.hypot(e.clientX - pointerDownInfo.x, e.clientY - pointerDownInfo.y);
    pointerDownInfo = null;
    // Discrimination tap/drag : même seuils que le geste d'orbite de
    // controls.js sur le même canvas — un drag de caméra ne doit jamais être
    // pris pour un tap sur un monument.
    if (elapsed > TAP_MAX_MS || dist > TAP_MAX_PX) return;
    handleCanvasTap(e.clientX, e.clientY, ctx);
  });
  canvas.addEventListener("pointercancel", () => {
    pointerDownInfo = null;
  });
}

/** Un tap sur le reste de l'UI (boutons, frise, popovers) ferme l'étiquette ouverte. */
function attachOutsideTapHandling(ctx) {
  document.addEventListener("pointerdown", (e) => {
    if (!dom.label.classList.contains("pdma-open")) return;
    if (dom.label.contains(e.target) || e.target === ctx.canvas) return;
    closeMonumentLabel();
  });
}

// --- ✨ Montrer les zones : pulse émissif/échelle, ou halos statiques --------

const HIGHLIGHT_COLOR = new THREE.Color(0xfff2b0);
const _scratchColor = new THREE.Color();

let zonePulse = null; // { startTime, lastWrite, groups: [{group, baseScale}], materials: [{material, base}] }
let haloRings = []; // construits une fois, réutilisés — un par site de MONUMENT_SITES
let ringsHiddenAt = null;

function ensureHaloRings(ctx) {
  if (haloRings.length) return;
  for (const m of MONUMENT_SITES) {
    const footprint = MONUMENT_FOOTPRINTS.find((f) => f.id === m.id);
    const r = (footprint ? footprint.r : 6) * 1.15;
    const geometry = new THREE.RingGeometry(r * 0.82, r, 40);
    const material = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(m.x, groundHeightAt(m.x, m.z) + 0.2, m.z);
    mesh.visible = false;
    mesh.renderOrder = 5;
    ctx.scene.add(mesh);
    haloRings.push({ monumentId: m.id, mesh });
  }
}

function collectPulseTargets() {
  const groups = visibleGroups();
  const matSet = new Map();
  for (const g of groups) {
    g.traverse((child) => {
      const m = child.material;
      if (m && m.emissive && !matSet.has(m)) matSet.set(m, m.emissive.clone());
    });
  }
  return {
    groups: groups.map((g) => ({ group: g, baseScale: g.scale.clone() })),
    materials: [...matSet.entries()].map(([material, base]) => ({ material, base })),
  };
}

function showStaticRings() {
  const presentIds = new Set(monumentStatesAt(currentState.year).map((e) => e.monument));
  for (const { monumentId, mesh } of haloRings) {
    if (!presentIds.has(monumentId)) continue;
    mesh.visible = true;
    mesh.material.opacity = 0.85;
  }
  ringsHiddenAt = currentState.time + ZONE_PULSE_SECONDS;
}

function updateStaticRings() {
  if (ringsHiddenAt === null || currentState.time < ringsHiddenAt) return;
  for (const { mesh } of haloRings) {
    mesh.visible = false;
    mesh.material.opacity = 0;
  }
  ringsHiddenAt = null;
}

function startZonePulse() {
  if (currentState.reducedMotion) {
    showStaticRings();
    return;
  }
  zonePulse = { startTime: currentState.time, lastWrite: -Infinity, ...collectPulseTargets() };
}

function updateZonePulse() {
  if (!zonePulse) return;
  const t = currentState.time - zonePulse.startTime;
  if (t >= ZONE_PULSE_SECONDS) {
    for (const { material, base } of zonePulse.materials) material.emissive.copy(base);
    for (const { group, baseScale } of zonePulse.groups) group.scale.copy(baseScale);
    zonePulse = null;
    return;
  }
  if (currentState.time - zonePulse.lastWrite < PULSE_UPDATE_PERIOD) return;
  zonePulse.lastWrite = currentState.time;
  const wave = 0.5 + 0.5 * Math.sin(t * 10);
  for (const { material, base } of zonePulse.materials) {
    _scratchColor.copy(base).lerp(HIGHLIGHT_COLOR, wave * 0.85 + 0.05);
    material.emissive.copy(_scratchColor);
  }
  const scaleFactor = 1 + wave * 0.05;
  for (const { group, baseScale } of zonePulse.groups) {
    group.scale.set(baseScale.x * scaleFactor, baseScale.y * scaleFactor, baseScale.z * scaleFactor);
  }
}

// ============================================================================
// Contrat public — appelé par main.js (pas dans le tableau `layers`, car ce
// module a aussi besoin du canvas DOM et du bus, que les autres layers
// n'ont pas)
// ============================================================================

/**
 * @param {{scene: THREE.Scene, camera: THREE.Camera, canvas: HTMLCanvasElement}} ctx
 * @param {object} state
 */
export function init(ctx, state) {
  currentState = state;
  const root = document.getElementById("pdma-ui");
  dom = {
    ...buildCardDOM(root),
    counter: buildCounterDOM(root),
    ...buildLabelDOM(root),
  };

  ensureHaloRings(ctx);
  attachCanvasTap(ctx);
  attachOutsideTapHandling(ctx);

  if (hasSpeech()) {
    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
  } else {
    configureVoiceButton(dom.cardVoiceBtn);
    configureVoiceButton(dom.labelVoiceBtn);
  }

  bus.addEventListener("showzones", () => startZonePulse());

  cardTrigger.reset();
  lastPopRounded = null;
  lastPopMagnitude = null;
  lastCounterWriteAt = -Infinity;
  // L'appli démarre à state.year = 2026, qui est lui-même la dernière ancre
  // de MOMENTS (d=0 <= 8) : la toute première carte doit déjà être visible,
  // sans attendre que l'utilisateur ne bouge la frise.
  maybeTriggerCard();
  updateCounter(true);
}

/**
 * @param {number} dt secondes
 * @param {object} state
 */
export function update(dt, state) {
  currentState = state;
  maybeTriggerCard();
  maybeAutoCollapse();
  updateCounter(false);
  updateZonePulse();
  updateStaticRings();
}

// ============================================================================
// Diagnostic — utilisé par window.__paris.narration (main.js) pour la
// vérification automatisée (Playwright) de la tâche 15.
// ============================================================================

export function debugState() {
  return {
    cardShown,
    cardCollapsed,
    momentIndex: cardTrigger.activeIndex,
    entryCount,
    population: currentState ? interpolatePopulation(currentState.year) : null,
    labelOpen: dom ? dom.label.classList.contains("pdma-open") : false,
    frVoiceAvailable: !!frVoice,
  };
}

export function debugVoices() {
  return voices.map((v) => ({ name: v.name, lang: v.lang, localService: v.localService }));
}
