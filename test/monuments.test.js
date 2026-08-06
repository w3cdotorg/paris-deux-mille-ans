import { test } from "node:test";
import assert from "node:assert/strict";
import { lifecycle } from "../src/timeEngine.js";
import { MONUMENTS, monumentStatesAt, monumentStateAt } from "../src/layers/monuments.js";
import { MODEL_BUILDERS, CHANTIER_STAGE, TOWER_STAGE } from "../src/monumentModels.js";
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
  // Les 9 sites du brief.
  assert.deepEqual(
    [...ids].sort(),
    [
      "arenes",
      "forum",
      "invalides",
      "louvre",
      "notreDame",
      "pantheon",
      "pontAuChange",
      "sainteChapelle",
      "thermes",
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
