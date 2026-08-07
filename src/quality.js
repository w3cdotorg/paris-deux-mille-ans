/**
 * Qualité graphique — trois tiers manuels + un mode auto par défaut.
 *
 * `ctx.quality` (créé dans main.js) est l'unique source de vérité pour les
 * cinq multiplicateurs `{ crowds, trees, rain, boats, shadows }` — ce module
 * ne crée jamais de nouvel objet à sa place (`applyTier` mute IN PLACE), pour
 * que les couches qui n'en gardent qu'une référence longue durée (terrain,
 * life, weather — voir leurs docstrings « capturé une fois à l'init ») lisent
 * toujours la valeur courante sans avoir besoin qu'on leur repasse `ctx`.
 *
 * ============================================================================
 * Ordre de sacrifice (spec) et ce qu'on n'y touche jamais
 *
 * foules → végétation → pluie/reflets → ombres. Concrètement : les trois
 * tiers ci-dessous ne sont *pas* une simple règle de trois sur un seul
 * facteur — chaque multiplicateur dégrade à son propre rythme (`shadows`
 * tombe à 0 dès `léger`, `boats` reste le mieux préservé) mais tous
 * respectent l'invariant testé dans quality.test.js : haut ≥ moyen ≥ léger,
 * champ par champ. Aucun tier, aucune étape de l'auto ne touche aux
 * monuments, aux murailles, aux repères (ghosts.js) ni à la fluidité du
 * scrub (buildings.js/terrain.js) — ces couches n'ont tout simplement pas de
 * bouton qualité, par construction.
 *
 * ============================================================================
 * Ombres — décision documentée, pas un oubli
 *
 * `weather.js` ne pose *aucune* shadow map (`sun.castShadow = false`,
 * décision déjà écrite au moment de créer la directionnelle, tâche 14 : une
 * shadow map utile sur un plan de 4000 unités vu depuis une caméra qui peut
 * orbiter librement coûterait plus qu'elle n'apporterait, et risquerait de
 * pénaliser justement la cible perf de cette tâche — iPad). Le champ
 * `shadows` existe donc pour l'instant comme une réservation d'API : il
 * descend avec les tiers (1 → 0,5 → 0) pour tenir le contrat d'interface et
 * l'ordre de sacrifice, mais n'active aucun rendu supplémentaire tant
 * qu'aucune couche ne le consomme. `shadows:1` et `shadows:0` produisent
 * donc rigoureusement le même rendu aujourd'hui — c'est le comportement que
 * le brief autorise explicitement quand activer de vraies ombres n'est pas
 * sûr d'être rentable.
 */

// ============================================================================
// Tiers — multiplicateurs exacts (spec)
// ============================================================================

export const TIERS = Object.freeze({
  haut: Object.freeze({ crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 }),
  moyen: Object.freeze({ crowds: 0.6, trees: 0.7, rain: 0.6, boats: 0.8, shadows: 0.5 }),
  leger: Object.freeze({ crowds: 0.3, trees: 0.4, rain: 0.3, boats: 0.5, shadows: 0 }),
});

/** Meilleur → pire ; l'auto ne descend/remonte jamais que d'un cran à la fois. */
export const TIER_ORDER = ["haut", "moyen", "leger"];

const QUALITY_KEYS = ["crowds", "trees", "rain", "boats", "shadows"];

/**
 * Copie `TIERS[tier]` dans `ctx.quality`, champ par champ, SANS remplacer
 * l'objet (`ctx.quality = ...` casserait toute référence déjà capturée par
 * une couche à l'init — voir le docstring de module). Ne notifie personne :
 * c'est `createController` (plus bas) qui enchaîne avec le rafraîchissement
 * des couches, jamais cette fonction seule.
 * @param {{quality: Record<string, number>}} ctx
 * @param {string} tier "haut" | "moyen" | "leger"
 * @returns {string} le tier appliqué (pour chaînage)
 */
export function applyTier(ctx, tier) {
  const preset = TIERS[tier];
  if (!preset) throw new Error(`Tier de qualité inconnu : ${tier}`);
  for (const key of QUALITY_KEYS) ctx.quality[key] = preset[key];
  return tier;
}

// ============================================================================
// Auto — moyenne glissante du temps de frame, hystérésis, jamais de sursaut
// ============================================================================

/** Fenêtre de la moyenne glissante (spec : "sur 4 s"), en secondes. */
const AUTO_WINDOW = 4;
/** Passe au tier inférieur si la moyenne glissante dépasse ce seuil. */
const DOWN_THRESHOLD_MS = 22;
/** Ne remonte que si la moyenne reste sous ce seuil. */
const UP_THRESHOLD_MS = 12;
/** ... pendant au moins cette durée continue (spec : "pendant 30 s"). */
const UP_HOLD_SECONDS = 30;
/**
 * Cooldown après CHAQUE changement (descente ou montée) avant d'en autoriser
 * un autre. Sans lui, une dégradation ferait chuter la moyenne glissante
 * seulement une fois que les échantillons *après* le changement ont eu le
 * temps de remplacer les anciens dans la fenêtre — sans cooldown, un tier qui
 * vient de descendre pourrait redescendre une deuxième fois sur la base
 * d'échantillons antérieurs au changement, avant même que l'amélioration
 * n'ait eu la moindre chance de se refléter dans la moyenne. Une fenêtre
 * pleine (AUTO_WINDOW) est le minimum nécessaire pour que la moyenne ne
 * contienne plus que des échantillons post-changement.
 */
const CHANGE_COOLDOWN = AUTO_WINDOW;

/**
 * Capacité du ring buffer des échantillons de frame — bien au-dessus de ce
 * qu'une fenêtre de AUTO_WINDOW (4 s) peut jamais accumuler à des cadences
 * réalistes (≈250 échantillons à 60 Hz, ≈570 à 144 Hz) ou dans les tests
 * synthétiques (dt ≥ 0.1). `ringPush` double la capacité plutôt que
 * d'écraser un échantillon encore dans la fenêtre si jamais elle était
 * dépassée, pour préserver exactement la sémantique de la fenêtre glissante.
 */
const AUTO_CAPACITY = 2048;

function createRing(capacity) {
  return { t: new Float64Array(capacity), ms: new Float64Array(capacity), head: 0, count: 0, capacity };
}

function growRing(ring) {
  const capacity = ring.capacity * 2;
  const t = new Float64Array(capacity);
  const ms = new Float64Array(capacity);
  for (let i = 0; i < ring.count; i++) {
    const idx = (ring.head + i) % ring.capacity;
    t[i] = ring.t[idx];
    ms[i] = ring.ms[idx];
  }
  ring.t = t;
  ring.ms = ms;
  ring.head = 0;
  ring.capacity = capacity;
}

function ringPush(ring, t, ms) {
  if (ring.count === ring.capacity) growRing(ring);
  const tail = (ring.head + ring.count) % ring.capacity;
  ring.t[tail] = t;
  ring.ms[tail] = ms;
  ring.count++;
}

function ringShiftOldest(ring) {
  ring.head = (ring.head + 1) % ring.capacity;
  ring.count--;
}

/**
 * État pur de la machine auto — aucune dépendance three/DOM, testable en
 * Node avec des `dt`/`frameMs` synthétiques (voir quality.test.js).
 * @param {string} [startTier]
 */
export function createAutoState(startTier = "haut") {
  return {
    tier: startTier,
    // Ring buffer préalloué (pas de `{t, ms}` par frame) : fenêtre glissante
    // de AUTO_WINDOW secondes, triée par t croissant du plus vieux (head) au
    // plus récent.
    ring: createRing(AUTO_CAPACITY),
    clock: 0, // secondes écoulées depuis createAutoState (ou le dernier enableAuto)
    goodSince: null, // instant (sur `clock`) depuis lequel la moyenne est restée < UP_THRESHOLD_MS sans interruption
    lastChangeAt: -Infinity,
  };
}

/**
 * Nourrit la machine auto d'une frame mesurée et applique la règle de
 * descente/montée. Pure — jamais d'accès à `ctx`/three ici, c'est
 * `createController` qui traduit un `changed:true` en `applyTier` + rebuild
 * des couches.
 * @param {ReturnType<typeof createAutoState>} auto
 * @param {number} dt secondes écoulées depuis la frame précédente
 * @param {number} frameMs durée de CETTE frame, en millisecondes
 * @returns {{changed:boolean, tier:string, direction?:'up'|'down', mean:number}}
 */
export function feedFrameTime(auto, dt, frameMs) {
  auto.clock += Math.max(0, dt);
  const ring = auto.ring;
  ringPush(ring, auto.clock, frameMs);
  while (ring.count > 1 && auto.clock - ring.t[ring.head] > AUTO_WINDOW) {
    ringShiftOldest(ring);
  }
  let sum = 0;
  for (let i = 0; i < ring.count; i++) {
    sum += ring.ms[(ring.head + i) % ring.capacity];
  }
  const mean = sum / ring.count;
  const sinceChange = auto.clock - auto.lastChangeAt;
  // La fenêtre n'est "pleine" (donc la moyenne réellement représentative des
  // AUTO_WINDOW dernières secondes, pas d'un unique échantillon de départ)
  // qu'une fois AUTO_WINDOW secondes écoulées depuis le début de cette
  // période de mesure — condition nécessaire pour qu'une dégradation soit
  // vraiment "sustained", pas une réaction à une seule frame accidentée.
  const windowFull = auto.clock >= AUTO_WINDOW;

  if (windowFull && mean > DOWN_THRESHOLD_MS && sinceChange >= CHANGE_COOLDOWN) {
    const idx = TIER_ORDER.indexOf(auto.tier);
    if (idx < TIER_ORDER.length - 1) {
      auto.tier = TIER_ORDER[idx + 1];
      auto.lastChangeAt = auto.clock;
      auto.goodSince = null;
      return { changed: true, tier: auto.tier, direction: "down", mean };
    }
  }

  if (mean < UP_THRESHOLD_MS) {
    if (auto.goodSince === null) auto.goodSince = auto.clock;
    if (auto.clock - auto.goodSince >= UP_HOLD_SECONDS && sinceChange >= CHANGE_COOLDOWN) {
      const idx = TIER_ORDER.indexOf(auto.tier);
      if (idx > 0) {
        auto.tier = TIER_ORDER[idx - 1];
        auto.lastChangeAt = auto.clock;
        auto.goodSince = auto.clock;
        return { changed: true, tier: auto.tier, direction: "up", mean };
      }
    }
  } else {
    // La moyenne est repassée au-dessus du seuil de montée : la série "sous
    // 12 ms" est rompue, il faut 30 s pleines à nouveau avant de remonter.
    auto.goodSince = null;
  }

  return { changed: false, tier: auto.tier, mean };
}

// ============================================================================
// Contrôleur — relie auto/manuel, ctx.quality et le rafraîchissement des
// couches qui n'échantillonnent leurs multiplicateurs qu'à l'init
// ============================================================================

/**
 * @param {{quality: Record<string, number>}} ctx
 * @param {{terrain?: {setQuality: Function}, life?: {setQuality: Function}, weather?: {setQuality: Function}}} consumers
 *   modules de couche exportant `setQuality(ctx)` — seuls ceux fournis sont
 *   appelés, pour rester testable sans importer les trois couches à la fois.
 * @param {string} [startTier]
 */
export function createController(ctx, consumers = {}, startTier = "haut") {
  const auto = createAutoState(startTier);
  let mode = "auto"; // "auto" | un tier manuel ("haut"/"moyen"/"leger")
  let effectiveTier = startTier;

  function refreshConsumers() {
    consumers.terrain?.setQuality(ctx);
    consumers.life?.setQuality(ctx);
    consumers.weather?.setQuality(ctx);
  }

  function setTier(tier) {
    effectiveTier = tier;
    applyTier(ctx, tier);
    refreshConsumers();
  }

  return {
    /** Sélection manuelle (⚙️) : applique le tier tout de suite, désactive l'auto pour la session. */
    setManualTier(tier) {
      if (!TIERS[tier]) return;
      mode = tier;
      setTier(tier);
    },
    /**
     * Chip "auto" (⚙️) : réactive l'auto à partir du tier courant (pas de
     * reset à `haut` — remonter au mieux se justifiera par sa propre mesure,
     * comme au tout premier démarrage).
     */
    enableAuto() {
      mode = "auto";
      auto.tier = effectiveTier;
      auto.ring.head = 0;
      auto.ring.count = 0;
      auto.clock = 0;
      auto.goodSince = null;
      auto.lastChangeAt = -Infinity;
    },
    /**
     * À appeler une fois par frame réelle (jamais par test — voir
     * `feedFrameTime` pour la version pure). No-op si l'auto est désactivé
     * (sélection manuelle en cours).
     * @param {number} dt secondes
     * @param {number} frameMs
     */
    update(dt, frameMs) {
      if (mode !== "auto") return null;
      const result = feedFrameTime(auto, dt, frameMs);
      if (result.changed) setTier(result.tier);
      return result;
    },
    isAuto() {
      return mode === "auto";
    },
    getTier() {
      return effectiveTier;
    },
    getMode() {
      return mode;
    },
  };
}
