/**
 * Sons d'ambiance procéduraux — 100 % synthèse Web Audio, aucun fichier.
 *
 * Suit le même contrat init/update que les couches 3D (`layers/*.js`) sans en
 * être une : pas de scène three.js, juste un graphe Web Audio piloté par les
 * mêmes signaux que la lumière (`state.year` via `momentBlend`, comme
 * `weather.js` le fait pour les signatures d'époque) et par la météo
 * (`state.weather`).
 *
 * ============================================================================
 * Architecture
 *
 *  - Un seul `AudioContext`, créé **paresseusement** au premier geste — ici
 *    précisément le clic sur 🔈 (voir l'écouteur `bus.addEventListener(
 *    "soundchange", ...)` ci-dessous : il tourne *synchrone* dans la pile du
 *    clic, ce qui satisfait la politique autoplay des navigateurs sans
 *    écouteur générique supplémentaire sur `pointerdown`/`keydown`).
 *  - Un `GainNode` maître à 0 par défaut, fondu à ~0,5 sur 0,8 s à l'aller,
 *    et suspendu (`ctx.suspend()`) après le fondu retour pour ne rien
 *    consommer de CPU quand le son est coupé.
 *  - Sept bus de « nappe » (nature, cloches, foule, siège, vapeur,
 *    circulation, pluie), chacun un `GainNode` unique vers lequel converge à
 *    la fois le lit continu de la nappe (bruit filtré en boucle) et ses
 *    événements ponctuels (chants d'oiseau, volée de cloches, coup de
 *    klaxon…) — leur gain suit `nappeWeights(year)` (+ modulateurs météo/
 *    distance caméra), amorti par `setTargetAtTime` pour ne jamais cliquer.
 *  - Un unique buffer de bruit blanc de 2 s, généré une fois (PRNG "seedé",
 *    mulberry32) et rejoué en boucle par toutes les nappes à base de bruit —
 *    jamais de fichier audio, jamais de buffer recréé par frame.
 *
 * ============================================================================
 * reducedMotion : choix documenté — le son N'Y OBÉIT PAS
 *
 * `state.reducedMotion` gèle les animations *visuelles* (respiration des
 * foules, scintillement du fantôme…) mais le son n'est pas une animation :
 * couper l'ambiance sonore parce qu'un enfant a demandé moins de mouvement à
 * l'écran retirerait une information qui n'a rien à voir avec le motion
 * sickness. `update()` ci-dessous ne lit donc jamais `state.reducedMotion` —
 * c'est intentionnel, pas un oubli.
 *
 * ============================================================================
 * Ce qui est pur et testable (Node, sans DOM ni Web Audio)
 *
 * `nappeWeights`, `ringProximityGain`, `bellPartials`, `populationToGain` (et
 * les tables `NATURE_TABLE`/`CLOCHES_TABLE`) ne touchent aucun nœud audio :
 * ce sont de simples fonctions de `year`/`distance`/`population` → nombre,
 * voir `test/audio.test.js`. Tout ce qui construit réellement le graphe
 * (oscillateurs, filtres, buffers) reste volontairement mince et n'est
 * vérifié qu'au navigateur (analyseur + lecture réelle par l'utilisateur).
 */

import { bus } from "./ui.js";
import { MOMENTS } from "./timeline.js";
import { momentBlend, lerp, smoothstep } from "./timeEngine.js";
import { RINGS, distanceToRing } from "./geography.js";

// ============================================================================
// Réglages du mix — "doux, jamais agressif" (oreilles d'enfant)
// ============================================================================

/** Gain maître visé quand 🔈 est activé (jamais plus fort que ça). */
export const MASTER_TARGET = 0.5;
/** Durée du fondu maître (activation/coupure), en secondes. */
const MASTER_FADE = 0.8;

/** Plafond dur, appliqué après tout multiplicateur (proximité, boost…) — aucune nappe ne peut le dépasser, même boostée. */
export const HARD_CAP = 0.35;

/** Plafonds par nappe avant tout multiplicateur de distance/boost — tous ≤ HARD_CAP. */
export const NAPPE_CAPS = {
  nature: 0.3,
  cloches: 0.28,
  foule: 0.3,
  siege: 0.32,
  vapeur: 0.3,
  circulation: 0.3,
  pluie: 0.25,
};

/** Constante de temps des transitions de gain par nappe (setTargetAtTime) — douce, sans clic. */
const GAIN_TIME_CONSTANT = 0.6;

/** Fréquence de recalcul des poids/planification d'événements — 4×/s, pas par frame. */
const TICK_INTERVAL = 0.25;

/** Sous ce poids, on ne planifie même plus les événements ponctuels d'une nappe (économie CPU pour un son inaudible). */
const MIN_AUDIBLE = 0.03;

// ============================================================================
// Partie pure — testable en Node (voir test/audio.test.js)
// ============================================================================

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Enveloppe temporelle lisse : 0 avant `start - fadeIn`, 1 entre `start` et
 * `end`, retour à 0 après `end + fadeOut` — utilisée pour les nappes bornées
 * dans le temps (siège, vapeur, circulation) plutôt que la table par moment
 * (leurs fenêtres sont beaucoup plus étroites que l'écart entre deux ancres
 * de la frise).
 * @param {number} year
 * @param {number} start
 * @param {number} end
 * @param {number} [fadeIn=10]
 * @param {number} [fadeOut=10]
 * @returns {number} poids [0,1]
 */
function windowEnvelope(year, start, end, fadeIn = 10, fadeOut = 10) {
  const rise = smoothstep((year - (start - fadeIn)) / fadeIn);
  const fall = 1 - smoothstep((year - end) / fadeOut);
  return Math.min(rise, fall);
}

/**
 * Table par moment (même principe que `weather.js`/`SIGNATURES`) : une entrée
 * par ancre de `timeline.MOMENTS`, interpolée par `momentBlend` — le fondu
 * suit exactement le même mécanisme que la lumière.
 * @param {number} year
 * @param {number[]} table
 * @returns {number}
 */
function momentTableWeight(year, table) {
  const { i, j, t } = momentBlend(year, MOMENT_YEARS);
  return lerp(table[i], table[j], t);
}

const MOMENT_YEARS = MOMENTS.map((m) => m.year);

/**
 * Nature — forte aux moments 1-2 (-250, 200 : Lutèce des Parisii/romaine),
 * puis résiduelle (jamais nulle : oiseaux et rivière ne disparaissent
 * jamais complètement, même en 2026 où la petite ceinture se réensauvage).
 */
export const NATURE_TABLE = [1, 0.9, 0.35, 0.25, 0.2, 0.15, 0.13, 0.1, 0.1, 0.09, 0.08, 0.08, 0.1, 0.15];

/**
 * Cloches — quasi nulles avant Notre-Dame, apogée médiévale/moderne (moments
 * 4-9 : 1200 à 1865), puis déclin progressif face à la circulation, sans
 * jamais atteindre 0 (les cloches sonnent encore un peu en 2026).
 */
export const CLOCHES_TABLE = [0, 0.05, 0.25, 0.85, 1.0, 0.95, 0.85, 0.7, 0.65, 0.4, 0.25, 0.15, 0.08, 0.05];

/** Fenêtre du siège des Vikings (moment 3 uniquement) — pic plat autour de 885. */
const SIEGE_START = 860;
const SIEGE_END = 910;
const SIEGE_FADE = 15;

/** Fenêtre de la vapeur de la petite ceinture (1869-1934). */
const VAPEUR_START = 1869;
const VAPEUR_END = 1934;
const VAPEUR_FADE = 8;

/** La circulation monte à partir de 1950 et ne redescend jamais dans la frise. */
const CIRCULATION_START = 1950;
const CIRCULATION_FADE_IN = 15;

/** Référence de population pour la mise à l'échelle logarithmique de la foule — même ordre de grandeur que `life.js` (pic de la frise : 2 900 000 en 1934). */
export const POP_GAIN_REF = 3_000_000;

/**
 * Population → gain de la nappe foule, échelle logarithmique (une ville de
 * 1000 habitants et une ville de 3 000 000 ne doivent pas différer d'un
 * facteur 3000 à l'oreille). Monotone croissante en population.
 * @param {number} population
 * @returns {number} [0,1]
 */
export function populationToGain(population) {
  const p = Math.max(0, population);
  return clamp01(Math.log10(p + 1) / Math.log10(POP_GAIN_REF + 1));
}

/** Population interpolée à une année (même formule que `life.js`'s `populationAt`, dupliquée ici pour ne pas coupler `audio.js` à la couche `life`). */
function populationAt(year) {
  const { i, j, t } = momentBlend(year, MOMENT_YEARS);
  return lerp(MOMENTS[i].population, MOMENTS[j].population, t);
}

/**
 * Table de poids des sept nappes pour une année donnée — pure, sans aucun
 * nœud audio. C'est elle que `update()` interroge à chaque tick, et elle
 * qu'exercent les tests Node (885 → siège ≈ 1 & cloches partielles ;
 * 1900 → vapeur active & foule haute ; 2026 → circulation + nature
 * résiduelle, vapeur nulle). La nappe pluie n'y figure pas : elle dépend de
 * `state.weather`, pas de l'année (voir `update()`).
 * @param {number} year
 * @returns {{nature:number, cloches:number, foule:number, siege:number, vapeur:number, circulation:number}}
 */
export function nappeWeights(year) {
  return {
    nature: momentTableWeight(year, NATURE_TABLE),
    cloches: momentTableWeight(year, CLOCHES_TABLE),
    foule: populationToGain(populationAt(year)),
    siege: windowEnvelope(year, SIEGE_START, SIEGE_END, SIEGE_FADE, SIEGE_FADE),
    vapeur: windowEnvelope(year, VAPEUR_START, VAPEUR_END, VAPEUR_FADE, VAPEUR_FADE),
    circulation: windowEnvelope(year, CIRCULATION_START, Infinity, CIRCULATION_FADE_IN, 1),
  };
}

/** Distance caméra↔anneau (petite ceinture ou périphérique) au-delà de laquelle le boost sonore associé s'annule. */
export const PC_NEAR = 50;
export const PC_FAR = 400;
const PERIPH_NEAR = 60;
const PERIPH_FAR = 500;
const PERIPH_BOOST = 0.6;
const PERIPH_YEAR = 1973;

/**
 * Courbe de gain par proximité à un anneau : 1 sous `near`, 0 au-delà de
 * `far`, transition lisse (smoothstep) entre les deux — monotone
 * décroissante. Utilisée pour la vapeur de la petite ceinture (50u→1,
 * 400u→0, valeurs par défaut) et le boost circulation près du périphérique.
 * @param {number} distance
 * @param {number} [near=PC_NEAR]
 * @param {number} [far=PC_FAR]
 * @returns {number} [0,1]
 */
export function ringProximityGain(distance, near = PC_NEAR, far = PC_FAR) {
  if (distance <= near) return 1;
  if (distance >= far) return 0;
  return 1 - smoothstep((distance - near) / (far - near));
}

/** Ratios des partiels inharmoniques d'une cloche (fondamentale ×1, ×2.76, ×5.4). */
export const BELL_PARTIAL_RATIOS = [1, 2.76, 5.4];

/**
 * Fréquences des trois partiels d'une cloche pour une fondamentale donnée.
 * @param {number} fundamental Hz
 * @returns {number[]} [fondamentale, partiel1, partiel2] en Hz
 */
export function bellPartials(fundamental) {
  return BELL_PARTIAL_RATIOS.map((r) => fundamental * r);
}

/** Décroissance exponentielle d'un coup de cloche, en secondes. */
const BELL_DECAY = 4;

// ============================================================================
// PRNG seedé — buffer de bruit blanc partagé (mulberry32, déterministe)
// ============================================================================

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE_BUFFER_SECONDS = 2;
const NOISE_SEED = 0x5eed1;

function buildNoiseBuffer(ctx) {
  const length = Math.round(ctx.sampleRate * NOISE_BUFFER_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rand = mulberry32(NOISE_SEED);
  for (let n = 0; n < length; n++) data[n] = rand() * 2 - 1;
  return buffer;
}

// ============================================================================
// État du module (Web Audio — jamais exercé en Node)
// ============================================================================

let audioCtx = null;
let master = null;
let analyser = null;
let noiseBuffer = null;
let cameraRef = null;
let suspendTimer = null;
let tickAccum = 0;
let shouldAutoStartOnGesture = false;
let gestureListenerAttached = false;

/** Un GainNode par nappe — clé = nom de nappe (voir NAPPE_CAPS). */
const gains = {};

/** Prochain instant de déclenchement (ctx.currentTime) pour chaque générateur d'événement ponctuel. */
const timers = {
  birds: [0, 0, 0],
  bellVolley: 0,
  drum: 0,
  fireBurst: 0,
  chuff: 0,
  whistle: 0,
  horn: 0,
  rainGrain: 0,
};

function ensureContext() {
  if (audioCtx) return;
  const AudioContextClass =
    typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : undefined;
  if (!AudioContextClass) return; // pas de Web Audio : on reste silencieux, jamais en erreur

  audioCtx = new AudioContextClass();
  master = audioCtx.createGain();
  master.gain.value = 0;
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  master.connect(analyser);
  analyser.connect(audioCtx.destination);

  noiseBuffer = buildNoiseBuffer(audioCtx);
  buildNappes(audioCtx);

  const now = audioCtx.currentTime;
  for (let v = 0; v < timers.birds.length; v++) timers.birds[v] = now + Math.random() * 4;
  timers.bellVolley = now + 5 + Math.random() * 15;
  timers.drum = now + Math.random() * 3;
  timers.fireBurst = now;
  timers.chuff = now;
  timers.whistle = now + 10 + Math.random() * 20;
  timers.horn = now + Math.random() * 30;
  timers.rainGrain = now;
}

/** Construit les sept bus de nappe et leurs lits continus (nature/rivière, foule, circulation, pluie). Les événements ponctuels (oiseaux, cloches, feu, tambour, chuff, sifflet, klaxon, grains de pluie) sont créés à la demande — voir scheduleEvents. */
function buildNappes(ctx) {
  for (const name of Object.keys(NAPPE_CAPS)) {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(master);
    gains[name] = g;
  }

  buildRiverBed(ctx);
  buildFouleBed(ctx);
  buildCirculationBed(ctx);
  buildPluieBed(ctx);
}

function buildLoopedNoise(ctx) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  src.start();
  return src;
}

/** Lit de rivière — bruit → passe-bas 400 Hz → LFO lent de gain (rivière qui "respire"). */
function buildRiverBed(ctx) {
  const src = buildLoopedNoise(ctx);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 400;

  const bed = ctx.createGain();
  bed.gain.value = 0.85;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.06; // ~16 s de cycle, lent
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.15;
  lfo.connect(lfoDepth);
  lfoDepth.connect(bed.gain);
  lfo.start();

  src.connect(lowpass);
  lowpass.connect(bed);
  bed.connect(gains.nature);
}

/** Lit de foule — bruit → passe-bande 300-800 Hz (rose-ish) → LFO lent (murmure modulé). */
function buildFouleBed(ctx) {
  const src = buildLoopedNoise(ctx);
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 500;
  bandpass.Q.value = 0.7;

  const bed = ctx.createGain();
  bed.gain.value = 0.8;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.18;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.2;
  lfo.connect(lfoDepth);
  lfoDepth.connect(bed.gain);
  lfo.start();

  src.connect(bandpass);
  bandpass.connect(bed);
  bed.connect(gains.foule);
}

/** Lit de circulation — bruit → deux passe-bas 250 Hz en cascade (roll-off plus marqué, "brun-ish") → rumeur continue. */
function buildCirculationBed(ctx) {
  const src = buildLoopedNoise(ctx);
  const lowpass1 = ctx.createBiquadFilter();
  lowpass1.type = "lowpass";
  lowpass1.frequency.value = 250;
  const lowpass2 = ctx.createBiquadFilter();
  lowpass2.type = "lowpass";
  lowpass2.frequency.value = 250;

  src.connect(lowpass1);
  lowpass1.connect(lowpass2);
  lowpass2.connect(gains.circulation);
}

/** Lit de pluie — bruit → highshelf (brillance type "pluie") → lit continu modéré. Les grains ponctuels s'ajoutent par-dessus (voir playRainGrain). */
function buildPluieBed(ctx) {
  const src = buildLoopedNoise(ctx);
  const highshelf = ctx.createBiquadFilter();
  highshelf.type = "highshelf";
  highshelf.frequency.value = 2500;
  highshelf.gain.value = 8;

  const bed = ctx.createGain();
  bed.gain.value = 0.6;

  src.connect(highshelf);
  highshelf.connect(bed);
  bed.connect(gains.pluie);
}

// ============================================================================
// Événements ponctuels — créés à la demande, jamais par frame
// ============================================================================

/** Chant d'oiseau — blip sinus 2-4 kHz, enveloppe ~60 ms. */
function playBirdChirp(when) {
  const freq = 2000 + Math.random() * 2000;
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, when);
  osc.frequency.linearRampToValueAtTime(freq * (0.85 + Math.random() * 0.3), when + 0.06);

  const env = audioCtx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(1, when + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);

  osc.connect(env);
  env.connect(gains.nature);
  osc.start(when);
  osc.stop(when + 0.09);
}

/** Un coup de cloche : fondamentale + deux partiels inharmoniques (bellPartials), décroissance exponentielle ~4 s. */
function playBellStrike(when, fundamental) {
  const partials = bellPartials(fundamental);
  const peaks = [0.9, 0.45, 0.25];
  partials.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const env = audioCtx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peaks[idx], when + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, when + BELL_DECAY);
    osc.connect(env);
    env.connect(gains.cloches);
    osc.start(when);
    osc.stop(when + BELL_DECAY + 0.1);
  });
}

/** Une volée : 3-6 coups espacés de 0,6-1,2 s, pitch qui varie d'une volée à l'autre. */
function playBellVolley(now) {
  const fundamental = 180 + Math.random() * 80;
  const strikeCount = 3 + Math.floor(Math.random() * 4);
  let t = now;
  for (let s = 0; s < strikeCount; s++) {
    playBellStrike(t, fundamental * (0.97 + Math.random() * 0.06));
    t += 0.6 + Math.random() * 0.6;
  }
}

/** Tambour lointain du siège — sinus 60 Hz, décroissance courte. */
function playDrumThump(when) {
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 60;
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(0.9, when + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, when + 0.4);
  osc.connect(env);
  env.connect(gains.siege);
  osc.start(when);
  osc.stop(when + 0.45);
}

/** Crépitement de feu — tranche de bruit → passe-haut 3 kHz → burst d'enveloppe très court. */
function playFireCrackleBurst(when) {
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer;
  const dur = 0.03 + Math.random() * 0.06;
  const offset = Math.random() * (noiseBuffer.duration - dur - 0.01);
  const highpass = audioCtx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 3000;
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(0.5 + Math.random() * 0.3, when + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(highpass);
  highpass.connect(env);
  env.connect(gains.siege);
  src.start(when, offset, dur + 0.02);
  src.stop(when + dur + 0.03);
}

/** Un "chuff" de vapeur — bruit → passe-bande 200-600 Hz → enveloppe courte, cadencé à ~2 Hz par le planificateur. */
function playChuffBurst(when) {
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer;
  const dur = 0.18;
  const offset = Math.random() * (noiseBuffer.duration - dur - 0.01);
  const bandpass = audioCtx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 200 + Math.random() * 400;
  bandpass.Q.value = 1.2;
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(0.6, when + 0.015);
  env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(bandpass);
  bandpass.connect(env);
  env.connect(gains.vapeur);
  src.start(when, offset, dur + 0.02);
  src.stop(when + dur + 0.03);
}

/** Sifflet de la petite ceinture — deux sinus 620+930 Hz, enveloppe 1,2 s. */
function playWhistle(when) {
  const freqs = [620, 930];
  const peaks = [0.8, 0.5];
  freqs.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const env = audioCtx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peaks[idx], when + 0.15);
    env.gain.setValueAtTime(peaks[idx], when + 0.9);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 1.2);
    osc.connect(env);
    env.connect(gains.vapeur);
    osc.start(when);
    osc.stop(when + 1.3);
  });
}

/** Klaxon rare — sawtooth 400 Hz, 150 ms. */
function playHorn(when) {
  const osc = audioCtx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 400;
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(0.5, when + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, when + 0.15);
  osc.connect(env);
  env.connect(gains.circulation);
  osc.start(when);
  osc.stop(when + 0.18);
}

/** Grain de pluie — micro-burst de bruit, texture par-dessus le lit continu. */
function playRainGrain(when) {
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer;
  const dur = 0.02 + Math.random() * 0.05;
  const offset = Math.random() * (noiseBuffer.duration - dur - 0.01);
  const highpass = audioCtx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 2000;
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(0.25 + Math.random() * 0.15, when + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(highpass);
  highpass.connect(env);
  env.connect(gains.pluie);
  src.start(when, offset, dur + 0.01);
  src.stop(when + dur + 0.02);
}

// ============================================================================
// Fondu maître (bus "soundchange") + planification (update throttlée)
// ============================================================================

function setTarget(gainNode, value, now) {
  const target = Math.min(HARD_CAP, Math.max(0, value));
  gainNode.gain.setTargetAtTime(target, now, GAIN_TIME_CONSTANT);
}

function fadeIn() {
  ensureContext();
  if (!audioCtx) return;
  clearTimeout(suspendTimer);
  if (audioCtx.state !== "running") audioCtx.resume();
  const now = audioCtx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.linearRampToValueAtTime(MASTER_TARGET, now + MASTER_FADE);
}

function fadeOut() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.linearRampToValueAtTime(0, now + MASTER_FADE);
  clearTimeout(suspendTimer);
  // On suspend un peu après la fin du fondu (marge de sécurité) plutôt qu'exactement
  // à MASTER_FADE : le contexte n'a plus besoin de tourner une fois le silence atteint.
  suspendTimer = setTimeout(() => {
    if (audioCtx && audioCtx.state === "running") audioCtx.suspend();
  }, MASTER_FADE * 1000 + 60);
}

function attachGestureListener() {
  if (gestureListenerAttached) return;
  gestureListenerAttached = true;

  const handleGesture = () => {
    if (shouldAutoStartOnGesture) {
      shouldAutoStartOnGesture = false;
      fadeIn();
    }
    document.removeEventListener("pointerdown", handleGesture);
    document.removeEventListener("keydown", handleGesture);
  };

  document.addEventListener("pointerdown", handleGesture, true);
  document.addEventListener("keydown", handleGesture, true);
}

// Écouteur direct sur le bus (même famille que narration.js et son écouteur
// "showzones") : c'est le clic sur 🔈 lui-même qui sert de "geste utilisateur"
// pour l'autoplay — voir le docstring en tête de fichier.
// Si sound est activé AVANT un geste utilisateur (son par défaut ON), on arme
// le drapeau shouldAutoStartOnGesture ; le premier clic/touche/clavier l'amorce.
// Cliquer 🔈 pour désactiver AVANT le geste annule le démarrage en attente.
bus.addEventListener("soundchange", (event) => {
  if (event.detail.enabled) {
    // Son activé : si pas de contexte encore, armer le drapeau pour le geste
    if (!audioCtx) {
      shouldAutoStartOnGesture = true;
      attachGestureListener();
    } else {
      // Contexte existe déjà, fade in maintenant
      fadeIn();
    }
  } else {
    // Son désactivé : cancel le démarrage en attente et fade out
    shouldAutoStartOnGesture = false;
    fadeOut();
  }
});

function scheduleEvents(weights, vapeurAudible, state, now) {
  if (weights.nature > MIN_AUDIBLE) {
    for (let v = 0; v < timers.birds.length; v++) {
      if (now >= timers.birds[v]) {
        playBirdChirp(now + Math.random() * 0.2);
        timers.birds[v] = now + 2 + Math.random() * 6;
      }
    }
  }
  if (weights.cloches > MIN_AUDIBLE && now >= timers.bellVolley) {
    playBellVolley(now);
    timers.bellVolley = now + 20 + Math.random() * 20;
  }
  if (weights.siege > MIN_AUDIBLE) {
    if (now >= timers.drum) {
      playDrumThump(now);
      timers.drum = now + 3 + Math.random() * 3;
    }
    if (now >= timers.fireBurst) {
      playFireCrackleBurst(now);
      timers.fireBurst = now + 0.06 + Math.random() * 0.2;
    }
  }
  if (vapeurAudible > MIN_AUDIBLE) {
    if (now >= timers.chuff) {
      playChuffBurst(now);
      timers.chuff = now + 0.42 + Math.random() * 0.16; // ~2 Hz
    }
    if (now >= timers.whistle) {
      playWhistle(now);
      timers.whistle = now + 30 + Math.random() * 30; // 45 s ± 15 s
    }
  }
  if (weights.circulation > MIN_AUDIBLE && now >= timers.horn) {
    playHorn(now);
    timers.horn = now + 30 + Math.random() * 60;
  }
  if (state.weather === "rain" && now >= timers.rainGrain) {
    playRainGrain(now);
    timers.rainGrain = now + 0.08 + Math.random() * 0.17;
  }
}

// ============================================================================
// Contrat de layer
// ============================================================================

/** @param {{camera: object}} ctx Même `ctx` que les couches 3D — seule `camera` nous intéresse (distance aux anneaux). */
export function init(ctx) {
  cameraRef = ctx.camera ?? null;
  // Son ON par défaut (state.sound = true) — armer le drapeau pour démarrage
  // au premier geste utilisateur (respect politique autoplay navigateur).
  shouldAutoStartOnGesture = true;
  attachGestureListener();
}

/**
 * Throttlé à `TICK_INTERVAL` (~4×/s) : pas de recalcul de poids ni de
 * planification d'événement à chaque frame. Ne fait rien tant qu'aucun geste
 * n'a créé le contexte, et rien non plus quand il est suspendu (son coupé) —
 * voir `reducedMotion`, volontairement absent d'ici (docstring en tête de
 * fichier).
 * @param {number} dt secondes
 * @param {{year:number, weather:string}} state
 */
export function update(dt, state) {
  if (!audioCtx) return;
  tickAccum += dt;
  if (tickAccum < TICK_INTERVAL) return;
  tickAccum = 0;
  if (audioCtx.state !== "running") return;

  const year = state.year;
  const weights = nappeWeights(year);
  const now = audioCtx.currentTime;

  let vapeurDist = 1;
  let periphBoost = 0;
  if (cameraRef) {
    const distPC = distanceToRing(cameraRef.position.x, cameraRef.position.z, RINGS.petiteCeinture);
    vapeurDist = ringProximityGain(distPC, PC_NEAR, PC_FAR);
    if (year >= PERIPH_YEAR) {
      const distPeriph = distanceToRing(cameraRef.position.x, cameraRef.position.z, RINGS.peripherique);
      periphBoost = ringProximityGain(distPeriph, PERIPH_NEAR, PERIPH_FAR) * PERIPH_BOOST;
    }
  }

  setTarget(gains.nature, weights.nature * NAPPE_CAPS.nature, now);
  setTarget(gains.cloches, weights.cloches * NAPPE_CAPS.cloches, now);
  setTarget(gains.foule, weights.foule * NAPPE_CAPS.foule, now);
  setTarget(gains.siege, weights.siege * NAPPE_CAPS.siege, now);
  setTarget(gains.vapeur, weights.vapeur * vapeurDist * NAPPE_CAPS.vapeur, now);
  setTarget(gains.circulation, weights.circulation * (1 + periphBoost) * NAPPE_CAPS.circulation, now);
  setTarget(gains.pluie, (state.weather === "rain" ? 1 : 0) * NAPPE_CAPS.pluie, now);

  scheduleEvents(weights, weights.vapeur * vapeurDist, state, now);
}

// ============================================================================
// Diagnostic pour la vérification automatisée (window.__paris.audio)
// ============================================================================

let rmsScratch = null;

/** RMS du signal maître (post-fondu, pré-destination) — calculé à la demande, jamais par frame. */
export function getMasterRMS() {
  if (!analyser) return 0;
  if (!rmsScratch || rmsScratch.length !== analyser.fftSize) {
    rmsScratch = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(rmsScratch);
  let sum = 0;
  for (let n = 0; n < rmsScratch.length; n++) sum += rmsScratch[n] * rmsScratch[n];
  return Math.sqrt(sum / rmsScratch.length);
}

/** L'AnalyserNode brut, pour une inspection plus fine (spectre par bande) depuis Playwright. */
export function getAnalyser() {
  return analyser;
}

/** État courant, en clair. */
export function debugState() {
  const nappes = {};
  for (const name of Object.keys(gains)) nappes[name] = Number(gains[name].gain.value.toFixed(4));
  return {
    ctxState: audioCtx ? audioCtx.state : "uninitialized",
    masterGain: master ? Number(master.gain.value.toFixed(4)) : 0,
    nappes,
  };
}
