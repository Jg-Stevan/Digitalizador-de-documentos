// src/core/dianaMath.ts — medición de precisión de esquinas con la diana F4
// (orden F4, punto 4). PURO (Node-testeable): convierte errores en px del
// quad detectado a mm usando el ancho real medido del rectángulo de la diana
// y agrega el percentil 95 sobre N capturas → "±X mm al 95%".

import type { Quadrilateral } from './types';

export const DIANA_DEFAULT_WIDTH_MM = 190.5;

/** Longitudes de los 4 lados en px: [top, right, bottom, left] (orden 0-3). */
export function sideLengths(q: Quadrilateral): [number, number, number, number] {
  const len = (i: number) => Math.hypot(q[(i + 1) % 4]!.x - q[i]!.x, q[(i + 1) % 4]!.y - q[i]!.y);
  return [len(0), len(1), len(2), len(3)];
}

/** Ancho "promedio" px del rectángulo detectado: media de los lados top/bottom
 *  (compensa algo la perspectiva). 0 si el quad es degenerado. */
export function meanWidthPx(q: Quadrilateral): number {
  const [top, , bottom] = sideLengths(q);
  return (top + bottom) / 2;
}

/** Conversor px→mm de ESTE quad: mmPorPx = anchoRealMm / anchoPx.
 *  NaN si el ancho medido o el ancho real son degenerados. */
export function mmPerPixel(widthPx: number, realMm: number): number {
  if (!(widthPx > 0) || !(realMm > 0)) return NaN;
  return realMm / widthPx;
}

/** 4N distancias esquina↔media (en mm, escaladas con el mmPorPx de cada
 *  captura) para reportar "±X mm al 95%". <2 capturas → null (una captura
 *  no define una media). */
export function cornerResidualsMm(quads: Quadrilateral[], realMm: number): number[] | null {
  if (quads.length < 2) return null;
  const n = quads.length;
  const meanX = [0, 0, 0, 0];
  const meanY = [0, 0, 0, 0];
  for (const q of quads) {
    for (let i = 0; i < 4; i++) {
      meanX[i] = (meanX[i] ?? 0) + q[i]!.x / n;
      meanY[i] = (meanY[i] ?? 0) + q[i]!.y / n;
    }
  }
  const out: number[] = [];
  for (const q of quads) {
    const mm = mmPerPixel(meanWidthPx(q), realMm);
    if (!Number.isFinite(mm) || mm <= 0) return null; // degenerado: sin escala
    for (let i = 0; i < 4; i++) {
      const dPx = Math.hypot(q[i]!.x - meanX[i]!, q[i]!.y - meanY[i]!);
      out.push(dPx * mm);
    }
  }
  return out;
}

/** Percentil 95 lineal (con interpolación tipo R-7 como Math.round del orden
 *  estadístico; suficiente para un reporte de harness). Vacío → null. */
export function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = 0.95 * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export interface DianaReport {
  /** Capturas usadas (≥2); el reporte no existe con menos. */
  count: number;
  /** mm por px promedio (global) — también resolución efectiva p/ver DPI. */
  mmPerPixel: number;
  /** "±X mm al 95%": percentil 95 de los 4N residuos en mm. */
  p95mm: number;
  /** T8: media de los 4N residuos en mm (junto al p95 — el p95 solo lo
   *  dominan los outliers cuando N es pequeño, como en la ronda F4 N=5). */
  meanMm: number;
  /** T8: desviación estándar poblacional de los 4N residuos en mm. */
  sdMm: number;
  /** T8: p95 por esquina [TL,TR,BR,BL] en mm — localiza el ruido del
   *  detector por esquina (con encuadre FIJO la dispersión es ruido del
   *  detector; ver protocolo en docs/matriz-dispositivos.md). */
  perCornerP95Mm: [number, number, number, number];
  /** T8: nº de residuos marcados outlier (|z| > 2.5) — marcados, NO
   *  eliminados (el reporte los conserva; el protocolo exige N ≥ 20 para
   *  que un outlier no domine el p95). */
  outlierCount: number;
}

/** Reporte de esquinas: vacío o <2 capturas → null (el harness muestra 0
 *  capturas pendientes en vez de un número sin significado estadístico). */
export function cdeReport(quads: Quadrilateral[], realMm: number): DianaReport | null {
  const mm = cornerResidualsMm(quads, realMm);
  const p95 = mm === null ? null : percentile95(mm);
  if (quads.length < 2 || p95 === null || mm === null) return null;
  const mpp = quads.map((q) => mmPerPixel(meanWidthPx(q), realMm)).filter(Number.isFinite);
  const meanMpp = mpp.reduce((a, b) => a + b, 0) / Math.max(1, mpp.length);
  const stats = meanStd(mm) ?? { mean: NaN, sd: NaN };
  const per = cornerErrorsMm(quads, realMm);
  const perCornerP95Mm: [number, number, number, number] = [0, 1, 2, 3].map((c) => {
    const p = per === null ? null : percentile95(per[c]!);
    return p ?? NaN;
  }) as [number, number, number, number];
  return {
    count: quads.length,
    mmPerPixel: meanMpp,
    p95mm: p95,
    meanMm: stats.mean,
    sdMm: stats.sd,
    perCornerP95Mm,
    outlierCount: flagOutliers(mm).filter(Boolean).length,
  };
}

// ---------------------------------------------------------------------------
// T8 — protocolo estadístico: error por esquina, outliers marcados (no
// eliminados) y media±SD junto al p95. La SEPARACIÓN entre ruido del detector
// y varianza de encuadre es de protocolo (docs/matriz-dispositivos.md):
// series con encuadre FIJO (trípode/apoyo, diana contra pared) miden ruido
// del detector; series a pulso miden detector + operador y se registran
// aparte. El código no intenta separarlas solo — sería inventar datos.
// ---------------------------------------------------------------------------

/** Residuos agrupados por esquina: errors[c] = residuos en mm de la esquina
 *  c (TL,TR,BR,BL) sobre las N capturas. <2 capturas o escala degenerada →
 *  null (mismas reglas que cornerResidualsMm, del que deriva). */
export function cornerErrorsMm(
  quads: Quadrilateral[],
  realMm: number,
): [number[], number[], number[], number[]] | null {
  const flat = cornerResidualsMm(quads, realMm);
  if (flat === null) return null;
  const n = quads.length;
  const out: [number[], number[], number[], number[]] = [[], [], [], []];
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 4; c++) out[c]!.push(flat[k * 4 + c]!);
  }
  return out;
}

/** Media + desviación estándar POBLACIONAL (÷N, no ÷N-1: describimos la
 *  serie medida, no estimamos una población mayor). Vacío o no-finito →
 *  null. */
export function meanStd(values: readonly number[]): { mean: number; sd: number } | null {
  if (values.length === 0) return null;
  let mean = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) return null;
    mean += v;
  }
  mean /= values.length;
  let variance = 0;
  for (const v of values) variance += (v - mean) * (v - mean);
  variance /= values.length;
  return { mean, sd: Math.sqrt(variance) };
}

/** Umbral |z| para marcar un residuo como outlier (T8). 2.5: con N ≥ 20 del
 *  protocolo, un punto más allá de 2.5σ es raro bajo ruido gaussiano
 *  (~1.2% a dos colas) y merece mirarse — pero se MARCA, no se elimina. */
export const OUTLIER_Z = 2.5;

/** Marca outliers por z-score contra la media±SD de la PROPIA serie
 *  (|x - mean| > z·sd → true). NO elimina nada: el llamador decide qué
 *  mostrar (el reporte CDE los cuenta; el protocolo exige re-medir antes
 *  que recortar). sd == 0 (serie idéntica) → todo false. Vacío → []. */
export function flagOutliers(values: readonly number[], z: number = OUTLIER_Z): boolean[] {
  const stats = meanStd(values);
  if (stats === null || !(stats.sd > 0)) return values.map(() => false);
  return values.map((v) => Math.abs(v - stats.mean) > z * stats.sd);
}