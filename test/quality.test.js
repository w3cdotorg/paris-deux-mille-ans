import { test } from "node:test";
import assert from "node:assert/strict";
import { TIERS, TIER_ORDER, applyTier, createAutoState, feedFrameTime, createController } from "../src/quality.js";

// ============================================================================
// Tiers — valeurs exactes de la spec
// ============================================================================

test("TIERS : valeurs exactes de la spec (haut/moyen/léger)", () => {
  assert.deepEqual(TIERS.haut, { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 });
  assert.deepEqual(TIERS.moyen, { crowds: 0.6, trees: 0.7, rain: 0.6, boats: 0.8, shadows: 0.5 });
  assert.deepEqual(TIERS.leger, { crowds: 0.3, trees: 0.4, rain: 0.3, boats: 0.5, shadows: 0 });
});

test("TIERS : ordre de dégradation respecté champ par champ (haut ≥ moyen ≥ léger)", () => {
  for (const key of ["crowds", "trees", "rain", "boats", "shadows"]) {
    assert.ok(TIERS.haut[key] >= TIERS.moyen[key], `${key}: haut < moyen`);
    assert.ok(TIERS.moyen[key] >= TIERS.leger[key], `${key}: moyen < léger`);
  }
});

test("TIER_ORDER : haut → moyen → léger, meilleur en premier", () => {
  assert.deepEqual(TIER_ORDER, ["haut", "moyen", "leger"]);
});

test("applyTier : mute ctx.quality IN PLACE (même référence d'objet)", () => {
  const ctx = { quality: { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1, windows: 1 } };
  const ref = ctx.quality;
  applyTier(ctx, "moyen");
  assert.equal(ctx.quality, ref, "l'objet quality a été remplacé, pas muté");
  assert.equal(ctx.quality.crowds, 0.6);
  assert.equal(ctx.quality.shadows, 0.5);
  // `windows` n'est pas l'un des 5 multiplicateurs de tier (spec) : jamais touché.
  assert.equal(ctx.quality.windows, 1);
});

test("applyTier : lève sur un tier inconnu plutôt que de corrompre ctx.quality silencieusement", () => {
  const ctx = { quality: { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 } };
  assert.throws(() => applyTier(ctx, "ultra"));
});

// ============================================================================
// Auto — machine à état pure (dt/frameMs synthétiques)
// ============================================================================

test("auto : descend d'un cran quand la moyenne glissante dépasse 22 ms, une fois la fenêtre de 4 s pleine", () => {
  const auto = createAutoState("haut");
  let changedAt = null;
  for (let i = 1; i <= 8; i++) {
    const r = feedFrameTime(auto, 0.5, 25); // 25 ms constant, dt=0.5s -> clock atteint 4.0 au 8e appel
    if (r.changed) {
      changedAt = { step: i, clock: auto.clock, tier: r.tier, direction: r.direction };
      break;
    }
  }
  assert.ok(changedAt, "aucune descente déclenchée");
  assert.equal(changedAt.tier, "moyen");
  assert.equal(changedAt.direction, "down");
  // La fenêtre n'était pleine (4 s) qu'à ce moment précis, pas avant.
  assert.ok(changedAt.clock >= 4, `descente trop tôt : clock=${changedAt.clock}`);
});

test("auto : ne descend PAS avant que la fenêtre de 4 s soit pleine (pas de réaction à une frame isolée)", () => {
  const auto = createAutoState("haut");
  // Une unique frame catastrophique (100 ms) ne doit rien déclencher : la
  // moyenne glissante est bien > 22, mais moins de 4 s se sont écoulées.
  const r = feedFrameTime(auto, 0.1, 100);
  assert.equal(r.changed, false);
  assert.equal(r.tier, "haut");
});

test("auto : hystérésis — cooldown après un changement, pas de cascade immédiate même si la moyenne reste mauvaise", () => {
  const auto = createAutoState("haut");
  const tiers = [];
  for (let i = 1; i <= 16; i++) {
    const r = feedFrameTime(auto, 0.5, 25);
    if (r.changed) tiers.push({ clock: Math.round(auto.clock * 10) / 10, tier: r.tier });
  }
  // Une deuxième descente (moyen -> léger) est légitime une fois le cooldown
  // écoulé (clock 8.0), mais PAS entre les deux (clock 4.0..8.0) — sinon un
  // seul mauvais relevé sonné cascaderait directement à léger.
  assert.deepEqual(
    tiers.map((t) => t.tier),
    ["moyen", "leger"]
  );
  assert.ok(tiers[1].clock - tiers[0].clock >= 4 - 1e-9, `pas de cooldown respecté : ${JSON.stringify(tiers)}`);
});

test("auto : ne descend jamais sous 'leger'", () => {
  const auto = createAutoState("leger");
  for (let i = 1; i <= 40; i++) {
    const r = feedFrameTime(auto, 0.5, 40);
    assert.equal(r.changed, false, "léger est déjà le pire tier");
  }
  assert.equal(auto.tier, "leger");
});

test("auto : zone morte 12-22 ms — aucun changement, même longtemps", () => {
  const auto = createAutoState("moyen");
  for (let i = 1; i <= 120; i++) {
    const r = feedFrameTime(auto, 0.5, 15);
    assert.equal(r.changed, false, `changement inattendu à clock=${auto.clock}`);
  }
  assert.equal(auto.tier, "moyen");
});

test("auto : ne remonte qu'après 30 s continues sous 12 ms, jamais avant", () => {
  const auto = createAutoState("leger");
  let changed = null;
  for (let i = 1; i <= 31; i++) {
    const r = feedFrameTime(auto, 1, 8); // clock == i après cet appel
    if (r.changed) {
      changed = { clock: auto.clock, tier: r.tier, direction: r.direction };
      break;
    }
    // Pas de remontée avant que 30 s pleines se soient écoulées.
    assert.ok(auto.clock < 31, `remontée trop tôt à clock=${auto.clock}`);
  }
  assert.ok(changed, "aucune remontée déclenchée");
  assert.equal(changed.direction, "up");
  assert.equal(changed.tier, "moyen");
  assert.equal(changed.clock, 31);
});

test("auto : ne remonte jamais au-delà de 'haut'", () => {
  const auto = createAutoState("haut");
  for (let i = 1; i <= 40; i++) {
    const r = feedFrameTime(auto, 1, 8);
    assert.equal(r.changed, false, "haut est déjà le meilleur tier");
  }
  assert.equal(auto.tier, "haut");
});

test("auto : une frame mauvaise interrompt le compteur de 30 s (le streak redémarre à zéro)", () => {
  const auto = createAutoState("leger");
  // 20 s de bonnes frames (sous le seuil de remontée, mais pas assez pour
  // déclencher les 30 s).
  for (let i = 1; i <= 20; i++) feedFrameTime(auto, 1, 8);
  assert.equal(auto.tier, "leger");
  // Un unique saut de dt=10s à 15 ms : la fenêtre glissante de 4 s ne
  // contient alors plus QUE cet échantillon (tout le reste a > 4 s d'âge et
  // a été purgé) — la moyenne dépasse 12 ms, ce qui casse le streak "sous
  // 12 ms" en cours.
  const r = feedFrameTime(auto, 10, 15);
  assert.equal(r.changed, false);
  assert.equal(auto.goodSince, null, "le streak de bonnes frames doit être remis à zéro");

  // Reprend ensuite de bonnes frames — la moyenne redescend sous 12 ms dès
  // que l'échantillon à 15 ms est dilué/expulsé de la fenêtre ; peu importe
  // exactement quand cela arrive (question de dilution, pas de spec), ce
  // qui compte est qu'il faille alors 30 NOUVELLES secondes pleines à
  // partir de LÀ, jamais moins.
  let goodSinceStart = null;
  let changedAt = null;
  for (let i = 1; i <= 60 && changedAt === null; i++) {
    const step = feedFrameTime(auto, 1, 8);
    if (goodSinceStart === null && auto.goodSince !== null) goodSinceStart = auto.goodSince;
    if (step.changed) changedAt = { clock: auto.clock, direction: step.direction, tier: step.tier };
  }

  assert.ok(goodSinceStart !== null, "le streak aurait dû repartir");
  assert.ok(changedAt, "aucune remontée déclenchée dans la fenêtre du test");
  assert.equal(changedAt.direction, "up");
  assert.equal(changedAt.clock - goodSinceStart, 30, "il faut exactement 30 s pleines depuis le RESTART du streak");
});

// ============================================================================
// Contrôleur — auto/manuel, notification des couches consommatrices
// ============================================================================

function fakeConsumer() {
  const snapshots = [];
  return {
    setQuality(ctx) {
      snapshots.push({ ...ctx.quality });
    },
    snapshots,
  };
}

test("createController : sélection manuelle applique le tier tout de suite et notifie chaque couche fournie", () => {
  const ctx = { quality: { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 } };
  const terrain = fakeConsumer();
  const life = fakeConsumer();
  const weather = fakeConsumer();
  const ctl = createController(ctx, { terrain, life, weather }, "haut");

  ctl.setManualTier("leger");

  assert.equal(ctl.getTier(), "leger");
  assert.equal(ctl.getMode(), "leger");
  assert.equal(ctl.isAuto(), false);
  assert.deepEqual(ctx.quality, TIERS.leger);
  for (const consumer of [terrain, life, weather]) {
    assert.equal(consumer.snapshots.length, 1);
    assert.deepEqual(consumer.snapshots[0], TIERS.leger);
  }
});

test("createController : un tier manuel désactive l'auto — update() ne change plus rien", () => {
  const ctx = { quality: { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 } };
  const terrain = fakeConsumer();
  const ctl = createController(ctx, { terrain }, "haut");

  ctl.setManualTier("leger");
  terrain.snapshots.length = 0; // ne compte que ce qui se passe APRÈS la sélection manuelle

  // Un temps de frame catastrophique ne doit RIEN faire : l'auto est éteint.
  for (let i = 0; i < 20; i++) ctl.update(0.5, 90);

  assert.equal(ctl.getTier(), "leger");
  assert.equal(terrain.snapshots.length, 0, "aucune notification attendue en mode manuel");
});

test("createController : la chip 'auto' réactive l'auto à partir du tier courant, pas d'un reset à 'haut'", () => {
  const ctx = { quality: { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 } };
  const terrain = fakeConsumer();
  const ctl = createController(ctx, { terrain }, "haut");

  ctl.setManualTier("leger");
  ctl.enableAuto();

  assert.equal(ctl.isAuto(), true);
  assert.equal(ctl.getTier(), "leger", "enableAuto ne doit pas remonter à haut de son propre chef");

  // De bonnes frames soutenues doivent maintenant pouvoir remonter d'un cran.
  let stepped = false;
  for (let i = 0; i < 32 && !stepped; i++) {
    const r = ctl.update(1, 8);
    if (r && r.changed) stepped = true;
  }
  assert.equal(stepped, true, "l'auto réactivé doit pouvoir remonter à nouveau");
  assert.equal(ctl.getTier(), "moyen");
});

test("createController : l'auto dégrade automatiquement sous charge soutenue et notifie les couches", () => {
  const ctx = { quality: { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 } };
  const terrain = fakeConsumer();
  const life = fakeConsumer();
  const ctl = createController(ctx, { terrain, life }, "haut");

  let stepped = false;
  for (let i = 0; i < 10 && !stepped; i++) {
    const r = ctl.update(0.5, 25);
    if (r && r.changed) stepped = true;
  }

  assert.equal(stepped, true);
  assert.equal(ctl.getTier(), "moyen");
  assert.deepEqual(ctx.quality, TIERS.moyen);
  assert.equal(terrain.snapshots.length, 1);
  assert.equal(life.snapshots.length, 1);
});
