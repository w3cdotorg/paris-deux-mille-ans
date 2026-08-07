import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { lifecycle } from "../src/timeEngine.js";
import {
  MONUMENTS,
  monumentStatesAt,
  monumentStateAt,
  init as initMonuments,
  forceRescan,
  update as updateMonuments,
  debugCounts,
} from "../src/layers/monuments.js";
import {
  MODEL_BUILDERS,
  CHANTIER_STAGE,
  TOWER_STAGE,
  EIFFEL_STAGES,
  EIFFEL_TOP,
  EIFFEL_FLOOR3,
  EIFFEL_SPARKLE_COUNT,
  eiffelHalfSpanAt,
  DEFENSE_TOWERS,
  defenseTowerStage,
} from "../src/monumentModels.js";
import { ARCHETYPES } from "../src/archetypes.js";
import { LANDMARKS, MONUMENT_FOOTPRINTS, insideMonumentFootprint } from "../src/geography.js";

// ============================================================================
// Structure du registre
// ============================================================================

test("registre : chaque site a un id unique, des coordonnées finies, un label et une phrase", () => {
  const ids = new Set();
  for (const m of MONUMENTS) {
    assert.ok(typeof m.id === "string" && m.id.length > 0, "id manquant");
    assert.ok(!ids.has(m.id), `id dupliqué : ${m.id}`);
    ids.add(m.id);
    assert.ok(Number.isFinite(m.x) && Number.isFinite(m.z), `${m.id} : coordonnées non finies`);
    assert.ok(typeof m.label === "string" && m.label.length > 2, `${m.id} : label manquant`);
    assert.ok(typeof m.phrase === "string" && m.phrase.length > 10, `${m.id} : phrase manquante`);
    assert.ok(Array.isArray(m.states) && m.states.length >= 1, `${m.id} : aucun état`);
  }
  // Les 9 sites de la tâche 10 + les 5 de la tâche 11.
  assert.deepEqual(
    [...ids].sort(),
    [
      "arenes",
      "forum",
      "invalides",
      "laDefense",
      "louvre",
      "notreDame",
      "operaGarnier",
      "pantheon",
      "pontAuChange",
      "sacreCoeur",
      "sainteChapelle",
      "thermes",
      "tourEiffel",
      "tourMontparnasse",
    ]
  );
});

test("registre : chaque état pointe vers un constructeur de modèle existant", () => {
  for (const m of MONUMENTS) {
    for (const st of m.states) {
      assert.equal(
        typeof MODEL_BUILDERS[st.model],
        "function",
        `${m.id}.${st.id} : modèle « ${st.model} » sans constructeur`
      );
    }
  }
});

test("registre : années cohérentes — born < died, buildYears > 0, razeYears >= 0", () => {
  for (const m of MONUMENTS) {
    for (const st of m.states) {
      assert.ok(Number.isFinite(st.born), `${m.id}.${st.id} : born non fini`);
      assert.ok(st.buildYears > 0, `${m.id}.${st.id} : buildYears doit être > 0`);
      if (st.died !== undefined) {
        assert.ok(st.died > st.born, `${m.id}.${st.id} : died (${st.died}) <= born (${st.born})`);
        assert.ok((st.razeYears ?? 5) >= 0, `${m.id}.${st.id} : razeYears négatif`);
      }
    }
  }
});

test("registre : dans un même slot, les états se succèdent (born du suivant >= died du précédent)", () => {
  for (const m of MONUMENTS) {
    const bySlot = new Map();
    for (const st of m.states) {
      assert.ok(typeof st.slot === "string" && st.slot.length > 0, `${m.id}.${st.id} : slot manquant`);
      if (!bySlot.has(st.slot)) bySlot.set(st.slot, []);
      bySlot.get(st.slot).push(st);
    }
    for (const [slot, states] of bySlot) {
      // L'ordre de déclaration doit déjà être chronologique.
      for (let i = 1; i < states.length; i++) {
        assert.ok(
          states[i].born >= states[i - 1].born,
          `${m.id}/${slot} : états déclarés hors ordre chronologique`
        );
        assert.notEqual(
          states[i - 1].died,
          undefined,
          `${m.id}/${slot} : ${states[i - 1].id} n'a pas de died mais un successeur`
        );
        // Recouvrement autorisé uniquement pendant la démolition du précédent
        // (crossgrow : l'ancien rétrécit pendant que le nouveau pousse).
        assert.ok(
          states[i].born >= states[i - 1].died,
          `${m.id}/${slot} : ${states[i].id} naît (${states[i].born}) avant la mort de ${states[i - 1].id} (${states[i - 1].died})`
        );
      }
      // Les sites « toujours là aujourd'hui » doivent avoir un dernier état
      // immortel — c'est la promesse de continuité du projet. Les autres (le
      // forum romain, rasé pour toujours) meurent légitimement.
      const ETERNAL = new Set(["notreDame", "louvre", "thermes", "pontAuChange", "arenes"]);
      const last = states[states.length - 1];
      if (slot === "main" && ETERNAL.has(m.id)) {
        assert.equal(last.died, undefined, `${m.id}/main : l'état final ${last.id} ne doit pas mourir`);
      }
    }
  }
});

test("registre : un seul état par slot est en train de naître à un instant donné (pas de doublon visuel)", () => {
  for (let year = -250; year <= 2026; year += 1) {
    const present = monumentStatesAt(year);
    const byKey = new Map();
    for (const s of present) {
      const key = `${s.monument}/${s.slot}`;
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    for (const [key, n] of byKey) {
      // Deux états d'un même slot peuvent coexister *seulement* pendant la
      // fenêtre de crossgrow (l'un en razing, l'autre en building).
      if (n <= 1) continue;
      const both = present.filter((s) => `${s.monument}/${s.slot}` === key);
      assert.equal(n, 2, `${key} : ${n} états simultanés en ${year}`);
      const phases = both.map((s) => s.phase).sort();
      assert.deepEqual(phases, ["building", "razing"], `${key} en ${year} : phases ${phases}`);
    }
  }
});

// ============================================================================
// Notre-Dame — la traversée demandée par le brief
// ============================================================================

const nd = (year, stateId) => monumentStateAt(year, "notreDame", stateId);

test("Notre-Dame : en l'an 100, rien encore sur le site", () => {
  const present = monumentStatesAt(100).filter((s) => s.monument === "notreDame");
  assert.deepEqual(present, []);
});

test("Notre-Dame : en 400, le temple gallo-romain (et lui seul)", () => {
  const present = monumentStatesAt(400).filter((s) => s.monument === "notreDame");
  assert.equal(present.length, 1);
  assert.equal(present[0].state, "templeRomain");
  assert.equal(present[0].presence, 1);
});

test("Notre-Dame : en 800, la basilique Saint-Étienne (et le temple a disparu)", () => {
  const present = monumentStatesAt(800).filter((s) => s.monument === "notreDame");
  assert.equal(present.length, 1);
  assert.equal(present[0].state, "basilique");
  assert.equal(present[0].presence, 1);
  assert.equal(nd(800, "templeRomain").phase, "gone");
});

test("Notre-Dame : en 1250, la cathédrale est en chantier (présence strictement entre 0 et 1)", () => {
  const { phase, presence } = nd(1250, "cathedrale");
  assert.equal(phase, "building");
  assert.ok(presence > 0 && presence < 1, `présence attendue dans (0,1), obtenue ${presence}`);
  // ... et les grues sont dans leur fenêtre de visibilité.
  assert.ok(presence >= CHANTIER_STAGE[0] && presence <= CHANTIER_STAGE[1]);
});

test("Notre-Dame : en 1400 la cathédrale est achevée, plus aucune grue", () => {
  const { phase, presence } = nd(1400, "cathedrale");
  assert.equal(phase, "alive");
  assert.equal(presence, 1);
  assert.ok(presence > CHANTIER_STAGE[1], "à présence 1 les grues doivent être hors fenêtre");
});

test("Notre-Dame : les tours n'émergent qu'à la fin du chantier (~1293-1341)", () => {
  const st = MONUMENTS.find((m) => m.id === "notreDame").states.find((s) => s.id === "cathedrale");
  const yearAt = (p) => st.born + p * st.buildYears;
  assert.ok(yearAt(TOWER_STAGE[0]) > 1280, "les tours ne doivent pas démarrer avant ~1280");
  assert.ok(yearAt(TOWER_STAGE[1]) <= 1345, "les tours doivent être finies vers 1345");
  // ... et rien d'autre ne monte après elles.
  assert.ok(TOWER_STAGE[1] >= 0.95);
});

test("Notre-Dame : en 1900, cathédrale + flèche de Viollet-le-Duc", () => {
  const present = monumentStatesAt(1900).filter((s) => s.monument === "notreDame");
  const ids = present.map((s) => s.state).sort();
  assert.deepEqual(ids, ["cathedrale", "fleche"]);
  assert.equal(nd(1900, "fleche").presence, 1);
});

test("Notre-Dame : en 2021, plus de flèche mais un échafaudage — la cathédrale reste entière", () => {
  const present = monumentStatesAt(2021).filter((s) => s.monument === "notreDame");
  const ids = present.map((s) => s.state).sort();
  assert.deepEqual(ids, ["cathedrale", "echafaudage"]);
  assert.equal(nd(2021, "fleche").presence, 0);
  assert.equal(nd(2021, "cathedrale").presence, 1);
});

test("Notre-Dame : en 2026, la flèche est revenue et l'échafaudage est parti", () => {
  const present = monumentStatesAt(2026).filter((s) => s.monument === "notreDame");
  const ids = present.map((s) => s.state).sort();
  assert.deepEqual(ids, ["cathedrale", "flecheNeuve"]);
  assert.equal(nd(2026, "flecheNeuve").presence, 1);
  assert.equal(nd(2026, "echafaudage").presence, 0);
});

test("Notre-Dame : la cathédrale ne meurt jamais après 1163", () => {
  for (const year of [1163.5, 1400, 1800, 2019, 2026]) {
    const { phase } = nd(year, "cathedrale");
    assert.ok(phase === "building" || phase === "alive", `en ${year}, phase = ${phase}`);
  }
});

// ============================================================================
// Louvre, arènes, thermes, pont
// ============================================================================

test("Louvre : forteresse en 1300, palais en 1700, palais + pyramide en 2026", () => {
  const at = (y) =>
    monumentStatesAt(y)
      .filter((s) => s.monument === "louvre")
      .map((s) => s.state)
      .sort();
  assert.deepEqual(at(1300), ["forteresse"]);
  assert.deepEqual(at(1700), ["palais"]);
  assert.deepEqual(at(2026), ["palais", "pyramide"]);
});

test("Louvre : en 1550, la forteresse rétrécit pendant que le palais pousse (crossgrow)", () => {
  const forteresse = monumentStateAt(1550, "louvre", "forteresse");
  const palais = monumentStateAt(1550, "louvre", "palais");
  assert.equal(forteresse.phase, "razing");
  assert.equal(palais.phase, "building");
  assert.ok(forteresse.presence > 0 && forteresse.presence < 1);
  assert.ok(palais.presence > 0 && palais.presence < 1);
});

test("Arènes : présentes en 200, disparues en 1000, de retour (partielles) en 2026", () => {
  const at = (y) =>
    monumentStatesAt(y)
      .filter((s) => s.monument === "arenes")
      .map((s) => s.state);
  assert.deepEqual(at(200), ["arenes"]);
  assert.deepEqual(at(1000), []);
  assert.deepEqual(at(2026), ["square"]);
});

test("Thermes : les bains meurent en 300 et la ruine, elle, ne meurt jamais", () => {
  assert.equal(monumentStateAt(250, "thermes", "thermes").presence, 1);
  assert.equal(monumentStateAt(400, "thermes", "thermes").presence, 0);
  assert.equal(monumentStateAt(400, "thermes", "ruine").phase, "alive");
  assert.equal(monumentStateAt(2026, "thermes", "ruine").phase, "alive");
});

test("Forum : bâti vers 100, complètement disparu en 700", () => {
  assert.equal(monumentStateAt(300, "forum", "forum").presence, 1);
  assert.equal(monumentStateAt(700, "forum", "forum").presence, 0);
});

test("Pont au Change : maisons + moulins de 1110 à 1786, pont de pierre pour toujours", () => {
  const at = (y) =>
    monumentStatesAt(y)
      .filter((s) => s.monument === "pontAuChange")
      .map((s) => s.state)
      .sort();
  assert.deepEqual(at(1050), []);
  assert.deepEqual(at(1400), ["moulins", "pont"]);
  assert.deepEqual(at(2026), ["pont"]);
});

test("Sainte-Chapelle, Panthéon, Invalides : présents aux années clés du brief", () => {
  const has = (y, id) => monumentStatesAt(y).some((s) => s.monument === id);
  assert.equal(has(1240, "sainteChapelle"), false);
  assert.equal(has(1750, "sainteChapelle"), true);
  assert.equal(has(1750, "invalides"), true); // 1671 + 35 = 1706
  assert.equal(has(1750, "pantheon"), false); // 1758
  assert.equal(has(1800, "pantheon"), true);
});

// ============================================================================
// monumentStatesAt — contrat général
// ============================================================================

test("monumentStatesAt : chaque entrée porte de quoi être cliquée (label, phrase, position, présence)", () => {
  for (const s of monumentStatesAt(1400)) {
    assert.ok(typeof s.label === "string" && s.label.length > 2);
    assert.ok(typeof s.phrase === "string" && s.phrase.length > 10);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z));
    assert.ok(s.presence > 0 && s.presence <= 1);
    assert.ok(["building", "alive", "razing"].includes(s.phase));
  }
});

test("monumentStatesAt : jamais rien avant l'an 80 (les arènes sont le plus ancien monument)", () => {
  assert.deepEqual(monumentStatesAt(-250), []);
  assert.deepEqual(monumentStatesAt(79), []);
  assert.deepEqual(
    monumentStatesAt(81).map((s) => s.monument),
    ["arenes"]
  );
});

test("monumentStatesAt : cohérent avec lifecycle état par état, sur toute la frise", () => {
  for (let year = -250; year <= 2026; year += 7) {
    const present = new Set(monumentStatesAt(year).map((s) => `${s.monument}.${s.state}`));
    for (const m of MONUMENTS) {
      for (const st of m.states) {
        const expected = lifecycle(year, st).presence > 0;
        assert.equal(
          present.has(`${m.id}.${st.id}`),
          expected,
          `${m.id}.${st.id} en ${year} : attendu ${expected}`
        );
      }
    }
  }
});

// ============================================================================
// Modèles — construction réelle des géométries (three.js, sans WebGL)
// ============================================================================

test("modèles : chaque constructeur renvoie un groupe non vide, sans NaN, avec des pièces mesurables", async () => {
  for (const [name, build] of Object.entries(MODEL_BUILDERS)) {
    const g = build();
    assert.ok(g.isObject3D, `${name} : pas un Object3D`);
    assert.ok(g.children.length >= 3, `${name} : seulement ${g.children.length} pièces`);
    assert.equal(g.visible, false, `${name} : doit naître invisible (le layer révèle)`);
    let meshes = 0;
    const walk = (node) => {
      for (const child of node.children) {
        if (child.isGroup) {
          assert.ok(child.userData.spin, `${name} : sous-groupe non animé inattendu`);
          walk(child);
          continue;
        }
        meshes++;
        const ud = child.userData;
        assert.ok(Number.isFinite(ud.y0), `${name} : y0 non fini`);
        assert.ok(Number.isFinite(ud.h) && ud.h > 0, `${name} : h invalide`);
        assert.ok(["base", "center", "fixed"].includes(ud.anchor), `${name} : anchor ${ud.anchor}`);
        for (const v of [child.position, child.scale]) {
          assert.ok(
            Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z),
            `${name} : transformation non finie`
          );
        }
      }
    };
    walk(g);
    assert.ok(meshes >= 3, `${name} : ${meshes} maillages`);
  }
});

test("modèles : le chantier de Notre-Dame porte exactement 2 grues qui tournent autour de Y", () => {
  const g = MODEL_BUILDERS.cathedraleGothique();
  const cranes = g.children.filter((c) => c.isGroup && c.userData.spin?.axis === "y");
  assert.equal(cranes.length, 2);
  for (const c of cranes) {
    assert.notEqual(c.userData.spin.speed, 0);
    assert.ok(Array.isArray(c.userData.stage), "une grue doit être bornée à la fenêtre de chantier");
    assert.ok(c.children.length >= 5, "une grue doit avoir mât, flèche, contrepoids, roue...");
  }
});

test("modèles : le pont aux moulins porte exactement 4 roues qui tournent autour de X", () => {
  const g = MODEL_BUILDERS.pontMoulins();
  const wheels = g.children.filter((c) => c.isGroup && c.userData.spin?.axis === "x");
  assert.equal(wheels.length, 4);
  for (const w of wheels) assert.ok(w.userData.spin.speed > 0);
});

test("modèles : les tours de Notre-Dame dominent la ville — plus hautes que tout bâtiment procédural", () => {
  const g = MODEL_BUILDERS.cathedraleGothique();
  let top = 0;
  for (const c of g.children) {
    if (c.isGroup) continue;
    top = Math.max(top, c.userData.y0 + c.userData.h);
  }
  // Le plus haut archétype hors tours modernes (qui n'existent pas dans le
  // centre historique) doit rester nettement en dessous.
  const tallestOld = Math.max(
    ...ARCHETYPES.filter((a) => a.family !== "moderne").map((a) => a.h ?? 0)
  );
  assert.ok(top > 6, `sommet des tours attendu > 6 unités (60 m), obtenu ${top}`);
  assert.ok(
    top > tallestOld * 1.5,
    `les tours (${top}) doivent dominer le plus haut bâtiment ancien (${tallestOld})`
  );
});

// ============================================================================
// Pousse (buildYears) — un état sans étage doit sortir de terre
// progressivement, pas apparaître d'un coup à taille finale (régression
// corrigée : `stageProgress` renvoyait 1 dès que `presence > 0`).
// ============================================================================

test("pousse : un état sans étage (Sainte-Chapelle) grandit avec la présence", () => {
  const scene = new THREE.Group();
  initMonuments({ scene });

  const group = scene.children.find((g) => g.name === "monument_sainteChapelle");
  assert.ok(group, "groupe de la Sainte-Chapelle introuvable dans la scène");
  // Une pièce qui pousse (grow:true), sans stage : le corps bas de la chapelle.
  const piece = group.children.find((c) => !c.isGroup && c.userData.grow && !c.userData.stage);
  assert.ok(piece, "aucune pièce sans étage à observer");
  const fullHeight = piece.userData.h;

  const st = MONUMENTS.find((m) => m.id === "sainteChapelle").states[0];
  const yearAt = (p) => st.born + p * st.buildYears;

  forceRescan(yearAt(0.2));
  assert.equal(piece.visible, true, "à 20 % du chantier, la pièce doit déjà être visible (elle pousse)");
  const scaleLow = piece.scale.y;

  forceRescan(yearAt(0.8));
  const scaleHigh = piece.scale.y;

  // Avant le correctif, les deux valeurs étaient identiques et égales à
  // `fullHeight` (le vieux fallback de `stageProgress` renvoyait 1 dès que
  // `presence > 0`). Ici, 20 % doit être visiblement partiel...
  assert.ok(
    scaleLow > 0 && scaleLow < fullHeight * 0.9,
    `à 20 % du chantier, hauteur ${scaleLow} attendue nettement < hauteur finale ${fullHeight}`
  );
  // ... et 80 % doit être strictement plus haut que 20 % (croissance monotone).
  assert.ok(scaleHigh > scaleLow, `la hauteur doit strictement croître (20 % → ${scaleLow}, 80 % → ${scaleHigh})`);
  // ... et proche de la hauteur finale (léger dépassement `easeOutBack` toléré).
  assert.ok(
    scaleHigh > fullHeight * 0.9 && scaleHigh < fullHeight * 1.1,
    `à 80 %, hauteur ${scaleHigh} attendue proche de la hauteur finale ${fullHeight}`
  );
});

test("pousse : le séquencement étagé de Notre-Dame (nef d'abord, tours en dernier) n'a pas régressé", () => {
  const scene = new THREE.Group();
  initMonuments({ scene });
  const group = scene.children.find((g) => g.name === "monument_cathedraleGothique");
  assert.ok(group, "groupe de la cathédrale introuvable dans la scène");

  const st = MONUMENTS.find((m) => m.id === "notreDame").states.find((s) => s.id === "cathedrale");
  const yearAt = (p) => st.born + p * st.buildYears;

  // La nef (stage [0, 0.32]).
  const nave = group.children.find(
    (c) =>
      !c.isGroup && Array.isArray(c.userData.stage) && c.userData.stage[0] === 0 && c.userData.stage[1] === 0.32
  );
  assert.ok(nave, "pièce de la nef introuvable");
  // Les deux tours (stage TOWER_STAGE, les seules pièces qui démarrent à 0,72).
  const towers = group.children.filter(
    (c) => !c.isGroup && Array.isArray(c.userData.stage) && c.userData.stage[0] === TOWER_STAGE[0]
  );
  assert.equal(towers.length, 2, "les deux tours doivent être identifiables par leur stage");

  // À 20 % du chantier : la nef pousse déjà, les tours n'existent pas encore.
  forceRescan(yearAt(0.2));
  assert.ok(nave.visible && nave.scale.y > 0, "la nef doit déjà pousser à 20 % du chantier");
  for (const t of towers) assert.equal(t.visible, false, "les tours ne doivent pas encore être visibles à 20 %");

  // À 85 % (dans la fenêtre TOWER_STAGE) : les tours poussent, la nef est finie.
  forceRescan(yearAt(0.85));
  for (const t of towers) assert.ok(t.visible && t.scale.y > 0, "les tours doivent pousser à 85 %");
  assert.equal(nave.scale.y, nave.userData.h, "la nef, achevée depuis longtemps, reste à sa hauteur finale");
});

// ============================================================================
// Emprises — accord entre le registre, les modèles et buildings.js
// ============================================================================

test("emprises : chaque site du registre (hors pont, sur l'eau) a une emprise déclarée", () => {
  const declared = new Set(MONUMENT_FOOTPRINTS.map((f) => f.id));
  for (const m of MONUMENTS) {
    if (m.id === "pontAuChange") continue; // au-dessus de l'eau : aucun bâti possible
    assert.ok(declared.has(m.id), `${m.id} : aucune emprise dans MONUMENT_FOOTPRINTS`);
  }
});

/**
 * Boîte englobante horizontale de tous les états d'un site, dans le repère du
 * site (rotation de pièce prise en compte exactement pour les boîtes,
 * conservativement pour les cylindres/cônes qui y sont inscrits).
 */
function siteExtent(m) {
  let minx = Infinity;
  let maxx = -Infinity;
  let minz = Infinity;
  let maxz = -Infinity;
  for (const st of m.states) {
    const g = MODEL_BUILDERS[st.model]();
    for (const child of g.children) {
      const ry = child.rotation.y || 0;
      const ca = Math.abs(Math.cos(ry));
      const sa = Math.abs(Math.sin(ry));
      // Un sous-groupe animé (grue, roue) : on ne retient que son socle — sa
      // flèche surplombe volontairement les toits voisins, 45 m plus haut.
      const hx = child.isGroup ? 1.1 : (child.scale.x * ca + child.scale.z * sa) / 2;
      const hz = child.isGroup ? 1.1 : (child.scale.x * sa + child.scale.z * ca) / 2;
      minx = Math.min(minx, child.position.x - hx);
      maxx = Math.max(maxx, child.position.x + hx);
      minz = Math.min(minz, child.position.z - hz);
      maxz = Math.max(maxz, child.position.z + hz);
    }
  }
  return { minx, maxx, minz, maxz };
}

test("emprises : couvrent réellement l'étendue des modèles du site, sans excès", () => {
  for (const m of MONUMENTS) {
    if (m.id === "pontAuChange") continue; // au-dessus de l'eau
    const f = MONUMENT_FOOTPRINTS.find((x) => x.id === m.id);
    const e = siteExtent(m);
    const needed = Math.hypot((e.maxx - e.minx) / 2, (e.maxz - e.minz) / 2);
    const cx = m.x + (e.minx + e.maxx) / 2;
    const cz = m.z + (e.minz + e.maxz) / 2;
    // Le disque déclaré doit contenir la boîte englobante réelle...
    const offset = Math.hypot(cx - f.x, cz - f.z);
    assert.ok(
      offset + needed <= f.r + 1e-6,
      `${m.id} : disque r=${f.r} centré (${f.x}, ${f.z}) trop petit — il faut ${(offset + needed).toFixed(2)}`
    );
    // ... sans stériliser un quartier entier pour rien.
    assert.ok(
      f.r <= needed + 2,
      `${m.id} : disque r=${f.r} bien plus large que nécessaire (${needed.toFixed(2)})`
    );
  }
});

test("emprises : le parvis de Notre-Dame et la Sainte-Chapelle sont interdits au bâti procédural", () => {
  assert.equal(insideMonumentFootprint(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z), true);
  assert.equal(insideMonumentFootprint(LANDMARKS.sainteChapelle.x, LANDMARKS.sainteChapelle.z), true);
  // ... mais l'île garde de la place ailleurs (est de l'île, vers Saint-Louis).
  assert.equal(insideMonumentFootprint(10, 3), false);
});

// ============================================================================
// TOUR EIFFEL — les 4 quarts de chantier (tâche 11)
// ============================================================================

/** Les pièces de maçonnerie d'un modèle (hors sous-groupes animés et scintillement). */
function modelPieces(group) {
  return group.children.filter((c) => !c.isGroup && !c.userData.sparkle);
}

/** Quart de chantier (0..3) auquel appartient une pièce étagée. */
function tierOf(piece) {
  return Math.min(3, Math.floor(piece.userData.stage[0] / 0.25));
}

test("Eiffel : quatre quarts de chantier déclarés, contigus, couvrant [0,1]", () => {
  assert.equal(EIFFEL_STAGES.length, 4);
  assert.deepEqual(EIFFEL_STAGES, [
    [0, 0.25],
    [0.25, 0.5],
    [0.5, 0.75],
    [0.75, 1],
  ]);
});

test("Eiffel : chaque pièce porte un étage, entièrement contenu dans un seul quart", () => {
  const g = MODEL_BUILDERS.tourEiffel();
  const pieces = modelPieces(g);
  assert.ok(pieces.length >= 30, `la tour n'a que ${pieces.length} pièces`);
  const perTier = [0, 0, 0, 0];
  for (const p of pieces) {
    const st = p.userData.stage;
    assert.ok(Array.isArray(st), "une pièce de la tour Eiffel sans étage : elle apparaîtrait trop tôt");
    const tier = tierOf(p);
    const [lo, hi] = EIFFEL_STAGES[tier];
    assert.ok(
      st[0] >= lo - 1e-9 && st[1] <= hi + 1e-9,
      `étage [${st}] à cheval sur deux quarts (quart ${tier} = [${lo}, ${hi}])`
    );
    perTier[tier]++;
  }
  for (let t = 0; t < 4; t++) {
    assert.ok(perTier[t] >= 1, `le quart ${t} n'a aucune pièce`);
  }
});

test("Eiffel : les dates du chantier tombent sur les vraies (1er étage 1888, sommet 1889)", () => {
  const st = MONUMENTS.find((m) => m.id === "tourEiffel").states[0];
  assert.equal(st.born, 1887);
  assert.equal(st.buildYears, 2.3);
  const yearAt = (p) => st.born + p * st.buildYears;
  // 1er étage fini vers avril 1888, 2e vers août 1888, pointe en mars 1889.
  assert.ok(Math.abs(yearAt(0.5) - 1888.15) < 0.1, `1er étage fini en ${yearAt(0.5)}`);
  assert.ok(Math.abs(yearAt(0.75) - 1888.7) < 0.15, `2e étage fini en ${yearAt(0.75)}`);
  assert.ok(Math.abs(yearAt(1) - 1889.3) < 0.05, `tour finie en ${yearAt(1)}`);
});

test("Eiffel : les étages apparaissent SUCCESSIVEMENT (0,2 → piliers ; 0,6 → 2 étages ; 1 → tout)", () => {
  const scene = new THREE.Group();
  initMonuments({ scene });
  const group = scene.children.find((g) => g.name === "monument_tourEiffel");
  assert.ok(group, "groupe de la tour Eiffel introuvable");
  const pieces = modelPieces(group);
  const byTier = [0, 1, 2, 3].map((t) => pieces.filter((p) => tierOf(p) === t));

  const st = MONUMENTS.find((m) => m.id === "tourEiffel").states[0];
  const yearAt = (p) => st.born + p * st.buildYears;
  const visibleIn = (tier) => byTier[tier].filter((p) => p.visible).length;

  // 0,2 : les piliers et l'arche montent, rien au-dessus.
  forceRescan(yearAt(0.2));
  assert.ok(visibleIn(0) > 0, "les piliers doivent être visibles à 20 %");
  assert.equal(visibleIn(1), 0, "aucun 1er étage à 20 %");
  assert.equal(visibleIn(2), 0, "aucun 2e étage à 20 %");
  assert.equal(visibleIn(3), 0, "aucune flèche à 20 %");

  // 0,6 : les piliers et le 1er étage sont finis, le 2e monte, pas de flèche.
  forceRescan(yearAt(0.6));
  assert.equal(visibleIn(0), byTier[0].length, "les piliers sont finis à 60 %");
  assert.equal(visibleIn(1), byTier[1].length, "le 1er étage est fini à 60 %");
  assert.ok(visibleIn(2) > 0, "le 2e étage doit monter à 60 %");
  assert.equal(visibleIn(3), 0, "aucune flèche à 60 % — c'est la photo de 1888");

  // 1 : tout est là, et la pointe est bien à 30 unités (300 m).
  forceRescan(yearAt(1));
  for (let t = 0; t < 4; t++) {
    assert.equal(visibleIn(t), byTier[t].length, `quart ${t} incomplet à la fin du chantier`);
  }
  let top = 0;
  for (const p of pieces) top = Math.max(top, p.userData.y0 + p.userData.h);
  assert.ok(Math.abs(top - EIFFEL_TOP) < 1e-6, `sommet à ${top}, attendu ${EIFFEL_TOP}`);
});

test("Eiffel : elle domine tout — plus haute que la tour Montparnasse et que La Défense", () => {
  const topOf = (name) => {
    const g = MODEL_BUILDERS[name]();
    let top = 0;
    for (const c of g.children) {
      if (c.isGroup || c.userData.sparkle) continue;
      top = Math.max(top, c.userData.y0 + c.userData.h);
    }
    return top;
  };
  const eiffel = topOf("tourEiffel");
  assert.ok(eiffel > topOf("tourMontparnasse") * 1.3, "la tour Eiffel doit dominer Montparnasse");
  assert.ok(eiffel > topOf("laDefense") * 1.3, "la tour Eiffel doit dominer La Défense");
  assert.ok(eiffel > topOf("cathedraleGothique") * 3, "la tour Eiffel doit écraser Notre-Dame");
});

test("Eiffel : le scintillement n'existe qu'achevé, la nuit, et après 2000", () => {
  const scene = new THREE.Group();
  initMonuments({ scene });
  const group = scene.children.find((g) => g.name === "monument_tourEiffel");
  const field = group.children.find((c) => c.userData.sparkle);
  assert.ok(field, "champ scintillant introuvable");
  assert.equal(field.count, EIFFEL_SPARKLE_COUNT);
  assert.equal(field.userData.positions.length, EIFFEL_SPARKLE_COUNT * 3);
  // Tous les points sont sur la structure : dans l'emprise et sous le 3e étage.
  for (let i = 0; i < EIFFEL_SPARKLE_COUNT; i++) {
    const x = field.userData.positions[i * 3];
    const y = field.userData.positions[i * 3 + 1];
    const z = field.userData.positions[i * 3 + 2];
    assert.ok(y > 0 && y <= EIFFEL_FLOOR3, `point ${i} hors hauteur : ${y}`);
    const half = eiffelHalfSpanAt(y) + 1e-6;
    assert.ok(Math.abs(x) <= half && Math.abs(z) <= half, `point ${i} hors emprise à y=${y}`);
  }

  const state = (year, weather) => ({ year, weather, time: 4, reducedMotion: false });

  // 1950 : la tour est là mais elle ne scintille pas encore, même la nuit.
  forceRescan(1950);
  updateMonuments(0.016, state(1950, "night"));
  assert.equal(field.visible, false, "pas de scintillement avant 2000");

  // 2026 de jour : rien non plus.
  forceRescan(2026);
  updateMonuments(0.016, state(2026, "sun"));
  assert.equal(field.visible, false, "pas de scintillement en plein jour");

  // 2026 la nuit : ça pétille.
  updateMonuments(0.016, state(2026, "night"));
  assert.equal(field.visible, true, "la tour doit scintiller la nuit après 2000");
  assert.equal(debugCounts(2026).sparkleFieldsLit, 1);

  // ... et le scintillement bouge dans le temps (sauf sous reducedMotion).
  const m = new THREE.Matrix4();
  const readScales = () => {
    const out = [];
    for (let i = 0; i < EIFFEL_SPARKLE_COUNT; i++) {
      field.getMatrixAt(i, m);
      out.push(m.elements[0]);
    }
    return out;
  };
  const a = readScales();
  updateMonuments(0.016, { year: 2026, weather: "night", time: 40, reducedMotion: false });
  const b = readScales();
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), "le scintillement doit clignoter");

  updateMonuments(0.016, { year: 2026, weather: "night", time: 80, reducedMotion: true });
  const c1 = readScales();
  updateMonuments(0.016, { year: 2026, weather: "night", time: 200, reducedMotion: true });
  assert.equal(JSON.stringify(c1), JSON.stringify(readScales()), "figé sous reducedMotion");
  assert.ok(c1.every((s) => s > 0), "sous reducedMotion, tous les points restent allumés");
});

// ============================================================================
// LA DÉFENSE — 8 tours qui poussent l'une après l'autre + la Grande Arche
// ============================================================================

test("La Défense : 8 tours, chacune avec sa propre fenêtre, étalées de 1970 à ~2010", () => {
  assert.equal(DEFENSE_TOWERS.length, 8);
  const st = MONUMENTS.find((m) => m.id === "laDefense").states.find((s) => s.id === "tours");
  const yearAt = (p) => st.born + p * st.buildYears;
  let previousEnd = -Infinity;
  for (let i = 0; i < 8; i++) {
    const [a, b] = defenseTowerStage(i);
    assert.ok(b > a, `fenêtre vide pour la tour ${i}`);
    assert.ok(a >= previousEnd - 0.05, "les tours doivent se succéder, pas surgir ensemble");
    previousEnd = b;
  }
  assert.ok(yearAt(defenseTowerStage(0)[1]) < 1980, "la 1re tour est finie avant 1980");
  const last = yearAt(defenseTowerStage(7)[1]);
  assert.ok(last > 2000 && last < 2015, `la dernière tour est finie en ${last}`);
});

test("La Défense : en 1980 quelques tours seulement, en 2026 les huit + la Grande Arche", () => {
  const scene = new THREE.Group();
  initMonuments({ scene });
  const towers = scene.children.find((g) => g.name === "monument_laDefense");
  const arche = scene.children.find((g) => g.name === "monument_grandeArche");
  assert.ok(towers && arche);

  const slabs = towers.children.filter(
    (c) => !c.isGroup && DEFENSE_TOWERS.some((t) => Math.abs(c.userData.h - t.h) < 1e-9 && c.userData.sx > 1)
  );
  assert.equal(slabs.length, 8, "les 8 fûts doivent être identifiables");
  const visible = () => slabs.filter((c) => c.visible).length;

  forceRescan(1968);
  assert.equal(towers.visible, false, "rien avant 1970");

  forceRescan(1980);
  assert.ok(visible() > 0 && visible() < 8, `en 1980, ${visible()} tours sur 8`);
  assert.equal(arche.visible, false, "la Grande Arche n'existe pas encore en 1980");

  forceRescan(1987);
  assert.equal(arche.visible, true, "la Grande Arche est en chantier en 1987");

  forceRescan(2026);
  assert.equal(visible(), 8, "les 8 tours sont là en 2026");
  assert.equal(arche.visible, true);
});

// ============================================================================
// Sacré-Cœur, Opéra, Montparnasse — présence aux années clés
// ============================================================================

test("Sacré-Cœur : chantier de 1875 à 1914, campanile en dernier", () => {
  const st = MONUMENTS.find((m) => m.id === "sacreCoeur").states[0];
  assert.equal(st.born, 1875);
  assert.equal(st.born + st.buildYears, 1914);
  assert.equal(monumentStateAt(1870, "sacreCoeur", "basilique").presence, 0);
  assert.equal(monumentStateAt(1900, "sacreCoeur", "basilique").phase, "building");
  assert.equal(monumentStateAt(1930, "sacreCoeur", "basilique").phase, "alive");

  // Le campanile (les pièces les plus au nord, z ≈ -4,2) monte dans le dernier
  // cinquième du chantier.
  const g = MODEL_BUILDERS.sacreCoeur();
  const campanile = g.children.filter((c) => c.position.z < -3.5);
  assert.ok(campanile.length >= 3, "le campanile doit avoir plusieurs pièces");
  for (const c of campanile) {
    assert.ok(c.userData.stage[0] >= 0.8, `pièce du campanile trop précoce : ${c.userData.stage}`);
  }
});

test("Opéra et Montparnasse : aux bonnes années, et Montparnasse fait bien 21 unités", () => {
  assert.equal(monumentStateAt(1855, "operaGarnier", "opera").presence, 0);
  assert.equal(monumentStateAt(1880, "operaGarnier", "opera").phase, "alive");
  assert.equal(monumentStateAt(1965, "tourMontparnasse", "tour").presence, 0);
  assert.equal(monumentStateAt(1971, "tourMontparnasse", "tour").phase, "building");
  assert.equal(monumentStateAt(1975, "tourMontparnasse", "tour").phase, "alive");

  const g = MODEL_BUILDERS.tourMontparnasse();
  let top = 0;
  let tallestPiece = 0;
  for (const c of g.children) {
    top = Math.max(top, c.userData.y0 + c.userData.h);
    tallestPiece = Math.max(tallestPiece, c.userData.h);
  }
  // Le fût lui-même mesure 21 unités (210 m, la vraie cote) ; avec le socle et
  // les locaux techniques du toit, le point le plus haut est un peu au-dessus.
  assert.equal(tallestPiece, 21.0);
  assert.ok(top > 21.5 && top < 23.5, `sommet de Montparnasse à ${top}`);
});
