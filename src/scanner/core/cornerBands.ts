// src/core/cornerBands.ts — bandas de búsqueda del CornerRefiner (PLAN_MAESTRO §F3, blindaje 1).
// SIN DOM ni OpenCV: 100% testeable en Node. Consume las constantes de banda de
// geometry.ts (NO las redeclara); el aspecto sale del quad medido, nunca de
// ratios hardcodeados.

import type { Quadrilateral } from './types';
import { BAND_MIN_PX, BAND_PCT_OF_SIDE } from './geometry';

/** Banda de búsqueda sobre un lado del quad: bbox axis-aligned del segmento
 *  inflado por el ancho de banda (sin rotar — Canny detecta el borde dentro).
 *  Campos x/y/width/height compatibles con el roi del worker. */
export interface BandRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0=top, 1=right, 2=bottom, 3=left (numeración de geometry.ts). */
  side: 0 | 1 | 2 | 3;
  /** Ancho de banda aplicado (para diagnóstico). */
  bandW: number;
}

/** Bandas adaptativas por lado: ancho `max(BAND_MIN_PX, BAND_PCT_OF_SIDE·longitud)`,
 *  centradas sobre el segmento y recortadas a la foto (clamp). Lados de longitud
 *  cero se omiten. Quad degenerado (coords no-finitas o área nula) → []. */
export function computeBandRects(
  quadPx: Quadrilateral,
  photoW: number,
  photoH: number,
): BandRect[] {
  if (!Number.isFinite(photoW) || !Number.isFinite(photoH) || !(photoW > 0) || !(photoH > 0)) {
    return [];
  }
  for (let i = 0; i < 4; i++) {
    if (
      !Number.isFinite(quadPx[i]!.x) ||
      !Number.isFinite(quadPx[i]!.y)
    ) {
      return [];
    }
  }
  const out: BandRect[] = [];
  for (let s = 0; s < 4; s++) {
    const a = quadPx[s]!;
    const b = quadPx[(s + 1) % 4]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > 0)) continue; // lado colapsado: sin banda (el pipeline lo marca caído)
    const bandW = Math.max(BAND_MIN_PX, BAND_PCT_OF_SIDE * len);
    const half = bandW / 2;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - half));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - half));
    const x1 = Math.min(photoW, Math.ceil(Math.max(a.x, b.x) + half));
    const y1 = Math.min(photoH, Math.ceil(Math.max(a.y, b.y) + half));
    if (x1 - x0 < 1 || y1 - y0 < 1) continue; // lado fuera de foto: sin banda
    out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, side: s as 0 | 1 | 2 | 3, bandW });
  }
  return out;
}
