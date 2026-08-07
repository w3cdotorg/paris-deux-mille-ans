import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCardTrigger,
  interpolatePopulation,
  roundPopulation,
  orderOfMagnitude,
  formatPopulation,
  resolveMonumentHit,
  CARD_THRESHOLD_YEARS,
} from "../src/narration.js";
import { MOMENTS } from "../src/timeline.js";
import { monumentStatesAt } from "../src/layers/monuments.js";

// ============================================================================
// createCardTrigger — hystérésis de la carte-récit
// ============================================================================

test("cardTrigger : ne se déclenche pas tant qu'on est hors de toute zone ±8 ans", () => {
  const trigger = createCardTrigger();
  // Aucune ancre proche de 1820 (voisines : 1789 à 31, 1860 à 40).
  assert.equal(trigger.evaluate(1820), null);
  assert.equal(trigger.activeIndex, -1);
});

test("cardTrigger : se déclenche une seule fois à l'entrée d'une zone, pas à chaque frame dedans", () => {
  const trigger = createCardTrigger();
  const idx1860 = MOMENTS.findIndex((m) => m.year === 1860);

  assert.equal(trigger.evaluate(1852), idx1860); // entre (1860-8=1852)
  // On reste dans la zone (±8) et 1860 reste l'ancre la plus proche : aucune
  // nouvelle entrée, même en bougeant (1865 existe aussi mais reste plus
  // loin que 1860 tant qu'on ne dépasse pas 1862,5).
  assert.equal(trigger.evaluate(1855), null);
  assert.equal(trigger.evaluate(1860), null);
  assert.equal(trigger.evaluate(1862), null); // encore plus proche de 1860 (2) que de 1865 (3)
});

test("cardTrigger : se réarme après avoir quitté la zone, et se redéclenche à la ré-entrée", () => {
  const trigger = createCardTrigger();
  const idx1860 = MOMENTS.findIndex((m) => m.year === 1860);

  assert.equal(trigger.evaluate(1855), idx1860); // 1re entrée
  assert.equal(trigger.evaluate(1840), null); // sort de la zone (20 > 8)
  assert.equal(trigger.activeIndex, -1, "hors de toute zone après en être sorti");
  assert.equal(trigger.evaluate(1858), idx1860); // 2e entrée (ré-armée)
});

test("cardTrigger : scrub 1860±20 deux fois de suite → exactement 2 entrées (brief, vérification Playwright)", () => {
  const trigger = createCardTrigger();
  let entries = 0;
  const years = [1840, 1860, 1840, 1860]; // dehors, dedans, dehors, dedans
  for (const y of years) {
    if (trigger.evaluate(y) !== null) entries++;
  }
  assert.equal(entries, 2);
});

test("cardTrigger : le seuil par défaut est bien ±8 ans (frontière incluse/exclue)", () => {
  // 200 (isolé : voisines à 885 et -250, bien plus loin que 8 ans) évite
  // toute ambiguïté avec une ancre plus proche.
  const trigger = createCardTrigger();
  const idx200 = MOMENTS.findIndex((m) => m.year === 200);
  assert.equal(CARD_THRESHOLD_YEARS, 8);
  assert.equal(trigger.evaluate(208), idx200); // exactement à 8 : inclus
  trigger.reset();
  assert.equal(trigger.evaluate(209), null); // à 9 : exclu
});

test("cardTrigger : choisit l'ancre la plus proche quand deux zones se chevauchent", () => {
  // 1860 et 1865 sont à 5 ans l'un de l'autre : leurs zones ±8 se chevauchent
  // entièrement. À 1862, 1860 est plus proche (2) que 1865 (3).
  const trigger = createCardTrigger();
  const idx1860 = MOMENTS.findIndex((m) => m.year === 1860);
  assert.equal(trigger.evaluate(1862), idx1860);
});

// ============================================================================
// interpolatePopulation — interpolation log-échelle
// ============================================================================

test("population : exacte à chaque ancre", () => {
  for (const m of MOMENTS) {
    assert.equal(interpolatePopulation(m.year), m.population, `année ${m.year}`);
  }
});

test("population : à 1370 (ancre) ≈ 250 000 (vérification Playwright du brief)", () => {
  assert.equal(interpolatePopulation(1370), 250000);
  // Construit l'attendu via toLocaleString (espace fine insécable, U+202F,
  // pas un espace ordinaire) plutôt qu'un littéral — évite un faux échec dû
  // au caractère d'espacement, pas au contenu.
  assert.equal(formatPopulation(interpolatePopulation(1370)), `≈ ${(250000).toLocaleString("fr-FR")} habitants`);
});

test("population : monotone croissante entre 1860 et 1889 (à travers l'ancre intermédiaire 1865)", () => {
  let prev = -Infinity;
  for (let y = 1860; y <= 1889; y += 1) {
    const p = interpolatePopulation(y);
    assert.ok(p >= prev, `population doit croître : à ${y}, ${p} < précédent ${prev}`);
    prev = p;
  }
});

test("population : le milieu log-échelle entre deux ancres est bien inférieur à la moyenne arithmétique", () => {
  // Entre 1200 (50 000) et 1370 (250 000) : moyenne arithmétique = 150 000,
  // moyenne géométrique (ce que fait l'interpolation log) ≈ 111 803.
  const mid = (1200 + 1370) / 2;
  const p = interpolatePopulation(mid);
  assert.ok(p > 90000 && p < 130000, `milieu log-échelle attendu ~111 803, obtenu ${p}`);
  assert.ok(p < 150000, "doit être strictement inférieur à la moyenne arithmétique");
});

test("population : constante avant -250 et après 2026 (comme momentBlend)", () => {
  assert.equal(interpolatePopulation(-1000), MOMENTS[0].population);
  assert.equal(interpolatePopulation(3000), MOMENTS[MOMENTS.length - 1].population);
});

test("population : visible dès -250 avec ≈ 1 000 habitants (brief)", () => {
  assert.equal(formatPopulation(interpolatePopulation(-250)), `≈ ${(1000).toLocaleString("fr-FR")} habitants`);
});

// ============================================================================
// roundPopulation / formatPopulation
// ============================================================================

test("roundPopulation : précision croissante avec l'ordre de grandeur", () => {
  assert.equal(roundPopulation(987), 990); // < 1 000 : dizaine
  assert.equal(roundPopulation(12345), 12000); // < 100 000 : millier
  assert.equal(roundPopulation(123456), 120000); // >= 100 000 : dizaine de mille
  assert.equal(roundPopulation(1700000), 1700000);
});

test("formatPopulation : format français (séparateur de milliers) avec préfixe ≈ et suffixe habitants", () => {
  const text = formatPopulation(1700000);
  assert.equal(text, `≈ ${(1700000).toLocaleString("fr-FR")} habitants`);
  assert.match(text, /^≈ 1.700.000 habitants$/u); // le `.` couvre l'espace fine insécable (U+202F)
  assert.ok(text.includes("habitants"));
});

test("orderOfMagnitude : détecte le changement d'ordre de grandeur (pour le tick visuel)", () => {
  assert.equal(orderOfMagnitude(999), 2);
  assert.equal(orderOfMagnitude(1000), 3);
  assert.notEqual(orderOfMagnitude(999), orderOfMagnitude(1000));
});

// ============================================================================
// resolveMonumentHit — résolution d'un hit de raycast (mock, sans three.js)
// ============================================================================

test("resolveMonumentHit : retrouve l'entrée du registre via userData.monumentId porté par un ancêtre", () => {
  // Simule une intersection three.js : le mesh touché est un enfant profond,
  // l'ancêtre (le groupe de premier niveau) porte monumentId/stateId — voir
  // layers/monuments.js `init()`.
  const group = { userData: { monumentId: "notreDame", stateId: "cathedrale" }, parent: null };
  const child = { userData: {}, parent: group };
  const mesh = { userData: {}, parent: child };

  const entry = resolveMonumentHit({ object: mesh }, 2026);
  assert.ok(entry, "une entrée doit être trouvée");
  assert.equal(entry.monument, "notreDame");
  assert.equal(entry.state, "cathedrale");
  assert.ok(typeof entry.label === "string" && entry.label.length > 2);
  assert.ok(typeof entry.phrase === "string" && entry.phrase.length > 10);
});

test("resolveMonumentHit : fonctionne aussi quand l'objet touché porte directement monumentId", () => {
  const mesh = { userData: { monumentId: "tourEiffel", stateId: "tour" }, parent: null };
  const entry = resolveMonumentHit({ object: mesh }, 2026);
  assert.equal(entry.monument, "tourEiffel");
});

test("resolveMonumentHit : renvoie null quand rien dans la chaîne d'ancêtres n'a de monumentId", () => {
  const mesh = { userData: {}, parent: { userData: {}, parent: null } };
  assert.equal(resolveMonumentHit({ object: mesh }, 2026), null);
});

test("resolveMonumentHit : renvoie null si le monument identifié n'est pas présent à cette année", () => {
  // La tour Eiffel n'existe pas en l'an 100.
  const mesh = { userData: { monumentId: "tourEiffel", stateId: "tour" }, parent: null };
  assert.equal(resolveMonumentHit({ object: mesh }, 100), null);
});

test("resolveMonumentHit : cohérent avec monumentStatesAt — un hit sur un site présent renvoie exactement cette entrée", () => {
  const year = 1400;
  const present = monumentStatesAt(year);
  assert.ok(present.length > 0, "au moins un monument doit être présent en 1400");
  for (const expected of present) {
    const mesh = { userData: { monumentId: expected.monument, stateId: expected.state }, parent: null };
    const found = resolveMonumentHit({ object: mesh }, year);
    assert.deepEqual(found, expected);
  }
});
