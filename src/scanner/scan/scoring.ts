// src/scan/scoring.ts — medición pura sobre píxeles + selector de aviso (F2).
// PURO (sin DOM/OpenCV): ImageData → {laplacianVar, hist} para alimentar
// quality.ts (APROBADO, se consume sin editar), y selectHint() con UN mensaje
// accionable por prioridad. Testeable en Node.

import { OVER_EXPOSED_PX, UNDER_EXPOSED_PX } from '../core/quality';

/** Umbrales SOLO de copy (qué aviso mostrar), NO de calidad: si >25% de los
 *  píxeles caen en la banda sub/sobreexpuesta, el aviso correspondiente gana.
 *  Origen: ingeniería F2 (los umbrales de CALIDAD viven en quality.ts). */
export const DARK_RATIO = 0.25;
export const BRIGHT_RATIO = 0.25;

export const HINT_NO_QUAD = 'Acerca el documento al recuadro';
export const HINT_CENTER = 'Centra el documento';
export const HINT_GLARE = 'Evita el reflejo, muévete';
export const HINT_DARK = 'Muy oscuro';
export const HINT_BRIGHT = 'Muy claro';
export const HINT_HOLD = 'Sostén firme';

/** Luminancia ITU-R BT.601 del buffer RGBA → histograma de 256 bins. */
export function rgbaToHist(data: Uint8ClampedArray): number[] {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i + 3 < data.length + 1; i += 4) {
    const l = (data[i]! * 77 + data[i + 1]! * 150 + data[i + 2]! * 29) >> 8;
    hist[l]! += 1;
  }
  return hist;
}

/** Gris de un canal desde RGBA (misma luminancia que rgbaToHist). */
export function rgbaToGray(data: Uint8ClampedArray): Uint8ClampedArray {
  const n = Math.floor(data.length / 4);
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    out[i] = (data[i * 4]! * 77 + data[i * 4 + 1]! * 150 + data[i * 4 + 2]! * 29) >> 8;
  }
  return out;
}

/** Var(Laplacian 3×3) sobre gris de un canal (borde de 1px excluido). */
export function laplacianVarGray(gray: Uint8ClampedArray, w: number, h: number): number {
  if (w < 3 || h < 3 || gray.length < w * h) return 0;
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        gray[i - w]! + gray[i - 1]! - 4 * gray[i]! + gray[i + 1]! + gray[i + w]!;
      n++;
      const d = lap - mean;
      mean += d / n;
      m2 += d * (lap - mean);
    }
  }
  return n > 0 ? m2 / n : 0;
}

/** Medición completa de un frame para quality.ts. */
export function measureFrame(imageData: ImageData): { laplacianVar: number; hist: number[] } {
  const gray = rgbaToGray(imageData.data);
  return {
    laplacianVar: laplacianVarGray(gray, imageData.width, imageData.height),
    hist: rgbaToHist(imageData.data),
  };
}

/** Fracciones sub/sobreexpuestas del histograma (bandas de quality.ts). */
export function underOverRatios(hist: number[]): { under: number; over: number } {
  let total = 0;
  let under = 0;
  let over = 0;
  const n = Math.min(hist.length, 256);
  for (let i = 0; i < n; i++) {
    const c = hist[i] ?? 0;
    if (!(c > 0)) continue;
    total += c;
    if (i < UNDER_EXPOSED_PX) under += c;
    else if (i > OVER_EXPOSED_PX) over += c;
  }
  if (total <= 0) return { under: 0, over: 0 };
  return { under: under / total, over: over / total };
}

export interface HintInput {
  hasQuad: boolean;
  /** null = sin penalización (sin quad o ecc neutral). */
  eccentricity: number | null;
  specularWarn: boolean;
  underRatio: number;
  overRatio: number;
  stability: number;
}

/** UN mensaje accionable por prioridad (spec F2 Fase 1.4, literal):
 *  sin quad → centrar → reflejo → exposición → firmeza; null si todo bien. */
export function selectHint(h: HintInput): string | null {
  if (!h.hasQuad) return HINT_NO_QUAD;
  if (h.eccentricity !== null && h.eccentricity < 1) return HINT_CENTER;
  if (h.specularWarn) return HINT_GLARE;
  if (h.overRatio > BRIGHT_RATIO) return HINT_BRIGHT;
  if (h.underRatio > DARK_RATIO) return HINT_DARK;
  if (h.stability < 1) return HINT_HOLD;
  return null;
}
