// src/core/quality.ts — Score de calidad de captura + máquina de disparo (T3).
// PLAN_MAESTRO §5-F2 y §8. Módulo PURO: recibe números crudos (varianza
// laplaciana, histograma, historial de quads con timestamps) y produce scores.
// OpenCV/DOM quedan en el worker (F1-F2). Testeable en Node con Vitest.
//
// CONTRATO DE MEDICIÓN: todas las métricas se calculan sobre el CROP del
// documento a resolución fija (400-clase de lado largo, nunca sobre el frame
// completo — F1-opt P3). HISTORIA DEL CONTRATO: original 480p (doc teórico) →
// F1-opt P3 movió el proceso a 400-clase (bottleneck Exynos) → umbrales
// VALIDADOS empíricamente a 400 en F2 (disparo correcto en SM-A566E + iPhone,
// F2-c). Recalibración formal solo si se observan desvíos en capturas reales.
//
// Las constantes son valores iniciales de referencia a calibrar con capturas
// reales (el plan lo declara); viven aquí exportadas, nunca inline. Cada una
// cita su origen. Los agentes NO las recalculan (AGENTS.md).

import type { Quadrilateral, QualityScore } from './types';

// --- Constantes DADAS (NO recalcular; comentario de origen) ---

/** v3 §5-F2: ponderación del score compuesto. */
export const WEIGHTS = { sharpness: 0.4, exposure: 0.3, stability: 0.3 } as const;

/** Saturación de Var(Laplacian) medida sobre el crop a 400-clase (doc teórico). */
export const SHARPNESS_NORM = 300;

/** isBlur si la varianza cruda < 100 (v3 §5-F2). OJO: compara la VARIANZA
 *  cruda, no el score normalizado (ver computeTotalScore). */
export const BLUR_THRESHOLD = 100.0;

/** Píxel con valor < 30 cuenta como subexpuesto (doc teórico). */
export const UNDER_EXPOSED_PX = 30;

/** Píxel con valor > 225 cuenta como sobreexpuesto (doc teórico). */
export const OVER_EXPOSED_PX = 225;

/** Píxel con valor > 248 = especular, info IRRECUPERABLE por CLAHE (v3 §5-F2). */
export const SPECULAR_PX = 248;

/** >3% de píxeles especulares → warning "evita el reflejo" (v3 §5-F2). */
export const SPECULAR_RATIO_WARN = 0.03;

/** Varianza de posiciones de quads (px²) normalizada a 400-clase (doc teórico). */
export const STABILITY_VAR_NORM = 20.0;

/** Ventana TEMPORAL de estabilidad en ms (APROBADA por humano 2026-09-22 F2-b:
 *  600ms — caso acta densa a 2.9 FPS: muestras cada ~345ms nunca caen en 300ms
 *  → inanición → estabilidad estructural 0 → score techo ~0.65 → auto jamás
 *  dispara. Cero costo de precisión; costo: +300ms de hold nominal). */
export const STABILITY_WINDOW_MS = 600;

/** Trigger de disparo: score compuesto por encima de 0.8 (v3 §5-F2). */
export const SHUTTER_SCORE = 0.8;

/** El score debe superar SHUTTER_SCORE de forma sostenida 600ms (APROBADA por
 *  humano 2026-09-22 F2-b: inanición de ventanas en acta densa — 345ms entre
 *  muestras → 300ms nunca contiene 2).
 *  @deprecated sustituido por k-de-n F2-c (SHUTTER_K/N/SPAN); se conserva porque
 *  el benchmark/tests históricos lo referencian. */
export const SHUTTER_HOLD_MS = 600;

/** F2-c (APROBADA por humano 2026-09-22): criterio k-de-n. K buenas requeridas
 *  de las últimas N muestras dentro de SPAN — tolera caídas puntuales del
 *  autofocus (evidencia: video F2-b, score 92-95 sostenido 9s sin disparar). */
export const SHUTTER_K = 4;
export const SHUTTER_N = 6;
export const SHUTTER_SPAN_MS = 1200;

/** Sin detección >8s → escape a captura manual (v3 §5-F2). */
export const NO_DETECT_TIMEOUT_MS = 8000;

/** Margen de excentricidad: fracción del lado corto del frame.
 *  APROBADA por humano 2026-09-21 (T3-b): score por esquina =
 *  clamp(dMin/margin, 0, 1) con margin = 0.05·min(frameW, frameH);
 *  score final = mín de las 4 (la peor domina). */
export const ECCENTRICITY_MARGIN = 0.05;

/** Entrada del historial de estabilidad: timestamp + quad medido. */
export interface QuadSample {
  t: number;
  quad: Quadrilateral;
}

/** Entrada del historial de disparo: timestamp + score compuesto. */
export interface ScoreSample {
  t: number;
  score: number;
}

/** Resultado de la métrica de exposición. */
export interface ExposureResult {
  score: number;
  specularRatio: number;
  specularWarn: boolean;
}

/** Componentes del score total. `eccentricity` null/undefined = sin
 *  penalización (×1); numérica = penalización multiplicativa (T3-b aprobada). */
export interface ScoreParts {
  sharpness: number;
  exposure: number;
  stability: number;
  eccentricity?: number | null;
}

/** Nitidez 0–1: saturación lineal de Var(Laplacian) del crop a 400-clase. */
export function computeSharpnessScore(laplacianVar: number): number {
  if (!Number.isFinite(laplacianVar) || laplacianVar <= 0) return 0;
  return Math.min(1, laplacianVar / SHARPNESS_NORM);
}

/** Exposición 0–1 desde el histograma de 256 bins del crop a 400-clase.
 *  under = píxeles con valor < UNDER_EXPOSED_PX; over = valor > OVER_EXPOSED_PX.
 *  score = 1 − (under + over). specularRatio = fracción > SPECULAR_PX. */
export function computeExposureScore(hist: number[]): ExposureResult {
  let total = 0;
  let under = 0;
  let over = 0;
  let specular = 0;
  const n = Math.min(hist.length, 256);
  for (let i = 0; i < n; i++) {
    const c = hist[i] ?? 0;
    if (!(c > 0)) continue;
    total += c;
    if (i < UNDER_EXPOSED_PX) under += c;
    else if (i > OVER_EXPOSED_PX) over += c;
    if (i > SPECULAR_PX) specular += c;
  }
  if (total <= 0) return { score: 0, specularRatio: 0, specularWarn: false };
  const specularRatio = specular / total;
  const score = Math.min(1, Math.max(0, 1 - (under + over) / total));
  return { score, specularRatio, specularWarn: specularRatio > SPECULAR_RATIO_WARN };
}

/** Estabilidad 0–1: 1 − clamp(meanVar / STABILITY_VAR_NORM).
 *  Solo entran muestras con `nowMs − t` dentro de STABILITY_WINDOW_MS (por
 *  TIMESTAMP: el backpressure descarta frames, el índice miente). <2 muestras
 *  en ventana → 0. meanVar = media de las varianzas poblacionales de las 8
 *  coordenadas (x,y × 4 esquinas) en px² a 400-clase. */
export function computeStabilityScore(history: QuadSample[], nowMs: number): number {
  const inWindow = history.filter((s) => nowMs - s.t >= 0 && nowMs - s.t <= STABILITY_WINDOW_MS);
  if (inWindow.length < 2) return 0;
  const n = inWindow.length;
  // Media por coordenada.
  const means = new Array<number>(8).fill(0);
  for (const s of inWindow) {
    for (let i = 0; i < 4; i++) {
      means[2 * i]! += s.quad[i]!.x / n;
      means[2 * i + 1]! += s.quad[i]!.y / n;
    }
  }
  // Varianza poblacional media de las 8 coordenadas.
  let acc = 0;
  for (const s of inWindow) {
    for (let i = 0; i < 4; i++) {
      const dx = s.quad[i]!.x - means[2 * i]!;
      const dy = s.quad[i]!.y - means[2 * i + 1]!;
      acc += (dx * dx + dy * dy) / n;
    }
  }
  const meanVar = acc / 8;
  return Math.min(1, Math.max(0, 1 - meanVar / STABILITY_VAR_NORM));
}

/** Excentricidad 0–1 (APROBADA por humano 2026-09-21, T3-b).
 *  margin = ECCENTRICITY_MARGIN · min(frameW, frameH); por esquina
 *  dMin = min(x, frameW−x, y, frameH−y); score = clamp(dMin/margin, 0, 1).
 *  Retorno = MÍN de las 4 (la peor esquina domina). Coordenadas fuera del
 *  frame → dMin negativa → 0. Frame inválido (lado ≤ 0) → 0. */
export function computeEccentricityScore(
  quad: Quadrilateral,
  frameW: number,
  frameH: number,
): number {
  const shortSide = Math.min(frameW, frameH);
  if (!Number.isFinite(shortSide) || shortSide <= 0) return 0;
  const margin = ECCENTRICITY_MARGIN * shortSide;
  let worst = 1;
  for (let i = 0; i < 4; i++) {
    const c = quad[i]!;
    const dMin = Math.min(c.x, frameW - c.x, c.y, frameH - c.y);
    const s = Math.min(1, Math.max(0, dMin / margin));
    if (s < worst) worst = s;
  }
  return worst;
}

/** Score compuesto (QualityScore de types.ts).
 *  @param parts componentes 0–1; `eccentricity` null/undefined = neutro (×1).
 *  @param sharpnessVar VARIANZA cruda del Laplaciano (isBlur compara contra
 *    BLUR_THRESHOLD con la varianza, NO con el score — pasarla aparte).
 *  @param specularRatio fracción especular de computeExposureScore (viaja por
 *    separado hasta la integración F2; por defecto 0).
 *
 *  Renormalización: base = Σ(wᵢ·vᵢ) / Σ(w presentes). Hoy solo existen 3
 *  pesos (Σ = 1.0) así que la base equivale a 0.4·s + 0.3·e + 0.3·st exactos
 *  (adjudicación humana 2026-09-21: la fórmula genérica rige sobre el
 *  "(0.4/0.7…)" ambiguo del brief T3, que sumaría >1).
 *  Integración de excentricidad (APROBADA humano 2026-09-21, T3-b):
 *  PENALIZACIÓN MULTIPLICATIVA total = base × (eccentricity ?? 1) — el plan
 *  la llama "penalización", no dimensión ponderada, así la fórmula §5-F2
 *  congelada queda intacta y el auto-shutter la hereda vía total.
 *  `eccentricity`/`specular` del QualityScore se rellenan con el valor medido
 *  (excentricidad: 1 neutro si null/undefined). */
export function computeTotalScore(
  parts: ScoreParts,
  sharpnessVar: number,
  specularRatio = 0,
): QualityScore {
  const entries: Array<[value: number, weight: number]> = [
    [parts.sharpness, WEIGHTS.sharpness],
    [parts.exposure, WEIGHTS.exposure],
    [parts.stability, WEIGHTS.stability],
  ];
  let ecc = 1;
  if (parts.eccentricity !== undefined && parts.eccentricity !== null) {
    ecc = parts.eccentricity;
  }
  const wSum = entries.reduce((acc, [, w]) => acc + w, 0);
  const base = entries.reduce((acc, [v, w]) => acc + v * w, 0) / wSum;
  const total = base * ecc;
  return {
    sharpness: parts.sharpness,
    exposure: parts.exposure,
    stability: parts.stability,
    eccentricity: ecc,
    specular: specularRatio,
    total: Math.min(1, Math.max(0, total)),
    isBlur: sharpnessVar < BLUR_THRESHOLD,
  };
}

/** Disparo k-de-n (APROBADA por humano 2026-09-22 F2-c): true si entre las
 *  últimas N muestras dentro de SPAN hay al menos K con score > SHUTTER_SCORE
 *  Y la última muestra es buena. Tolera hasta N-K caídas puntuales del
 *  autofocus/exposición. Reemplaza la racha continua (F2-b). */
export function shouldTriggerShutter(history: ScoreSample[]): boolean {
  if (history.length < SHUTTER_K) return false;
  const sorted = [...history].sort((a, b) => a.t - b.t);
  const now = sorted[sorted.length - 1]!.t;
  const last = sorted[sorted.length - 1]!;
  if (last.score <= SHUTTER_SCORE) return false;
  const inSpan = sorted.filter((s) => s.t >= now - SHUTTER_SPAN_MS);
  const lastN = inSpan.slice(-SHUTTER_N);
  let good = 0;
  for (const s of lastN) if (s.score > SHUTTER_SCORE) good++;
  return good >= SHUTTER_K;
}

/** Escape a manual: true si pasó más de NO_DETECT_TIMEOUT_MS desde el primer
 *  intento de detección. */
export function detectionTimedOut(firstAttemptMs: number, nowMs: number): boolean {
  return nowMs - firstAttemptMs > NO_DETECT_TIMEOUT_MS;
}
