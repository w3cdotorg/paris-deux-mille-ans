/**
 * Monuments layer — les ancres persistantes de la ville.
 *
 * C'est la couche qui porte la promesse du projet : **la continuité fait la
 * magie**. Un monument n'est pas un objet qui apparaît puis disparaît, c'est un
 * *lieu* qui traverse les siècles en changeant de forme. Sur l'île de la Cité,
 * le même point (0, 0) porte successivement un temple gallo-romain, une
 * basilique mérovingienne, puis un chantier gothique de 180 ans qui devient
 * Notre-Dame — et la cathédrale, elle, ne meurt plus jamais.
 *
 * ============================================================================
 * Registre (`MONUMENTS`, exporté) : un objet par *site*, avec
 *
 *   { id, label, phrase, x, z, rotY?, baseY?, states: [...] }
 *
 * `label`/`phrase` (français, une phrase, lisible par un enfant de 4-5 ans)
 * sont stockés ici pour les interactions au clic de la tâche 15.
 *
 * Chaque état vaut `{ id, slot, model, born, buildYears, died, razeYears }` :
 *  - `model` est une clé de `monumentModels.MODEL_BUILDERS` ;
 *  - `slot` regroupe les états qui **occupent la même place** : dans un slot,
 *    les états se succèdent (l'ordre chronologique est garanti par les tests),
 *    et deux slots peuvent coexister — c'est ce qui permet à la cathédrale
 *    (slot `main`, jamais morte après 1163) de porter une flèche (slot
 *    `fleche`) qui, elle, naît en 1859, disparaît en 2019 et revient en 2024,
 *    ou au palais du Louvre de cohabiter avec sa pyramide.
 *  - Le recouvrement `died` d'un état = `born` du suivant est voulu : la
 *    présence de l'ancien (1→0) et celle du nouveau (0→1) se somment, donc
 *    l'ancien **rétrécit pendant que le nouveau pousse** (crossgrow, comme
 *    buildings.js). Là où l'histoire impose un trou (les arènes ensevelies de
 *    380 à 1896), le trou est explicite et le site reste vide entre les deux.
 *
 * ============================================================================
 * Rendu : chaque état est un `THREE.Group` construit une fois par
 * `monumentModels.js`, posé au sol (`groundHeightAt`) et masqué/révélé selon
 * `lifecycle`. Deux subtilités :
 *  - **Étagement** : les pièces portant `userData.stage = [a, b]` n'apparaissent
 *    que dans cette fenêtre de présence — la nef de Notre-Dame d'abord, ses
 *    **tours en dernier** (0,72 → 1, soit ~1293-1343).
 *  - **Ensevelissement** : un état marqué `bury: true` s'enfonce dans le sol
 *    pendant sa démolition au lieu de rétrécir sur place (arènes, 380-460).
 *
 * `update` n'anime que les sous-groupes marqués `spin` (2 grues + 4 roues = 6
 * matrices par frame au maximum, et seulement quand elles sont visibles), et ne
 * reconstruit les matrices d'année que quand `state.year` change.
 */

import { LANDMARKS, MONUMENT_FOOTPRINTS } from "../geography.js";
import { lifecycle, easeOutBack } from "../timeEngine.js";
import { groundHeightAt } from "./terrain.js";
import { MODEL_BUILDERS } from "../monumentModels.js";

// ============================================================================
// Le registre
// ============================================================================

const L = LANDMARKS;

export const MONUMENTS = [
  {
    id: "notreDame",
    label: "Notre-Dame de Paris",
    phrase:
      "Au même endroit, il y a eu un temple romain, puis une église, puis cette immense cathédrale : elle a mis presque 200 ans à être construite, avec des grues en bois !",
    x: L.notreDame.x,
    z: L.notreDame.z,
    states: [
      {
        id: "templeRomain",
        slot: "main",
        model: "templeRomain",
        born: 150,
        buildYears: 20,
        died: 540,
        razeYears: 30,
        label: "Le temple gallo-romain",
        phrase: "Les Romains priaient ici leurs dieux, dans un temple avec de grandes colonnes.",
      },
      {
        id: "basilique",
        slot: "main",
        model: "basilique",
        born: 540,
        buildYears: 30,
        died: 1163,
        razeYears: 12,
        label: "La basilique Saint-Étienne",
        phrase: "La première grande église de Paris, toute en rondeurs, avec un clocher trapu.",
      },
      {
        id: "cathedrale",
        slot: "main",
        model: "cathedraleGothique",
        born: 1163,
        buildYears: 180,
        // Pas de `died` : depuis 1163, Notre-Dame est toujours là.
        label: "La cathédrale gothique",
        phrase:
          "Regarde les grues en bois qui tournent : les bâtisseurs montent la nef d'abord, et les deux tours tout à la fin.",
      },
      {
        id: "fleche",
        slot: "fleche",
        model: "fleche",
        born: 1859,
        buildYears: 5,
        died: 2019,
        razeYears: 0.2, // l'incendie
        label: "La flèche de Viollet-le-Duc",
        phrase: "Une flèche toute fine ajoutée au milieu du toit, avec un coq doré tout en haut.",
      },
      {
        id: "echafaudage",
        slot: "fleche",
        model: "echafaudage",
        born: 2019,
        buildYears: 1,
        died: 2024,
        razeYears: 0.5,
        label: "Le chantier de la restauration",
        phrase: "Après le grand feu de 2019, des échafaudages ont protégé la cathédrale pendant cinq ans.",
      },
      {
        id: "flecheNeuve",
        slot: "fleche",
        model: "flecheNeuve",
        born: 2024,
        buildYears: 1,
        label: "La flèche retrouvée",
        phrase: "La flèche a été refaite exactement comme avant : son plomb neuf brille encore.",
      },
    ],
  },
  {
    id: "louvre",
    label: "Le Louvre",
    phrase:
      "D'abord un château fort avec un gros donjon rond, puis un palais de rois, et aujourd'hui un musée avec une pyramide de verre.",
    x: L.louvre.x,
    z: L.louvre.z,
    states: [
      {
        id: "forteresse",
        slot: "main",
        model: "louvreForteresse",
        born: 1190,
        buildYears: 20,
        died: 1546,
        razeYears: 20,
        label: "La forteresse du Louvre",
        phrase: "Un château fort avec des tours rondes et une grosse tour au milieu, pour défendre Paris.",
      },
      {
        id: "palais",
        slot: "main",
        model: "louvrePalais",
        born: 1546,
        buildYears: 120,
        label: "Le palais du Louvre",
        phrase: "Les rois ont remplacé le château fort par un palais autour d'une grande cour carrée.",
      },
      {
        id: "pyramide",
        slot: "pyramide",
        model: "pyramide",
        born: 1988,
        buildYears: 2,
        label: "La pyramide de verre",
        phrase: "Une pyramide toute en verre : c'est par là qu'on entre dans le musée.",
      },
    ],
  },
  {
    id: "arenes",
    label: "Les arènes de Lutèce",
    phrase:
      "Ici, les Romains venaient voir des spectacles. Les arènes ont été enterrées pendant plus de mille ans, puis on les a retrouvées !",
    x: L.arenes.x,
    z: L.arenes.z,
    states: [
      {
        id: "arenes",
        slot: "main",
        model: "arenes",
        born: 80,
        buildYears: 20,
        died: 300,
        razeYears: 80,
        bury: true, // s'enfoncent lentement sous la terre
        label: "Les arènes romaines",
        phrase: "Des gradins en pierre tout autour d'une piste de sable, pour 15 000 spectateurs.",
      },
      {
        id: "square",
        slot: "main",
        model: "arenesSquare",
        born: 1896,
        buildYears: 3,
        label: "Le square des arènes",
        phrase: "Les archéologues ont dégagé les vieux gradins et en ont fait un square où on joue.",
      },
    ],
  },
  {
    id: "thermes",
    label: "Les thermes de Cluny",
    phrase: "C'étaient les bains chauds des Romains. Un morceau de leur grande voûte est encore debout aujourd'hui !",
    x: L.thermes.x,
    z: L.thermes.z,
    states: [
      {
        id: "thermes",
        slot: "main",
        model: "thermes",
        born: 200,
        buildYears: 15,
        died: 300,
        razeYears: 0, // remplacés d'un bloc par la ruine, qui reste
        label: "Les bains romains",
        phrase: "On venait s'y baigner dans de l'eau chaude, sous d'énormes voûtes en pierre.",
      },
      {
        id: "ruine",
        slot: "main",
        model: "thermesRuine",
        born: 300,
        buildYears: 40,
        // jamais de `died` : le frigidarium est toujours là, rue Saint-Jacques.
        label: "La ruine des thermes",
        phrase: "Ce gros mur cassé est vieux de 1800 ans : c'est le plus vieux mur debout de Paris.",
      },
    ],
  },
  {
    id: "forum",
    label: "Le forum romain",
    phrase: "La grande place de Lutèce : on y discutait, on y vendait, tout autour de longues colonnes.",
    x: L.forum.x,
    z: L.forum.z,
    states: [
      {
        id: "forum",
        slot: "main",
        model: "forum",
        born: 100,
        buildYears: 15,
        died: 500,
        razeYears: 100,
        label: "Le forum de Lutèce",
        phrase: "La place principale de la ville romaine, entourée de galeries à colonnes.",
      },
    ],
  },
  {
    id: "pontAuChange",
    label: "Le pont au Change",
    phrase:
      "Un pont couvert de petites maisons, avec de grandes roues qui tournent dans le courant pour moudre le blé.",
    x: L.pontAuChange.x,
    z: L.pontAuChange.z,
    // Le pont franchit la Seine en biais : l'axe local +x suit la normale
    // « vers le nord » du fleuve, (0,351 ; -0,937) — voir LANDMARKS.pontAuChange.
    rotY: Math.atan2(0.937, 0.351),
    baseY: 0, // niveau de l'eau, pas le lit du fleuve
    states: [
      {
        id: "pont",
        slot: "main",
        model: "pont",
        born: 1100,
        buildYears: 10,
        // Le pont de pierre, lui, n'a jamais disparu.
        label: "Le pont de pierre",
        phrase: "Un pont solide sur trois piles, pour passer de l'île à la rive droite.",
      },
      {
        id: "moulins",
        slot: "maisons",
        model: "pontMoulins",
        born: 1100,
        buildYears: 10,
        died: 1786,
        razeYears: 5,
        label: "Les maisons et les moulins",
        phrase: "Des changeurs de monnaie habitaient sur le pont, et quatre roues à eau tournaient dessous.",
      },
    ],
  },
  {
    id: "sainteChapelle",
    label: "La Sainte-Chapelle",
    phrase: "Une chapelle presque entièrement en vitraux, avec une flèche dorée qui monte très haut.",
    x: L.sainteChapelle.x,
    z: L.sainteChapelle.z,
    states: [
      {
        id: "sainteChapelle",
        slot: "main",
        model: "sainteChapelle",
        born: 1242,
        buildYears: 6,
        label: "La Sainte-Chapelle",
        phrase: "Construite en seulement six ans pour abriter une relique, elle est faite de verre et de lumière.",
      },
    ],
  },
  {
    id: "pantheon",
    label: "Le Panthéon",
    phrase: "Un très grand dôme sur la colline : c'est là qu'on honore les gens qui ont fait de belles choses.",
    x: L.pantheon.x,
    z: L.pantheon.z,
    states: [
      {
        id: "pantheon",
        slot: "main",
        model: "pantheon",
        born: 1758,
        buildYears: 32,
        label: "Le Panthéon",
        phrase: "Un temple à colonnes surmonté d'un dôme, tout en haut de la montagne Sainte-Geneviève.",
      },
    ],
  },
  {
    id: "invalides",
    label: "Le dôme des Invalides",
    phrase: "Son dôme est couvert de vraie feuille d'or : quand le soleil tape, il brille comme un bijou.",
    x: L.invalides.x,
    z: L.invalides.z,
    states: [
      {
        id: "invalides",
        slot: "main",
        model: "invalides",
        born: 1671,
        buildYears: 35,
        label: "Les Invalides",
        phrase: "Un hôpital construit par le roi pour ses soldats blessés, avec une église au dôme doré.",
      },
    ],
  },
];

// ============================================================================
// Partie pure — testable sous `node --test`, aussi utilisée par la tâche 15
// ============================================================================

/**
 * Tous les états de monuments *présents* (présence > 0) à une année donnée.
 * Pure : ne lit que `MONUMENTS` et `lifecycle`, aucune dépendance à la scène.
 * C'est aussi le registre cliquable de la tâche 15 (chaque entrée porte son
 * `label`/`phrase`, celui de l'état s'il en a un, sinon celui du site).
 *
 * @param {number} year
 * @returns {Array<{monument:string, state:string, slot:string, model:string,
 *   x:number, z:number, phase:string, presence:number, label:string, phrase:string}>}
 */
export function monumentStatesAt(year) {
  const out = [];
  for (const m of MONUMENTS) {
    for (const st of m.states) {
      const { phase, presence } = lifecycle(year, st);
      if (presence <= 0) continue;
      out.push({
        monument: m.id,
        state: st.id,
        slot: st.slot,
        model: st.model,
        x: m.x,
        z: m.z,
        phase,
        presence,
        label: st.label ?? m.label,
        phrase: st.phrase ?? m.phrase,
      });
    }
  }
  return out;
}

/**
 * Présence/phase d'un état précis (`monumentId`, `stateId`) — raccourci de
 * lecture pour les tests et le debug.
 * @param {number} year
 * @param {string} monumentId
 * @param {string} stateId
 * @returns {{phase:string, presence:number}|null}
 */
export function monumentStateAt(year, monumentId, stateId) {
  const m = MONUMENTS.find((x) => x.id === monumentId);
  if (!m) return null;
  const st = m.states.find((s) => s.id === stateId);
  if (!st) return null;
  return lifecycle(year, st);
}

// ============================================================================
// Rendu
// ============================================================================

const SPIN_AXES = { x: "x", y: "y", z: "z" };

/** Groupes construits, un par état du registre. */
let entries = [];
/** Sous-groupes animés visibles (grues, roues) — liste stable, sans allocation. */
let spinners = [];
let lastAppliedYear = null;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Progression locale d'une pièce dans la présence globale du chantier.
 *
 * Une pièce **étagée** (`stage: [a, b]`) suit sa propre fenêtre : absente avant
 * `a`, montée à `b`. Une pièce **sans étage** (la grande majorité — 15 des 19
 * états de monuments n'ont aucune pièce étagée) suit directement la présence
 * globale : à `presence = 0.2` elle est montée à 20 %, à `0.8` à 80 %. C'était
 * le bug corrigé ici — l'ancien code renvoyait 1 dès que `presence > 0`, donc
 * ces monuments *apparaissaient* d'un coup à taille finale au lieu de sortir de
 * terre sur leurs `buildYears`, alors que la démolition (côté `razing`, plus
 * bas) rétrécit déjà bien ces mêmes pièces avec `presence`. C'est le miroir
 * exact côté naissance.
 */
function stageProgress(stage, presence) {
  if (!stage) return clamp01(presence);
  const [a, b] = stage;
  if (presence <= a) return 0;
  if (b <= a) return 1;
  return clamp01((presence - a) / (b - a));
}

/**
 * Applique une présence/phase à un groupe de monument : visibilité, pousse des
 * pièces (par étage si `stage`), enfouissement des ruines.
 * @param {object} entry
 * @param {number} presence
 * @param {string} phase
 */
function applyEntry(entry, presence, phase) {
  const group = entry.group;
  if (presence <= 0) {
    if (group.visible) group.visible = false;
    return;
  }
  group.visible = true;

  const razing = phase === "razing";
  // Ensevelissement (arènes, 300-380) : le monument garde sa taille et
  // **s'enfonce** dans le sol au lieu de rétrécir — c'est ce qui raconte
  // « la terre les a recouvertes » plutôt que « on les a démolies ». Cumuler
  // les deux (rétrécir *et* couler) les faisait disparaître d'un coup dès le
  // tiers de la fenêtre (constat de la capture task10-arenes-350).
  const burying = razing && entry.state.bury === true;
  // Sinon, pendant la démolition, tout le monument redescend ensemble (aucun
  // étage : une cathédrale ne se dé-construit pas tour d'abord). Pendant le
  // chantier, chaque pièce suit sa fenêtre `stage`.
  const globalGrow = razing && !burying ? presence : 1;
  const sink = burying ? (1 - presence) * entry.buriedDepth : 0;
  group.position.y = entry.baseY - sink;

  for (const child of group.children) {
    const ud = child.userData;
    if (ud.spin) {
      // Grues/roues : visibles seulement dans leur fenêtre de chantier.
      const on = !ud.stage || (presence >= ud.stage[0] && presence <= ud.stage[1]);
      child.visible = on && !razing;
      continue;
    }
    // Pièce de chantier (échafaudage) : elle n'existe que dans sa fenêtre.
    if (ud.temporary && ud.stage && (presence < ud.stage[0] || presence > ud.stage[1])) {
      child.visible = false;
      continue;
    }
    // En démolition, une pièce ne peut redescendre que si elle avait eu le
    // temps d'apparaître avant la mort du monument (cas d'un chantier
    // interrompu) : on gèle son étage à la présence atteinte au décès.
    const t = razing ? stageProgress(ud.stage, entry.deathPresence) : stageProgress(ud.stage, presence);
    if (t <= 0) {
      child.visible = false;
      continue;
    }
    child.visible = true;
    if (!ud.grow) continue;
    const grow = burying ? 1 : razing ? t : easeOutBack(t, 0.45);
    const scaled = ud.h * grow * globalGrow;
    child.scale.set(ud.sx, scaled, ud.sz);
    child.position.y = ud.anchor === "base" ? ud.y0 : ud.y0 + scaled / 2;
  }
}

/** Réévalue tous les monuments pour `year`. */
function rescanAll(year) {
  for (const entry of entries) {
    const { phase, presence } = lifecycle(year, entry.state);
    applyEntry(entry, presence, phase);
  }
  // Recalcule la liste des animés effectivement visibles (une fois par
  // changement d'année, jamais par frame).
  spinners.length = 0;
  for (const entry of entries) {
    if (!entry.group.visible) continue;
    for (const child of entry.group.children) {
      if (child.userData.spin && child.visible) spinners.push(child);
    }
  }
}

/**
 * Altitude de pose d'un site : la **moyenne** du sol échantillonné au centre et
 * aux quatre coins de son emprise, et non la seule valeur au centre. Un modèle
 * est un bloc rigide, et les grands (arènes, Panthéon, Louvre) couvrent 10 à 30
 * unités de terrain en pente — sur la montagne Sainte-Geneviève, la dénivelée
 * atteint ~1 unité (10 m) d'un bord à l'autre de l'emprise des arènes. Moyenner
 * répartit l'erreur (un peu enterré en amont, un peu décollé en aval) au lieu de
 * la concentrer d'un côté : le minimum des échantillons, essayé d'abord,
 * engloutissait la moitié amont des gradins (capture task10-arenes-200).
 * Purement déterministe (groundHeightAt l'est), calculé une fois à l'init.
 * @param {{x:number, z:number, id:string}} m
 * @returns {number}
 */
function siteBaseY(m) {
  const footprint = MONUMENT_FOOTPRINTS.find((f) => f.id === m.id);
  const r = (footprint ? footprint.r : 4) * 0.7;
  let sum = groundHeightAt(m.x, m.z);
  for (const [dx, dz] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]) {
    sum += groundHeightAt(m.x + dx * r, m.z + dz * r);
  }
  return sum / 5;
}

export function init(ctx) {
  entries = [];
  spinners = [];
  for (const m of MONUMENTS) {
    for (const st of m.states) {
      const build = MODEL_BUILDERS[st.model];
      if (!build) throw new Error(`monuments: modèle inconnu « ${st.model} » (site ${m.id})`);
      const group = build();
      const baseY = m.baseY ?? siteBaseY(m);
      group.position.set(m.x, baseY, m.z);
      if (m.rotY) group.rotation.y = m.rotY;
      group.visible = false;
      ctx.scene.add(group);

      // Profondeur d'enfouissement = hauteur de la pièce la plus haute, pour
      // qu'un monument « enseveli » finisse réellement sous le sol.
      let top = 0;
      for (const child of group.children) {
        const ud = child.userData;
        if (ud && typeof ud.y0 === "number") top = Math.max(top, ud.y0 + ud.h);
      }
      // Présence atteinte au moment de la mort (1 pour tous les monuments
      // actuels, qui meurent tous après achèvement — mais le calcul reste
      // juste si un état est un jour tué en cours de chantier).
      const buildYears = st.buildYears ?? 10;
      const deathPresence =
        st.died === undefined ? 1 : clamp01((st.died - st.born) / (buildYears || 1));

      entries.push({
        monument: m,
        state: st,
        group,
        baseY,
        buriedDepth: Math.max(top, 1),
        deathPresence,
      });
    }
  }
  lastAppliedYear = null;
  rescanAll(2026);
  lastAppliedYear = 2026;
}

export function update(dt, state) {
  if (state.year !== lastAppliedYear) {
    rescanAll(state.year);
    lastAppliedYear = state.year;
  }
  // Grues qui tournent et roues à aubes : 6 rotations au maximum, uniquement
  // sur les sous-groupes visibles (voir `rescanAll`). Figées sous reducedMotion,
  // dans une position stable (leur phase, pas leur angle courant).
  for (const s of spinners) {
    const { axis, speed, phase } = s.userData.spin;
    const angle = state.reducedMotion ? phase : phase + state.time * speed;
    s.rotation[SPIN_AXES[axis] ?? "y"] = angle;
  }
}

/** Même contrat que walls.forceRescan / terrain.forceRescan (window.__paris.setYear). */
export function forceRescan(year) {
  rescanAll(year);
  lastAppliedYear = year;
}

/**
 * Diagnostic : ce qui est visible, avec quelle présence, et combien de pièces
 * de chaque groupe sont rendues — utilisé par la vérification automatisée.
 * @param {number} year
 */
export function debugCounts(year) {
  const out = { states: {}, visibleMeshes: 0, spinners: spinners.length };
  for (const entry of entries) {
    const { phase, presence } = lifecycle(year, entry.state);
    let visibleParts = 0;
    if (entry.group.visible) {
      for (const child of entry.group.children) {
        if (child.visible) visibleParts += child.isGroup ? child.children.length : 1;
      }
    }
    out.visibleMeshes += visibleParts;
    out.states[`${entry.monument.id}.${entry.state.id}`] = {
      phase,
      presence: Math.round(presence * 1000) / 1000,
      visible: entry.group.visible,
      visibleParts,
    };
  }
  return out;
}

/** Nombre total de maillages construits (diagnostic de coût). */
export function stats() {
  let meshes = 0;
  for (const entry of entries) {
    for (const child of entry.group.children) {
      meshes += child.isGroup ? child.children.length : 1;
    }
  }
  return { sites: MONUMENTS.length, states: entries.length, meshes };
}
