// src/workers/enhanceJs.ts — enhance de la cola multipágina (§5-F5) en JS PURO
// dentro del worker (sin cv.Mat). DESVIACIÓN DOCUMENTADA D-F5: opencv.js
// 4.5.5 (URL pineada en protocol.ts) NO expone createCLAHE ni COLOR_RGBA2Lab.
// El resto de morfología sí existe, pero no se usa para mantener una sola ruta
// determinista testeable en Node. LAB vía fórmulas estándar sRGB↔CIELAB (CIE 1976,
// D65), CLAHE 2.0 8×8 por tiles con clip (parámetros por defecto de OpenCV),
// remoción de sombras por división morfológica sobre versión reducida
// (ILLUM_MAP_LONG_SIDE=800, core/imageModes.ts) y [RONDA 4 D1] flat-field
// OPT-IN (normalización a blanco, misma maquinaria). Umbral local del modo
// 'bw' (Bradley-Roth/Sauvola/despeckle): primitivas puras en core/imageModes.
// Todo sobre Uint8ClampedArray: Node-testeable con los mocks de dims del
// pipeline.
//
// El budget de applyMode (warped 2040×2640 < 2s desktop) se cumple por diseño:
// L desde LUT sRGB→linear (una tabla de 256), CLAHE con LUTs por tile y
// morfología separable con deque O(px) sobre el mapa
// REDUCIDO (≤800×600) — nunca full-res.

import {
  BW_DESPECKLE_PX,
  BW_SAUVOLA_K,
  BW_SAUVOLA_R,
  BW_T,
  BW_WINDOW_RATIO,
  FF_FLOOR_DEFAULT,
  ILLUM_MAP_LONG_SIDE,
  TEXT_CLARO_BLACK_POINT,
  TEXT_CLARO_WHITE_PCT,
  bradleyRoth,
  despeckleBinary,
  sauvola,
  textClaroContrast,
  whitePointStretch,
  whitePointStretchPct,
} from '../core/imageModes';
import type { EnhanceMode } from '../core/types';

// --- Constantes del enhance (derivadas del spec §F5; comentario de origen) ---

/** Estructurante de la morfología del mapa de iluminación, DERIVADO de
 *  ILLUM_MAP_LONG_SIDE (no es constante nueva: §F5 "división morfológica sobre
 *  versión reducida" no fija tamaño; 1/32 del lado reducido ≈ 25px sobre un
 *  mapa de 800 — captura la iluminación (baja frecuencia) sin tocar el texto). */
const ILLUM_KERNEL =
  Math.max(3, Math.floor(ILLUM_MAP_LONG_SIDE / 32)) % 2 === 0
    ? Math.max(3, Math.floor(ILLUM_MAP_LONG_SIDE / 32)) - 1
    : Math.max(3, Math.floor(ILLUM_MAP_LONG_SIDE / 32));

// ---------------------------------------------------------------------------
// Conversiones de color
// ---------------------------------------------------------------------------

/** Luma Rec.601 (mismo peso que cv.COLOR_RGBA2GRAY: 0.299R+0.587G+0.114B,
 *  enteros 77/150/29 >> 8). Entrada RGBA, salida gris U8. */
export function rgbaToGray(data: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const n = w * h;
  if (!(n > 0) || data.length < n * 4) return new Uint8ClampedArray(0);
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (data[o]! * 77 + data[o + 1]! * 150 + data[o + 2]! * 29) >> 8;
  }
  return out;
}

/** Gris U8 → RGBA (canales replicados, alpha 255). */
export function grayToRgba(gray: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const n = w * h;
  if (!(n > 0) || gray.length < n) return new Uint8ClampedArray(0);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const v = gray[i]!;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

/** LUT sRGB (8 bits) → lineal (0..1), transferencia IEC 61966-2-1. */
const SRGB_LIN = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

/** Luminancia CIELAB (componente L*, CIE 1976, iluminante D65, Yn=1) desde un
 *  píxel sRGB 8-bit. Impacto: L en el mismo espacio que usa el plan ("CLAHE
 *  canal L (LAB)") — no es un simple luma. PURO, testeable. */
function cieLightnessFromLinear(y: number): number {
  const eps = 216 / 24389;
  const f = y > eps ? Math.cbrt(y) : y * (841 / 108) + 4 / 29;
  return 116 * f - 16;
}

export function labLightness(r: number, g: number, b: number): number {
  const y = 0.2126 * SRGB_LIN[r]! + 0.7152 * SRGB_LIN[g]! + 0.0722 * SRGB_LIN[b]!;
  return cieLightnessFromLinear(y);
}

const LAB_L8 = (() => {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(cieLightnessFromLinear(i / 255));
  return lut;
})();

export function labL8(r: number, g: number, b: number): number {
  const y = 0.2126 * SRGB_LIN[r]! + 0.7152 * SRGB_LIN[g]! + 0.0722 * SRGB_LIN[b]!;
  return LAB_L8[Math.round(y * 255)]!;
}

/** Canal L (0..100) de todos los píxeles RGBA. Costo O(px) con LUT. */
export function labLOfRgba(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = labLightness(data[o]!, data[o + 1]!, data[o + 2]!);
  }
  return out;
}

/** Aplica una ganancia por píxel (Float32Array) al RGBA (croma preservado;
 *  alpha intacto). clamp a [0,255]. */
export function applyGainToRgba(
  data: Uint8ClampedArray,
  gain: Float32Array,
  w: number,
  h: number,
): Uint8ClampedArray {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const g = gain[i]!;
    const o = i * 4;
    out[o] = data[o]! * g > 255 ? 255 : data[o]! * g;
    out[o + 1] = data[o + 1]! * g > 255 ? 255 : data[o + 1]! * g;
    out[o + 2] = data[o + 2]! * g > 255 ? 255 : data[o + 2]! * g;
    out[o + 3] = data[o + 3]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remoción de sombras (división morfológica sobre versión reducida, §F5)
// ---------------------------------------------------------------------------

/** Muestreo por celda al mapa reducido. La iluminación es de baja frecuencia;
 *  tomar el centro de cada celda evita recorrer los 5M píxeles full-res. */
function sampleDownscale(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  mw: number,
  mh: number,
): Float64Array {
  const map = new Float64Array(mw * mh);
  for (let my = 0; my < mh; my++) {
    const y = Math.min(h - 1, Math.floor(((my + 0.5) * h) / mh));
    for (let mx = 0; mx < mw; mx++) {
      const x = Math.min(w - 1, Math.floor(((mx + 0.5) * w) / mw));
      map[my * mw + mx] = gray[y * w + x]!;
    }
  }
  return map;
}

/** Filtro deslizante de min/max separable sobre una fila/columna.
 *  Costo O(n). IMPORTANTE (fix F5-a): la morfología es CENTRADA — la ventana
 *  de la función clásica de deque es causal [i-k+1, i]; el resultado centrado
 *  sobre [i-h, i+h] (h=(k-1)/2) se obtiene evaluando el causal en i+h (equiv.
 *  exacto para k impar en el interior). Borde izquierdo: la entrada del deque
 *  trunca la ventana [0, i+h] igual que OpenCV. Borde derecho: clamp a n-1
 *  (efecto menor en 12px del mapa de iluminación — baja frecuencia, aceptado). */
function slidingMinMax1D(src: Float64Array, n: number, k: number, isMax: boolean): Float64Array {
  const causal = new Float64Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0; // [head, tail)
  const better = (a: number, b: number): boolean => (isMax ? a >= b : a <= b);
  for (let i = 0; i < n; i++) {
    while (tail > head && better(src[i]!, src[dq[tail - 1]!]!)) tail--;
    dq[tail] = i;
    tail++;
    while (dq[head]! <= i - k) head++;
    causal[i] = src[dq[head]!]!;
  }
  const half = (k - 1) >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const e = Math.min(n - 1, i + half);
    out[i] = causal[e]!;
  }
  return out;
}

/** Cierre morfológico (dilatación+erosión) separable sobre el mapa reducido
 *  (estructurante cuadrado k×k). Mín/máx con ventana deslizante O(px). */
function morphClose(map: Float64Array, mw: number, mh: number, k: number): Float64Array {
  const hmax = new Float64Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const row = slidingMinMax1D(map.subarray(y * mw, (y + 1) * mw), mw, k, true);
    hmax.set(row, y * mw);
  }
  const dil = new Float64Array(mw * mh);
  for (let x = 0; x < mw; x++) {
    const col = new Float64Array(mh);
    for (let y = 0; y < mh; y++) col[y] = hmax[y * mw + x]!;
    const r = slidingMinMax1D(col, mh, k, true);
    for (let y = 0; y < mh; y++) dil[y * mw + x] = r[y]!;
  }
  const hmin = new Float64Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const row = slidingMinMax1D(dil.subarray(y * mw, (y + 1) * mw), mw, k, false);
    hmin.set(row, y * mw);
  }
  const ero = new Float64Array(mw * mh);
  for (let x = 0; x < mw; x++) {
    const col = new Float64Array(mh);
    for (let y = 0; y < mh; y++) col[y] = hmin[y * mw + x]!;
    const r = slidingMinMax1D(col, mh, k, false);
    for (let y = 0; y < mh; y++) ero[y * mw + x] = r[y]!;
  }
  return ero;
}

/** Re-escala el mapa reducido a full-res por celdas. El mapa es de muy baja
 *  frecuencia y su celda cubre ~2-3px a 2040×2640; nearest evita interpolar
 *  cuatroesquinas por píxel y mantiene el shadow-removal por debajo del budget. */
function nearestUpsample(
  map: Float64Array,
  mw: number,
  mh: number,
  w: number,
  h: number,
): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const my = Math.min(mh - 1, Math.floor((y * mh) / h));
    const row = my * mw;
    for (let x = 0; x < w; x++) {
      const mx = Math.min(mw - 1, Math.floor((x * mw) / w));
      out[y * w + x] = map[row + mx]!;
    }
  }
  return out;
}

function estimateIlluminationMap(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
): { map: Float64Array; mw: number; mh: number } {
  const scale = Math.min(1, ILLUM_MAP_LONG_SIDE / Math.max(w, h));
  const mw = Math.max(1, Math.round(w * scale));
  const mh = Math.max(1, Math.round(h * scale));
  const reduced = sampleDownscale(gray, w, h, mw, mh);
  const map = mw * mh <= 1 ? reduced : morphClose(reduced, mw, mh, ILLUM_KERNEL);
  return { map, mw, mh };
}

interface ShadowModel {
  gains: Float32Array;
  xMap: Uint16Array;
  yMap: Uint16Array;
  mw: number;
}

function estimateShadowModel(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
): ShadowModel {
  const { map, mw, mh } = estimateIlluminationMap(gray, w, h);
  let acc = 0;
  for (let i = 0; i < map.length; i++) acc += map[i]!;
  const mean = map.length > 0 ? acc / map.length : 255;
  const gains = new Float32Array(map.length);
  for (let i = 0; i < map.length; i++) {
    gains[i] = map[i]! > 0 ? mean / map[i]! : 1;
  }
  const xMap = new Uint16Array(w);
  const yMap = new Uint16Array(h);
  for (let x = 0; x < w; x++) xMap[x] = Math.min(mw - 1, Math.floor((x * mw) / w));
  for (let y = 0; y < h; y++) yMap[y] = Math.min(mh - 1, Math.floor((y * mh) / h));
  return { gains, xMap, yMap, mw };
}

/** [RONDA 4 D1] Modelo flat-field: REUSA estimateIlluminationMap (downscale
 *  ≤ILLUM_MAP_LONG_SIDE + closing morfológico — la MISMA maquinaria §F5 de
 *  baja frecuencia) pero con ganancias de NORMALIZACIÓN A BLANCO:
 *  gains[i] = 255 / max(map[i], floor) — la división norm = luma/B·255 del
 *  §R4-D1 (el fondo queda blanco uniforme CUALQUIERA que sea el patrón de
 *  luz: hotspot, sombra lateral, viñeteo). El floor (FF_FLOOR_DEFAULT)
 *  mitiga el ruido amplificado en sombras profundas (B pequeño → división
 *  ruidosa — riesgo D3). Mismo formato {gains, xMap, yMap, mw} que
 *  estimateShadowModel → correctedGrayWithModel/labL8WithModel/
 *  applyModelAndGainToRgba funcionan sin cambios. La diferencia con §F5:
 *  el modelo de sombras normaliza a la MEDIA del mapa (ganancia ≈1 en
 *  promedio, look neutro); este fuerza el fondo a BLANCO puro (255).
 *  `flatField` es OPT-IN por variante de laboratorio (D2: bw-ff, text-ff,
 *  gray-ff, color-ff), NUNCA default de producción; el modo 'natural'
 *  NUNCA lo aplica (referencia visual — §5 Ronda 4 congelado). */
function flatFieldModel(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  floor: number = FF_FLOOR_DEFAULT,
): ShadowModel {
  const { map, mw, mh } = estimateIlluminationMap(gray, w, h);
  const f = floor > 1 ? floor : 1; // floor inválido → 1 (sin división por 0)
  const gains = new Float32Array(map.length);
  for (let i = 0; i < map.length; i++) {
    const b = map[i]! > f ? map[i]! : f;
    gains[i] = 255 / b;
  }
  const xMap = new Uint16Array(w);
  const yMap = new Uint16Array(h);
  for (let x = 0; x < w; x++) xMap[x] = Math.min(mw - 1, Math.floor((x * mw) / w));
  for (let y = 0; y < h; y++) yMap[y] = Math.min(mh - 1, Math.floor((y * mh) / h));
  return { gains, xMap, yMap, mw };
}

function correctedGrayWithModel(
  gray: Uint8ClampedArray,
  model: ShadowModel,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = model.yMap[y]! * model.mw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const mx = model.xMap[x]!;
      out[i] = gray[i]! * model.gains[row + mx]!;
    }
  }
  return out;
}

function labL8WithModel(
  data: Uint8ClampedArray,
  model: ShadowModel,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = model.yMap[y]! * model.mw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const mx = model.xMap[x]!;
      const gain = model.gains[row + mx]!;
      out[i] = labL8(
        Math.min(255, Math.round(data[o]! * gain)),
        Math.min(255, Math.round(data[o + 1]! * gain)),
        Math.min(255, Math.round(data[o + 2]! * gain)),
      );
    }
  }
  return out;
}

function applyModelAndGainToRgba(
  data: Uint8ClampedArray,
  model: ShadowModel,
  gain: Float32Array,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = model.yMap[y]! * model.mw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const mx = model.xMap[x]!;
      const factor = model.gains[row + mx]! * gain[i]!;
      out[o] = data[o]! * factor;
      out[o + 1] = data[o + 1]! * factor;
      out[o + 2] = data[o + 2]! * factor;
      out[o + 3] = data[o + 3]!;
    }
  }
  return out;
}

export function estimateIllumination(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
): Float32Array {
  if (!(w > 0) || !(h > 0) || gray.length < w * h) return new Float32Array(0);
  const { map, mw, mh } = estimateIlluminationMap(gray, w, h);
  return nearestUpsample(map, mw, mh, w, h);
}

export function shadowGain(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
): Float32Array {
  const n = w * h;
  const gain = new Float32Array(n);
  if (!(n > 0) || gray.length < n) return gain;
  const model = estimateShadowModel(gray, w, h);
  for (let y = 0; y < h; y++) {
    const row = model.yMap[y]! * model.mw;
    for (let x = 0; x < w; x++) {
      const mx = model.xMap[x]!;
      gain[y * w + x] = model.gains[row + mx]!;
    }
  }
  return gain;
}

/** Gris corregido de sombras (out = gray × shadowGain, clamp). */
export function correctedGray(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8ClampedArray {
  const n = w * h;
  const out = new Uint8ClampedArray(n);
  if (!(n > 0) || gray.length < n) return out;
  const gain = shadowGain(gray, w, h);
  for (let i = 0; i < n; i++) {
    const v = gray[i]! * gain[i]!;
    out[i] = v > 255 ? 255 : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLAHE (2.0, 8×8, con clip) — §F5
// ---------------------------------------------------------------------------

/** CLAHE sobre gris: 8×8 tiles, histograma 256 bins por tile con clip +
 *  redistribución uniforme y LUT por tile. D-F5-b: indexa la LUT de la celda
 *  sin interpolación bilineal entre las cuatro vecinas; la verificación final
 *  de rejilla/banding queda en el CER + revisión visual humana del harness. */
export function claheGray(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  clipLimit = 2.0,
  tiles = 8,
): Uint8ClampedArray {
  const n = w * h;
  if (!(n > 0) || gray.length < n) return new Uint8ClampedArray(0);
  const T = Math.max(1, tiles);
  const cellW = Math.ceil(w / T);
  const cellH = Math.ceil(h / T);

  // Histogramas por tile (256 bins).
  const hist: Uint32Array[] = [];
  for (let t = 0; t < T * T; t++) hist.push(new Uint32Array(256));
  for (let y = 0; y < h; y++) {
    const ty = Math.min(T - 1, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const tx = Math.min(T - 1, Math.floor(x / cellW));
      hist[ty * T + tx]![gray[y * w + x]!]! += 1;
    }
  }

  // Clip + redistribución (OpenCV: clip = clipLimit·tilePx/histSize; el exceso
  // se reparte uniformemente y el resto, en los primeros bins).
  const tilePx = cellW * cellH;
  const clip = Math.max(1, Math.floor((clipLimit * tilePx) / 256));
  const luts: Float32Array[] = [];
  for (let t = 0; t < T * T; t++) {
    const hh = hist[t]!;
    let excess = 0;
    for (let b = 0; b < 256; b++) {
      if (hh[b]! > clip) {
        excess += hh[b]! - clip;
        hh[b] = clip;
      }
    }
    const redist = Math.floor(excess / 256);
    let rem = excess % 256;
    for (let b = 0; b < 256; b++) {
      hh[b]! += redist + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
    }
    // CDF → LUT 0..255.
    const lut = new Float32Array(256);
    let acc = 0;
    const total = tilePx;
    for (let b = 0; b < 256; b++) {
      acc += hh[b]!;
      lut[b] = (acc / total) * 255;
    }
    luts.push(lut);
  }

  const out = new Uint8ClampedArray(n);
  let ty = 0;
  let nextY = cellH;
  for (let y = 0; y < h; y++) {
    if (y >= nextY && ty < T - 1) {
      ty++;
      nextY += cellH;
    }
    const row = ty * T;
    let tx = 0;
    let nextX = cellW;
    for (let x = 0; x < w; x++) {
      if (x >= nextX && tx < T - 1) {
        tx++;
        nextX += cellW;
      }
      out[y * w + x] = luts[row + tx]![gray[y * w + x]!]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orquestación por modo (§F5) — devuelve RGBA U8 listo para encode
// ---------------------------------------------------------------------------

/** Overrides puntuales del modo 'text' (D-F5-d 2026-09-26: diagnóstico de
 *  "pixeles grises en las letras" — permite afinar p85/contraste/pivote y el
 *  punto negro sin tocar las constantes congeladas). Todos opcionales;
 *  undefined = constante vigente (textBlackPoint default TEXT_CLARO_BLACK_POINT;
 *  0 explícito = desactivado). textBlackPoint: niveles con piso de tinta
 *  (v' = (v−bp)/(1−bp), clamp) — quema el grano dentro del trazo a negro puro
 *  dejando la rampa de antialias lineal por encima. */
export interface EnhanceOpts {
  textWhitePct?: number;
  textContrast?: number;
  textPivot?: number;
  textBlackPoint?: number;
  /** R2 (2026-09-27): percentil del whitening del modo gray (default p97,
   *  = whitePointStretch). Solo calibración vía harness (variante gray-p95);
   *  producción NO lo usa (el modo es GLOBAL y fijo). */
  grayWhitePct?: number;
  /** [RONDA 4 A1] Umbral local del modo 'bw' — fracción de la media local por
   *  DEBAJO de la cual el píxel es negro (Bradley-Roth: pixel negro si
   *  v ≤ mean·(1−T)). Default BW_T = 0.15. Variantes de harness: bw-t12/t20. */
  bwT?: number;
  /** [RONDA 4 A1] Ventana del umbral local como fracción del ANCHO
   *  (S = max(8, w·ratio)). Default BW_WINDOW_RATIO = 1/12. Variantes: bw-s8/s16. */
  bwWindowRatio?: number;
  /** [RONDA 4 A2b] Variante Sauvola del modo bw ('br' | 'sauvola').
   *  Default 'br' (validado por el humano). Harness: bw-sauvola. */
  bwMethod?: 'br' | 'sauvola';
  /** [RONDA 4 A2b] k de Sauvola (T = m·(1+k·(s/R−1))). Default 0.34. */
  bwSauvolaK?: number;
  /** [RONDA 4 A2] Despeckle del binario: componentes conexas de fondo con
   *  área < minPx se blanquean (granos <3px). Default BW_DESPECKLE_PX = 3. */
  bwDespecklePx?: number;
  /** [RONDA 4 D2] Normalización de iluminación flat-field OPT-IN por variante
   *  (NO cambia defaults de producción): estima el fondo B (baja frecuencia)
   *  y devuelve norm = clamp(luma·255/B) ANTES del modo. Combo máximo:
   *  bw-ff (flat-field + umbral local). El modo 'natural' NUNCA la aplica
   *  (referencia visual — §5 Ronda 4). */
  flatField?: boolean;
  /** [RONDA 4 D1] Floor del mapa de fondo B (mitigación de ruido amplificado
   *  en sombras profundas: B pequeño → división ruidosa). Default 40. */
  flatFieldFloor?: number;
}

/** Aplica el modo al warped RGBA (dims w×h). Salida SIEMPRE RGBA opaca:
 *  color/natural/text conservan el croma (ganancia aplicada a los 3 canales),
 *  gris y bw son luma/binario (bw puro 0/255). Sin cv.Mat (D-F5). Nunca lanza
 *  con dims inválidas: devuelve el arreglo vacío (el worker valida antes).
 *  [RONDA 4 D1] opts.flatField === true (y modo ≠ 'natural') cambia el modelo
 *  de sombras §F5 por flatFieldModel (normalización a BLANCO) ANTES del modo —
 *  OPT-IN de laboratorio, nunca default de producción. */
export function enhanceToRgba(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  mode: EnhanceMode,
  opts: EnhanceOpts = {},
): Uint8ClampedArray {
  const n = w * h;
  if (!(n > 0) || data.length < n * 4) return new Uint8ClampedArray(0);

  // [F5-RAW, 2026-10-01 — petición humana] "Original de cámara": passthrough
  // byte a byte, PRIMERO y sin tocar la maquinaria de sombras/CLAHE (ni
  // siquiera se calcula el modelo — cero costo). El único retoque permitido
  // es forzar alpha 255 (los warped del worker ya son opacos, pero un PNG
  // importado con alpha parcial rompería el encode JPEG del export — el
  // contrato del pipeline es RGBA opaco). opts.flatField/bw* se ignoran:
  // el modo es la REFERENCIA de fidelidad, no un filtro calibrable.
  if (mode === 'raw') {
    const out = data.slice(0, n * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
  }

  const gray = rgbaToGray(data, w, h);
  // [RONDA 4 D1] Flat-field OPT-IN por variante (D2): normaliza el fondo a
  // blanco ANTES del modo. 'natural' NUNCA lo aplica (referencia visual —
  // §5 Ronda 4: "modo natural sin flat-field").
  const shadow =
    opts.flatField === true && mode !== 'natural'
      ? flatFieldModel(gray, w, h, opts.flatFieldFloor ?? FF_FLOOR_DEFAULT)
      : estimateShadowModel(gray, w, h);

  if (mode === 'bw') {
    // [RONDA 4 A1] "B/N adaptativo" — Bradley-Roth VERBATIM del prototipo
    // (integral image O(N), cero dependencias): cada píxel se compara con la
    // media de su VECINDARIO → fondo 100% uniforme ante cualquier gradiente
    // de iluminación (§R4-1c), tinta nítida. A2b: variante Sauvola (misma
    // maquinaria + integral de cuadrados — mejor en texto tenue/speckle).
    // Con opts.flatField (D2, combo bw-ff) la corrección a blanco del §R4-D1
    // precede al umbral local: correctedGrayWithModel ya es luma/B·255.
    const grayS = correctedGrayWithModel(gray, shadow, w, h);
    const bin =
      opts.bwMethod === 'sauvola'
        ? sauvola(
            grayS,
            w,
            h,
            opts.bwSauvolaK ?? BW_SAUVOLA_K,
            BW_SAUVOLA_R,
            opts.bwWindowRatio ?? BW_WINDOW_RATIO,
          )
        : bradleyRoth(
            grayS,
            w,
            h,
            opts.bwT ?? BW_T,
            opts.bwWindowRatio ?? BW_WINDOW_RATIO,
          );
    // A2: despeckle por componentes conexas (granos <3px fuera del binario).
    // 0 EXPLÍCITO = desactivado (A/B del harness: opts.bwDespecklePx === 0).
    const clean =
      opts.bwDespecklePx !== 0
        ? despeckleBinary(bin, w, h, opts.bwDespecklePx ?? BW_DESPECKLE_PX)
        : bin;
    return grayToRgba(clean, w, h);
  }

  if (mode === 'gray') {
    // M3 (2026-09-27): el gris es "el modo natural sin color" — desaturar +
    // MISMO whitening que natural (whitePointStretch p97). El CLAHE previo
    // ecualizaba cada tile y oscurecía el papel a gris medio (mediana ~193
    // en el acta, E3) — ese era el bug, no una calibración.
    // R2: percentil parametrizable SOLO para la variante de harness gray-p95
    // (M3 cumple en fixture pero el acta real quedó en med 220 < 235).
    const grayS = correctedGrayWithModel(gray, shadow, w, h);
    return grayToRgba(whitePointStretchPct(grayS, opts.grayWhitePct ?? 0.97), w, h);
  }

  if (mode === 'text') {
    // Texto claro (D-F5-c, 2026-09-26 — petición humana, video Adobe Scan):
    // sombras fuera → fondo a blanco con percentil agresivo → S-curve que
    // oscurece la tinta SIN binarización dura (antialias conservado). El gain
    // ink/src aplica la curva también al croma (papel blanco, contenido
    // dominante en oscuro — el look del filtro).
    const grayS = correctedGrayWithModel(gray, shadow, w, h);
    const wp = whitePointStretchPct(grayS, opts.textWhitePct ?? TEXT_CLARO_WHITE_PCT);
    const ink = textClaroContrast(wp, opts.textContrast, opts.textPivot);
    const bp = opts.textBlackPoint ?? TEXT_CLARO_BLACK_POINT;
    const gainW = new Float32Array(n);
    if (bp > 0) {
      // Niveles con piso de tinta (D-F5-d): el trazo queda negro PURO (el grano
      // interno deja de verse gris) y el antialias conserva rampa lineal.
      const k = 1 / (1 - bp);
      for (let i = 0; i < n; i++) {
        const v = ink[i]! / 255;
        const lv = v <= bp ? 0 : (v - bp) * k;
        ink[i] = lv * 255;
      }
    }
    for (let i = 0; i < n; i++) {
      const src = grayS[i]!;
      gainW[i] = src > 0 ? ink[i]! / src : 1;
    }
    return applyModelAndGainToRgba(data, shadow, gainW, w, h);
  }

  if (mode === 'natural') {
    const grayS = correctedGrayWithModel(gray, shadow, w, h);
    const wp = whitePointStretch(grayS);
    const gainW = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const src = grayS[i]!;
      gainW[i] = src > 0 ? wp[i]! / src : 1;
    }
    return applyModelAndGainToRgba(data, shadow, gainW, w, h);
  }

  const L = labL8WithModel(data, shadow, w, h);
  const Lc = claheGray(L, w, h, 2.0, 8);
  const gainL = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = L[i]!;
    gainL[i] = src > 0 ? Lc[i]! / src : 1;
  }
  return applyModelAndGainToRgba(data, shadow, gainL, w, h);
}
