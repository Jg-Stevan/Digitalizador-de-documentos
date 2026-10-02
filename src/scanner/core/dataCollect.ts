// src/core/dataCollect.ts — registro de capturas para el dataset F6.5
// (orden F4, punto 3). PURO (Node-testeable): metadatos de la captura +
// quads en fracciones + serialización JSONL del manifest + presupuesto de
// cuota. La foto pedestal (downscale a 1600 → JPEG q85) y el almacenamiento
// IndexedDB viven en src/export/datasetStore.ts (DOM).
//
// Regla anti-sesgo (orden F4): se registra el quad AUTOMÁTICO de TODAS las
// capturas (autoQuad = quadRefined ?? quad) y, si el humano ajustó, el quad
// ajustado ADEMÁS (adjustedQuad) — nunca se sustituye el auto por el ajustado:
// el dataset de F6.5 debe poder ver la calidad de la detección sin editar
// incluso cuando el usuario la corrigió.

import type { Quadrilateral } from './types';

/** Lado mayor de la foto de entrenamiento del dataset (F6.5), en px.
 *  Origen: orden F4 punto 3 (aprobación humana 2026-09-24): "foto a 1600 lado
 *  largo JPEG q85". 1600 equilibra memoria/disco por foto (~100-200 kB JPEG)
 *  contra precisión de esquinas: el dataset real (F6.5) entrena sobre la foto
 *  + fracciones del quad, y 1600px conserva la geometría (≈108 DPI efectivos
 *  en carta — suficiente para etiquetas de esquinas). */
export const TRAINING_LONG_SIDE = 1600;

/** Objetivo de capturas del dataset F6.5 ("Dataset F6.5: X/300"). */
export const DATASET_TARGET = 300;

/** Fracción de cuota de almacenamiento que dispara el aviso (orden F4):
 *  "navigator.storage.estimate() aviso si >70% cuota". */
export const QUOTA_WARN_FRACTION = 0.7;

export type ConditionTag = 'normal' | 'poca-luz' | 'fondo-claro' | 'inclinado' | 'sombra';

export const CONDITION_TAGS: readonly ConditionTag[] = [
  'normal',
  'poca-luz',
  'fondo-claro',
  'inclinado',
  'sombra',
];

export interface DatasetDeviceInfo {
  platform: string;
  trackW: number;
  trackH: number;
}

/** Entrada serializable del dataset: un registro por captura. autoQuad en
 *  FRACCIONES 0–1 de la foto (mismo convenio que ResultReply.corners). */
export interface DatasetEntry {
  id: string;
  ts: number;
  route: 'A' | 'B' | 'burst';
  revalScore: number;
  /** Quad automático (quadRefined ?? quad) en fracciones; null si la captura
   *  no tuvo detección (se registra IGUAL por anti-sesgo, sin label). */
  autoQuad: Float32Array | null;
  /** Quad final del editor F4 en fracciones; ausente si el humano no editó. */
  adjustedQuad?: Float32Array;
  /** Lados caídos del refine (blindaje 3 F3-b); null si no hubo refine. */
  fellBack: [boolean, boolean, boolean, boolean] | null;
  device: DatasetDeviceInfo;
  condicion: ConditionTag;
}

/** Datos de la captura que el registro necesita (subset estructural de
 *  CapturedPhoto — core no importa scan/, el harness pasa la foto tal cual). */
export interface CaptureSource {
  quad: Quadrilateral | null;
  quadRefined: Quadrilateral | null;
  adjustedQuad?: Quadrilateral | null;
  frameW: number;
  frameH: number;
  revalScore: number;
  ts: number;
  route: 'A' | 'B' | 'burst';
}

/** Dims del pedestal de entrenamiento: escala el lado mayor del original a
 *  TRAINING_LONG_SIDE manteniendo el aspecto (sin ratios hardcodeados —
 *  todo llega por parámetros). Origen del valor: TRAINING_LONG_SIDE arriba. */
export function trainingDims(
  w: number,
  h: number,
  longSide: number = TRAINING_LONG_SIDE,
): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const s = longSide / Math.max(w, h);
  if (s >= 1) return { w, h }; // ya cabe: no se amplía
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Quad (px) → 8 fracciones 0–1 (Float32Array TL,TR,BR,BL), clampadas a la
 *  foto. Mismo contrato que quadToFractions del orquestador (core no importa
 *  scan/; la duplicación es deliberada y testeada). guard → null. */
export function quadToFractionArray(
  q: Quadrilateral,
  w: number,
  h: number,
): Float32Array | null {
  if (q === null || !(w > 0) || !(h > 0)) return null;
  const out = new Float32Array(8);
  for (let i = 0; i < 4; i++) {
    const x = q[i]!.x;
    const y = q[i]!.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out[2 * i] = Math.min(1, Math.max(0, x / w));
    out[2 * i + 1] = Math.min(1, Math.max(0, y / h));
  }
  return out;
}

/** autoQuad = quadRefined si el worker refinó; si no, la detección (quad). */
export function autoQuadFractions(
  src: Pick<CaptureSource, 'quad' | 'quadRefined' | 'frameW' | 'frameH'>,
): Float32Array | null {
  const raw = src.quadRefined ?? src.quad;
  if (raw === null) return null;
  return quadToFractionArray(raw, src.frameW, src.frameH);
}

/** Construye el registro de una captura (puro). `id` lo elige el caller
 *  (el store usa un UUID); el resto se deriva de la foto. */
export function entryFromCapture(
  src: CaptureSource,
  device: DatasetDeviceInfo,
  condicion: ConditionTag,
  id: string,
  fellBack: [boolean, boolean, boolean, boolean] | null = null,
): DatasetEntry {
  const autoQuad = autoQuadFractions(src);
  const adjusted = src.adjustedQuad
    ? quadToFractionArray(src.adjustedQuad, src.frameW, src.frameH)
    : undefined;
  return {
    id,
    ts: src.ts,
    route: src.route,
    revalScore: src.revalScore,
    autoQuad,
    ...(adjusted !== undefined && adjusted !== null ? { adjustedQuad: adjusted } : {}),
    fellBack,
    device,
    condicion,
  };
}

/** JSON seguro del registro: Float32Array → number[] (JSON.stringify de un
 *  TypedArray produciría {“0”:…} — el manifest JSONL debe ser arrays planos). */
export function entryToJson(entry: DatasetEntry): Record<string, unknown> {
  return {
    id: entry.id,
    ts: entry.ts,
    route: entry.route,
    revalScore: entry.revalScore,
    autoQuad: entry.autoQuad !== null ? Array.from(entry.autoQuad) : null,
    ...(entry.adjustedQuad !== undefined ? { adjustedQuad: Array.from(entry.adjustedQuad) } : {}),
    fellBack: entry.fellBack,
    device: entry.device,
    condicion: entry.condicion,
  };
}

/** Manifest JSONL: una línea JSON por registro (orden de inserción). */
export function toJsonl(entries: DatasetEntry[]): string {
  return entries.map((e) => JSON.stringify(entryToJson(e))).join('\n') + '\n';
}

export interface QuotaReport {
  /** Fracción usada 0–1; null si storage.estimate() no está disponible. */
  pct: number | null;
  /** true si pct > QUOTA_WARN_FRACTION (aviso del harness). */
  warn: boolean;
}

/** Presupuesto de cuota: aviso >70% (orden F4). Null-safe (navigator.storage
 *  puede no existir o devolver quota ilimitada). */
export function quotaReport(usage: number | null, quota: number | null): QuotaReport {
  if (!(usage !== null && usage > 0) || !(quota !== null && quota > 0)) {
    return { pct: null, warn: false };
  }
  const pct = usage / quota;
  return { pct, warn: pct > QUOTA_WARN_FRACTION };
}