/**
 * Custom orbit/pan/zoom camera controls, tuned for a small child on a
 * touchscreen or a parent on a trackpad — not three.js's OrbitControls,
 * because we want full control over feel (soft inertia, ground clamp,
 * eased flyTo presets) without fighting a generic implementation.
 *
 * Gestures:
 *  - 1 finger / left-drag  -> orbit (azimuth + polar)
 *  - 2 fingers pinch       -> zoom
 *  - 2 fingers drag / right-drag -> pan (moves the look-at target)
 *  - wheel                 -> zoom
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

const INERTIA_DECAY = 5.5; // exponential decay rate (per second)
const INERTIA_STOP_EPS = 1e-4;

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
  let lastPinch = null; // {dist, midX, midY}
  let lastMoveTime = 0;

  let flight = null; // {fromTarget, toTarget, fromRadius, toRadius, elapsed, duration}

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

  function orbitBy(dx, dy, dt) {
    const dTheta = -dx * ORBIT_SPEED;
    const dPhi = dy * ORBIT_SPEED;
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
    try {
      domElement.setPointerCapture(e.pointerId);
    } catch {
      /* ignore — not all pointer types support capture */
    }
    pointers.set(e.pointerId, pointerXY(e));
    lastMoveTime = performance.now();
    if (pointers.size === 1) {
      dragButton = e.button === 2 ? 2 : 0;
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
        orbitBy(dx, dy, dt);
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
    if (pointers.size === 0) dragButton = null;
    if (getState().reducedMotion) stopInertia();
  }

  function onWheel(e) {
    e.preventDefault();
    if (flight) cancelFlight();
    stopInertia();
    zoomBy(e.deltaY * WHEEL_ZOOM_SPEED);
    applyClamps();
    applyToCamera();
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.addEventListener("pointercancel", onPointerUp);
  domElement.addEventListener("wheel", onWheel, { passive: false });
  domElement.addEventListener("contextmenu", onContextMenu);

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
    if (flight) {
      flight.elapsed += dt;
      const t = clamp(flight.elapsed / flight.duration, 0, 1);
      const eased = smoothstep(t);
      target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
      radius = lerp(flight.fromRadius, flight.toRadius, eased);
      applyClamps();
      applyToCamera();
      if (t >= 1) flight = null;
      return;
    }

    if (pointers.size > 0) return; // direct manipulation in progress

    const anyVelocity =
      Math.abs(velTheta) > INERTIA_STOP_EPS ||
      Math.abs(velPhi) > INERTIA_STOP_EPS ||
      Math.abs(velRadius) > INERTIA_STOP_EPS ||
      velPan.lengthSq() > INERTIA_STOP_EPS;
    if (!anyVelocity) return;

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
  }

  function dispose() {
    domElement.removeEventListener("pointerdown", onPointerDown);
    domElement.removeEventListener("pointermove", onPointerMove);
    domElement.removeEventListener("pointerup", onPointerUp);
    domElement.removeEventListener("pointercancel", onPointerUp);
    domElement.removeEventListener("wheel", onWheel);
    domElement.removeEventListener("contextmenu", onContextMenu);
  }

  // Initial placement (matches the original fixed camera exactly).
  applyClamps();
  applyToCamera();

  return { update, flyTo, dispose, get target() { return target.clone(); } };
}
