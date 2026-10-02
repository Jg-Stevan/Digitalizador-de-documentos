// src/core/imageModes.ts — modos de procesamiento de la cola multipágina (§5-F5).
// PURO (Node-testeable, sin DOM ni OpenCV): punto blanco paramétrico, curva de
// contraste del modo "Texto claro", umbral LOCAL del modo 'bw' (RONDA 4 §R4-A:
// Bradley-Roth + variante Sauvola + despeckle, sobre integral images) y mime
// por modo. El resto del enhance (LAB/CLAHE/remoción de sombras/flat-field)
// vive en src/workers/enhanceJs.ts (JS puro dentro del worker — ver
// desviación D-F5 en la documentación del pipeline; opencv.js 4.5.5 no
// expone createCLAHE ni COLOR_*Lab, decisión del explorador).
//
// Origen de los valores: PLAN_MAESTRO §F5 (tabla de modos) para los 4 modos
// originales; D-F5-c (2026-09-26, petición humana con video de referencia de
// Adobe Scan) para el modo 'text'; PLAN-RONDA4 §R4-A/§R4-D (2026-09-28) para
// el modo 'bw' (umbral local Bradley-Roth + variante Sauvola + despeckle) y
// el floor del flat-field. NO recalcular los del plan.

import type { EnhanceMode } from './types';

// --- Constantes D-F5-c: modo "Texto claro" (petición humana 2026-09-26) ---

/** Percentil del histograma que mapea a blanco puro en el modo 'text'
 *  (D-F5-c). Mucho más agresivo que el p97 de natural: en el filtro Texto
 *  claro de Adobe Scan TODO el papel (arrugas, sombras suaves, grano) se
 *  vuelve blanco y solo la tinta sobrevive oscura. 0.85 (D-F5-d 2026-09-26:
 *  antes 0.80 — el diagnóstico de "pixeles grises en las letras" sobre el acta
 *  E-14 pidió blanco más agresivo). Valor INICIAL de ingeniería — validar con
 *  el CER Tesseract por modo + revisión visual humana antes de congelar (misma
 *  disciplina que §F5). */
export const TEXT_CLARO_WHITE_PCT = 0.85;

/** Ganancia de la curva de contraste de medios del modo 'text' (D-F5-c).
 *  Aplicada como S-curve alrededor de TEXT_CLARO_PIVOT: los grises por debajo
 *  del pivote se oscurecen (tinta más marcada) y los de arriba se van a blanco.
 *  1.8 (D-F5-d: antes 1.35 — el diagnóstico de grises en trazos midió 33.7%→16.8%
 *  de píxeles grises en zona de texto al pasar de 1.35 a 1.8 con bp 0.2).
 *  Validar con CER + revisión visual (idem TEXT_CLARO_WHITE_PCT). */
export const TEXT_CLARO_CONTRAST = 1.8;

/** Punto fijo de la S-curve del modo 'text' (D-F5-c): el valor que NO se
 *  modifica por el contraste. 0.72 alto a propósito — el pivote cerca del
 *  papel hace que casi todo lo que no es fondo se oscurezca (es lo que
 *  caracteriza al filtro: papel blanco, tinta dominante). */
export const TEXT_CLARO_PIVOT = 0.72;

/** Punto negro del modo 'text' (D-F5-d 2026-09-26, NUEVO): niveles con piso
 *  de tinta v' = (v−bp)/(1−bp) tras la S-curve. Es la palanca principal contra
 *  los "pixeles grises en las letras": el grano dentro del trazo quema a negro
 *  puro y el antialias conserva su rampa lineal por encima. Diagnóstico sobre
 *  acta E-14 (lote 2): banda gris 33.7%→16.8% (números) y 47.1%→29.8%
 *  (cabecera con banda negra/QR — textura genuina). 0.2 no muerde papel
 *  (papel ≥ 0.72 por el pivote) ni fragmenta trazos (+8% de tinta). Validar
 *  con CER + revisión visual. */
export const TEXT_CLARO_BLACK_POINT = 0.2;

/** Calidad JPEG del encode de los modos color/gris/natural/text (§F5: q88-92 →
 *  0.90; hiResCapture ya usa 92 — este 0.90 es el medio del rango del plan). */
export const JPEG_QUALITY = 0.9;

/** Lado mayor de la versión reducida del mapa de iluminación de la remoción
 *  de sombras (§F5 color/gris/natural/text: "división morfológica sobre
 *  versión reducida"). 800px = mapa de iluminación (baja frecuencia) sin pagar
 *  costo full-res; la morfología JS sobre 800×~600 es trivial (<10ms desktop). */
export const ILLUM_MAP_LONG_SIDE = 800;

// --- Constantes [RONDA 4, 2026-09-28]: modo 'bw' "B/N adaptativo" (§R4-A) ---

/** [R4-A1] Ventana del umbral local como FRACCIÓN DEL ANCHO (S = lado de la
 *  ventana cuadrada = max(8, round(w·ratio)) forzada a impar). Origen:
 *  "ventana S=w/12" del prototipo pre-repo (el Bradley-Roth verbatim que el
 *  humano validó visualmente — §R4-1c/§R4-1a). A 2040px de ancho → S=171:
 *  capta la iluminación (baja frecuencia) sin comerse los trazos. Variantes
 *  de harness: bw-s8 (1/8) / bw-s16 (1/16). */
export const BW_WINDOW_RATIO = 1 / 12;

/** [R4-A1] T de Bradley-Roth: píxel NEGRO si v ≤ m·(1−T), con m = media LOCAL
 *  de la ventana (0.15 = "píxel negro si ≤85% de la media local" del
 *  prototipo, §R4-1a). Inmune al patrón de iluminación por construcción —
 *  el corazón de R4-A. Variantes de harness: bw-t12/t20 (§R4-A2, halos). */
export const BW_T = 0.15;

/** [R4-A2b] k de Sauvola (T = m·(1+k·(s/R−1))). Origen: Sauvola &
 *  Pietikäinen 2000, rango típico de la literatura 0.2–0.5 → 0.34 (mismo
 *  valor que el SAUVOLA_K histórico F5 — misma fórmula, §R4-1d). En fondos
 *  lisos (s≈0) el umbral cae POR DEBAJO de la media → mata el speckle. */
export const BW_SAUVOLA_K = 0.34;

/** [R4-A2b] Rango dinámico R de Sauvola para 8 bits (128 — estándar de la
 *  fórmula clásica; el fondo tipográfico esperado es ≈128). */
export const BW_SAUVOLA_R = 128;

/** [R4-A2] Despeckle del binario: componentes conexas de TINTA con área <
 *  minPx se blanquean ("granos <3px fuera" del §R4-A2). 0 explícito vía
 *  opts.bwDespecklePx = desactivado (A/B del harness). */
export const BW_DESPECKLE_PX = 3;

/** [R4-D1] Floor del mapa de fondo B del flat-field (opts.flatFieldFloor):
 *  la ganancia de normalización a blanco es 255/max(B, floor). Mitiga el
 *  ruido amplificado en sombras profundas (B pequeño → división ruidosa,
 *  riesgo D3). */
export const FF_FLOOR_DEFAULT = 40;

// ---------------------------------------------------------------------------
// Umbral local (RONDA 4 §R4-A) — primitivas PURAS sobre Uint8ClampedArray
// (misma disciplina que whitePointStretchPct: sin DOM, testeables en Node,
// NO mutan la entrada). Maquinaria: integral images O(N) por Shafait et al.
// 2008 (§R4-1d) — la MISMA integral sirve a Bradley-Roth y a Sauvola (este
// añade solo la integral de los cuadrados). Cero dependencias.
// ---------------------------------------------------------------------------

/** [R4-A1] Integral image (suma acumulada) de una imagen gris: Float64Array
 *  (w+1)×(h+1) con fila 0 y columna 0 en cero (padding para ventanas
 *  clamped a bordes: la suma del rect [x0..x1]×[y0..y1] INCLUSIVE es
 *  ii[(y1+1)·iw + x1+1] − ii[y0·iw + x1+1] − ii[(y1+1)·iw + x0] +
 *  ii[y0·iw + x0], sin branches). Dims inválidas → arreglo vacío. O(N). */
export function integralImage(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
): Float64Array {
  if (!(w > 0) || !(h > 0) || gray.length < w * h) return new Float64Array(0);
  const iw = w + 1;
  const ii = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowAcc = 0;
    const src = y * w;
    const dst = (y + 1) * iw;
    const prev = y * iw;
    for (let x = 0; x < w; x++) {
      rowAcc += gray[src + x]!;
      ii[dst + x + 1] = ii[prev + x + 1] + rowAcc;
    }
  }
  return ii;
}

/** Integral de píxeles² (mismo layout que integralImage; para la varianza
 *  local de Sauvola — Shafait et al.). Sumas exactas en float64: máx
 *  255²·5.4M px ≈ 3.5e11 < 2^53. */
function integralImageSq(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
): Float64Array {
  if (!(w > 0) || !(h > 0) || gray.length < w * h) return new Float64Array(0);
  const iw = w + 1;
  const ii = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowAcc = 0;
    const src = y * w;
    const dst = (y + 1) * iw;
    const prev = y * iw;
    for (let x = 0; x < w; x++) {
      const v = gray[src + x]!;
      rowAcc += v * v;
      ii[dst + x + 1] = ii[prev + x + 1] + rowAcc;
    }
  }
  return ii;
}

/** Lado S de la ventana cuadrada del umbral local (A1): max(8, round(w·ratio))
 *  forzada a IMPAR (centro exacto; el mínimo impar ≥8 es 9). */
function oddWindow(w: number, windowRatio: number): number {
  const raw = Math.max(8, Math.round(w * windowRatio));
  return raw % 2 === 0 ? raw + 1 : raw;
}

/** [R4-A1] Binarización Bradley-Roth (VERBATIM del prototipo, ~60 líneas,
 *  integral image O(N), cero dependencias): píxel NEGRO (0) si
 *  v ≤ m·(1−t), blanco (255) en otro caso, con m = media de la ventana
 *  cuadrada S centrada y CLAMPED a los bordes (la integral se consulta con
 *  el rectángulo EFECTIVO y el CONTEO real de píxeles — el borde nunca
 *  inventa píxeles). Salida binaria pura 0/255. Dims inválidas → vacío. */
export function bradleyRoth(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  t: number = BW_T,
  windowRatio: number = BW_WINDOW_RATIO,
): Uint8ClampedArray {
  const n = w * h;
  if (!(n > 0) || gray.length < n) return new Uint8ClampedArray(0);
  const ii = integralImage(gray, w, h);
  const iw = w + 1;
  const half = oddWindow(w, windowRatio) >> 1;
  const out = new Uint8ClampedArray(n);
  const k = 1 - t; // píxel negro si v ≤ m·(1−t)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h - 1, y + half);
    const r0 = y0 * iw;
    const r1 = (y1 + 1) * iw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      const sum = ii[r1 + x1 + 1]! - ii[r0 + x1 + 1]! - ii[r1 + x0]! + ii[r0 + x0]!;
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const m = sum / count;
      out[row + x] = gray[row + x]! <= m * k ? 0 : 255;
    }
  }
  return out;
}

/** [R4-A2b] Binarización Sauvola (variante del modo bw — misma maquinaria de
 *  integral images + una SEGUNDA integral de píxeles² para la varianza
 *  local, Shafait et al.): T = m·(1 + k·(s/R − 1)) con m media local, s
 *  desvío local; píxel NEGRO (0) si v ≤ T, blanco (255) si no. En fondos
 *  lisos T < m (mata speckle); en texto tenue retira menos trazo que
 *  Bradley (§R4-1d). Dims inválidas → vacío. */
export function sauvola(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  k: number = BW_SAUVOLA_K,
  r: number = BW_SAUVOLA_R,
  windowRatio: number = BW_WINDOW_RATIO,
): Uint8ClampedArray {
  const n = w * h;
  if (!(n > 0) || gray.length < n) return new Uint8ClampedArray(0);
  const ii = integralImage(gray, w, h);
  const iiSq = integralImageSq(gray, w, h);
  const iw = w + 1;
  const half = oddWindow(w, windowRatio) >> 1;
  const out = new Uint8ClampedArray(n);
  const rr = r > 0 ? r : 1; // R inválido → sin división por 0
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(h - 1, y + half);
    const r0 = y0 * iw;
    const r1 = (y1 + 1) * iw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(w - 1, x + half);
      const c0 = x0;
      const c1 = x1 + 1;
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = ii[r1 + c1]! - ii[r0 + c1]! - ii[r1 + c0]! + ii[r0 + c0]!;
      const sumSq = iiSq[r1 + c1]! - iiSq[r0 + c1]! - iiSq[r1 + c0]! + iiSq[r0 + c0]!;
      const m = sum / count;
      // Varianza por Shafait: E[v²]−m² (redondeo float64 puede dar −ε → clamp 0).
      const variance = sumSq / count - m * m;
      const s = Math.sqrt(variance > 0 ? variance : 0);
      const t = m * (1 + k * (s / rr - 1));
      out[row + x] = gray[row + x]! <= t ? 0 : 255;
    }
  }
  return out;
}

/** [R4-A2] Despeckle del binario: componentes conexas de píxeles NEGROS
 *  (4-conectividad) con área < minPx se blanquean (granos de fondo/márgenes).
 *  Flood fill iterativo con un Int32Array usado como cola (cada píxel entra
 *  exactamente una vez: se marca ANTES de encolar → O(N) total en todas las
 *  componentes). minPx ≤ 1 → copia sin cambios (0 = desactivado, A/B del
 *  harness). Dims inválidas → copia. NO muta la entrada. */
export function despeckleBinary(
  binary: Uint8ClampedArray,
  w: number,
  h: number,
  minPx: number = BW_DESPECKLE_PX,
): Uint8ClampedArray {
  const n = w * h;
  if (!(n > 0) || binary.length < n) return binary.slice();
  if (!(minPx > 1)) return binary.slice();
  const out = binary.slice();
  const visited = new Uint8Array(n); // 1 = píxel negro ya asignado a una componente
  const queue = new Int32Array(n); // cola del flood: [r, sp) pendientes; [0, r) procesados
  for (let seed = 0; seed < n; seed++) {
    if (visited[seed] !== 0 || binary[seed] !== 0) continue;
    visited[seed] = 1;
    let r = 0;
    let sp = 0;
    queue[sp++] = seed;
    while (r < sp) {
      const i = queue[r++]!;
      const x = i % w;
      // 4-conectividad; marca ANTES de encolar (sin duplicados).
      if (x > 0 && visited[i - 1] === 0 && binary[i - 1] === 0) {
        visited[i - 1] = 1;
        queue[sp++] = i - 1;
      }
      if (x < w - 1 && visited[i + 1] === 0 && binary[i + 1] === 0) {
        visited[i + 1] = 1;
        queue[sp++] = i + 1;
      }
      if (i >= w && visited[i - w] === 0 && binary[i - w] === 0) {
        visited[i - w] = 1;
        queue[sp++] = i - w;
      }
      if (i < n - w && visited[i + w] === 0 && binary[i + w] === 0) {
        visited[i + w] = 1;
        queue[sp++] = i + w;
      }
    }
    // queue[0..sp) ES la lista de píxeles de la componente (área = sp).
    if (sp < minPx) {
      for (let j = 0; j < sp; j++) out[queue[j]!] = 255;
    }
  }
  return out;
}

/** Estirado de punto blanco PARAMÉTRICO (§F5 natural + D-F5-c text): mapea el
 *  percentil `pct` del histograma al blanco puro con estiramiento LINEAL
 *  (slope 255/p, clamp a 255; nada por encima del percentil se quema — el
 *  blanco roza 255). Sin percentil fiable (imagen unicolor) → copia sin
 *  cambios. NO muta la entrada. `whitePointStretch` es el caso §F5 (p97). */
export function whitePointStretchPct(
  gray: Uint8ClampedArray,
  pct: number,
): Uint8ClampedArray {
  const n = gray.length;
  if (!(n > 0)) return new Uint8ClampedArray(0);
  const p = Math.min(1, Math.max(0, pct));
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]!]! += 1;
  const target = Math.ceil(n * p);
  let acc = 0;
  let pivot = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= target) {
      pivot = v;
      break;
    }
  }
  if (pivot <= 0) return gray.slice();
  const scale = 255 / pivot;
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const v = Math.round(gray[i]! * scale);
    out[i] = v > 255 ? 255 : v;
  }
  return out;
}

/** Estirado de punto blanco del modo natural (§F5): percentil 97 → 255. */
export function whitePointStretch(gray: Uint8ClampedArray): Uint8ClampedArray {
  return whitePointStretchPct(gray, 0.97);
}

/** S-curve de contraste del modo 'text' (D-F5-c): v' = (v − pivote)·contraste
 *  + pivote (en unidades normalizadas), clamp a [0,1]. Con pivote alto
 *  (TEXT_CLARO_PIVOT) y contraste >1: el fondo ya-blanco se mantiene en 255 y
 *  los grises medios (tinta, antialias) se oscurecen — texto claro y marcado
 *  SIN binarización dura (conserva escalas, a diferencia del Sauvola que
 *  sustituía al modo bw). NO muta la entrada. */
export function textClaroContrast(
  gray: Uint8ClampedArray,
  contrast: number = TEXT_CLARO_CONTRAST,
  pivot: number = TEXT_CLARO_PIVOT,
): Uint8ClampedArray {
  const n = gray.length;
  const out = new Uint8ClampedArray(n);
  if (!(n > 0)) return out;
  for (let i = 0; i < n; i++) {
    const v = gray[i]! / 255;
    out[i] = ((v - pivot) * contrast + pivot) * 255;
  }
  return out;
}

/** Normaliza un modo legado/externo al union actual. [RONDA 4 A1,
 *  2026-09-28] 'bw' vuelve a ser un modo VÁLIDO (B/N adaptativo) y ya NO
 *  migra a 'text': el port Next.js empieza con IndexedDB VACÍA, no hay
 *  páginas persistidas con el 'bw' legado de D-F5-c que migrar. [F5-RAW,
 *  2026-10-01] 'raw' (Original de cámara) es un modo válido de primera
 *  clase. Desconocido → 'color' (el modo por defecto de la cola). */
export function normalizeEnhanceMode(mode: string): EnhanceMode {
  if (
    mode === 'raw' ||
    mode === 'color' ||
    mode === 'gray' ||
    mode === 'natural' ||
    mode === 'text' ||
    mode === 'bw'
  ) {
    return mode;
  }
  return 'color';
}

/** Mime del encode por modo. M4a 2026-09-27: `text` → PNG sin pérdida —
 *  el JPEG sobre bordes duros de alto contraste genera ringing/halos por
 *  diseño; en contenido de tinta el PNG pesa igual o menos. pdfExport.ts ya
 *  distingue por mime (embedPng). [R4-A3, 2026-09-28] `bw` → PNG también
 *  (regla M4a re-evaluada): el binario 0/255 comprime muchísimo mejor en
 *  PNG que en JPEG — y sin ringing en los bordes de trazo. [F5-RAW,
 *  2026-10-01] `raw` → PNG: el JPEG re-encodea con pérdida y el modo promete
 *  fidelidad al sensor — PNG sin pérdida (sugerencia analizada del humano:
 *  "para el modo original conviene exportar PNG sin pérdida"). PURO. */
export function enhanceMime(mode: EnhanceMode): 'image/jpeg' | 'image/png' {
  return mode === 'raw' || mode === 'text' || mode === 'bw' ? 'image/png' : 'image/jpeg';
}
