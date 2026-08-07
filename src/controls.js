/**
 * Custom orbit/pan/zoom camera controls, tuned for a small child on a
 * touchscreen or a parent on a trackpad — not three.js's OrbitControls,
 * because we want full control over feel (soft inertia, ground clamp,
 * eased flyTo presets) without fighting a generic implementation.
 *
 * Gestures:
 *  - 1 finger / left-drag  -> orbit (azimuth + polar). Mouse-drag has its
 *    VERTICAL axis inverted on purpose (post-v1: dragging up now does what
 *    dragging down used to do) — touch/pen drags stay natural, only
 *    pointerType "mouse" is flipped. Horizontal is never inverted.
 *  - 2 fingers pinch       -> zoom
 *  - 2 fingers drag / right-drag -> pan (moves the look-at target)
 *  - wheel                 -> zoom
 *  - ZQSD / WASD keys      -> pan the target horizontally, relative to the
 *    camera's current heading (see `panVectorFromKeys` below). Listened via
 *    `e.code` KeyW/KeyA/KeyS/KeyD — the *physical* key position, which is
 *    exactly where Z/Q/S/D sit on an AZERTY keyboard, so one set of
 *    listeners covers both layouts without checking `e.key` or locale.
 *
 * Spherical convention (around `target`):
 *   x = target.x + radius * sin(phi) * sin(theta)
 *   y = target.y + radius * cos(phi)
 *   z = target.z + radius * sin(phi) * cos(theta)
 * where phi is the polar angle from +Y (0 = straight overhead) and theta
 * is the azimuth around Y.
 */

import * as THREE from "three";
import { heightAt, RINGS } from "./geography.js";
import { lerp, smoothstep } from "./timeEngine.js";

// ============================================================================
// Tunables
// ============================================================================

const MIN_DISTANCE = 18;
// "pas au-delà de 2x le périphérique" — the périphérique's ellipse averages
// ~500 world units in radius (rx 575 / rz 430); double that with a little
// headroom above the `ensemble` preset's own ~1106 so the preset itself
// never sits right at the wall.
const MAX_DISTANCE = Math.max(RINGS.peripherique.rx, RINGS.peripherique.rz) * 2 + 100;

const MIN_ABOVE_GROUND = 4; // world units of clearance kept above terrain
const PHI_MIN = 0.12; // ~7deg — avoid a straight-overhead gimbal-ish feel
const PHI_MAX = 1.5; // ~86deg — avoid grazing the horizon / flipping under

const ORBIT_SPEED = 0.0055; // rad per pixel
const PAN_SPEED = 0.0016; // world units per pixel per unit of radius
const WHEEL_ZOOM_SPEED = 0.0016; // fraction of radius per wheel-delta unit
const PINCH_ZOOM_SPEED = 0.01; // fraction of radius per pixel of pinch delta

// ZQSD/WASD keyboard pan (post-v1). Speed is proportional to the current
// camera distance so it feels right both zoomed in (slow, precise) and
// zoomed out (fast enough to actually get somewhere) — see
// `panVectorFromKeys` below.
const KEY_PAN_SPEED = 0.6; // fraction of current distance, world units/sec

const INERTIA_DECAY = 5.5; // exponential decay rate (per second)
const INERTIA_STOP_EPS = 1e-4;

// Cinematic idle drift (task 16, "▶️ Lecture") — a slow yaw orbit that kicks
// in only once the user hasn't touched the camera for a while, so playback
// still looks "alive" during a long hold at a moment card without wrestling
// control away from a user who's actively looking around.
const DRIFT_IDLE_DELAY = 10; // seconds of no pointer/wheel/flight before drift starts
const DRIFT_YAW_RATE = (2 * Math.PI) / 180; // ~2deg/s, radians per second

// Loose world-space leash on the pan target so a long drag can't wander off
// into the void past the terrain's own extent (see layers/terrain.js).
const TARGET_BOUNDS = { xMin: -2000, xMax: 1600, zMin: -2000, zMax: 2000 };

export const PRESETS = {
  // Reproduces main.js's original fixed establishing shot exactly, so the
  // very first frame is unchanged: position (450,620,620), lookAt
  // (-140,0,-80) => offset (590,620,700), radius ~1105.66.
  ensemble: { target: [-140, 0, -80], distance: 1105.66, theta: 0.69298, phi: 0.9755 },
  cite: { target: [0, 0, 0], distance: 80, theta: 0.69298, phi: 0.9755 },
  chezNous: { target: [-131, 0, -497], distance: 90, theta: 0.69298, phi: 0.9755 },
  eiffel: { target: [-406, 0, -60], distance: 110, theta: 0.69298, phi: 0.9755 },
};

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// ============================================================================
// Pure helpers (exported for unit tests — no THREE/DOM dependency)
// ============================================================================

/**
 * ZQSD/WASD -> world-space pan delta for this frame, relative to the
 * camera's current heading. `heading` is `theta`, the azimuth used by the
 * spherical convention documented at the top of this file: forward (the
 * horizontal projection of the camera's look direction, i.e. towards
 * `target`) is `(-sin(heading), -cos(heading))`, and screen-right is
 * `(cos(heading), -sin(heading))` — the same right/forward basis `panBy`
 * already uses for drag-panning, so key-pan and drag-pan agree on which way
 * is which.
 *
 * Diagonal input (e.g. forward+right) is normalized so moving diagonally
 * isn't faster than moving along one axis. Returns `{dx:0, dz:0}` when no
 * relevant key is held.
 *
 * @param {{forward?: boolean, back?: boolean, left?: boolean, right?: boolean}} keys
 * @param {number} heading camera azimuth (theta), radians
 * @param {number} dt seconds elapsed this frame
 * @param {number} distance current camera distance (radius) — speed scales with it
 * @returns {{dx: number, dz: number}}
 */
export function panVectorFromKeys(keys, heading, dt, distance) {
  const forwardInput = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const rightInput = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  if (!forwardInput && !rightInput) return { dx: 0, dz: 0 };

  const sinH = Math.sin(heading);
  const cosH = Math.cos(heading);
  const fwdX = -sinH;
  const fwdZ = -cosH;
  const rightX = cosH;
  const rightZ = -sinH;

  let dirX = forwardInput * fwdX + rightInput * rightX;
  let dirZ = forwardInput * fwdZ + rightInput * rightZ;
  const len = Math.hypot(dirX, dirZ);
  if (len > 0) {
    dirX /= len;
    dirZ /= len;
  }

  const speed = distance * KEY_PAN_SPEED;
  return { dx: dirX * speed * dt, dz: dirZ * speed * dt };
}

/**
 * The signed vertical-orbit delta for a mouse-drag frame, with the vertical
 * axis inversion applied (post-v1: dragging up now does what dragging down
 * used to do, mouse only). Extracted as a pure one-liner so the sign flip
 * itself is unit-testable without any DOM/pointer machinery.
 * @param {number} dy pixels moved this frame (screen space, +down)
 * @param {number} speed radians per pixel (ORBIT_SPEED)
 * @param {boolean} invertVertical true for mouse drags, false for touch/pen
 * @returns {number} dPhi
 */
export function verticalOrbitDelta(dy, speed, invertVertical) {
  return (invertVertical ? -1 : 1) * dy * speed;
}

// ============================================================================
// Controls factory
// ============================================================================

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {HTMLElement} domElement - element to attach pointer/wheel listeners to
 * @param {() => {reducedMotion: boolean}} getState - read-only accessor for main.js's state
 */
export function createControls(camera, domElement, getState) {
  const target = new THREE.Vector3(...PRESETS.ensemble.target);
  let theta = PRESETS.ensemble.theta;
  let phi = PRESETS.ensemble.phi;
  let radius = PRESETS.ensemble.distance;

  let velTheta = 0;
  let velPhi = 0;
  let velRadius = 0;
  const velPan = new THREE.Vector2(0, 0); // world-space x/z per second

  const pointers = new Map(); // pointerId -> {x, y}
  let dragButton = null; // mouse button captured at gesture start (touch => 0)
  let dragPointerType = null; // "mouse" | "touch" | "pen" — captured at gesture start
  let lastPinch = null; // {dist, midX, midY}
  let lastMoveTime = 0;

  // ZQSD/WASD key-pan state (post-v1). Set by keydown/keyup below, consumed
  // every frame in update() — no per-keypress movement, so holding a key
  // gives smooth continuous motion regardless of OS key-repeat rate.
  const keys = { forward: false, back: false, left: false, right: false };

  let flight = null; // {fromTarget, toTarget, fromRadius, toRadius, elapsed, duration}

  // Idle drift (see DRIFT_* above): armed by main.js while playback (task 16)
  // is running, disarmed the instant it pauses/stops or the user touches the
  // camera. `idleTime` only accumulates once nothing else is moving the
  // camera (no flight, no pointer down, no inertia still settling).
  let driftArmed = false;
  let idleTime = 0;

  const _pos = new THREE.Vector3();

  function computePosition(t = theta, p = phi, r = radius, tg = target) {
    const sinPhi = Math.sin(p);
    _pos.set(
      tg.x + r * sinPhi * Math.sin(t),
      tg.y + r * Math.cos(p),
      tg.z + r * sinPhi * Math.cos(t)
    );
    return _pos;
  }

  /** Pulls `phi` up (shallower) if the current framing would dip the camera below ground. */
  function clampAboveGround() {
    for (let i = 0; i < 2; i++) {
      const pos = computePosition();
      const groundY = heightAt(pos.x, pos.z);
      const minY = groundY + MIN_ABOVE_GROUND;
      const camY = target.y + radius * Math.cos(phi);
      if (camY >= minY) return;
      const cosPhiMin = clamp((minY - target.y) / radius, -0.999, 0.999);
      phi = Math.min(phi, Math.acos(cosPhiMin));
      phi = clamp(phi, PHI_MIN, PHI_MAX);
    }
  }

  function applyClamps() {
    radius = clamp(radius, MIN_DISTANCE, MAX_DISTANCE);
    phi = clamp(phi, PHI_MIN, PHI_MAX);
    target.x = clamp(target.x, TARGET_BOUNDS.xMin, TARGET_BOUNDS.xMax);
    target.z = clamp(target.z, TARGET_BOUNDS.zMin, TARGET_BOUNDS.zMax);
    clampAboveGround();
  }

  function applyToCamera() {
    const pos = computePosition();
    camera.position.copy(pos);
    camera.lookAt(target);
  }

  function cancelFlight() {
    flight = null;
  }

  function stopInertia() {
    velTheta = 0;
    velPhi = 0;
    velRadius = 0;
    velPan.set(0, 0);
  }

  // --- Gesture math ---------------------------------------------------------

  function orbitBy(dx, dy, dt, invertVertical) {
    const dTheta = -dx * ORBIT_SPEED;
    const dPhi = verticalOrbitDelta(dy, ORBIT_SPEED, invertVertical);
    theta += dTheta;
    phi = clamp(phi + dPhi, PHI_MIN, PHI_MAX);
    if (dt > 0) {
      velTheta = dTheta / dt;
      velPhi = dPhi / dt;
    }
  }

  function panBy(dx, dy, dt) {
    // Pan along the camera's local right/forward axes projected onto the
    // ground plane, scaled by distance so it feels consistent at any zoom.
    const scale = PAN_SPEED * radius;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    // Screen-right in world space (camera looking roughly toward -offset).
    const rightX = cosT;
    const rightZ = -sinT;
    const fwdX = sinT;
    const fwdZ = cosT;
    const dX = (-dx * rightX + dy * fwdX) * scale;
    const dZ = (-dx * rightZ + dy * fwdZ) * scale;
    target.x += dX;
    target.z += dZ;
    if (dt > 0) {
      velPan.x = dX / dt;
      velPan.y = dZ / dt;
    }
  }

  function zoomBy(deltaRadius) {
    radius = clamp(radius * (1 + deltaRadius), MIN_DISTANCE, MAX_DISTANCE);
  }

  // --- Pointer handling ------------------------------------------------------

  function pointerXY(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function onPointerDown(e) {
    if (flight) cancelFlight();
    stopInertia();
    idleTime = 0; // any touch resets the "hasn't touched the camera" clock
    try {
      domElement.setPointerCapture(e.pointerId);
    } catch {
      /* ignore — not all pointer types support capture */
    }
    pointers.set(e.pointerId, pointerXY(e));
    lastMoveTime = performance.now();
    if (pointers.size === 1) {
      dragButton = e.button === 2 ? 2 : 0;
      dragPointerType = e.pointerType;
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      lastPinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2,
      };
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const now = performance.now();
    const dt = Math.max((now - lastMoveTime) / 1000, 1 / 240);
    lastMoveTime = now;

    const prev = pointers.get(e.pointerId);
    const curX = e.clientX;
    const curY = e.clientY;

    if (pointers.size === 1) {
      const dx = curX - prev.x;
      const dy = curY - prev.y;
      pointers.set(e.pointerId, { x: curX, y: curY });
      if (dragButton === 2) {
        panBy(dx, dy, dt);
      } else {
        // Vertical-axis invert is mouse-only (post-v1) — touch/pen orbit
        // stays natural (tablets shouldn't feel flipped).
        orbitBy(dx, dy, dt, dragPointerType === "mouse");
      }
      applyClamps();
      applyToCamera();
    } else if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: curX, y: curY });
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      if (lastPinch) {
        const distDelta = dist - lastPinch.dist;
        zoomBy(-distDelta * PINCH_ZOOM_SPEED);
        panBy(-(midX - lastPinch.midX), -(midY - lastPinch.midY), dt);
        velRadius = 0; // pinch is direct-manipulation, no zoom inertia
      }
      lastPinch = { dist, midX, midY };
      applyClamps();
      applyToCamera();
    } else {
      pointers.set(e.pointerId, { x: curX, y: curY });
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    try {
      domElement.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (pointers.size < 2) lastPinch = null;
    if (pointers.size === 0) {
      dragButton = null;
      dragPointerType = null;
    }
    if (getState().reducedMotion) stopInertia();
  }

  function onWheel(e) {
    e.preventDefault();
    if (flight) cancelFlight();
    stopInertia();
    idleTime = 0;
    zoomBy(e.deltaY * WHEEL_ZOOM_SPEED);
    applyClamps();
    applyToCamera();
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  // --- ZQSD/WASD key-pan -------------------------------------------------
  // Listened on `window` (like main.js's arrow-key handler) rather than
  // `domElement`, since keyboard events target whatever has DOM focus, not
  // necessarily the canvas. `e.code` is the *physical* key position
  // (locale-independent), so KeyW/KeyA/KeyS/KeyD is exactly Z/Q/S/D on an
  // AZERTY keyboard and W/A/S/D on QWERTY — one listener, both layouts, no
  // `e.key` string-matching. Modifier combos (Cmd/Ctrl/Alt) are left alone
  // so browser/OS shortcuts on those same physical keys keep working.

  function keyFromCode(code) {
    switch (code) {
      case "KeyW":
        return "forward";
      case "KeyS":
        return "back";
      case "KeyA":
        return "left";
      case "KeyD":
        return "right";
      default:
        return null;
    }
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const dir = keyFromCode(e.code);
    if (!dir) return;
    if (!keys[dir]) {
      // Edge-triggered: only on the false->true transition, so holding the
      // key doesn't keep re-cancelling anything every OS key-repeat tick.
      if (flight) cancelFlight();
      stopInertia();
      idleTime = 0;
    }
    keys[dir] = true;
  }

  function onKeyUp(e) {
    const dir = keyFromCode(e.code);
    if (dir) keys[dir] = false;
  }

  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.addEventListener("pointercancel", onPointerUp);
  domElement.addEventListener("wheel", onWheel, { passive: false });
  domElement.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // --- Public API -------------------------------------------------------------

  function resolvePreset(nameOrPreset) {
    if (typeof nameOrPreset === "string") return PRESETS[nameOrPreset];
    return nameOrPreset;
  }

  /**
   * Eases the camera to a named preset (or a preset-shaped object). Cancels
   * on the next user input (pointerdown/wheel). Instant when reducedMotion.
   * @param {string|object} nameOrPreset
   * @param {number} [duration] milliseconds
   */
  function flyTo(nameOrPreset, duration = 1400) {
    const preset = resolvePreset(nameOrPreset);
    if (!preset) return;
    stopInertia();
    idleTime = 0;
    const reduced = getState().reducedMotion;
    if (reduced || duration <= 0) {
      target.set(preset.target[0], preset.target[1], preset.target[2]);
      radius = preset.distance;
      if (typeof preset.theta === "number") theta = preset.theta;
      if (typeof preset.phi === "number") phi = preset.phi;
      applyClamps();
      applyToCamera();
      flight = null;
      return;
    }
    flight = {
      fromTarget: target.clone(),
      toTarget: new THREE.Vector3(preset.target[0], preset.target[1], preset.target[2]),
      fromRadius: radius,
      toRadius: preset.distance,
      duration: duration / 1000,
      elapsed: 0,
    };
  }

  /**
   * Advances inertia / an active flyTo. Call once per animation frame.
   * @param {number} dt seconds
   */
  function update(dt) {
    // ZQSD/WASD key-pan takes priority every frame it's active: it's
    // direct user input (not ambient animation), so it runs even under
    // reducedMotion, and it already cancelled any flyTo/inertia at the
    // keydown edge above — no need to re-check those here.
    if (keys.forward || keys.back || keys.left || keys.right) {
      const { dx, dz } = panVectorFromKeys(keys, theta, dt, radius);
      target.x += dx;
      target.z += dz;
      applyClamps();
      applyToCamera();
      idleTime = 0;
      return;
    }

    if (flight) {
      flight.elapsed += dt;
      const t = clamp(flight.elapsed / flight.duration, 0, 1);
      const eased = smoothstep(t);
      target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
      radius = lerp(flight.fromRadius, flight.toRadius, eased);
      applyClamps();
      applyToCamera();
      if (t >= 1) flight = null;
      idleTime = 0;
      return;
    }

    if (pointers.size > 0) {
      idleTime = 0; // direct manipulation in progress
      return;
    }

    const anyVelocity =
      Math.abs(velTheta) > INERTIA_STOP_EPS ||
      Math.abs(velPhi) > INERTIA_STOP_EPS ||
      Math.abs(velRadius) > INERTIA_STOP_EPS ||
      velPan.lengthSq() > INERTIA_STOP_EPS;
    if (anyVelocity) {
      idleTime = 0; // still settling from a fling — not idle yet
      const decay = Math.exp(-INERTIA_DECAY * dt);
      theta += velTheta * dt;
      phi = clamp(phi + velPhi * dt, PHI_MIN, PHI_MAX);
      radius = clamp(radius + velRadius * dt, MIN_DISTANCE, MAX_DISTANCE);
      target.x += velPan.x * dt;
      target.z += velPan.y * dt;

      velTheta *= decay;
      velPhi *= decay;
      velRadius *= decay;
      velPan.multiplyScalar(decay);

      applyClamps();
      applyToCamera();
      return;
    }

    // Truly idle: no flight, no pointer down, no inertia left to settle.
    // Drift only runs while armed (main.js arms it exactly while playback is
    // running) and never under reducedMotion.
    if (!driftArmed || getState().reducedMotion) return;
    idleTime += dt;
    if (idleTime < DRIFT_IDLE_DELAY) return;
    theta += DRIFT_YAW_RATE * dt;
    applyClamps();
    applyToCamera();
  }

  /**
   * Arms/disarms the idle cinematic drift (task 16). Disarming also resets
   * the idle clock so re-arming later always waits a fresh DRIFT_IDLE_DELAY,
   * rather than drifting immediately because the user happened to already
   * be idle before playback started.
   * @param {boolean} enabled
   */
  function setDrift(enabled) {
    driftArmed = enabled;
    idleTime = 0;
  }

  function dispose() {
    domElement.removeEventListener("pointerdown", onPointerDown);
    domElement.removeEventListener("pointermove", onPointerMove);
    domElement.removeEventListener("pointerup", onPointerUp);
    domElement.removeEventListener("pointercancel", onPointerUp);
    domElement.removeEventListener("wheel", onWheel);
    domElement.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  }

  // Initial placement (matches the original fixed camera exactly).
  applyClamps();
  applyToCamera();

  return {
    update,
    flyTo,
    dispose,
    setDrift,
    get target() {
      return target.clone();
    },
    // Debug/verification hook (main.js re-exposes this on window.__paris) —
    // lets Playwright read theta/phi/radius/target/keys without reaching
    // into module-private state.
    debugState: () => ({
      target: target.clone(),
      theta,
      phi,
      radius,
      keys: { ...keys },
    }),
  };
}
