// src/core/quadSelect.ts — elección del cuadrilátero entre aproximaciones (F1).
// PURO (sin DOM ni OpenCV): recibe polígonos ya aproximados (el lado cv hace
// findContours + approxPolyDP) con sus áreas, y aplica la geometría aprobada
// de core/geometry.ts (orderPoints + validateQuad — SOLO consumo, sin editar).
// Contrato de unidades: points y frameW/H en píxeles del MISMO frame
// (el pipeline convierte a coords del frame ORIGINAL antes de llamar).
//
// [R4-B2 rev.2] Priores GENÉRICOS de documento (perfiles configurables, NO
// hardcode de un formato): el score de cada candidato VÁLIDO suma un bonus
// suave si su aspecto cae en el rango del perfil activo + un término de
// blancura del blob (separa PAPEL de mesa/manos/fundas — genérico). Los
// priores son PREFERENCIAS, nunca rechazo: un documento fuera de perfil
// sigue siendo válido (regla del escáner genérico), y con profile 'auto' y
// sin whiteness el resultado degrada al orden por área pre-R4 (compatibilidad).
// [R4-B3] DocAligner ONNX tras ?neural=1 queda CONGELADO a decisión humana
// (plan §R4-B B3) — nada de eso vive en este archivo.

import { orderPoints, orderPointsAngle, validateQuad, QUAD_MIN_AREA_RATIO_DETECT } from './geometry';
import type { Corner, DocProfile, Quadrilateral } from './types';

/** Nº de contornos top por área que se evalúan (F1: el resto es ruido). */
export const TOP_CONTOURS = 5;

/** Bonus de score cuando el aspecto del quad cae en el rango del perfil. */
export const PROFILE_ASPECT_BONUS = 0.15;

/** Peso del pre-score de blancura (0–1) en el score total. */
export const WHITENESS_WEIGHT = 0.25;

/** Semántica del rango de aspecto de un perfil (documentado por entrada). */
export type AspectPrior =
  /** h/w ∈ [min, max] — la orientación queda implícita en el rango
   *  (rango >1 ⇒ vertical h>w; rango <1 ⇒ horizontal w>h). */
  | { ratio: 'h/w'; min: number; max: number }
  /** max(w,h)/min(w,h) ∈ [min, max] en CUALQUIER orientación. */
  | { ratio: 'long/short'; min: number; max: number }
  /** 'auto': sin prior de aspecto. */
  | null;

/** [R4-B2 rev.2] Tabla de priores de aspecto por perfil (plan §R4-B B2):
 *  - 'documento-largo' (actas/tirillas): vertical, h/w ∈ [1.3, 4.5].
 *  - 'pagina' (carta/A4): max/min ∈ [1.2, 1.6] en CUALQUIER orientación.
 *  - 'tarjeta' (credenciales): horizontal (w>h) con lado corto/largo
 *    0.6–0.8 — con w>h eso es h/w ∈ [0.6, 0.8] (ID-1: 54/85.6 ≈ 0.63 ✓;
 *    la lectura literal "w/h ∈ [0.6,0.8] con w>h" es vacía porque w/h>1,
 *    así que se normaliza al convenio corto/largo del plan).
 *  - 'auto': null (sin prior). */
export const PROFILE_ASPECT_PRIORS: Readonly<Record<DocProfile, AspectPrior>> = {
  auto: null,
  'documento-largo': { ratio: 'h/w', min: 1.3, max: 4.5 },
  pagina: { ratio: 'long/short', min: 1.2, max: 1.6 },
  tarjeta: { ratio: 'h/w', min: 0.6, max: 0.8 },
};

/** Polígono aproximado con su área (lado cv: approxPolyDP + contourArea). */
export interface ScoredPoly {
  points: Corner[];
  area: number;
  /** [R4-B2] Pre-score de blancura del blob (0–1, media de
   *  luma/255·(1−sat·2.2) sobre los píxeles dentro del polígono). Opcional:
   *  ausente (p. ej. sin imageData) → el score no lo considera. */
  whiteness?: number;
}

/** w/h y h/w MEDIDOS de lados (mismo convenio que computeWarpDims: nunca
 *  aspect ratios hardcodeados — solo el quad manda). */
function sideLens(q: Quadrilateral): { w: number; h: number } {
  const len = (i: number): number =>
    Math.hypot(q[(i + 1) % 4]!.x - q[i]!.x, q[(i + 1) % 4]!.y - q[i]!.y);
  return {
    w: Math.max(len(0), len(2)), // top, bottom
    h: Math.max(len(1), len(3)), // right, left
  };
}

/** [R4-B2] ¿El aspecto del quad cumple el prior del perfil? (solo bonus). */
function aspectMatches(quad: Quadrilateral, prior: AspectPrior): boolean {
  if (prior === null) return false;
  const { w, h } = sideLens(quad);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 1e-9 || h <= 1e-9) {
    return false; // quad degenerado: sin bonus, pero sigue siendo candidato
  }
  if (prior.ratio === 'h/w') {
    const hw = h / w;
    return hw >= prior.min && hw <= prior.max;
  }
  const ls = Math.max(w, h) / Math.min(w, h);
  return ls >= prior.min && ls <= prior.max;
}

/** Top-N por área → solo 4 vértices → orden canónico → validación estricta
 *  (los INVÁLIDOS se descartan, como siempre — los priores son preferencias,
 *  nunca rechazo). [R4-B2 rev.2] Entre los válidos gana el MAYOR score:
 *  score = área/(frameW·frameH) + 0.15·(aspecto cumple el perfil) +
 *  0.25·(whiteness ?? 0); empate → mayor área. Sin válidos → null (como hoy).
 *  Con profile 'auto' y sin whiteness, el mayor área gana: mismo resultado
 *  que el pre-R4 (compatibilidad exacta). */
export function selectQuad(
  polys: ScoredPoly[],
  frameW: number,
  frameH: number,
  topN: number = TOP_CONTOURS,
  opts: { profile?: DocProfile } = {},
): Quadrilateral | null {
  const prior = PROFILE_ASPECT_PRIORS[opts.profile ?? 'auto'] ?? null;
  const top = [...polys].sort((a, b) => b.area - a.area).slice(0, Math.max(0, topN));
  let best: { quad: Quadrilateral; score: number; area: number } | null = null;
  for (const poly of top) {
    if (poly.points.length !== 4) continue;
    let ordered: Quadrilateral | null = null;
    try {
      ordered = orderPoints(poly.points);
    } catch {
      // [F5-CROP] suma/diferencia degenera en quads rotados ~45° (un punto
      // reclama TL y TR a la vez); el orden ANGULAR alrededor del centroide
      // es colision-free para quads convexos → retry antes de descartar.
      try {
        ordered = orderPointsAngle(poly.points);
      } catch {
        continue; // degenerado real → siguiente candidato
      }
    }
    if (ordered === null) continue;
    if (
      // [F5-CROP, 2026-10-01] umbral de DETECCIÓN 0.10 (fotos reales issue #2:
      // documento a distancia normal no llena el 25% §F1 del encuadre).
      !validateQuad(ordered, frameW, frameH, QUAD_MIN_AREA_RATIO_DETECT)
    ) {
      continue;
    }
    const score =
      poly.area / (frameW * frameH) +
      (aspectMatches(ordered, prior) ? PROFILE_ASPECT_BONUS : 0) +
      WHITENESS_WEIGHT * (poly.whiteness ?? 0);
    if (
      best === null ||
      score > best.score ||
      (score === best.score && poly.area > best.area)
    ) {
      best = { quad: ordered, score, area: poly.area };
    }
  }
  return best === null ? null : best.quad;
}

/** Escala anisotrópica de polígono (proceso → frame original, sx≠sy).
 *  Las fracciones se preservan por eje: es lo que hace invariante el mapeo. */
export function scalePoly(points: Corner[], sx: number, sy: number): Corner[] {
  return points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}
