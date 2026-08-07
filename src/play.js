/**
 * Machine à état pure du bouton ▶️ Lecture — le voyage automatique (tâche 16).
 *
 * `createPlayback` ne connaît ni le DOM ni three.js : elle avance une simple
 * position `u ∈ [0,1]` — la même unité que le slider de la frise, voir
 * `timeEngine.sliderToYear`/`yearToSlider` — à vitesse constante, et marque
 * une pause (« hold ») de `pauseSeconds` chaque fois que `u` atteint une
 * ancre. Comme les 14 `MOMENTS` sont par construction également espacés en
 * `u` (0, 1/13, 2/13, … 1 — `sliderToYear` place toujours une ancre à
 * `index/(n-1)`, quel que soit l'écart en années entre deux ancres), les
 * ancres par défaut sont ces 14 positions ; l'appelant (main.js) reconvertit
 * ensuite `u` en année via `sliderToYear(u, anchéesEnAnnées)` — cette machine
 * n'a jamais besoin de connaître une seule année.
 *
 * `tick(dt)` est le seul point d'entrée qui fait avancer l'état ; tout le
 * reste (play/pause/stop/vitesse/prolongation de pause) ne fait que poser
 * des intentions consommées au prochain tick — jamais d'écriture d'état hors
 * de `tick`. Câblage DOM/audio/caméra : voir main.js et ui.js.
 */

import { MOMENTS } from "./timeline.js";

const EPS = 1e-6;

/**
 * Les 14 ancres de MOMENTS sont également espacées en u par construction
 * (voir le commentaire de tête ci-dessus) : anchorsU[i] = i/(n-1).
 */
export const DEFAULT_ANCHORS_U = MOMENTS.map((_, i) => i / (MOMENTS.length - 1));

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * @param {object} [options]
 * @param {number} [options.totalSeconds=105] durée totale de croisière (hors pauses) à vitesse ×1
 * @param {number} [options.pauseSeconds=4] durée de pause de base à chaque ancre
 * @param {number} [options.maxHoldSeconds=12] plafond absolu d'une pause prolongée (voix encore en cours)
 * @param {number[]} [options.anchors] positions u∈[0,1], croissantes — par défaut les 14 ancres de MOMENTS
 * @returns {{
 *   tick: (dt: number) => {u: number, phase: string, holdRemaining: number},
 *   play: () => void, pause: () => void, resume: () => void, stop: () => void,
 *   setSpeed: (multiplier: number) => void, setU: (value: number) => void,
 *   extendHold: (minRemainingSeconds: number) => void,
 *   u: number, phase: string, playing: boolean, speed: number,
 *   holdRemaining: number, holdCount: number,
 * }}
 */
export function createPlayback({
  totalSeconds = 105,
  pauseSeconds = 4,
  maxHoldSeconds = 12,
  anchors = DEFAULT_ANCHORS_U,
} = {}) {
  const anchorsU = anchors.slice();
  let u = 0;
  let phase = "cruising"; // 'cruising' | 'holding' | 'done'
  let playing = false;
  let speed = 1;
  let holdElapsed = 0;
  let holdTarget = pauseSeconds;
  let holdIndex = -1; // indice dans anchorsU de l'ancre en cours (ou dernière tenue)
  // "Déjà tenue" — garantit une pause par ancre même après une pause/reprise
  // manuelle qui laisserait u exactement sur une ancre déjà visitée.
  const visited = new Set();

  function anchorIndexAt(value) {
    for (let i = 0; i < anchorsU.length; i++) {
      if (Math.abs(anchorsU[i] - value) < EPS) return i;
    }
    return -1;
  }

  function enterHold(index) {
    phase = "holding";
    holdElapsed = 0;
    holdTarget = pauseSeconds;
    holdIndex = index;
    visited.add(index);
  }

  /** Première ancre franchie strictement après `prevU` et jusqu'à `newU` inclus, ou -1. */
  function firstCrossedAnchor(prevU, newU) {
    for (let i = 0; i < anchorsU.length; i++) {
      if (anchorsU[i] > prevU + EPS && anchorsU[i] <= newU + EPS) return i;
    }
    return -1;
  }

  /**
   * Démarre (ou reprend) la lecture. Un appel après la fin (`phase==='done'`)
   * relance tout le voyage depuis le début (u=0, ancres réarmées) — c'est le
   * comportement attendu d'un second tap sur ▶️ une fois arrivé à 2026.
   * Une reprise en plein milieu d'une pause (`phase==='holding'`, ex. après un
   * `pause()`) continue cette même pause plutôt que de la sauter : c'est pour
   * ça que le test d'ancre n'est fait que si l'on n'est *pas déjà* en pause.
   */
  function play() {
    if (phase === "done") {
      u = 0;
      holdIndex = -1;
      visited.clear();
      phase = "cruising";
    }
    playing = true;
    if (phase === "holding") return;
    const idx = anchorIndexAt(u);
    if (idx !== -1 && !visited.has(idx)) enterHold(idx);
  }

  /** Suspend l'avance sans rien perdre (u, phase, pause en cours restent tels quels). Idempotent. */
  function pause() {
    playing = false;
  }

  /** Reprend après un `pause()` — idempotent, sans effet une fois `phase==='done'`. */
  function resume() {
    if (phase !== "done") playing = true;
  }

  /** Réinitialisation complète : retour à u=0, toutes les ancres réarmées, lecture arrêtée. */
  function stop() {
    playing = false;
    phase = "cruising";
    u = 0;
    holdElapsed = 0;
    holdIndex = -1;
    visited.clear();
  }

  function setSpeed(multiplier) {
    if (multiplier > 0) speed = multiplier;
  }

  /** Repositionne u directement (ex. resynchronisation externe) sans toucher au reste de l'état. */
  function setU(value) {
    u = clamp01(value);
  }

  /**
   * Garantit au moins `minRemainingSeconds` de pause restante à partir de
   * MAINTENANT (la cible totale n'est repoussée que si besoin — jamais
   * raccourcie), plafonné à `maxHoldSeconds` au total. C'est ce plafond qui
   * borne « tenir tant que la voix parle encore » : main.js appelle
   * `extendHold` à chaque frame tant que `speechSynthesis.speaking` est vrai
   * pendant une pause ; dès que la voix s'arrête (ou que le plafond est
   * atteint), la pause s'écoule normalement. Sans effet hors d'une pause en
   * cours.
   * @param {number} minRemainingSeconds
   */
  function extendHold(minRemainingSeconds) {
    if (phase !== "holding") return;
    const desired = holdElapsed + Math.max(0, minRemainingSeconds);
    holdTarget = Math.min(maxHoldSeconds, Math.max(holdTarget, desired));
  }

  function currentHoldRemaining() {
    return phase === "holding" ? Math.max(0, holdTarget - holdElapsed) : 0;
  }

  /**
   * Fait avancer l'état de `dt` secondes ; sans effet si `playing` est faux
   * (pause/reprise ne font que basculer ce drapeau — `tick` reste l'unique
   * point d'écriture de `u`/`phase`).
   * @param {number} dt secondes
   * @returns {{u: number, phase: string, holdRemaining: number}}
   */
  function tick(dt) {
    if (playing) {
      if (phase === "holding") {
        holdElapsed += dt;
        if (holdElapsed >= holdTarget) {
          if (holdIndex >= anchorsU.length - 1) {
            phase = "done";
            playing = false;
            u = 1;
          } else {
            phase = "cruising";
          }
        }
      } else if (phase === "cruising") {
        const prevU = u;
        u = clamp01(u + (speed / totalSeconds) * dt);
        const crossed = firstCrossedAnchor(prevU, u);
        if (crossed !== -1) {
          u = anchorsU[crossed];
          enterHold(crossed);
        } else if (u >= 1 - EPS) {
          u = 1;
          phase = "done";
          playing = false;
        }
      }
    }
    return { u, phase, holdRemaining: currentHoldRemaining() };
  }

  return {
    tick,
    play,
    pause,
    resume,
    stop,
    setSpeed,
    setU,
    extendHold,
    get u() {
      return u;
    },
    get phase() {
      return phase;
    },
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    get holdRemaining() {
      return currentHoldRemaining();
    },
    get holdCount() {
      return visited.size;
    },
  };
}
