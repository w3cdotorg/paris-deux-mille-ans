/**
 * archetypes.js — 22 archétypes de bâtiments low-poly, construits en code.
 *
 * Six familles historiques (gaulois, romain, medieval, classique, haussmann,
 * moderne). Chaque archétype est une BufferGeometry non indexée, à faces
 * planes (flat shading) et couleurs par sommet : les murs, les toits, les
 * balcons et les cheminées portent leur propre teinte dans l'attribut
 * `color`. Une variation par instance s'ajoute par-dessus via
 * `InstancedMesh.setColorAt` — three.js multiplie la couleur d'instance par
 * la couleur de sommet (chunk `color_vertex`), donc les teintes d'instance
 * sont des *multiplicateurs* subtils autour de 1.0 (voir FAMILY_TINTS).
 *
 * Conventions partagées : 1 unité = 10 m. Origine de chaque géométrie au
 * centre du sol (y = 0 = pied du bâtiment), façade principale tournée vers
 * +z, largeur sur x, profondeur sur z.
 *
 * Choix « merge » (demandé explicitement par le brief) : on n'utilise PAS
 * `BufferGeometryUtils.mergeGeometries` et on ne vendorise pas l'addon. Les
 * primitives sont émises directement dans un unique triangle-soup par
 * archétype (`newBuilder()` + `box/prism/gable/...`), donc la fusion est
 * gratuite et déjà faite au moment de la construction — importer un addon
 * pour recoller ensuite des BoxGeometry/ConeGeometry séparées aurait coûté
 * un fichier vendorisé, une entrée d'import map et un aller-retour
 * d'attributs, pour exactement le même résultat. Les normales sont
 * calculées par face (produit vectoriel du triangle), ce qui donne
 * précisément le rendu facetté low-poly voulu, là où mergeGeometries +
 * computeVertexNormals aurait lissé les arêtes.
 */

import * as THREE from "three";

// ============================================================================
// Palette (sRGB) — convertie une fois vers l'espace de travail linéaire par
// THREE.Color, comme le fait terrain.js pour ses couleurs de sol.
// ============================================================================

function c(hex) {
  const col = new THREE.Color(hex);
  return [col.r, col.g, col.b];
}

const PAL = {
  // gaulois
  thatch: c(0xb49b62),
  thatchDark: c(0x97814f),
  wattle: c(0xa8916b),
  wood: c(0x6d5236),
  // romain
  stucco: c(0xe6dfcd),
  romanTile: c(0xb0603c),
  romanBrick: c(0xa96a4c),
  marble: c(0xeae4d6),
  // medieval
  plaster: c(0xd9ccb1),
  plasterPink: c(0xd6bfa8),
  timber: c(0x6b4a2f),
  tile: c(0x8f5a43),
  slate: c(0x545b66),
  // classique
  stone: c(0xdbd1ba),
  stoneWarm: c(0xe3d8c0),
  brickVosges: c(0xa5563e),
  slateBlue: c(0x4e5766),
  // haussmann
  hStone: c(0xe4d9c1),
  hStoneCool: c(0xdcd3bd),
  zinc: c(0x8d9298),
  zincDark: c(0x787e85),
  iron: c(0x3b4048),
  // Balcon filant — gris moyen plutôt que le fer quasi noir d'origine : à
  // ×2-3 bandeaux pleine largeur par archétype, l'iron 0x3b4048 peinturait
  // des zébrures sombres sur toute la façade (review Important 4). Un gris
  // moyen reste lisible comme ferronnerie sans écraser la pierre claire.
  balconyIron: c(0x6b6f75),
  chimney: c(0x9c6a53),
  // moderne
  concrete: c(0xb7b4ab),
  concreteDark: c(0x8f8d86),
  panel: c(0x9ba0a0),
  glass: c(0x86adc0),
  glassDark: c(0x4f7387),
  glassGreen: c(0x7ba69f),
  flatRoof: c(0x8e8c85),
};

// ============================================================================
// Triangle-soup builder — toutes les primitives ci-dessous écrivent dans le
// même trio de tableaux, donc un archétype = une géométrie, sans merge.
// ============================================================================

function newBuilder() {
  return { pos: [], nor: [], col: [] };
}

/** Triangle avec normale de face (flat shading) et couleur uniforme. */
function tri(b, p, q, r, col) {
  const ux = q[0] - p[0];
  const uy = q[1] - p[1];
  const uz = q[2] - p[2];
  const vx = r[0] - p[0];
  const vy = r[1] - p[1];
  const vz = r[2] - p[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  b.pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  b.nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  b.col.push(col[0], col[1], col[2], col[0], col[1], col[2], col[0], col[1], col[2]);
}

function quad(b, p, q, r, s, col) {
  tri(b, p, q, r, col);
  tri(b, p, r, s, col);
}

/**
 * Polygone en (x, z), ordonné *sens anti-horaire dans le plan (x, z)* — avec
 * cette convention, `prism` sort des normales latérales vers l'extérieur et
 * une normale de toit vers +y. Un rectangle s'écrit donc rectPoly() ci-dessous.
 */
function rectPoly(x0, x1, z0, z1) {
  return [
    [x1, z0],
    [x0, z0],
    [x0, z1],
    [x1, z1],
  ];
}

/**
 * Prisme droit : côtés + couvercle. Le fond n'est jamais émis (les bâtiments
 * posent sur le sol, et même les bandeaux « flottants » — balcons, corniches —
 * ne sont jamais vus par en dessous aux distances de jeu) : ~40 % de
 * triangles économisés sur les archétypes riches en bandeaux.
 */
function prism(b, poly, y0, y1, colSide, colTop) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const d = poly[(i + 1) % n];
    quad(
      b,
      [a[0], y0, a[1]],
      [d[0], y0, d[1]],
      [d[0], y1, d[1]],
      [a[0], y1, a[1]],
      colSide
    );
  }
  if (colTop) {
    const p0 = [poly[0][0], y1, poly[0][1]];
    for (let i = 1; i < n - 1; i++) {
      tri(b, p0, [poly[i][0], y1, poly[i][1]], [poly[i + 1][0], y1, poly[i + 1][1]], colTop);
    }
  }
}

function box(b, x0, x1, y0, y1, z0, z1, colSide, colTop = colSide) {
  prism(b, rectPoly(x0, x1, z0, z1), y0, y1, colSide, colTop);
}

/** Toit à deux pentes. Faîtage sur x (défaut) ou sur z (pignon sur rue). */
function gable(b, x0, x1, y0, yRidge, z0, z1, col, ridgeAlongX = true) {
  const A = [x0, y0, z0];
  const B = [x1, y0, z0];
  const C = [x1, y0, z1];
  const D = [x0, y0, z1];
  if (ridgeAlongX) {
    const zc = (z0 + z1) / 2;
    const R0 = [x0, yRidge, zc];
    const R1 = [x1, yRidge, zc];
    quad(b, B, A, R0, R1, col);
    quad(b, D, C, R1, R0, col);
    tri(b, A, D, R0, col);
    tri(b, C, B, R1, col);
  } else {
    const xc = (x0 + x1) / 2;
    const R0 = [xc, yRidge, z0];
    const R1 = [xc, yRidge, z1];
    quad(b, A, D, R1, R0, col);
    quad(b, C, B, R0, R1, col);
    tri(b, B, A, R0, col);
    tri(b, D, C, R1, col);
  }
}

/** Toit à quatre pentes (croupes) : faîtage sur x, raccourci de `inset`. */
function hip(b, x0, x1, y0, yRidge, z0, z1, inset, col) {
  const A = [x0, y0, z0];
  const B = [x1, y0, z0];
  const C = [x1, y0, z1];
  const D = [x0, y0, z1];
  const zc = (z0 + z1) / 2;
  const R0 = [x0 + inset, yRidge, zc];
  const R1 = [x1 - inset, yRidge, zc];
  quad(b, B, A, R0, R1, col);
  quad(b, D, C, R1, R0, col);
  tri(b, A, D, R0, col);
  tri(b, C, B, R1, col);
}

/** Tronc de pyramide (pente de comble mansardé, socle en retrait, etc.). */
function frustum(b, x0, x1, y0, y1, z0, z1, insetX, insetZ, colSide, colTop) {
  const base = rectPoly(x0, x1, z0, z1);
  const top = rectPoly(x0 + insetX, x1 - insetX, z0 + insetZ, z1 - insetZ);
  for (let i = 0; i < 4; i++) {
    const a = base[i];
    const d = base[(i + 1) % 4];
    const a2 = top[i];
    const d2 = top[(i + 1) % 4];
    quad(b, [a[0], y0, a[1]], [d[0], y0, d[1]], [d2[0], y1, d2[1]], [a2[0], y1, a2[1]], colSide);
  }
  if (colTop) {
    const t = top;
    tri(b, [t[0][0], y1, t[0][1]], [t[1][0], y1, t[1][1]], [t[2][0], y1, t[2][1]], colTop);
    tri(b, [t[0][0], y1, t[0][1]], [t[2][0], y1, t[2][1]], [t[3][0], y1, t[3][1]], colTop);
  }
}

/** Polygone régulier à `segs` côtés, rayon `r`, centré sur (cx, cz). */
function ringPoly(cx, cz, r, segs, phase = 0) {
  const poly = [];
  for (let i = 0; i < segs; i++) {
    const a = phase + (i / segs) * Math.PI * 2;
    poly.push([cx + Math.cos(a) * r, cz - Math.sin(a) * r]);
  }
  return poly;
}

/** Cône (toit de chaume conique). */
function cone(b, cx, cz, r, y0, y1, segs, col) {
  const poly = ringPoly(cx, cz, r, segs);
  const apex = [cx, y1, cz];
  for (let i = 0; i < segs; i++) {
    const a = poly[i];
    const d = poly[(i + 1) % segs];
    tri(b, [a[0], y0, a[1]], [d[0], y0, d[1]], apex, col);
  }
}

// ============================================================================
// Teintes par instance — 4 par famille, multiplicatives et volontairement
// discrètes (±6 %) : elles cassent l'uniformité d'un InstancedMesh sans
// transformer un quartier haussmannien en patchwork.
// ============================================================================

export const FAMILY_TINTS = {
  gaulois: [
    [1.0, 0.99, 0.96],
    [0.94, 0.95, 0.93],
    [1.05, 1.02, 0.97],
    [0.98, 0.97, 1.0],
  ],
  romain: [
    [1.0, 0.99, 0.97],
    [0.95, 0.94, 0.93],
    [1.05, 1.01, 0.96],
    [1.0, 0.96, 0.94],
  ],
  medieval: [
    [1.0, 0.98, 0.95],
    [0.93, 0.94, 0.95],
    [1.06, 1.02, 0.96],
    [0.97, 0.95, 0.98],
  ],
  classique: [
    [1.0, 0.99, 0.97],
    [0.95, 0.96, 0.96],
    [1.04, 1.03, 1.0],
    [0.98, 0.97, 0.95],
  ],
  haussmann: [
    [1.0, 0.99, 0.97],
    [0.96, 0.96, 0.95],
    [1.04, 1.03, 1.0],
    [0.99, 0.98, 1.01],
  ],
  moderne: [
    [1.0, 1.0, 1.0],
    [0.94, 0.95, 0.97],
    [1.04, 1.04, 1.03],
    [0.97, 1.0, 1.02],
  ],
};

export const FAMILY_ORDER = ["gaulois", "romain", "medieval", "classique", "haussmann", "moderne"];

// ============================================================================
// Les 22 archétypes
// ============================================================================
//
// Chaque entrée : id, family, w/d (emprise en unités), h (hauteur totale),
// build(b) (géométrie détaillée), et les champs `lod*` qui décrivent la
// version simplifiée (boîte + toit) utilisée au-delà de la distance de LOD.

/**
 * Bandeau de balcon filant : fine boîte débordant légèrement de la façade.
 * Gris moyen, fin et peu débordant (review Important 4 : l'ancien iron quasi
 * noir + débord 0.07 + épaisseur 0.09, répété ×2-3 par archétype, peignait
 * des zébrures sombres pleine largeur plutôt qu'une ferronnerie discrète).
 */
function balcony(b, x0, x1, y, z0, z1, overhang = 0.03, thickness = 0.05, col = PAL.balconyIron) {
  box(b, x0 - overhang, x1 + overhang, y, y + thickness, z0 - overhang, z1 + overhang, col);
}

/** Rangée de souches de cheminée le long du faîtage. */
function chimneys(b, x0, x1, y, count, z, size = 0.11, height = 0.28, col = PAL.chimney) {
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const cx = x0 + (x1 - x0) * t;
    box(b, cx - size, cx + size, y, y + height, z - size, z + size, col);
  }
}

/** Petite lucarne (chien-assis) sur un versant. */
function dormer(b, cx, y, z, w = 0.16, h = 0.2, col = PAL.stone, roofCol = PAL.slate) {
  box(b, cx - w, cx + w, y, y + h, z - w, z + w, col);
  gable(b, cx - w, cx + w, y + h, y + h + 0.1, z - w, z + w, roofCol);
}

const ARCHETYPES = [
  // --- gaulois (2) ---------------------------------------------------------
  {
    id: "gaulois_hutte_ronde",
    family: "gaulois",
    w: 1.7,
    d: 1.7,
    h: 0.95,
    lodRoof: "cone",
    lodEaves: 0.4,
    lodWall: PAL.wattle,
    lodRoofCol: PAL.thatch,
    build(b) {
      prism(b, ringPoly(0, 0, 0.8, 8), 0, 0.38, PAL.wattle, null);
      cone(b, 0, 0, 0.88, 0.36, 0.95, 8, PAL.thatch);
      // auvent d'entrée, face +z
      box(b, -0.16, 0.16, 0, 0.34, 0.78, 0.98, PAL.wood);
      gable(b, -0.2, 0.2, 0.32, 0.46, 0.74, 1.02, PAL.thatchDark);
    },
  },
  {
    id: "gaulois_hutte_conique",
    family: "gaulois",
    w: 2.0,
    d: 2.0,
    h: 1.05,
    lodRoof: "cone",
    lodEaves: 0.18,
    lodWall: PAL.wattle,
    lodRoofCol: PAL.thatchDark,
    build(b) {
      prism(b, ringPoly(0, 0, 0.95, 9, 0.3), 0, 0.16, PAL.wattle, null);
      cone(b, 0, 0, 1.0, 0.14, 1.05, 9, PAL.thatchDark);
      box(b, -0.13, 0.13, 0, 0.3, 0.86, 1.04, PAL.wood);
    },
  },

  // --- romain (3) ---------------------------------------------------------
  {
    id: "romain_domus",
    family: "romain",
    w: 2.4,
    d: 2.0,
    h: 0.78,
    lodRoof: "hip",
    lodEaves: 0.72,
    lodWall: PAL.stucco,
    lodRoofCol: PAL.romanTile,
    build(b) {
      // quatre ailes autour d'un atrium ouvert
      const t = 0.42; // épaisseur d'aile
      box(b, -1.2, 1.2, 0, 0.56, -1.0, -1.0 + t, PAL.stucco);
      gable(b, -1.2, 1.2, 0.56, 0.78, -1.02, -0.96 + t, PAL.romanTile);
      box(b, -1.2, 1.2, 0, 0.52, 1.0 - t, 1.0, PAL.stucco);
      gable(b, -1.2, 1.2, 0.52, 0.72, 1.0 - t - 0.02, 1.02, PAL.romanTile);
      box(b, -1.2, -1.2 + t, 0, 0.5, -1.0 + t, 1.0 - t, PAL.stucco);
      gable(b, -1.24, -1.16 + t, 0.5, 0.68, -1.0 + t, 1.0 - t, PAL.romanTile, false);
      box(b, 1.2 - t, 1.2, 0, 0.5, -1.0 + t, 1.0 - t, PAL.stucco);
      gable(b, 1.16 - t, 1.24, 0.5, 0.68, -1.0 + t, 1.0 - t, PAL.romanTile, false);
    },
  },
  {
    id: "romain_insula",
    family: "romain",
    w: 2.0,
    d: 1.6,
    h: 1.55,
    lodRoof: "gable",
    lodEaves: 0.88,
    lodWall: PAL.romanBrick,
    lodRoofCol: PAL.romanTile,
    build(b) {
      box(b, -1.0, 1.0, 0, 1.36, -0.8, 0.8, PAL.romanBrick);
      // planchers marqués par des bandeaux de brique claire
      for (let i = 1; i <= 3; i++) {
        const y = i * 0.34;
        box(b, -1.03, 1.03, y, y + 0.055, -0.83, 0.83, PAL.stucco);
      }
      gable(b, -1.06, 1.06, 1.36, 1.55, -0.86, 0.86, PAL.romanTile);
      // balcon de bois du 1er étage, face +z
      box(b, -0.7, 0.7, 0.36, 0.42, 0.8, 0.94, PAL.wood);
    },
  },
  {
    id: "romain_temple",
    family: "romain",
    w: 2.2,
    d: 1.6,
    h: 1.3,
    lodRoof: "gable",
    lodEaves: 0.78,
    lodWall: PAL.marble,
    lodRoofCol: PAL.romanTile,
    build(b) {
      box(b, -1.1, 1.1, 0, 0.16, -0.8, 0.8, PAL.marble); // podium
      box(b, -0.9, 0.9, 0.16, 0.2, 0.8, 0.98, PAL.marble); // marches
      box(b, -0.72, 0.72, 0.16, 0.86, -0.66, 0.34, PAL.stucco); // cella
      for (let i = 0; i < 6; i++) {
        const cx = -0.78 + (i / 5) * 1.56;
        prism(b, rectPoly(cx - 0.07, cx + 0.07, 0.5, 0.64), 0.16, 0.88, PAL.marble, null);
      }
      box(b, -0.95, 0.95, 0.88, 0.96, -0.78, 0.78, PAL.marble); // architrave
      gable(b, -0.95, 0.95, 0.96, 1.3, -0.78, 0.78, PAL.romanTile, false); // fronton
    },
  },

  // --- medieval (4) -------------------------------------------------------
  {
    id: "medieval_2etages",
    family: "medieval",
    w: 1.45,
    d: 1.25,
    h: 1.5,
    lodRoof: "gable",
    lodEaves: 0.62,
    lodWall: PAL.plaster,
    lodRoofCol: PAL.tile,
    build(b) {
      box(b, -0.72, 0.72, 0, 0.92, -0.62, 0.62, PAL.plaster);
      box(b, -0.75, 0.75, 0.44, 0.5, -0.65, 0.65, PAL.timber);
      box(b, -0.75, 0.75, 0.86, 0.92, -0.65, 0.65, PAL.timber);
      box(b, -0.07, 0.07, 0, 0.92, 0.6, 0.66, PAL.timber);
      gable(b, -0.78, 0.78, 0.92, 1.42, -0.68, 0.68, PAL.tile, false);
      chimneys(b, -0.3, 0.3, 1.1, 1, -0.4, 0.09, 0.4, PAL.romanBrick);
    },
  },
  {
    id: "medieval_encorbellement",
    family: "medieval",
    w: 1.6,
    d: 1.35,
    h: 2.05,
    lodRoof: "gable",
    lodEaves: 0.68,
    lodWall: PAL.plasterPink,
    lodRoofCol: PAL.tile,
    build(b) {
      // trois niveaux en encorbellement : chaque étage déborde du précédent
      box(b, -0.62, 0.62, 0, 0.6, -0.52, 0.52, PAL.plasterPink);
      box(b, -0.72, 0.72, 0.6, 1.14, -0.6, 0.6, PAL.plasterPink);
      box(b, -0.8, 0.8, 1.14, 1.6, -0.67, 0.67, PAL.plasterPink);
      box(b, -0.75, 0.75, 0.56, 0.64, -0.63, 0.63, PAL.timber);
      box(b, -0.83, 0.83, 1.1, 1.18, -0.7, 0.7, PAL.timber);
      box(b, -0.09, 0.09, 1.18, 1.6, 0.63, 0.7, PAL.timber);
      gable(b, -0.84, 0.84, 1.6, 2.05, -0.71, 0.71, PAL.tile, false);
    },
  },
  {
    id: "medieval_pignon_haut",
    family: "medieval",
    w: 1.15,
    d: 1.05,
    h: 2.4,
    lodRoof: "gable",
    lodEaves: 0.75,
    lodWall: PAL.plaster,
    lodRoofCol: PAL.slate,
    build(b) {
      box(b, -0.56, 0.56, 0, 1.8, -0.5, 0.5, PAL.plaster);
      for (let i = 1; i <= 3; i++) {
        const y = i * 0.45;
        box(b, -0.59, 0.59, y, y + 0.06, -0.53, 0.53, PAL.timber);
      }
      box(b, -0.07, 0.07, 0, 1.8, 0.48, 0.54, PAL.timber);
      gable(b, -0.6, 0.6, 1.8, 2.4, -0.54, 0.54, PAL.slate, false);
      chimneys(b, -0.2, 0.2, 2.0, 1, -0.3, 0.08, 0.36, PAL.romanBrick);
    },
  },
  {
    id: "medieval_atelier",
    family: "medieval",
    w: 1.9,
    d: 1.5,
    h: 1.45,
    lodRoof: "hip",
    lodEaves: 0.5,
    lodWall: PAL.plaster,
    lodRoofCol: PAL.tile,
    build(b) {
      box(b, -0.95, 0.95, 0, 0.72, -0.75, 0.75, PAL.plaster);
      box(b, -0.98, 0.98, 0.66, 0.72, -0.78, 0.78, PAL.timber);
      hip(b, -1.0, 1.0, 0.72, 1.45, -0.8, 0.8, 0.35, PAL.tile);
      dormer(b, -0.3, 0.98, 0.42, 0.14, 0.18, PAL.plaster, PAL.tile);
      chimneys(b, 0.3, 0.6, 1.15, 1, -0.1, 0.1, 0.3, PAL.romanBrick);
    },
  },

  // --- classique (4) ------------------------------------------------------
  {
    id: "classique_hotel",
    family: "classique",
    w: 2.3,
    d: 1.7,
    h: 2.15,
    lodRoof: "mansard",
    lodEaves: 0.72,
    lodWall: PAL.stone,
    lodRoofCol: PAL.slateBlue,
    build(b) {
      box(b, -1.15, 1.15, 0, 1.5, -0.85, 0.85, PAL.stone);
      box(b, -1.18, 1.18, 0.72, 0.78, -0.88, 0.88, PAL.stoneWarm); // bandeau
      box(b, -1.2, 1.2, 1.46, 1.56, -0.9, 0.9, PAL.stoneWarm); // corniche
      frustum(b, -1.18, 1.18, 1.56, 2.02, -0.88, 0.88, 0.3, 0.3, PAL.slateBlue, null);
      box(b, -0.9, 0.9, 2.02, 2.15, -0.6, 0.6, PAL.slateBlue); // brisis / terrasson
      dormer(b, -0.6, 1.62, 0.72, 0.15, 0.2, PAL.stone, PAL.slateBlue);
      dormer(b, 0.0, 1.62, 0.72, 0.15, 0.2, PAL.stone, PAL.slateBlue);
      dormer(b, 0.6, 1.62, 0.72, 0.15, 0.2, PAL.stone, PAL.slateBlue);
      chimneys(b, -0.85, 0.85, 2.15, 2, 0, 0.1, 0.3);
    },
  },
  {
    id: "classique_hotel_aile",
    family: "classique",
    w: 2.4,
    d: 2.0,
    h: 1.95,
    lodRoof: "mansard",
    lodEaves: 0.7,
    lodWall: PAL.stoneWarm,
    lodRoofCol: PAL.slateBlue,
    build(b) {
      // corps principal + aile en retour (plan en L)
      box(b, -1.2, 1.2, 0, 1.32, 0.0, 1.0, PAL.stoneWarm);
      box(b, -1.2, 1.2, 1.28, 1.38, -0.04, 1.04, PAL.stone);
      frustum(b, -1.18, 1.18, 1.38, 1.8, 0.0, 1.0, 0.28, 0.26, PAL.slateBlue, null);
      box(b, -0.92, 0.92, 1.8, 1.95, 0.26, 0.74, PAL.slateBlue);
      box(b, -1.2, -0.3, 0, 1.16, -1.0, 0.0, PAL.stoneWarm);
      box(b, -1.23, -0.27, 1.12, 1.22, -1.03, 0.02, PAL.stone);
      hip(b, -1.22, -0.28, 1.22, 1.66, -1.02, 0.02, 0.2, PAL.slateBlue);
      dormer(b, -0.5, 1.44, 0.86, 0.14, 0.18, PAL.stone, PAL.slateBlue);
      dormer(b, 0.4, 1.44, 0.86, 0.14, 0.18, PAL.stone, PAL.slateBlue);
      chimneys(b, -0.8, 0.8, 1.95, 2, 0.5, 0.09, 0.28);
    },
  },
  {
    id: "classique_maison",
    family: "classique",
    w: 1.5,
    d: 1.3,
    h: 1.85,
    lodRoof: "mansard",
    lodEaves: 0.7,
    lodWall: PAL.stone,
    lodRoofCol: PAL.slate,
    build(b) {
      box(b, -0.75, 0.75, 0, 1.28, -0.65, 0.65, PAL.stone);
      box(b, -0.78, 0.78, 0.62, 0.68, -0.68, 0.68, PAL.stoneWarm);
      box(b, -0.8, 0.8, 1.24, 1.33, -0.7, 0.7, PAL.stoneWarm);
      frustum(b, -0.78, 0.78, 1.33, 1.7, -0.68, 0.68, 0.24, 0.22, PAL.slate, null);
      box(b, -0.56, 0.56, 1.7, 1.85, -0.48, 0.48, PAL.slate);
      dormer(b, -0.25, 1.38, 0.56, 0.13, 0.17, PAL.stone, PAL.slate);
      dormer(b, 0.3, 1.38, 0.56, 0.13, 0.17, PAL.stone, PAL.slate);
      chimneys(b, -0.5, 0.5, 1.85, 2, 0, 0.09, 0.26);
    },
  },
  {
    id: "classique_pavillon_brique",
    family: "classique",
    w: 1.7,
    d: 1.45,
    h: 2.0,
    lodRoof: "hip",
    lodEaves: 0.6,
    lodWall: PAL.brickVosges,
    lodRoofCol: PAL.slate,
    build(b) {
      box(b, -0.85, 0.85, 0, 1.2, -0.72, 0.72, PAL.brickVosges);
      // chaînes de pierre aux angles
      box(b, -0.88, -0.68, 0, 1.2, -0.75, -0.55, PAL.stone);
      box(b, 0.68, 0.88, 0, 1.2, -0.75, -0.55, PAL.stone);
      box(b, -0.88, -0.68, 0, 1.2, 0.55, 0.75, PAL.stone);
      box(b, 0.68, 0.88, 0, 1.2, 0.55, 0.75, PAL.stone);
      box(b, -0.9, 0.9, 1.16, 1.26, -0.77, 0.77, PAL.stone);
      hip(b, -0.9, 0.9, 1.26, 2.0, -0.77, 0.77, 0.3, PAL.slate);
      chimneys(b, -0.6, 0.6, 1.7, 2, 0, 0.09, 0.3);
    },
  },

  // --- haussmann (5) ------------------------------------------------------
  {
    id: "haussmann_6etages",
    family: "haussmann",
    w: 2.1,
    d: 1.5,
    h: 2.25,
    lodRoof: "mansard",
    lodEaves: 0.76,
    lodWall: PAL.hStone,
    lodRoofCol: PAL.zinc,
    build(b) {
      box(b, -1.05, 1.05, 0, 1.72, -0.75, 0.75, PAL.hStone);
      // soubassement commercial légèrement plus sombre
      box(b, -1.07, 1.07, 0, 0.3, -0.77, 0.77, PAL.hStoneCool);
      // balcons filants du 2e et du 5e (la signature haussmannienne)
      balcony(b, -1.05, 1.05, 0.58, -0.75, 0.75);
      balcony(b, -1.05, 1.05, 1.42, -0.75, 0.75);
      // corniche
      box(b, -1.1, 1.1, 1.68, 1.78, -0.8, 0.8, PAL.hStoneCool);
      // comble mansardé à 45°, zinc
      frustum(b, -1.08, 1.08, 1.78, 2.12, -0.78, 0.78, 0.26, 0.24, PAL.zinc, null);
      box(b, -0.82, 0.82, 2.12, 2.25, -0.54, 0.54, PAL.zincDark);
      chimneys(b, -0.85, 0.85, 2.25, 3, 0, 0.1, 0.28);
    },
  },
  {
    id: "haussmann_5etages",
    family: "haussmann",
    w: 1.8,
    d: 1.4,
    h: 1.95,
    lodRoof: "mansard",
    lodEaves: 0.75,
    lodWall: PAL.hStoneCool,
    lodRoofCol: PAL.zinc,
    build(b) {
      box(b, -0.9, 0.9, 0, 1.46, -0.7, 0.7, PAL.hStoneCool);
      box(b, -0.92, 0.92, 0, 0.28, -0.72, 0.72, PAL.hStone);
      balcony(b, -0.9, 0.9, 1.16, -0.7, 0.7);
      box(b, -0.95, 0.95, 1.42, 1.51, -0.75, 0.75, PAL.hStone);
      frustum(b, -0.93, 0.93, 1.51, 1.83, -0.73, 0.73, 0.24, 0.22, PAL.zinc, null);
      box(b, -0.69, 0.69, 1.83, 1.95, -0.51, 0.51, PAL.zincDark);
      chimneys(b, -0.7, 0.7, 1.95, 2, 0, 0.09, 0.26);
    },
  },
  {
    id: "haussmann_7etages",
    family: "haussmann",
    w: 2.0,
    d: 1.55,
    h: 2.6,
    lodRoof: "mansard",
    lodEaves: 0.78,
    lodWall: PAL.hStone,
    lodRoofCol: PAL.zinc,
    build(b) {
      box(b, -1.0, 1.0, 0, 2.04, -0.78, 0.78, PAL.hStone);
      box(b, -1.02, 1.02, 0, 0.32, -0.8, 0.8, PAL.hStoneCool);
      // Max 2 bandeaux de balcon par archétype (review Important 4) : on
      // garde le 2e et le 6e étage, on abandonne celui du milieu.
      balcony(b, -1.0, 1.0, 0.62, -0.78, 0.78);
      balcony(b, -1.0, 1.0, 1.74, -0.78, 0.78);
      box(b, -1.05, 1.05, 2.0, 2.1, -0.83, 0.83, PAL.hStoneCool);
      frustum(b, -1.03, 1.03, 2.1, 2.44, -0.81, 0.81, 0.26, 0.25, PAL.zinc, null);
      box(b, -0.77, 0.77, 2.44, 2.6, -0.56, 0.56, PAL.zincDark);
      chimneys(b, -0.8, 0.8, 2.6, 3, 0, 0.1, 0.3);
    },
  },
  {
    id: "haussmann_large",
    family: "haussmann",
    w: 2.5,
    d: 1.6,
    h: 2.3,
    lodRoof: "mansard",
    lodEaves: 0.77,
    lodWall: PAL.hStone,
    lodRoofCol: PAL.zinc,
    build(b) {
      box(b, -1.25, 1.25, 0, 1.78, -0.8, 0.8, PAL.hStone);
      box(b, -1.27, 1.27, 0, 0.3, -0.82, 0.82, PAL.hStoneCool);
      balcony(b, -1.25, 1.25, 0.6, -0.8, 0.8);
      balcony(b, -1.25, 1.25, 1.48, -0.8, 0.8);
      // travée centrale légèrement saillante
      box(b, -0.34, 0.34, 0, 1.78, 0.8, 0.9, PAL.hStoneCool);
      box(b, -1.3, 1.3, 1.74, 1.84, -0.85, 0.85, PAL.hStoneCool);
      frustum(b, -1.28, 1.28, 1.84, 2.16, -0.83, 0.83, 0.28, 0.26, PAL.zinc, null);
      box(b, -1.0, 1.0, 2.16, 2.3, -0.57, 0.57, PAL.zincDark);
      chimneys(b, -1.05, 1.05, 2.3, 4, 0, 0.1, 0.28);
    },
  },
  {
    id: "haussmann_angle",
    family: "haussmann",
    w: 1.9,
    d: 1.9,
    h: 2.35,
    lodRoof: "mansard",
    lodEaves: 0.76,
    lodWall: PAL.hStone,
    lodRoofCol: PAL.zinc,
    build(b) {
      // immeuble d'angle à pan coupé : pentagone, balcons filants continus
      const poly = [
        [0.95, -0.95],
        [-0.95, -0.95],
        [-0.95, 0.5],
        [-0.5, 0.95],
        [0.95, 0.95],
      ];
      const grow = (p, k) => p.map(([x, z]) => [x * k, z * k]);
      prism(b, poly, 0, 1.8, PAL.hStone, null);
      prism(b, grow(poly, 1.02), 0, 0.3, PAL.hStoneCool, null);
      // Bandeaux de balcon filant : gris moyen, fin, faible débord — même
      // traitement que balcony() ci-dessus (review Important 4).
      prism(b, grow(poly, 1.03), 0.62, 0.67, PAL.balconyIron, null);
      prism(b, grow(poly, 1.03), 1.46, 1.51, PAL.balconyIron, null);
      prism(b, grow(poly, 1.05), 1.76, 1.86, PAL.hStoneCool, null);
      prism(b, grow(poly, 1.0), 1.86, 2.16, PAL.zinc, null);
      prism(b, grow(poly, 0.74), 2.16, 2.24, PAL.zinc, PAL.zincDark);
      chimneys(b, -0.6, 0.6, 2.24, 3, 0, 0.1, 0.28);
    },
  },

  // --- moderne (4) --------------------------------------------------------
  {
    id: "moderne_barre",
    family: "moderne",
    w: 2.5,
    d: 1.1,
    h: 2.8,
    lodRoof: "flat",
    lodEaves: 0.94,
    lodWall: PAL.concrete,
    lodRoofCol: PAL.flatRoof,
    build(b) {
      box(b, -1.25, 1.25, 0, 2.62, -0.55, 0.55, PAL.concrete, PAL.flatRoof);
      // bandes de fenêtres filantes (8 niveaux), les deux faces longues
      for (let i = 0; i < 8; i++) {
        const y = 0.22 + i * 0.3;
        box(b, -1.2, 1.2, y, y + 0.17, 0.55, 0.58, PAL.glassDark);
        box(b, -1.2, 1.2, y, y + 0.17, -0.58, -0.55, PAL.glassDark);
      }
      box(b, -0.5, 0.1, 2.62, 2.8, -0.35, 0.35, PAL.concreteDark); // édicule d'ascenseur
    },
  },
  {
    id: "moderne_tour",
    family: "moderne",
    w: 1.6,
    d: 1.6,
    h: 6.4,
    // Poids de tirage au sein de la famille (défaut 1, voir pickArchetype
    // dans buildings.js) : sans ça, les 4 archétypes modernes sont tirés à
    // parts égales, et une tour de 64 m devient aussi fréquente qu'une barre
    // de 28 m — Paris hors La Défense n'a presque aucune tour. Abaissé pour
    // que les tours restent des ponctuations rares du tissu, pas la moitié
    // du bâti « moderne ».
    weight: 0.12,
    lodRoof: "flat",
    lodEaves: 0.95,
    lodWall: PAL.concreteDark,
    lodRoofCol: PAL.flatRoof,
    build(b) {
      box(b, -0.8, 0.8, 0, 6.1, -0.8, 0.8, PAL.concreteDark, PAL.flatRoof);
      // nervures verticales de béton sur les quatre faces
      for (let i = 0; i < 3; i++) {
        const cx = -0.5 + i * 0.5;
        box(b, cx - 0.08, cx + 0.08, 0.3, 6.1, 0.8, 0.86, PAL.concrete);
        box(b, cx - 0.08, cx + 0.08, 0.3, 6.1, -0.86, -0.8, PAL.concrete);
      }
      box(b, -0.9, 0.9, 0, 0.34, -0.9, 0.9, PAL.concrete); // socle
      box(b, -0.85, 0.85, 6.1, 6.24, -0.85, 0.85, PAL.concrete); // acrotère
      box(b, -0.18, 0.18, 6.24, 6.4, -0.18, 0.18, PAL.panel);
    },
  },
  {
    id: "contemporain_verre",
    family: "moderne",
    w: 1.9,
    d: 1.5,
    h: 3.2,
    lodRoof: "flat",
    lodEaves: 0.93,
    lodWall: PAL.glass,
    lodRoofCol: PAL.flatRoof,
    build(b) {
      box(b, -0.95, 0.95, 0, 2.7, -0.75, 0.75, PAL.glass, PAL.flatRoof);
      for (let i = 1; i <= 7; i++) {
        const y = i * 0.34;
        box(b, -0.98, 0.98, y, y + 0.05, -0.78, 0.78, PAL.panel);
      }
      box(b, -0.7, 0.7, 2.7, 3.12, -0.55, 0.55, PAL.glassGreen, PAL.flatRoof); // retrait
      box(b, -1.05, 1.05, 0.32, 0.38, 0.75, 1.0, PAL.panel); // auvent
    },
  },
  {
    id: "contemporain_tour_verre",
    family: "moderne",
    w: 1.7,
    d: 1.7,
    h: 9.0,
    weight: 0.12, // voir la note sur moderne_tour ci-dessus
    lodRoof: "flat",
    lodEaves: 0.96,
    lodWall: PAL.glassDark,
    lodRoofCol: PAL.flatRoof,
    build(b) {
      box(b, -0.85, 0.85, 0, 5.6, -0.85, 0.85, PAL.glassDark);
      box(b, -0.72, 0.72, 5.6, 8.1, -0.72, 0.72, PAL.glass);
      box(b, -0.55, 0.55, 8.1, 8.8, -0.55, 0.55, PAL.glassGreen, PAL.flatRoof);
      for (let i = 1; i <= 6; i++) {
        const y = i * 0.8;
        box(b, -0.88, 0.88, y, y + 0.07, -0.88, 0.88, PAL.panel);
      }
      box(b, -0.95, 0.95, 0, 0.4, -0.95, 0.95, PAL.panel); // socle vitré
      box(b, -0.1, 0.1, 8.8, 9.0, -0.1, 0.1, PAL.concreteDark);
    },
  },
];

export { ARCHETYPES };

/** Indices d'archétypes par famille, dans l'ordre de déclaration. */
export const ARCHETYPES_BY_FAMILY = (() => {
  const byFamily = {};
  for (const name of FAMILY_ORDER) byFamily[name] = [];
  ARCHETYPES.forEach((a, i) => byFamily[a.family].push(i));
  return byFamily;
})();

// ============================================================================
// Construction des géométries
// ============================================================================

function toGeometry(b) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(b.pos), 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(b.nor), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(b.col), 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Construit les 22 géométries détaillées, dans le même ordre que ARCHETYPES.
 * @returns {THREE.BufferGeometry[]}
 */
export function buildArchetypeGeometries() {
  return ARCHETYPES.map((spec) => {
    const b = newBuilder();
    spec.build(b);
    return toGeometry(b);
  });
}

/**
 * Version LOD d'un archétype : une boîte de murs + un toit de la bonne forme
 * et de la bonne couleur. C'est *cette* silhouette-là que la vue aérienne
 * lointaine montre, donc le toit y est essentiel (c'est lui qui donne le
 * gris zinc du centre haussmannien vu d'en haut).
 * @param {number} index - index dans ARCHETYPES
 * @returns {THREE.BufferGeometry}
 */
export function buildArchetypeLodGeometry(index) {
  const spec = ARCHETYPES[index];
  const b = newBuilder();
  const hx = spec.w / 2;
  const hz = spec.d / 2;
  const eaves = spec.h * spec.lodEaves;
  const flat = spec.lodRoof === "flat";
  box(b, -hx, hx, 0, eaves, -hz, hz, spec.lodWall, flat ? spec.lodRoofCol : spec.lodWall);
  switch (spec.lodRoof) {
    case "gable":
      gable(b, -hx, hx, eaves, spec.h, -hz, hz, spec.lodRoofCol, spec.w >= spec.d);
      break;
    case "hip":
      hip(b, -hx, hx, eaves, spec.h, -hz, hz, Math.min(hx, hz) * 0.5, spec.lodRoofCol);
      break;
    case "mansard":
      frustum(
        b,
        -hx,
        hx,
        eaves,
        spec.h,
        -hz,
        hz,
        hx * 0.34,
        hz * 0.34,
        spec.lodRoofCol,
        spec.lodRoofCol
      );
      break;
    case "cone":
      cone(b, 0, 0, Math.min(hx, hz), eaves, spec.h, 6, spec.lodRoofCol);
      break;
    default:
      break; // flat: le couvercle de la boîte fait office de toiture
  }
  return toGeometry(b);
}

/**
 * Nombre de triangles de la géométrie détaillée d'un archétype (utile aux
 * tests de budget et au rapport de perf).
 * @param {number} index
 * @returns {number}
 */
export function archetypeTriangleCount(index) {
  const b = newBuilder();
  ARCHETYPES[index].build(b);
  return b.pos.length / 9;
}
