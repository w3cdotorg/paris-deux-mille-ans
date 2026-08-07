/**
 * Weather / lumière layer — la cinématographie de toute la pièce.
 *
 * Cette couche possède **tout** l'éclairage de la scène : dôme de ciel,
 * brouillard, `scene.background`, lumière hémisphérique, soleil/lune
 * directionnel, exposition du renderer, étoiles, pluie, feux du siège de 885
 * et les lumières de fenêtres/becs de gaz. `terrain.js` ne garde que sa
 * géométrie et ses couleurs (le rig provisoire qu'il portait a été retiré au
 * profit de ce module — voir le rapport de la tâche 14).
 *
 * Deux étages, dans cet ordre :
 *
 *  1. **Signature d'époque** — une table de 14 entrées (une par moment de
 *     `timeline.js`), interpolée *en continu* avec `momentBlend` : le scrub de
 *     la frise fait glisser la lumière d'une époque à l'autre sans palier.
 *  2. **Modulation météo** — les 4 modes choisis par l'utilisateur
 *     (`sun` / `overcast` / `rain` / `night`). Pour rester continue pendant
 *     une transition, la modulation est appliquée aux **4** modes puis
 *     mélangée par un vecteur de poids amorti (≈1,5 s), plutôt qu'en amortis-
 *     sant le résultat : la signature suit donc l'année instantanément tandis
 *     que la météo, elle, fond en douceur. Sous `reducedMotion`, les poids
 *     sautent directement à la cible.
 *
 * **Règle documentée — moment 3 (885, le siège) gagne contre la météo.** Sa
 * signature est déjà une nuit (`nightness: 1`) ; les modes clairs ne peuvent
 * pas la ramener au grand jour (leur éclaircissement est pondéré par
 * `1 - nightness`) et le mode `night` ne peut pas la refroidir complètement
 * (`NIGHT_SIGNATURE_LOCK`) : 885 reste brun-rouge, feux compris, quelle que
 * soit la météo choisie.
 *
 * **Contrainte enfant — la nuit reste lisible.** Le mode `night` impose un
 * plancher d'exposition (`NIGHT_EXPOSURE_FLOOR`), un ciel bleu profond (jamais
 * noir), une lune généreuse et un remplissage hémisphérique : même à la nuit
 * la plus pauvre de la frise (moment 1, aucune fenêtre allumée), le relief et
 * la Seine restent lisibles.
 *
 * Aucune allocation par frame : toutes les signatures intermédiaires, couleurs
 * et vecteurs sont des scratchs alloués une fois à l'import.
 */

import * as THREE from "three";
import { MOMENTS } from "../timeline.js";
import { momentBlend, lerp, smoothstep } from "../timeEngine.js";
import {
  urbanYear,
  distanceToSeine,
  insideMonumentFootprint,
  SEINE_POINTS,
} from "../geography.js";
import { groundHeightAt } from "./terrain.js";

// ============================================================================
// Tunables
// ============================================================================

export const WEATHER_MODES = ["sun", "overcast", "rain", "night"];
const RAIN_MODE_INDEX = WEATHER_MODES.indexOf("rain");

/** Constante de temps du fondu météo : ~3τ ≈ 1,45 s pour arriver à 95 %. */
const WEATHER_TAU = 0.48;

/** Plancher d'exposition du mode nuit — la garantie « jamais noir ». */
export const NIGHT_EXPOSURE_FLOOR = 1.38;

/**
 * À quel point une signature déjà nocturne résiste au mode `night` de
 * l'utilisateur : 0 = la nuit générique l'écrase, 1 = elle est ignorée.
 * 0,8 garde le brun-rouge du siège dominant tout en y ajoutant lune+étoiles :
 * en dessous, le tirage vers le bleu nocturne suffisait à faire passer le
 * canal bleu devant le rouge (vérifié par le test « moment 3 + nuit »).
 *
 * Pondéré par `nightness³` (et non `nightness`) : seule une signature
 * *pleinement* nocturne (le siège, nightness = 1) doit résister. Les
 * crépuscules — 1865 (0,62), 1900 (0,28), 2026 (0,7) — doivent, eux, basculer
 * franchement en nuit quand l'utilisateur la demande. En linéaire, 2026 ne
 * recevait que 44 % de la cible nocturne : la lumière restait chaude et le sol
 * clair de la ville prenait un ton sable de plein jour (capture
 * task14-extra-2026-night-eiffel), au lieu du gris bleuté attendu.
 */
const NIGHT_SIGNATURE_LOCK = 0.8;

/** Désaturation du mode couvert (fraction retirée à la saturation). */
export const OVERCAST_DESATURATION = 0.4;

const OVERCAST_SKY_TOP = 0xa3adb4;
const OVERCAST_SKY_HORIZON = 0xc8ccce;
const OVERCAST_SKY_PULL = 0.5; // vers le gris ci-dessus, après désaturation

/**
 * Plancher du brouillard sous couvert/pluie. Sans lui, une signature déjà
 * brumeuse (885 : 380/2150) descendait à 190/1290 en pluie — à la distance du
 * préréglage `ensemble` (~1100 unités), *tout* le paysage passait alors
 * derrière le voile et le relief disparaissait (constaté sur la capture
 * task14-885-rain). Le mauvais temps rapproche l'horizon ; il n'efface pas la
 * ville.
 */
const MIN_FOG_NEAR = 380;
const MIN_FOG_FAR = 1700;

const NIGHT_SKY_TOP = 0x1a2550;
const NIGHT_SKY_HORIZON = 0x2f3f70;
const NIGHT_FOG = 0x1c2748;
// Franchement bleue, et pas seulement « fraîche » : le sol urbain a un albédo
// beige clair (0xd8c6a0, terrain.js) qui domine une lumière neutre — sous une
// lune quasi blanche, la ville de nuit prenait un ton sable de plein jour
// (capture task14-extra-2026-night-eiffel). C'est la couleur de la lumière,
// pas son intensité, qui fait basculer la scène en nuit.
const NIGHT_MOON_COLOR = 0x9ab8f5;
const NIGHT_MOON_INTENSITY = 0.85;
const NIGHT_HEMI_SKY = 0x38487c;
const NIGHT_HEMI_GROUND = 0x1d2230;
const NIGHT_HEMI_INTENSITY = 0.5;
const NIGHT_FOG_NEAR = 600;
const NIGHT_FOG_FAR = 2700;

const SKY_RADIUS = 3200;
const STAR_RADIUS = 3050;
const STAR_COUNT = 400;

const RAIN_MAX_STREAKS = 6000;

const WINDOW_CAP = 1200;
const LAMP_CAP = 320;
/** Rayon (unités monde) du semis de fenêtres autour du point regardé. */
const WINDOW_FIELD_RADIUS = 520;
/** Déplacement du point regardé au-delà duquel on repositionne le semis. */
const WINDOW_REPOSITION_DISTANCE = 90;
/** Écart d'année au-delà duquel on repositionne le semis. */
const WINDOW_REPOSITION_YEARS = 12;
/** Intervalle minimum (s) entre deux repositionnements. */
const WINDOW_REPOSITION_INTERVAL = 0.45;
/** Une fenêtre n'est jamais posée sur l'eau. */
const WINDOW_RIVER_CLEARANCE = 9;
/** Exposant du tirage radial du semis (0,5 = uniforme, >0,5 = centré). */
const WINDOW_RADIAL_BIAS = 0.62;

const FIRE_BANK_OFFSET = 13; // distance à l'axe de la Seine : sur la berge
const FIRE_LIGHT_DISTANCE = 95;
const FIRE_LIGHT_INTENSITY = 95; // candela (three r180 : décroissance physique)

// ============================================================================
// Table des signatures — une par moment de timeline.js, dans le même ordre
// ============================================================================
//
// `sunAzimuth` : degrés, 0 = +z (sud de la carte), 90 = +x (est), 180 = -z,
// 270 = -x — donc « matin » ≈ 90-110, « midi » ≈ 180, « soir » ≈ 250-270.
// `sunElevation` : degrés au-dessus de l'horizon.
// `nightness` : 0 = plein jour, 1 = nuit (utilisé par la règle du moment 3,
// par les étoiles et par le plancher d'exposition).
// `fires` / `lamps` / `windows` : intensité des trois systèmes ponctuels.

export const SIGNATURES = [
  {
    year: -250,
    ambientMood: "brume verte matinale",
    skyTop: 0x8fb2c2,
    skyHorizon: 0xd6e2c9,
    fogColor: 0xc2d2bb,
    fogNear: 480,
    fogFar: 2400,
    sunColor: 0xffe9c9,
    sunIntensity: 0.78,
    sunAzimuth: 100,
    sunElevation: 17,
    hemiSky: 0xc6dcc9,
    hemiGround: 0x3c4a2c,
    hemiIntensity: 0.95,
    exposure: 1.02,
    nightness: 0,
    fires: 0,
    lamps: 0,
    windows: 0,
  },
  {
    year: 200,
    ambientMood: "midi clair de Lutèce",
    skyTop: 0x5b96d8,
    skyHorizon: 0xdfeaf2,
    fogColor: 0xcfe0e8,
    fogNear: 1500,
    fogFar: 3300,
    sunColor: 0xfff6e6,
    sunIntensity: 1.15,
    sunAzimuth: 178,
    sunElevation: 68,
    hemiSky: 0xcfe6f5,
    hemiGround: 0x6a5a40,
    hemiIntensity: 0.82,
    exposure: 1.05,
    nightness: 0,
    fires: 0,
    lamps: 0,
    windows: 0,
  },
  {
    // LE MORCEAU DE BRAVOURE nº1 : la nuit du siège viking. Ciel brun-rouge
    // (les feux sur les berges éclairent la couche de fumée), assez clair pour
    // que les drakkars se lisent en silhouette sur l'eau.
    year: 885,
    ambientMood: "nuit orange du siège",
    skyTop: 0x452029,
    skyHorizon: 0x8e4020,
    fogColor: 0x6b3423,
    fogNear: 380,
    fogFar: 2150,
    sunColor: 0xff9a52, // lune basse teintée par l'incendie
    sunIntensity: 1.0,
    sunAzimuth: 205,
    sunElevation: 13,
    // Remontés après capture : à 0,7 d'hémisphérique sur des couleurs de sol
    // aussi sombres (vert forêt), tout le paysage hors de l'île tombait au
    // noir — la nuit du siège doit rester *lisible*, c'est la contrainte nº1.
    hemiSky: 0x8f5c68,
    hemiGround: 0x5c3a26,
    hemiIntensity: 2.6,
    exposure: 1.42,
    nightness: 1,
    fires: 1,
    lamps: 0,
    windows: 0,
  },
  {
    year: 1200,
    ambientMood: "aube dorée sur la muraille",
    skyTop: 0x6a86bf,
    skyHorizon: 0xf6c98a,
    fogColor: 0xdcc3a8,
    fogNear: 900,
    fogFar: 2800,
    sunColor: 0xffd9a0,
    sunIntensity: 1.0,
    sunAzimuth: 95,
    sunElevation: 12,
    hemiSky: 0xd3d9ee,
    hemiGround: 0x584a34,
    hemiIntensity: 0.85,
    exposure: 1.06,
    nightness: 0,
    fires: 0,
    lamps: 0,
    windows: 0,
  },
  {
    year: 1370,
    ambientMood: "après-midi bleu",
    skyTop: 0x5d92cf,
    skyHorizon: 0xdce9f2,
    fogColor: 0xc9dbe6,
    fogNear: 1400,
    fogFar: 3200,
    sunColor: 0xfff3df,
    sunIntensity: 1.1,
    sunAzimuth: 215,
    sunElevation: 46,
    hemiSky: 0xcbe2f4,
    hemiGround: 0x635334,
    hemiIntensity: 0.82,
    exposure: 1.03,
    nightness: 0,
    fires: 0,
    lamps: 0,
    windows: 0,
  },
  {
    year: 1670,
    ambientMood: "fin d'après-midi dorée sur les Boulevards",
    skyTop: 0x6f92c0,
    skyHorizon: 0xf7d39a,
    fogColor: 0xe0cba4,
    fogNear: 1100,
    fogFar: 2900,
    sunColor: 0xffd89b,
    sunIntensity: 1.05,
    sunAzimuth: 254,
    sunElevation: 21,
    hemiSky: 0xd8dcea,
    hemiGround: 0x6a5535,
    hemiIntensity: 0.84,
    exposure: 1.05,
    nightness: 0,
    fires: 0,
    lamps: 0,
    windows: 0,
  },
  {
    year: 1789,
    ambientMood: "ciel dramatique gris-rouge de la Révolution",
    skyTop: 0x4b4652,
    skyHorizon: 0xb35c44,
    fogColor: 0x8f6a5e,
    fogNear: 700,
    fogFar: 2500,
    sunColor: 0xffb08a,
    sunIntensity: 0.85,
    sunAzimuth: 250,
    sunElevation: 15,
    hemiSky: 0x8a7a80,
    hemiGround: 0x40342c,
    hemiIntensity: 0.8,
    exposure: 1.12,
    nightness: 0.1,
    fires: 0,
    lamps: 0,
    windows: 0,
  },
  {
    year: 1860,
    ambientMood: "matin clair d'annexion",
    skyTop: 0x63a0da,
    skyHorizon: 0xe6efdc,
    fogColor: 0xd2e2e4,
    fogNear: 1400,
    fogFar: 3200,
    sunColor: 0xfff4e2,
    sunIntensity: 1.1,
    sunAzimuth: 105,
    sunElevation: 38,
    hemiSky: 0xd0e6f6,
    hemiGround: 0x6b5c40,
    hemiIntensity: 0.84,
    exposure: 1.04,
    nightness: 0,
    fires: 0,
    lamps: 0,
    windows: 0,
  },
  {
    // Crépuscule au gaz : becs de gaz ambrés le long des percées, ciel qui
    // bascule du bleu au cuivre. Le système de « fenêtres » sert ici les
    // lampadaires (voir LAMP_SLOTS) plus les premiers logements éclairés.
    year: 1865,
    ambientMood: "crépuscule au gaz haussmannien",
    skyTop: 0x3f4a75,
    skyHorizon: 0xe08a52,
    fogColor: 0x7d6a72,
    fogNear: 620,
    fogFar: 2600,
    sunColor: 0xffa967,
    sunIntensity: 0.58,
    sunAzimuth: 264,
    sunElevation: 6,
    hemiSky: 0x6d6f92,
    hemiGround: 0x342a2c,
    hemiIntensity: 0.75,
    exposure: 1.16,
    nightness: 0.62,
    fires: 0,
    lamps: 1,
    windows: 0.75,
  },
  {
    year: 1889,
    ambientMood: "grand beau de l'Exposition",
    skyTop: 0x4f93df,
    skyHorizon: 0xe9f2f8,
    fogColor: 0xd6e6ef,
    fogNear: 1550,
    fogFar: 3300,
    sunColor: 0xfffaf0,
    sunIntensity: 1.2,
    sunAzimuth: 190,
    sunElevation: 60,
    hemiSky: 0xd4eaf8,
    hemiGround: 0x70603f,
    hemiIntensity: 0.85,
    exposure: 1.05,
    nightness: 0,
    fires: 0,
    lamps: 0,
    windows: 0,
  },
  {
    year: 1900,
    ambientMood: "Belle Époque scintillante",
    skyTop: 0x5a7fbe,
    skyHorizon: 0xf3d7a5,
    fogColor: 0xd8c6b4,
    fogNear: 1000,
    fogFar: 2800,
    sunColor: 0xffe0b0,
    sunIntensity: 0.95,
    sunAzimuth: 250,
    sunElevation: 19,
    hemiSky: 0xd6d8ec,
    hemiGround: 0x67543a,
    hemiIntensity: 0.85,
    exposure: 1.08,
    nightness: 0.28,
    fires: 0,
    lamps: 0.85,
    windows: 0.4,
  },
  {
    year: 1934,
    ambientMood: "automne brumeux doux",
    skyTop: 0x8f9fae,
    skyHorizon: 0xe0d6c4,
    fogColor: 0xd3cbbb,
    fogNear: 520,
    fogFar: 2300,
    sunColor: 0xffe8cc,
    sunIntensity: 0.8,
    sunAzimuth: 150,
    sunElevation: 27,
    hemiSky: 0xd6d6d0,
    hemiGround: 0x5d5443,
    hemiIntensity: 0.9,
    exposure: 1.02,
    nightness: 0,
    fires: 0,
    lamps: 0.15,
    windows: 0.1,
  },
  {
    year: 1973,
    ambientMood: "gris des années 70, léger smog",
    skyTop: 0x8b8f8a,
    skyHorizon: 0xcfc7b4,
    fogColor: 0xbdbaa8,
    fogNear: 700,
    fogFar: 2500,
    sunColor: 0xf7e6c8,
    sunIntensity: 0.75,
    sunAzimuth: 200,
    sunElevation: 34,
    hemiSky: 0xc9c8bd,
    hemiGround: 0x55503f,
    hemiIntensity: 0.92,
    exposure: 0.98,
    nightness: 0,
    fires: 0,
    lamps: 0.2,
    windows: 0.12,
  },
  {
    // LE MORCEAU DE BRAVOURE nº2 : le crépuscule contemporain. La ville
    // s'allume fenêtre par fenêtre (WINDOW_SLOTS), la Tour scintille (couche
    // monuments), les phares filent sur le périph (couche rails).
    year: 2026,
    ambientMood: "crépuscule contemporain, la ville s'allume",
    skyTop: 0x2f4a7a,
    skyHorizon: 0xf0a267,
    fogColor: 0x6d7590,
    fogNear: 720,
    fogFar: 2700,
    sunColor: 0xffb877,
    sunIntensity: 0.66,
    sunAzimuth: 262,
    sunElevation: 7,
    hemiSky: 0x6b7ba6,
    hemiGround: 0x2f3038,
    hemiIntensity: 0.78,
    exposure: 1.14,
    nightness: 0.7,
    fires: 0,
    lamps: 0.9,
    windows: 1,
  },
];

const MOMENT_YEARS = MOMENTS.map((m) => m.year);

// ============================================================================
// Fonctions pures — aucune dépendance THREE, testables sous node --test
// ============================================================================

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hash déterministe [0,1) — cosmétique uniquement (même famille que terrain.js). */
function hash01(a, b, seed) {
  let h = (a * 374761393 + b * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

/**
 * Décompose un entier 0xRRGGBB en triplet sRGB [0,1] écrit dans `out`.
 * Toute l'arithmétique de couleur de ce module se fait en sRGB, puis est
 * remise à THREE via `setColor` (= `Color.setHex(hex)`, conversion vers
 * l'espace de travail linéaire) — donc les valeurs de la table ci-dessus
 * signifient bien ce qu'un sélecteur de couleur affiche. Seule exception : les
 * uniformes du dôme de ciel et de la pluie, écrits verbatim (voir
 * `setColorRaw`).
 * @param {number} hex
 * @param {{r:number,g:number,b:number}} out
 * @returns {{r:number,g:number,b:number}} out
 */
export function hexToRgb(hex, out) {
  out.r = ((hex >> 16) & 255) / 255;
  out.g = ((hex >> 8) & 255) / 255;
  out.b = (hex & 255) / 255;
  return out;
}

/** Luminance perçue (Rec.709) d'un triplet sRGB. */
export function luminance(rgb) {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

/** Saturation « HSL » d'un triplet sRGB, dans [0,1]. */
export function saturation(rgb) {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

/** Tire un triplet vers son propre gris de luminance. Mute `rgb`. */
function desaturateInPlace(rgb, amount) {
  const y = luminance(rgb);
  rgb.r += (y - rgb.r) * amount;
  rgb.g += (y - rgb.g) * amount;
  rgb.b += (y - rgb.b) * amount;
  return rgb;
}

function lerpRgb(a, b, t, out) {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

function pullRgbToward(rgb, hex, t) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  rgb.r += (r - rgb.r) * t;
  rgb.g += (g - rgb.g) * t;
  rgb.b += (b - rgb.b) * t;
  return rgb;
}

function copyRgb(src, dst) {
  dst.r = src.r;
  dst.g = src.g;
  dst.b = src.b;
  return dst;
}

const COLOR_FIELDS = ["skyTop", "skyHorizon", "fogColor", "sunColor", "hemiSky", "hemiGround"];
const SCALAR_FIELDS = [
  "fogNear",
  "fogFar",
  "sunIntensity",
  "sunAzimuth",
  "sunElevation",
  "hemiIntensity",
  "exposure",
  "nightness",
  "fires",
  "lamps",
  "windows",
];

/**
 * Alloue une « signature résolue » vide : mêmes champs que la table, mais les
 * couleurs sont des triplets sRGB mutables. Sert de scratch réutilisable —
 * c'est ce qui permet de n'allouer aucune couleur par frame.
 * @returns {object}
 */
export function createSignatureTarget() {
  const out = { ambientMood: "" };
  for (const key of COLOR_FIELDS) out[key] = { r: 0, g: 0, b: 0 };
  for (const key of SCALAR_FIELDS) out[key] = 0;
  return out;
}

/** Convertit une entrée de la table (hex) en signature résolue (triplets). */
function resolveSignature(entry) {
  const out = createSignatureTarget();
  out.ambientMood = entry.ambientMood;
  for (const key of COLOR_FIELDS) hexToRgb(entry[key], out[key]);
  for (const key of SCALAR_FIELDS) out[key] = entry[key];
  return out;
}

/** Les 14 signatures, résolues une fois à l'import. */
const RESOLVED = SIGNATURES.map(resolveSignature);

function copySignature(src, dst) {
  dst.ambientMood = src.ambientMood;
  for (const key of COLOR_FIELDS) copyRgb(src[key], dst[key]);
  for (const key of SCALAR_FIELDS) dst[key] = src[key];
  return dst;
}

function lerpSignature(a, b, t, out) {
  for (const key of COLOR_FIELDS) lerpRgb(a[key], b[key], t, out[key]);
  for (const key of SCALAR_FIELDS) out[key] = lerp(a[key], b[key], t);
  out.ambientMood = t < 0.5 ? a.ambientMood : b.ambientMood;
  return out;
}

/**
 * Signature d'époque à l'année donnée, interpolée en continu entre les deux
 * moments encadrants (`momentBlend`). Écrit dans `out` — aucune allocation.
 * @param {number} year
 * @param {object} out - issu de createSignatureTarget()
 * @returns {object} out
 */
export function blendSignatures(year, out) {
  const { i, j, t } = momentBlend(year, MOMENT_YEARS);
  if (i === j) return copySignature(RESOLVED[i], out);
  return lerpSignature(RESOLVED[i], RESOLVED[j], t, out);
}

/**
 * Applique un mode météo à une signature déjà interpolée.
 *
 * - `sun` : la signature, très légèrement poussée (soleil +8 %, horizon plus
 *   lointain) — l'éclaircissement est pondéré par `1 - nightness`, donc le
 *   moment 3 reste sa nuit orange.
 * - `overcast` : désature de OVERCAST_DESATURATION, tire le ciel vers un gris
 *   bas, adoucit le soleil, remonte le remplissage hémisphérique et rapproche
 *   le brouillard — le tout pondéré par `1 - nightness`, comme `sun`, donc
 *   nul sur le moment 3.
 * - `rain` : couvert + sol assombri (hémisphère bas × 0,55), exposition −15 %,
 *   brouillard encore plus près — même pondération par `1 - nightness`. La
 *   Seine ressort d'elle-même : son shader (terrain.js) ne dépend pas de
 *   l'éclairage, donc quand le sol s'assombrit, le fleuve devient le point
 *   clair de l'image — l'effet « pavé mouillé » recherché, sans toucher au
 *   matériau de l'eau.
 * - `night` : cible nuit lisible (ciel #1a2550, lune généreuse, plancher
 *   d'exposition), mélangée avec un verrou sur les signatures déjà nocturnes.
 *
 * @param {object} sig - signature source (non modifiée)
 * @param {string} weather - un de WEATHER_MODES
 * @param {object} out - destination (peut être === sig)
 * @returns {object} out
 */
export function applyWeather(sig, weather, out) {
  if (out !== sig) copySignature(sig, out);
  const day = 1 - clamp01(sig.nightness);

  if (weather === "sun") {
    out.sunIntensity = sig.sunIntensity * (1 + 0.08 * day);
    out.exposure = sig.exposure * (1 + 0.02 * day);
    out.fogFar = sig.fogFar * (1 + 0.1 * day);
    return out;
  }

  if (weather === "overcast" || weather === "rain") {
    // Comme le mode `sun` : toute la modulation est pondérée par `day`
    // (= 1 - nightness), donc nulle sur une signature déjà pleinement
    // nocturne (le siège, 885). Sans ce poids, le couvert/la pluie
    // désaturaient et refroidissaient 885 quand même — en contradiction avec
    // la règle documentée « 885 reste brun-rouge quelle que soit la météo »
    // (revue de la tâche 14). `lerp(1, x, day)` vaut 1 (inchangé) à day = 0
    // et x (l'effet plein) à day = 1, exactement comme au-dessus.
    for (const key of COLOR_FIELDS) desaturateInPlace(out[key], OVERCAST_DESATURATION * day);
    pullRgbToward(out.skyTop, OVERCAST_SKY_TOP, OVERCAST_SKY_PULL * day);
    pullRgbToward(out.skyHorizon, OVERCAST_SKY_HORIZON, OVERCAST_SKY_PULL * day);
    pullRgbToward(out.fogColor, OVERCAST_SKY_HORIZON, 0.35 * day);
    out.sunIntensity = sig.sunIntensity * lerp(1, 0.55, day);
    out.hemiIntensity = sig.hemiIntensity * lerp(1, 1.15, day);
    out.fogNear = Math.max(MIN_FOG_NEAR, sig.fogNear * lerp(1, 0.75, day));
    out.fogFar = Math.max(MIN_FOG_FAR, sig.fogFar * lerp(1, 0.85, day));
    out.exposure = sig.exposure * lerp(1, 0.96, day);
    if (weather === "rain") {
      // Toits et chaussées mouillés : le sol renvoie moins, le ciel un peu
      // plus — c'est ce contraste (et non une vraie réflexion) qui donne
      // l'averse. La Seine, elle, garde le ciel plus clair et ressort donc.
      const groundMul = lerp(1, 0.55, day);
      out.hemiGround.r *= groundMul;
      out.hemiGround.g *= groundMul;
      out.hemiGround.b *= groundMul;
      out.fogNear = Math.max(MIN_FOG_NEAR, sig.fogNear * lerp(1, 0.65, day));
      out.fogFar = Math.max(MIN_FOG_FAR, sig.fogFar * lerp(1, 0.75, day));
      out.exposure = sig.exposure * lerp(1, 0.85, day);
      out.lamps = Math.max(sig.lamps, 0.3 * day);
    }
    return out;
  }

  if (weather === "night") {
    // Verrou : une signature déjà nocturne n'est refroidie que partiellement.
    const lockable = clamp01(sig.nightness);
    const w = 1 - NIGHT_SIGNATURE_LOCK * lockable * lockable * lockable;
    pullRgbToward(out.skyTop, NIGHT_SKY_TOP, w);
    pullRgbToward(out.skyHorizon, NIGHT_SKY_HORIZON, w);
    pullRgbToward(out.fogColor, NIGHT_FOG, w);
    pullRgbToward(out.sunColor, NIGHT_MOON_COLOR, w);
    pullRgbToward(out.hemiSky, NIGHT_HEMI_SKY, w);
    pullRgbToward(out.hemiGround, NIGHT_HEMI_GROUND, w);
    out.sunIntensity = lerp(sig.sunIntensity, NIGHT_MOON_INTENSITY, w);
    out.hemiIntensity = lerp(sig.hemiIntensity, NIGHT_HEMI_INTENSITY, w);
    out.fogNear = lerp(sig.fogNear, NIGHT_FOG_NEAR, w);
    out.fogFar = lerp(sig.fogFar, NIGHT_FOG_FAR, w);
    // Lune haute mais pas au zénith : c'est la directionnelle (et non le
    // remplissage hémisphérique, qui aplatit) qui fait lire le relief, donc
    // elle doit garder un peu de rasance — 44°, calé sur la capture
    // task14-extra--250-night (la nuit la plus pauvre de la frise : aucune
    // fenêtre allumée, sol vert forêt, donc le pire cas de lisibilité).
    out.sunAzimuth = lerp(sig.sunAzimuth, 38, w);
    out.sunElevation = lerp(sig.sunElevation, 44, w);
    out.nightness = 1;
    out.lamps = Math.max(sig.lamps, 0.95);
    out.windows = Math.max(sig.windows, 1);
    out.exposure = Math.max(sig.exposure, NIGHT_EXPOSURE_FLOOR);
    return out;
  }

  return out;
}

/**
 * Mélange N signatures par un vecteur de poids (normalisé en interne).
 * C'est ce qui rend la transition météo continue sans amortir la signature
 * d'époque elle-même.
 * @param {object[]} sigs
 * @param {number[]} weights
 * @param {object} out
 * @returns {object} out
 */
export function mixSignatures(sigs, weights, out) {
  let total = 0;
  for (let k = 0; k < weights.length; k++) total += weights[k];
  if (total <= 0) return copySignature(sigs[0], out);

  for (const key of COLOR_FIELDS) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < sigs.length; k++) {
      const w = weights[k] / total;
      if (w === 0) continue;
      r += sigs[k][key].r * w;
      g += sigs[k][key].g * w;
      b += sigs[k][key].b * w;
    }
    out[key].r = r;
    out[key].g = g;
    out[key].b = b;
  }
  for (const key of SCALAR_FIELDS) {
    let v = 0;
    for (let k = 0; k < sigs.length; k++) v += sigs[k][key] * (weights[k] / total);
    out[key] = v;
  }
  // Le mood est une étiquette de debug : celui du mode dominant.
  let best = 0;
  for (let k = 1; k < weights.length; k++) if (weights[k] > weights[best]) best = k;
  out.ambientMood = sigs[best].ambientMood;
  return out;
}

/**
 * Avance le vecteur de poids météo (un canal par mode) vers sa cible one-hot,
 * en amortissement exponentiel. Mute `weights` et le renvoie.
 * @param {number[]} weights - état courant, longueur WEATHER_MODES.length
 * @param {number} targetIndex - indice du mode demandé
 * @param {number} dt - secondes
 * @param {number} [tau] - constante de temps
 * @returns {number[]} weights
 */
export function stepWeatherWeights(weights, targetIndex, dt, tau = WEATHER_TAU) {
  const k = tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau);
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    const target = i === targetIndex ? 1 : 0;
    weights[i] += (target - weights[i]) * k;
    if (weights[i] < 1e-4) weights[i] = 0;
    total += weights[i];
  }
  if (total > 0) {
    for (let i = 0; i < weights.length; i++) weights[i] /= total;
  } else {
    weights[targetIndex] = 1;
  }
  return weights;
}

/** Force le vecteur de poids sur un mode (transition instantanée). */
export function snapWeatherWeights(weights, targetIndex) {
  for (let i = 0; i < weights.length; i++) weights[i] = i === targetIndex ? 1 : 0;
  return weights;
}

// ---------------------------------------------------------------------------
// Fenêtres allumées — bougies → gaz → électrique
// ---------------------------------------------------------------------------

/**
 * Époques d'éclairage domestique. `lit` = fraction des fenêtres allumées ;
 * la teinte va de la bougie franchement ambrée au blanc électrique.
 */
const WINDOW_ERAS = [
  { year: -250, lit: 0.06, hex: 0xff8a36 }, // bougie, très rare
  { year: 1600, lit: 0.1, hex: 0xff9440 }, // bougies : ~10 % (plafond du brief)
  { year: 1830, lit: 0.24, hex: 0xffa64d }, // huile / premiers becs
  { year: 1900, lit: 0.58, hex: 0xffbc6a }, // gaz généralisé, ambré
  { year: 1930, lit: 0.78, hex: 0xffdca8 }, // électrique chaud
  { year: 1970, lit: 0.86, hex: 0xffecd2 }, // électrique blanc
  { year: 2026, lit: 0.9, hex: 0xfff2dd },
];

/**
 * Profil d'éclairage des fenêtres pour une année : quelle fraction est
 * allumée et de quelle couleur. Progressif et monotone : comme le rang de
 * chaque fenêtre est déterministe, la même fenêtre reste allumée quand la
 * fraction monte — la ville s'allume vraiment *fenêtre par fenêtre*.
 * @param {number} year
 * @param {{r:number,g:number,b:number}} [outColor] - scratch optionnel
 * @returns {{litFraction:number, color:{r:number,g:number,b:number}}}
 */
export function windowLightProfile(year, outColor = { r: 0, g: 0, b: 0 }) {
  const n = WINDOW_ERAS.length;
  if (year <= WINDOW_ERAS[0].year) {
    hexToRgb(WINDOW_ERAS[0].hex, outColor);
    return { litFraction: WINDOW_ERAS[0].lit, color: outColor };
  }
  if (year >= WINDOW_ERAS[n - 1].year) {
    hexToRgb(WINDOW_ERAS[n - 1].hex, outColor);
    return { litFraction: WINDOW_ERAS[n - 1].lit, color: outColor };
  }
  for (let i = 0; i < n - 1; i++) {
    const a = WINDOW_ERAS[i];
    const b = WINDOW_ERAS[i + 1];
    if (year >= a.year && year <= b.year) {
      const t = (year - a.year) / (b.year - a.year);
      const ar = ((a.hex >> 16) & 255) / 255;
      const ag = ((a.hex >> 8) & 255) / 255;
      const ab = (a.hex & 255) / 255;
      const br = ((b.hex >> 16) & 255) / 255;
      const bg = ((b.hex >> 8) & 255) / 255;
      const bb = (b.hex & 255) / 255;
      outColor.r = lerp(ar, br, t);
      outColor.g = lerp(ag, bg, t);
      outColor.b = lerp(ab, bb, t);
      return { litFraction: lerp(a.lit, b.lit, t), color: outColor };
    }
  }
  hexToRgb(WINDOW_ERAS[n - 1].hex, outColor);
  return { litFraction: WINDOW_ERAS[n - 1].lit, color: outColor };
}

/**
 * Hauteur maximale (unités monde, 1 = 10 m) à laquelle poser une fenêtre à
 * cette époque. Approximation assumée : la couche ne lit pas la hauteur réelle
 * de chaque bâtiment instancié — elle place des points lumineux dans la
 * tranche de hauteur *plausible* du tissu de l'époque (voir rapport).
 * @param {number} year
 * @returns {number}
 */
export function eraMaxWindowHeight(year) {
  if (year < 1600) return 7;
  if (year < 1850) return 10;
  if (year < 1900) return 18; // haussmannien
  if (year < 1960) return 20;
  return 24;
}

/**
 * Semis déterministe de fenêtres autour d'un point : ne retient que les
 * cellules déjà urbanisées à `year`, hors eau et hors emprise de monument.
 * Purement arithmétique (aucun THREE) — testable et reproductible : deux
 * appels avec les mêmes arguments renvoient exactement la même liste.
 * @param {number} year
 * @param {number} cx - centre du semis (x)
 * @param {number} cz - centre du semis (z)
 * @param {number} radius
 * @param {number} count - nombre visé
 * @param {number} [seed]
 * @returns {Array<{x:number,z:number,rank:number,hFrac:number,tint:number}>}
 */
export function generateWindowSlots(year, cx, cz, radius, count, seed = 0) {
  const slots = [];
  const maxAttempts = count * 12;
  for (let k = 0; k < maxAttempts && slots.length < count; k++) {
    // Exposant 0,62 : au-dessus de 0,5 (= densité parfaitement uniforme dans
    // le disque) pour resserrer légèrement le semis autour du point regardé,
    // sans le concentrer au point de vider la périphérie du cadre.
    const r = radius * Math.pow(hash01(k, seed, 101), WINDOW_RADIAL_BIAS);
    const a = hash01(k, seed, 202) * Math.PI * 2;
    const x = cx + r * Math.cos(a);
    const z = cz + r * Math.sin(a);
    if (distanceToSeine(x, z) < WINDOW_RIVER_CLEARANCE) continue;
    if (!(urbanYear(x, z) <= year)) continue;
    if (insideMonumentFootprint(x, z)) continue;
    slots.push({
      x,
      z,
      rank: hash01(k, seed, 303),
      hFrac: hash01(k, seed, 404),
      tint: hash01(k, seed, 505),
    });
  }
  return slots;
}

/**
 * Semis déterministe de lampadaires : 55 % sur l'ellipse des Grands
 * Boulevards, 25 % le long de six percées radiales (les avenues d'Haussmann),
 * 20 % sur les quais de Seine. Indépendant de l'année — c'est la signature
 * (`lamps`) et l'époque d'allumage qui décident s'ils brillent.
 * @param {number} count
 * @param {number} [seed]
 * @returns {Array<{x:number,z:number,tint:number}>}
 */
export function generateLampSlots(count, seed = 0) {
  const slots = [];
  const boulevards = { cx: -60, cz: -40, rx: 290, rz: 210 };
  const onMap = SEINE_POINTS.slice(0, 12);
  for (let k = 0; k < count; k++) {
    const pick = hash01(k, seed, 11);
    const u = hash01(k, seed, 22);
    const v = hash01(k, seed, 33);
    let x;
    let z;
    if (pick < 0.55) {
      const a = u * Math.PI * 2;
      const wobble = 0.9 + v * 0.22;
      x = boulevards.cx + Math.cos(a) * boulevards.rx * wobble;
      z = boulevards.cz + Math.sin(a) * boulevards.rz * wobble;
    } else if (pick < 0.8) {
      const avenue = Math.floor(u * 6);
      const a = (avenue / 6) * Math.PI * 2 + 0.35;
      const dist = 45 + v * 265;
      x = Math.cos(a) * dist;
      z = Math.sin(a) * dist * 0.8 - 20;
    } else {
      // Quais : seulement la traversée urbaine (points 1→9). Le point 0 de la
      // Seine, (300, 315), est déjà hors du périphérique — y poser un bec de
      // gaz mettrait un réverbère en pleine campagne.
      const t = lerp(1, 9, u);
      const i = Math.min(Math.floor(t), onMap.length - 2);
      const f = t - i;
      const ax = onMap[i].x;
      const az = onMap[i].z;
      const bx = onMap[i + 1].x;
      const bz = onMap[i + 1].z;
      const px = lerp(ax, bx, f);
      const pz = lerp(az, bz, f);
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      const side = v < 0.5 ? 1 : -1;
      x = px + (-dz / len) * 12 * side;
      z = pz + (dx / len) * 12 * side;
    }
    slots.push({ x, z, tint: hash01(k, seed, 44) });
  }
  return slots;
}

/** Année à partir de laquelle un lampadaire public a un sens (réverbères). */
export const LAMP_ERA_START = 1770;
const LAMP_ERA_FULL = 1860;

/**
 * Facteur d'allumage de l'éclairage public à cette année : 0 avant les
 * premiers réverbères, 1 à partir du gaz généralisé.
 * @param {number} year
 * @returns {number}
 */
export function lampEraFactor(year) {
  return smoothstep((year - LAMP_ERA_START) / (LAMP_ERA_FULL - LAMP_ERA_START));
}

/**
 * Scintillement d'un feu : produit de deux sinus déphasés, borné dans
 * [0.55, 1.25]. Statique (1) sous reducedMotion — l'appelant passe alors
 * `time = null`.
 * @param {number|null} time
 * @param {number} phase
 * @returns {number}
 */
export function fireFlicker(time, phase) {
  if (time === null) return 1;
  const a = Math.sin(time * 7.3 + phase * 6.1);
  const b = Math.sin(time * 13.7 + phase * 11.3);
  return 0.9 + a * 0.22 + b * 0.13;
}

/** Nombre de streaks de pluie effectivement dessinés pour un niveau de qualité. */
export function rainStreakCount(qualityRain = 1, cap = RAIN_MAX_STREAKS) {
  const q = Math.max(0, Math.min(1.5, qualityRain));
  return Math.min(cap, Math.round(cap * q));
}

// ============================================================================
// Scratch (alloués une fois — zéro allocation par frame)
// ============================================================================

const sigYear = createSignatureTarget();
const sigPerMode = WEATHER_MODES.map(() => createSignatureTarget());
const sigNow = createSignatureTarget();
const weatherWeights = WEATHER_MODES.map((_, i) => (i === 0 ? 1 : 0));

const _anchor = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _windowColor = { r: 0, g: 0, b: 0 };
// Les attributs `color` d'une géométrie sont lus par three comme *déjà*
// linéaires : y écrire des valeurs sRGB éclaircit tout vers le blanc (c'est ce
// qui délavait les becs de gaz ambrés). Ce scratch fait la conversion.
const _pointColor = new THREE.Color();

// ============================================================================
// État de la couche
// ============================================================================

const rig = {
  hemi: null,
  sun: null,
  sky: null,
  stars: null,
  starsMaterial: null,
};

const rain = {
  mesh: null,
  material: null,
  count: 0,
};

const windows = {
  points: null,
  material: null,
  positions: null,
  colors: null,
  slots: null,
  cap: 0,
  lastYear: null,
  lastCx: Infinity,
  lastCz: Infinity,
  lastTime: -Infinity,
  lit: 0,
};

const lamps = {
  points: null,
  material: null,
  cap: 0,
  built: false,
};

const fires = [];

let ctxRef = null;
let qualityRain = 1;
let qualityWindows = 1;
let deferredBuilt = false;

// ============================================================================
// Ciel
// ============================================================================

const SKY_VERTEX_SHADER = `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Remappage volontairement plus large que le rig provisoire de terrain.js :
// à l'assiette aérienne par défaut (préréglage `ensemble`, caméra piquée de
// ~34°), la bande de ciel réellement visible ne monte qu'à ~12° au-dessus de
// l'horizon, soit y ∈ [0, 0,2] du rayon normalisé. L'ancien mapping
// (y*1.2 + 0.92) écrasait tout le dégradé dans les 8 derniers pourcents de
// sa course : les crépuscules (moments 9, 11, 14) et la nuit du siège n'y
// montraient aucune transition. Ici le dégradé occupe toute la bande visible.
const SKY_FRAGMENT_SHADER = `
  varying vec3 vWorldPos;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  void main() {
    float h = clamp(normalize(vWorldPos).y * 2.6 + 0.52, 0.0, 1.0);
    gl_FragColor = vec4(mix(uHorizon, uTop, h * h), 1.0);
  }
`;

function buildSky(ctx) {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(0x6fa8d0) },
      uHorizon: { value: new THREE.Color(0xf3e6cf) },
    },
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  ctx.scene.add(mesh);
  rig.sky = material;

  ctx.scene.background = new THREE.Color(0x9fb8c4);
  ctx.scene.fog = new THREE.Fog(0x9fb8c4, 1800, 3200);
}

function buildLights(ctx) {
  const hemi = new THREE.HemisphereLight(0xbfe0f0, 0x5b4a35, 0.85);
  ctx.scene.add(hemi);
  rig.hemi = hemi;

  // Pas d'ombres portées : la scène est un plan de 4000 unités vu de haut,
  // une shadow map utile y coûterait plus qu'elle n'apporte (et le brief
  // demande explicitement des ombres « douces/absentes » par couvert).
  const sun = new THREE.DirectionalLight(0xfff2df, 0.9);
  sun.castShadow = false;
  ctx.scene.add(sun);
  rig.sun = sun;
}

function buildStars(ctx) {
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Hémisphère supérieur uniquement, un peu resserré vers le zénith pour
    // que les étoiles tombent dans la bande de ciel réellement cadrée.
    const u = hash01(i, 0, 909);
    const v = hash01(i, 0, 808);
    const theta = u * Math.PI * 2;
    const y = 0.12 + Math.pow(v, 0.7) * 0.88;
    const rXZ = Math.sqrt(Math.max(0, 1 - y * y));
    positions[i * 3 + 0] = Math.cos(theta) * rXZ * STAR_RADIUS;
    positions[i * 3 + 1] = y * STAR_RADIUS;
    positions[i * 3 + 2] = Math.sin(theta) * rXZ * STAR_RADIUS;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xf2f6ff,
    size: 2.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -9;
  points.visible = false;
  ctx.scene.add(points);
  rig.stars = points;
  rig.starsMaterial = material;
}

// ============================================================================
// Pluie — 6000 streaks instanciés dans un cylindre qui suit la caméra
// ============================================================================
//
// Tout le mouvement est dans le vertex shader : une seule écriture d'uniforme
// par frame, aucun parcours CPU des 6000 streaks. Les tailles (largeur,
// longueur, rayon du cylindre, vitesse) sont mises à l'échelle de la distance
// caméra→sol : à 1100 unités (préréglage `ensemble`) un streak de 0,1 unité
// serait sous-pixel et l'averse invisible ; à 80 unités (préréglage `cite`) le
// même streak à l'échelle « ensemble » remplirait l'écran.

const RAIN_VERTEX_SHADER = `
  attribute vec3 aBase;    // x,z dans le disque unité ; y dans [0,1)
  attribute vec2 aCorner;  // x = ±1 (largeur), y = 0..1 (longueur)
  attribute float aSpeed;  // 0.7..1.3
  uniform vec3 uAnchor;
  uniform float uTime;
  uniform float uSpread;
  uniform float uHeight;
  uniform float uWidth;
  uniform float uLength;
  uniform float uFall;
  varying float vAlpha;
  void main() {
    float span = uHeight;
    float fall = mod(aBase.y * span - uTime * uFall * aSpeed, span);
    vec3 world = vec3(
      uAnchor.x + aBase.x * uSpread,
      uAnchor.y + fall - span * 0.18,
      uAnchor.z + aBase.z * uSpread
    );
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    world += camRight * (aCorner.x * uWidth);
    world.y += aCorner.y * uLength;
    // Léger dévers pour que l'averse ne soit pas parfaitement verticale.
    world.x += aCorner.y * uLength * 0.18;
    float radial = length(aBase.xz);
    vAlpha = (1.0 - smoothstep(0.72, 1.0, radial)) * (1.0 - smoothstep(0.8, 1.0, fall / span));
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const RAIN_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    float a = vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

function buildRain(ctx) {
  const n = RAIN_MAX_STREAKS;
  const base = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const speed = new Float32Array(n * 4);
  const index = new Uint32Array(n * 6);

  for (let i = 0; i < n; i++) {
    const a = hash01(i, 0, 71) * Math.PI * 2;
    const r = Math.sqrt(hash01(i, 0, 72));
    const bx = Math.cos(a) * r;
    const bz = Math.sin(a) * r;
    const by = hash01(i, 0, 73);
    const sp = 0.7 + hash01(i, 0, 74) * 0.6;
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      base[v * 3 + 0] = bx;
      base[v * 3 + 1] = by;
      base[v * 3 + 2] = bz;
      // (−1,0) (1,0) (1,1) (−1,1)
      corner[v * 2 + 0] = c === 0 || c === 3 ? -1 : 1;
      corner[v * 2 + 1] = c < 2 ? 0 : 1;
      speed[v] = sp;
    }
    const o = i * 4;
    const t = i * 6;
    index[t + 0] = o;
    index[t + 1] = o + 1;
    index[t + 2] = o + 2;
    index[t + 3] = o;
    index[t + 4] = o + 2;
    index[t + 5] = o + 3;
  }

  const geometry = new THREE.BufferGeometry();
  // `position` reste requis par three (bounding sphere, raycast) même si le
  // shader n'en fait rien : on lui donne **le même objet BufferAttribute** que
  // `aBase` — three indexe ses buffers GL par attribut, donc les 72 000
  // flottants ne sont téléversés qu'une fois.
  const baseAttribute = new THREE.BufferAttribute(base, 3);
  geometry.setAttribute("position", baseAttribute);
  geometry.setAttribute("aBase", baseAttribute);
  geometry.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
  geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uAnchor: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSpread: { value: 300 },
      uHeight: { value: 180 },
      uWidth: { value: 0.6 },
      uLength: { value: 9 },
      uFall: { value: 90 },
      // Même remarque que setColorRaw : ce ShaderMaterial est brut, donc la
      // valeur part telle quelle dans le framebuffer sRGB — on l'écrit donc
      // directement en sRGB (0xdce8f4) plutôt qu'en linéaire.
      uColor: { value: new THREE.Color().setRGB(0.863, 0.91, 0.957, THREE.LinearSRGBColorSpace) },
      uOpacity: { value: 0 },
    },
    vertexShader: RAIN_VERTEX_SHADER,
    fragmentShader: RAIN_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  mesh.visible = false;
  ctx.scene.add(mesh);

  rain.mesh = mesh;
  rain.material = material;
  rain.count = rainStreakCount(qualityRain);
  geometry.setDrawRange(0, rain.count * 6);
}

// ============================================================================
// Fenêtres allumées + éclairage public
// ============================================================================

function buildWindowCloud(ctx) {
  const cap = Math.max(32, Math.round(WINDOW_CAP * Math.min(1.2, Math.max(0.2, qualityWindows))));
  const positions = new Float32Array(cap * 3);
  const colors = new Float32Array(cap * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setDrawRange(0, 0);

  const material = new THREE.PointsMaterial({
    // 2,4 px : à 4,2 px les fenêtres se lisaient comme des confettis blancs
    // plutôt que comme un tapis de lumières (première capture 2026-nuit).
    size: 2.4,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 12;
  points.visible = false;
  ctx.scene.add(points);

  windows.points = points;
  windows.material = material;
  windows.positions = positions;
  windows.colors = colors;
  windows.cap = cap;
}

/**
 * Repositionne le semis de fenêtres pour (année, point regardé) et réécrit
 * les seules fenêtres allumées. Coûteux (≈15 000 tirages + urbanYear) mais
 * strictement limité par WINDOW_REPOSITION_* — jamais par frame.
 */
function repositionWindows(year, cx, cz) {
  const cap = windows.cap;
  const slots = generateWindowSlots(year, cx, cz, WINDOW_FIELD_RADIUS, cap, 0);
  windows.slots = slots;

  const profile = windowLightProfile(year, _windowColor);
  const maxH = eraMaxWindowHeight(year);
  const positions = windows.positions;
  const colors = windows.colors;

  let n = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.rank >= profile.litFraction) continue;
    // 70 % des fenêtres dans les étages bas, 30 % réparties jusqu'au faîte
    // plausible de l'époque (voir eraMaxWindowHeight pour l'approximation).
    const h = s.hFrac < 0.7 ? 1.6 + s.hFrac * 6 : 4 + s.hFrac * (maxH - 4);
    positions[n * 3 + 0] = s.x;
    positions[n * 3 + 1] = groundHeightAt(s.x, s.z) + h;
    positions[n * 3 + 2] = s.z;
    const jitter = 0.82 + s.tint * 0.36;
    setColor(_pointColor, profile.color);
    colors[n * 3 + 0] = Math.min(1, _pointColor.r * jitter);
    colors[n * 3 + 1] = Math.min(1, _pointColor.g * jitter);
    colors[n * 3 + 2] = Math.min(1, _pointColor.b * jitter);
    n++;
  }

  windows.lit = n;
  windows.points.geometry.setDrawRange(0, n);
  windows.points.geometry.attributes.position.needsUpdate = true;
  windows.points.geometry.attributes.color.needsUpdate = true;
  windows.lastYear = year;
  windows.lastCx = cx;
  windows.lastCz = cz;
}

function buildLampCloud(ctx) {
  const cap = Math.max(24, Math.round(LAMP_CAP * Math.min(1.2, Math.max(0.2, qualityWindows))));
  const positions = new Float32Array(cap * 3);
  const colors = new Float32Array(cap * 3);
  const slots = generateLampSlots(cap, 0);
  const amber = { r: 0, g: 0, b: 0 };
  hexToRgb(0xffb257, amber);
  setColor(_pointColor, amber);

  for (let i = 0; i < cap; i++) {
    const s = slots[i];
    positions[i * 3 + 0] = s.x;
    positions[i * 3 + 1] = Math.max(groundHeightAt(s.x, s.z), 0.1) + 1.4;
    positions[i * 3 + 2] = s.z;
    const jitter = 0.85 + s.tint * 0.3;
    colors[i * 3 + 0] = Math.min(1, _pointColor.r * jitter);
    colors[i * 3 + 1] = Math.min(1, _pointColor.g * jitter);
    colors[i * 3 + 2] = Math.min(1, _pointColor.b * jitter);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 3.4,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 12;
  points.visible = false;
  ctx.scene.add(points);

  lamps.points = points;
  lamps.material = material;
  lamps.cap = cap;
  lamps.built = true;
}

// ============================================================================
// Feux du siège (moment 3) — 6 brasiers sur les berges de l'île
// ============================================================================

const FIRE_SPECS = [
  { seg: 2, t: 0.55, side: -1 },
  { seg: 2, t: 0.85, side: 1 },
  { seg: 3, t: 0.5, side: -1 },
  { seg: 4, t: 0.5, side: 1 },
  { seg: 5, t: 0.45, side: -1 },
  { seg: 5, t: 0.9, side: 1 },
];

function buildFires(ctx) {
  const glowGeo = new THREE.IcosahedronGeometry(1, 1);
  for (let i = 0; i < FIRE_SPECS.length; i++) {
    const spec = FIRE_SPECS[i];
    const a = SEINE_POINTS[spec.seg];
    const b = SEINE_POINTS[spec.seg + 1];
    const px = lerp(a.x, b.x, spec.t);
    const pz = lerp(a.z, b.z, spec.t);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const x = px + (-dz / len) * FIRE_BANK_OFFSET * spec.side;
    const z = pz + (dx / len) * FIRE_BANK_OFFSET * spec.side;
    // La berge : le maillage du sol retombe dans le lit du fleuve près de
    // l'axe, donc on plancher à 0,2 pour ne pas noyer le brasier.
    const y = Math.max(groundHeightAt(x, z), 0.2) + 0.8;

    const light = new THREE.PointLight(0xff7a2a, 0, FIRE_LIGHT_DISTANCE, 2);
    light.position.set(x, y + 1.2, z);
    light.visible = false;
    ctx.scene.add(light);

    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffa03c,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.set(x, y + 0.6, z);
    glow.visible = false;
    glow.renderOrder = 11;
    ctx.scene.add(glow);

    fires.push({ light, glow, glowMat, phase: hash01(i, 0, 1234), x, y, z });
  }
}

// ============================================================================
// Application de la signature courante aux objets THREE
// ============================================================================

function setColor(target, rgb) {
  target.setRGB(rgb.r, rgb.g, rgb.b, THREE.SRGBColorSpace);
}

/**
 * Variante pour les uniformes du dôme de ciel. Le dôme est un ShaderMaterial
 * « brut » : three n'y injecte ni le chunk de tone mapping ni celui d'encodage
 * de sortie, donc ce que le fragment écrit part **tel quel** dans le
 * framebuffer sRGB. Convertir ses couleurs en linéaire (comme `setColor` le
 * fait, correctement, pour les lumières et le brouillard) les y écrirait donc
 * non encodées : le ciel sortait bien plus sombre que le hex demandé — c'est
 * ce qui rendait les crépuscules ternes et la nuit du siège quasi noire à la
 * première capture (le rig provisoire de terrain.js avait déjà ce défaut).
 * On garde donc les valeurs sRGB verbatim : le hex de la table est exactement
 * ce qui s'affiche — et la garantie « la nuit n'est jamais noire » devient
 * littérale, indépendante du tone mapping.
 */
function setColorRaw(target, rgb) {
  target.setRGB(rgb.r, rgb.g, rgb.b, THREE.LinearSRGBColorSpace);
}

function applyToScene() {
  const scene = ctxRef.scene;

  setColorRaw(rig.sky.uniforms.uTop.value, sigNow.skyTop);
  setColorRaw(rig.sky.uniforms.uHorizon.value, sigNow.skyHorizon);

  if (scene.fog) {
    setColor(scene.fog.color, sigNow.fogColor);
    scene.fog.near = sigNow.fogNear;
    scene.fog.far = sigNow.fogFar;
  }
  if (scene.background && scene.background.isColor) {
    setColor(scene.background, sigNow.fogColor);
  }

  setColor(rig.hemi.color, sigNow.hemiSky);
  setColor(rig.hemi.groundColor, sigNow.hemiGround);
  rig.hemi.intensity = sigNow.hemiIntensity;

  setColor(rig.sun.color, sigNow.sunColor);
  rig.sun.intensity = sigNow.sunIntensity;
  const az = (sigNow.sunAzimuth * Math.PI) / 180;
  const el = (sigNow.sunElevation * Math.PI) / 180;
  const cosEl = Math.cos(el);
  rig.sun.position.set(
    Math.sin(az) * cosEl * 1600,
    Math.max(0.05, Math.sin(el)) * 1600,
    Math.cos(az) * cosEl * 1600
  );

  if (ctxRef.renderer) ctxRef.renderer.toneMappingExposure = sigNow.exposure;

  const nightness = clamp01(sigNow.nightness);
  const starOpacity = smoothstep((nightness - 0.35) / 0.45) * 0.9;
  rig.stars.visible = starOpacity > 0.01;
  rig.starsMaterial.opacity = starOpacity;
}

function updateFires(state) {
  const strength = clamp01(sigNow.fires);
  const time = state.reducedMotion ? null : state.time;
  // Les brasiers grossissent avec la distance caméra : un halo de 1 unité est
  // sous-pixel depuis le préréglage `ensemble`.
  const dist = ctxRef.camera ? ctxRef.camera.position.distanceTo(_anchor) : 300;
  const glowScale = Math.max(1, Math.min(7, dist * 0.0075));
  for (let i = 0; i < fires.length; i++) {
    const f = fires[i];
    if (strength <= 0.01) {
      if (f.light.visible) {
        f.light.visible = false;
        f.light.intensity = 0;
        f.glow.visible = false;
        f.glowMat.opacity = 0;
      }
      continue;
    }
    const flick = fireFlicker(time, f.phase);
    f.light.visible = true;
    f.light.intensity = FIRE_LIGHT_INTENSITY * strength * flick;
    f.glow.visible = true;
    f.glowMat.opacity = Math.min(1, 0.75 * strength * flick);
    const s = glowScale * (0.85 + flick * 0.2);
    f.glow.scale.set(s, s * 1.35, s);
  }
}

function updateRain(state, weight) {
  if (!rain.mesh) return;
  const visible = weight > 0.01;
  rain.mesh.visible = visible;
  if (!visible) return;

  const camera = ctxRef.camera;
  const dist = camera ? camera.position.distanceTo(_anchor) : 300;
  const u = rain.material.uniforms;
  u.uAnchor.value.copy(_anchor);
  u.uSpread.value = Math.max(70, Math.min(700, dist * 0.55));
  u.uHeight.value = Math.max(60, Math.min(420, dist * 0.36));
  u.uWidth.value = 0.3 + dist * 0.0006;
  u.uLength.value = 3 + dist * 0.01;
  u.uFall.value = 55 + dist * 0.09;
  if (state.reducedMotion) {
    // Averse figée : des traits fins et discrets, pas de mouvement.
    u.uTime.value = 0;
    u.uOpacity.value = 0.1 * weight;
  } else {
    u.uTime.value = state.time;
    // 0,18 et non 0,45 : à pleine opacité, 6 000 streaks à l'échelle du
    // préréglage `ensemble` masquaient entièrement la ville (première capture
    // 2026-pluie). L'averse doit voiler, pas effacer.
    u.uOpacity.value = 0.18 * weight;
  }
}

function updateWindows(state) {
  if (!windows.points) return;
  const strength = clamp01(sigNow.windows);
  if (strength <= 0.01) {
    if (windows.points.visible) windows.points.visible = false;
    windows.material.opacity = 0;
    return;
  }

  const year = Math.round(state.year);
  const needYear = windows.lastYear === null || Math.abs(year - windows.lastYear) >= WINDOW_REPOSITION_YEARS;
  const dx = _anchor.x - windows.lastCx;
  const dz = _anchor.z - windows.lastCz;
  const needMove = dx * dx + dz * dz > WINDOW_REPOSITION_DISTANCE * WINDOW_REPOSITION_DISTANCE;
  if (
    (needYear || needMove) &&
    state.time - windows.lastTime >= WINDOW_REPOSITION_INTERVAL
  ) {
    windows.lastTime = state.time;
    repositionWindows(year, _anchor.x, _anchor.z);
  }

  windows.points.visible = windows.lit > 0;
  windows.material.opacity = 0.82 * strength;
}

function updateLamps(state) {
  if (!lamps.points) return;
  const strength = clamp01(sigNow.lamps) * lampEraFactor(state.year);
  if (strength <= 0.01) {
    if (lamps.points.visible) lamps.points.visible = false;
    lamps.material.opacity = 0;
    return;
  }
  lamps.points.visible = true;
  lamps.material.opacity = 0.9 * strength;
}

/**
 * Point regardé au sol : intersection du rayon caméra avec le plan y = 0.
 * Sert d'ancre au cylindre de pluie et au semis de fenêtres — plus stable que
 * la position caméra elle-même (qui, en vue aérienne, est loin du cadre utile)
 * et sans dépendance à `controls.js`.
 */
function updateAnchor() {
  const camera = ctxRef.camera;
  if (!camera) {
    _anchor.set(0, 0, 0);
    return;
  }
  camera.getWorldDirection(_camDir);
  const py = camera.position.y;
  if (_camDir.y < -1e-3 && py > 0) {
    const t = Math.min(-py / _camDir.y, 1400);
    _anchor.set(
      camera.position.x + _camDir.x * t,
      0,
      camera.position.z + _camDir.z * t
    );
  } else {
    _anchor.set(camera.position.x, 0, camera.position.z);
  }
}

/** Recalcule sigNow pour (année, météo) et l'applique. */
function recompute(dt, state) {
  const targetIndex = Math.max(0, WEATHER_MODES.indexOf(state.weather));
  if (state.reducedMotion) snapWeatherWeights(weatherWeights, targetIndex);
  else stepWeatherWeights(weatherWeights, targetIndex, dt);

  blendSignatures(state.year, sigYear);
  for (let k = 0; k < WEATHER_MODES.length; k++) {
    if (weatherWeights[k] === 0) continue;
    applyWeather(sigYear, WEATHER_MODES[k], sigPerMode[k]);
  }
  mixSignatures(sigPerMode, weatherWeights, sigNow);
}

// ============================================================================
// Contrat public de la couche
// ============================================================================

export function init(ctx) {
  ctxRef = ctx;
  const quality = ctx.quality || {};
  qualityRain = quality.rain !== undefined ? quality.rain : 1;
  qualityWindows = quality.windows !== undefined ? quality.windows : 1;

  fires.length = 0;
  deferredBuilt = false;
  windows.lastYear = null;
  windows.lastCx = Infinity;
  windows.lastCz = Infinity;
  windows.lastTime = -Infinity;
  windows.lit = 0;
  lamps.built = false;
  snapWeatherWeights(weatherWeights, 0);

  buildSky(ctx);
  buildLights(ctx);
  buildStars(ctx);
  buildRain(ctx);
  buildWindowCloud(ctx);
}

export function update(dt, state) {
  if (!ctxRef) return;

  // Les nuages de points au sol (lampadaires, brasiers) échantillonnent le
  // maillage rendu du terrain (`groundHeightAt`) : ils ne peuvent donc être
  // construits qu'après l'init de terrain.js. Comme cette couche est
  // enregistrée *avant* terrain (elle possède les lumières), on diffère leur
  // construction à la première frame — terrain.init() a alors déjà tourné.
  if (!deferredBuilt) {
    deferredBuilt = true;
    buildLampCloud(ctxRef);
    buildFires(ctxRef);
  }

  updateAnchor();
  recompute(dt, state);
  applyToScene();
  updateFires(state);
  updateRain(state, weatherWeights[RAIN_MODE_INDEX]);
  updateWindows(state);
  updateLamps(state);
}

/**
 * Force le recalcul immédiat pour l'année donnée, en repositionnant le semis
 * de fenêtres sans attendre le débounce — même contrat que
 * `terrain.forceRescan` (utilisé par `window.__paris.setYear`).
 * @param {number} year
 */
export function forceRescan(year) {
  if (!windows.points) return;
  updateAnchor();
  windows.lastTime = -Infinity;
  repositionWindows(Math.round(year), _anchor.x, _anchor.z);
}

/**
 * Tâche 18 — qualité graphique : `qualityRain` n'était échantillonné qu'à
 * l'init (voir le commentaire de `init` ci-dessous) — ce point d'entrée le
 * relit depuis `ctx.quality` (déjà à jour, `quality.js` appelle `applyTier`
 * avant celui-ci) et réduit `rain.mesh`'s `drawRange` en conséquence. Bon
 * marché : le buffer de pluie est TOUJOURS alloué à sa taille maximale
 * (`RAIN_MAX_STREAKS`, voir `buildRain`) — seul le `drawRange` (combien de
 * ces streaks sont effectivement dessinés) dépend de la qualité, donc changer
 * de tier ne réalloue jamais rien, juste une borne.
 *
 * `ctx.quality.windows` est délibérément IGNORÉ ici : ce n'est pas l'un des
 * cinq multiplicateurs de tier (`crowds`/`trees`/`rain`/`boats`/`shadows`,
 * voir quality.js) — les fenêtres allumées restent au budget fixé à l'init,
 * quel que soit le tier choisi.
 * @param {object} ctx
 */
export function setQuality(ctx) {
  const quality = ctx.quality || {};
  qualityRain = quality.rain !== undefined ? quality.rain : 1;
  if (rain.mesh) {
    rain.count = rainStreakCount(qualityRain);
    rain.mesh.geometry.setDrawRange(0, rain.count * 6);
  }
}

/**
 * Saute la transition météo (1,5 s) et applique le mode immédiatement.
 * Utilisé par `window.__paris.setWeather` pour que les captures automatisées
 * n'attendent pas le fondu.
 * @param {{weather:string}} state
 */
export function forceWeather(state) {
  const targetIndex = Math.max(0, WEATHER_MODES.indexOf(state.weather));
  snapWeatherWeights(weatherWeights, targetIndex);
}

/** Diagnostic : la signature effective courante, en clair. */
export function debugState() {
  const toHex = (rgb) =>
    "#" +
    [rgb.r, rgb.g, rgb.b]
      .map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0"))
      .join("");
  return {
    mood: sigNow.ambientMood,
    weights: WEATHER_MODES.reduce((acc, m, i) => {
      acc[m] = Number(weatherWeights[i].toFixed(3));
      return acc;
    }, {}),
    skyTop: toHex(sigNow.skyTop),
    skyHorizon: toHex(sigNow.skyHorizon),
    fog: `${toHex(sigNow.fogColor)} ${Math.round(sigNow.fogNear)}/${Math.round(sigNow.fogFar)}`,
    sun: `${toHex(sigNow.sunColor)} i=${sigNow.sunIntensity.toFixed(2)} az=${Math.round(sigNow.sunAzimuth)} el=${Math.round(sigNow.sunElevation)}`,
    hemi: `${toHex(sigNow.hemiSky)}/${toHex(sigNow.hemiGround)} i=${sigNow.hemiIntensity.toFixed(2)}`,
    exposure: Number(sigNow.exposure.toFixed(3)),
    nightness: Number(sigNow.nightness.toFixed(3)),
    fires: Number(sigNow.fires.toFixed(3)),
    lamps: Number(sigNow.lamps.toFixed(3)),
    windows: Number(sigNow.windows.toFixed(3)),
    skyLuminance: Number(luminance(sigNow.skyTop).toFixed(3)),
  };
}

/** Diagnostic : budgets réellement alloués. */
export function stats() {
  return {
    signatures: SIGNATURES.length,
    rainStreaks: rain.count,
    rainStreakCap: RAIN_MAX_STREAKS,
    windowCap: windows.cap,
    windowsLit: windows.lit,
    windowSlots: windows.slots ? windows.slots.length : 0,
    lampCap: lamps.cap,
    stars: STAR_COUNT,
    fires: fires.length,
    anchor: [Math.round(_anchor.x), Math.round(_anchor.z)],
  };
}
