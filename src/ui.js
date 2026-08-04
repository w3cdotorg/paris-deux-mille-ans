/**
 * The child-facing UI shell: bottom timeline (frise), round action buttons,
 * and the (currently empty) story-card slot Task 15 will fill.
 *
 * Follows the same init/update contract as the 3D layers in layers/ (see
 * layers/terrain.js) even though it drives the DOM, not the scene graph —
 * main.js calls `ui.init(state)` once and `ui.update(dt, state)` every
 * frame, right alongside the scene layers.
 *
 * This module never mutates `state` directly. It only emits events on
 * `bus`; main.js listens and mutates state (see main.js's `bus.addEventListener`
 * calls). The one exception is its own DOM (handle position, year text,
 * button pressed-states, popovers) which it owns outright.
 */

import { MOMENTS, YEAR_MIN, YEAR_MAX } from "./timeline.js";
import { sliderToYear, yearToSlider, lerp, smoothstep } from "./timeEngine.js";

export const bus = new EventTarget();

const ANCHORS = MOMENTS.map((m) => m.year);
const WEATHER_CYCLE = ["sun", "overcast", "rain", "night"];
const WEATHER_ICON = { sun: "☀️", overcast: "🌥️", rain: "🌧️", night: "🌙" };
const WEATHER_LABEL = { sun: "soleil", overcast: "nuageux", rain: "pluie", night: "nuit" };
const QUALITY_TIERS = [
  { value: "haut", label: "Haut" },
  { value: "moyen", label: "Moyen" },
  { value: "leger", label: "Léger" },
];
const PRESET_ITEMS = [
  { value: "ensemble", emoji: "🌍", label: "Vue d'ensemble" },
  { value: "cite", emoji: "🏛️", label: "L'Île de la Cité" },
  { value: "chezNous", emoji: "🏠", label: "Chez nous" },
  { value: "eiffel", emoji: "🗼", label: "La Tour Eiffel" },
];

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function formatYear(year) {
  const y = Math.round(year);
  return y < 0 ? `${Math.abs(y)} av. J.-C.` : `${y}`;
}

// ============================================================================
// Module state — DOM refs + tiny caches so DOM writes only happen on actual
// change ("UI updates throttled to actual changes").
// ============================================================================

let currentState = null;
let dom = null;
let tween = null; // {fromYear, toYear, elapsed, duration}
let dragging = false;
let openPopover = null;

let lastRenderedYear = null;
let lastHandlePct = null;
let lastActiveIndex = null;
let lastWeather = null;
let lastShowLandmarks = null;
let lastVoice = null;
let lastSound = null;
let lastQualityTier = null;

// ============================================================================
// DOM construction
// ============================================================================

function createIconButton(emoji, label, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pdma-icon-btn" + (extraClass ? ` ${extraClass}` : "");
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.textContent = emoji;
  return btn;
}

function createPopover(items, onSelect) {
  const pop = document.createElement("div");
  pop.className = "pdma-popover";
  pop.setAttribute("role", "menu");
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pdma-popover-btn";
    b.setAttribute("role", "menuitem");
    const emojiSpan = document.createElement("span");
    emojiSpan.className = "pdma-popover-emoji";
    emojiSpan.textContent = item.emoji || "";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = item.label;
    b.appendChild(emojiSpan);
    b.appendChild(labelSpan);
    b.addEventListener("click", () => {
      onSelect(item.value);
      closePopovers();
    });
    pop.appendChild(b);
  }
  return pop;
}

function closePopovers() {
  if (openPopover) {
    openPopover.classList.remove("pdma-open");
    openPopover = null;
  }
}

function togglePopover(pop) {
  if (openPopover === pop) {
    closePopovers();
    return;
  }
  closePopovers();
  pop.classList.add("pdma-open");
  openPopover = pop;
}

function buildDOM() {
  const root = document.createElement("div");
  root.id = "pdma-ui";
  root.className = "pdma-ui";

  // --- Story card slot (Task 15 fills this in) ------------------------------
  const storyCard = document.createElement("div");
  storyCard.id = "story-card";
  storyCard.className = "pdma-story-card";
  root.appendChild(storyCard);

  // --- Round action buttons (top-right cluster) -----------------------------
  const buttonsRow = document.createElement("div");
  buttonsRow.className = "pdma-buttons-row";

  const viewsWrap = document.createElement("div");
  viewsWrap.className = "pdma-btn-wrap";
  const viewsBtn = createIconButton("🏠", "Changer de vue");
  const viewsPopover = createPopover(PRESET_ITEMS, (name) => {
    bus.dispatchEvent(new CustomEvent("preset", { detail: { name } }));
  });
  viewsWrap.appendChild(viewsBtn);
  viewsWrap.appendChild(viewsPopover);
  viewsBtn.addEventListener("click", () => togglePopover(viewsPopover));

  const voiceBtn = createIconButton("🔊", "Voix");
  voiceBtn.addEventListener("click", () => {
    bus.dispatchEvent(
      new CustomEvent("voicechange", { detail: { enabled: !currentState.voice } })
    );
  });

  const soundBtn = createIconButton("🔈", "Sons");
  soundBtn.addEventListener("click", () => {
    bus.dispatchEvent(
      new CustomEvent("soundchange", { detail: { enabled: !currentState.sound } })
    );
  });

  const landmarksBtn = createIconButton("📍", "Repères");
  landmarksBtn.addEventListener("click", () => {
    bus.dispatchEvent(
      new CustomEvent("landmarkschange", { detail: { show: !currentState.showLandmarks } })
    );
  });

  const weatherBtn = createIconButton("☀️", "Météo : soleil");
  weatherBtn.addEventListener("click", () => {
    const idx = WEATHER_CYCLE.indexOf(currentState.weather);
    const next = WEATHER_CYCLE[(idx + 1) % WEATHER_CYCLE.length];
    bus.dispatchEvent(new CustomEvent("weatherchange", { detail: { weather: next } }));
  });

  const qualityWrap = document.createElement("div");
  qualityWrap.className = "pdma-btn-wrap";
  const qualityBtn = createIconButton("⚙️", "Qualité graphique");
  const qualityPopover = createPopover(QUALITY_TIERS, (tier) => {
    bus.dispatchEvent(new CustomEvent("qualitychange", { detail: { tier } }));
  });
  qualityWrap.appendChild(qualityBtn);
  qualityWrap.appendChild(qualityPopover);
  qualityBtn.addEventListener("click", () => togglePopover(qualityPopover));

  buttonsRow.appendChild(viewsWrap);
  buttonsRow.appendChild(voiceBtn);
  buttonsRow.appendChild(soundBtn);
  buttonsRow.appendChild(landmarksBtn);
  buttonsRow.appendChild(weatherBtn);
  buttonsRow.appendChild(qualityWrap);
  root.appendChild(buttonsRow);

  // --- Bottom timeline (frise) -----------------------------------------------
  const timeline = document.createElement("div");
  timeline.className = "pdma-timeline";

  const yearDisplay = document.createElement("div");
  yearDisplay.className = "pdma-year-display";
  yearDisplay.setAttribute("aria-live", "polite");
  timeline.appendChild(yearDisplay);

  const track = document.createElement("div");
  track.className = "pdma-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "Frise du temps");
  track.setAttribute("aria-valuemin", String(YEAR_MIN));
  track.setAttribute("aria-valuemax", String(YEAR_MAX));

  const trackFill = document.createElement("div");
  trackFill.className = "pdma-track-fill";
  track.appendChild(trackFill);

  const momentButtons = [];
  MOMENTS.forEach((moment, index) => {
    const btn = createIconButton(
      moment.icon,
      `${moment.titre} (${formatYear(moment.year)})`,
      "pdma-moment-btn"
    );
    btn.style.left = `${(index / (MOMENTS.length - 1)) * 100}%`;
    btn.addEventListener("click", () => {
      flyToYear(moment.year, 2000);
    });
    track.appendChild(btn);
    momentButtons.push(btn);
  });

  const handle = document.createElement("div");
  handle.className = "pdma-handle";
  handle.setAttribute("aria-hidden", "true");
  track.appendChild(handle);

  timeline.appendChild(track);
  root.appendChild(timeline);

  document.body.appendChild(root);

  // --- Drag interaction on the track (grab anywhere, incl. the handle) ------
  function trackPointerToYear(clientX) {
    const rect = track.getBoundingClientRect();
    const u = clamp((clientX - rect.left) / rect.width, 0, 1);
    return sliderToYear(u, ANCHORS);
  }

  track.addEventListener("pointerdown", (e) => {
    // A moment icon handles its own click (see flyToYear above) — don't
    // also start a track-wide "jump to pointer" drag underneath it, or the
    // icon's smooth ~2s flight would be preceded by an instant teleport to
    // (approximately) the same spot.
    if (e.target.closest(".pdma-moment-btn")) return;
    dragging = true;
    tween = null;
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    emitYearChange(trackPointerToYear(e.clientX));
  });
  track.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    emitYearChange(trackPointerToYear(e.clientX));
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      track.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);

  document.addEventListener("pointerdown", (e) => {
    if (openPopover && !e.target.closest(".pdma-btn-wrap")) closePopovers();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopovers();
  });

  return {
    root,
    storyCard,
    yearDisplay,
    track,
    trackFill,
    handle,
    momentButtons,
    voiceBtn,
    soundBtn,
    landmarksBtn,
    weatherBtn,
    qualityPopover,
  };
}

// ============================================================================
// Bus emission helpers
// ============================================================================

function emitYearChange(year) {
  const clamped = clamp(year, YEAR_MIN, YEAR_MAX);
  bus.dispatchEvent(new CustomEvent("yearchange", { detail: { year: clamped } }));
}

/**
 * Animates state.year toward `toYear` over `duration` ms (instant when
 * reducedMotion). Called by the 14 moment icons; exported so other code
 * (e.g. a future guided tour) could reuse it too.
 * @param {number} toYear
 * @param {number} [duration] milliseconds
 */
export function flyToYear(toYear, duration = 2000) {
  if (!currentState) return;
  dragging = false;
  if (currentState.reducedMotion || duration <= 0) {
    tween = null;
    emitYearChange(toYear);
    return;
  }
  tween = {
    fromYear: currentState.year,
    toYear,
    elapsed: 0,
    duration: duration / 1000,
  };
}

// ============================================================================
// Sync FROM state (throttled to actual changes) — the single place that
// reflects state.year/weather/... onto the DOM, regardless of what changed
// it (drag, icon flight, keyboard ←/→, window.__paris.setYear, ...).
// ============================================================================

function syncFromState(state) {
  // Handle position: continuous, not throttled — it must track smoothly
  // during a drag or a flight tween.
  const pct = yearToSlider(state.year, ANCHORS) * 100;
  if (lastHandlePct === null || Math.abs(pct - lastHandlePct) > 1e-3) {
    dom.handle.style.left = `${pct}%`;
    dom.trackFill.style.width = `${pct}%`;
    lastHandlePct = pct;
  }

  const rounded = Math.round(state.year);
  if (rounded !== lastRenderedYear) {
    lastRenderedYear = rounded;
    dom.yearDisplay.textContent = formatYear(rounded);
    dom.track.setAttribute("aria-valuenow", String(rounded));

    // Nearest moment gets the gentle "active" pulse.
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < MOMENTS.length; i++) {
      const d = Math.abs(MOMENTS[i].year - rounded);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    if (nearest !== lastActiveIndex) {
      if (lastActiveIndex !== null) dom.momentButtons[lastActiveIndex].classList.remove("pdma-active");
      dom.momentButtons[nearest].classList.add("pdma-active");
      lastActiveIndex = nearest;
    }
  }

  if (state.weather !== lastWeather) {
    lastWeather = state.weather;
    dom.weatherBtn.textContent = WEATHER_ICON[state.weather] || "☀️";
    const label = `Météo : ${WEATHER_LABEL[state.weather] || state.weather}`;
    dom.weatherBtn.setAttribute("aria-label", label);
    dom.weatherBtn.title = label;
  }

  if (state.showLandmarks !== lastShowLandmarks) {
    lastShowLandmarks = state.showLandmarks;
    dom.landmarksBtn.classList.toggle("pdma-pressed", state.showLandmarks);
  }

  if (state.voice !== lastVoice) {
    lastVoice = state.voice;
    dom.voiceBtn.classList.toggle("pdma-pressed", state.voice);
  }

  if (state.sound !== lastSound) {
    lastSound = state.sound;
    dom.soundBtn.classList.toggle("pdma-pressed", state.sound);
  }

  if (state.qualityTier !== lastQualityTier) {
    lastQualityTier = state.qualityTier;
    // Buttons are in the same order as QUALITY_TIERS, matched positionally.
    const idx = QUALITY_TIERS.findIndex((t) => t.value === state.qualityTier);
    const buttons = dom.qualityPopover.querySelectorAll(".pdma-popover-btn");
    buttons.forEach((btn, i) => btn.classList.toggle("pdma-pressed", i === idx));
  }
}

// ============================================================================
// Public layer-style contract
// ============================================================================

/** @param {object} state */
export function init(state) {
  currentState = state;
  dom = buildDOM();
  lastRenderedYear = null;
  lastHandlePct = null;
  lastActiveIndex = null;
  lastWeather = null;
  lastShowLandmarks = null;
  lastVoice = null;
  lastSound = null;
  lastQualityTier = null;
  syncFromState(state);
}

/**
 * @param {number} dt seconds
 * @param {object} state
 */
export function update(dt, state) {
  currentState = state;
  if (tween && !dragging) {
    tween.elapsed += dt;
    const t = clamp(tween.elapsed / tween.duration, 0, 1);
    const eased = smoothstep(t);
    const year = lerp(tween.fromYear, tween.toYear, eased);
    emitYearChange(year);
    if (t >= 1) tween = null;
  }
  syncFromState(state);
}
