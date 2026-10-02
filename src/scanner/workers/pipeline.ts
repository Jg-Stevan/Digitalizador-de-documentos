// src/workers/pipeline.ts — pipeline de proceso por frame (F1: detector real).
// Recibe el cv como INTERFAZ (CvApi), no como global: los unit tests inyectan
// un mock que cuenta create/delete y verifica withMats() sin WASM.
//
// F1 (decisión documentada): preproceso a 480p-clase (grayscale → blur → Canny
// → contornos) + QuadDetector (top por área → approxPolyDP(0.02·peri) → 4
// vértices → selectQuad del core con validateQuad aprobada). La geometría vive
// en core (pura); OpenCV solo píxeles. Salida: corners Float32Array(8) en
// FRACCIONES del frame ORIGINAL (invariantes por eje ante resize anisotrópico)
// o null. qualityInput: laplacianVar + media/desv del CROP del quad (contrato
// 480p de quality.ts) o del frame completo si no hay quad.

import type { Quadrilateral } from '../core/types';
import type { Corner } from '../core/types';
import type { DocProfile } from '../core/types';
import type { EnhanceMode } from '../core/types';
import type { LineEq, RefineResult } from '../core/geometry';
import { BAND_MIN_PX, fitLineRansac, fitLineTrimmed, orderPoints, refineQuadFromLines } from '../core/geometry';
import type { ScoredPoly } from '../core/quadSelect';
import { computeBandRects } from '../core/cornerBands';
import type { BandRect } from '../core/cornerBands';
import { UNSHARP_AMOUNT, UNSHARP_KERNEL_SIZE, UNSHARP_RADIUS } from '../core/warp';
import { scalePoly, selectQuad, TOP_CONTOURS } from '../core/quadSelect';
import type { RawQualityInput, ResultReply } from './protocol';
import { withMats } from './withMats';
import { enhanceToRgba, type EnhanceOpts } from './enhanceJs';

/** Mat mínimo que usa el pipeline (cv.Mat real lo satisface). */
export interface PipelineMat {
  delete(): void;
  doubleAt(row: number, col: number): number;
  /** Filas (para leer vértices de approxPolyDP: Nx1x2 CV_32S). */
  rows: number;
  /** Vista i32 de los datos (approx: [x0,y0,x1,y1,…]). */
  data32S: Int32Array<ArrayBufferLike>;
}

export interface PipelineMatVector {
  delete(): void;
  size(): number;
}

export interface PipelineSize {
  width: number;
  height: number;
}

export interface PipelineRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Superficie exacta de OpenCV.js que el pipeline necesita (ni una más). */
export interface CvApi {
  readonly COLOR_RGBA2GRAY: number;
  readonly RETR_LIST: number;
  /** F1-opt palanca 1: solo contornos exteriores (las arrugas del papel generan
   *  internos que se aproximaban en vano). Origen: profiling Fase 0. */
  readonly RETR_EXTERNAL: number;
  readonly CHAIN_APPROX_SIMPLE: number;
  readonly CV_64F: number;
  matFromImageData(img: ImageData): PipelineMat;
  createMat(): PipelineMat;
  createMatVector(): PipelineMatVector;
  createSize(w: number, h: number): PipelineSize;
  cvtColor(src: PipelineMat, dst: PipelineMat, code: number): void;
  GaussianBlur(
    src: PipelineMat,
    dst: PipelineMat,
    ksize: PipelineSize,
    sigmaX: number,
    sigmaY: number,
  ): void;
  Canny(src: PipelineMat, dst: PipelineMat, t1: number, t2: number): void;
  findContours(
    img: PipelineMat,
    contours: PipelineMatVector,
    hierarchy: PipelineMat,
    mode: number,
    method: number,
  ): void;
  contourCount(contours: PipelineMatVector): number;
  getContour(contours: PipelineMatVector, i: number): PipelineMat;
  contourArea(cnt: PipelineMat): number;
  arcLength(cnt: PipelineMat, closed: boolean): number;
  approxPolyDP(src: PipelineMat, dst: PipelineMat, epsilon: number, closed: boolean): void;
  Laplacian(src: PipelineMat, dst: PipelineMat, depth: number): void;
  meanStdDev(src: PipelineMat, mean: PipelineMat, stddev: PipelineMat): void;
  roi(src: PipelineMat, rect: PipelineRect): PipelineMat;
  /** F3-c (mínimo para warpPage, ni una más): interpolación cúbica del warp. */
  readonly INTER_CUBIC: number;
  /** H = quad src → quad dst (como cv.getPerspectiveTransform: RETORNA el Mat 3×3). */
  getPerspectiveTransform(src: Quadrilateral, dst: Quadrilateral): PipelineMat;
  warpPerspective(
    src: PipelineMat,
    dst: PipelineMat,
    M: PipelineMat,
    dsize: PipelineSize,
    flags: number,
  ): void;
  addWeighted(
    src1: PipelineMat,
    alpha: number,
    src2: PipelineMat,
    beta: number,
    gamma: number,
    dst: PipelineMat,
  ): void;
  /** [F5-CROP fallback] Elemento estructurante para dilatar el edge map. */
  readonly MORPH_RECT: number;
  getStructuringElement(shape: number, ksize: PipelineSize): PipelineMat;
  /** [F5-CROP fallback] Dilatación del edge map (puentear gaps del borde). */
  dilate(src: PipelineMat, dst: PipelineMat, kernel: PipelineMat, iterations: number): void;
  /** Píxeles RGBA del Mat (COPIA — la memoria WASM se reutiliza después). */
  matDataRGBA(m: PipelineMat, w: number, h: number): Uint8ClampedArray;
  /** Píxeles U8 de un canal del Mat (COPIA; p. ej. mapa Canny 0/255). */
  matDataU8(m: PipelineMat, w: number, h: number): Uint8Array;
}

/** Umbrales de Canny (F1 Fase 0, benchmark sobre 6 fixtures sintéticos):
 *  empate en detección b/c/d entre 50/150 y 75/200 (mismo err ~0.002);
 *  50/150 gana por COSTO (~10ms vs segundos en ruido: menos fragmentación de
 *  contornos con RETR_LIST). Evidencia: PLAN_EVIDENCE/F1/bench-fase0.json. */
export const CANNY_LOW = 50;
export const CANNY_HIGH = 150;

/** Epsilon de approxPolyDP como fracción del perímetro (spec F1). */
export const APPROX_EPSILON_RATIO = 0.02;

/** Prefiltro de rendimiento (F1-a): contornos bajo el 0.5% del área de proceso
 *  ni se aproximan. Origen HONESTO: ingeniería, no benchmark — ningún contorno
 *  bajo 0.5% podría pasar el validateQuad del core (≥25%), así que aproximarlo
 *  es puro costo. NO es umbral de calidad (la decisión la toma selectQuad). */
export const MIN_CONTOUR_AREA_PCT = 0.005;

/** F1-opt P2: top-N contornos por área que llegan a approxPolyDP. Origen:
 *  ingeniería F1-opt con expectativa calibrada — la evidencia P1 indica que el
 *  bottleneck del Exynos NO está en el conteo (se aplica por orden aprobado y
 *  costo cero, no por ganancia esperada). selectQuad ya miraba top-5; el cap
 *  evita aproximar el resto. */
export const MAX_CONTOUR_CANDIDATES = 8;

/** F3-b (ingeniería): mínimo de píxeles de borde en una banda para ajustar su
 *  recta. Menos que esto = banda sin información (borde fuera de banda o
 *  ocluido) → lado caído al blindaje 3. */
export const MIN_EDGE_POINTS = 20;

// --- [R4-B2] Perfil de documento para los priores de selectQuad ---

/** Perfil activo del worker ('auto' al nacer; lo setea el mensaje 'config'
 *  del main en caliente — ver workers/protocol.ts ConfigRequest). */
let docProfile: DocProfile = 'auto';

/** [R4-B2] Configura el perfil de priores (documento-largo/pagina/tarjeta/
 *  auto). Idempotente y sin efecto secundario: solo alimenta el `opts`
 *  de selectQuad en el próximo frame. */
export function setDocProfile(p: DocProfile): void {
  docProfile = p;
}

/** [R4-B2] ¿El punto (centro de píxel) está dentro del quad ordenado?
 *  Test de signos de productos cruzales contra los 4 lados: mismo signo en
 *  todos (o cero — sobre un lado) = interior. Se aceptan AMBOS sentidos de
 *  recorrido por robustez ante polys de approxPolyDP con orden imprevisto. */
function pointInQuad(q: Quadrilateral, x: number, y: number): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross > 0) pos = true;
    else if (cross < 0) neg = true;
  }
  return !(pos && neg);
}

/** [R4-B2] Pre-score de blancura del blob (0–1) sobre el imageData de
 *  PROCESO: recorre el bbox del polígono (coords de proceso) acumulando
 *  `wpx = max(0, luma/255 · (1 − sat·2.2))` con luma = 0.299R+0.587G+0.114B
 *  y sat = (max−min)/max(R,G,B,1) (fórmula del prototipo: separa PAPEL de
 *  mesa/manos/fundas — genérica, no ligada a un formato). Devuelve la MEDIA
 *  de wpx; undefined si el polígono está degenerado (orderPoints lanza) o
 *  no cubre ningún centro de píxel. O(bbox) a resolución de proceso
 *  (~225×400) — barato. Nunca lanza. */
function whitenessOfQuad(
  imageData: ImageData,
  pts: Corner[],
  procW: number,
  procH: number,
): number | undefined {
  let ordered: Quadrilateral;
  try {
    ordered = orderPoints(pts);
  } catch {
    return undefined; // degenerado (coordenadas empatadas): sin prior
  }
  const xs = ordered.map((c) => c.x);
  const ys = ordered.map((c) => c.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(procW - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(procH - 1, Math.ceil(Math.max(...ys)));
  const data = imageData.data;
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!pointInQuad(ordered, x + 0.5, y + 0.5)) continue; // centro del píxel
      const i = (y * procW + x) * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = (mx - mn) / Math.max(mx, 1);
      const wpx = (luma / 255) * (1 - sat * 2.2);
      sum += wpx > 0 ? wpx : 0;
      count++;
    }
  }
  return count > 0 ? sum / count : undefined;
}

function clampRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  h: number,
): PipelineRect | null {
  const x = Math.max(0, Math.min(x0, x1));
  const y = Math.max(0, Math.min(y0, y1));
  const xe = Math.min(w, Math.max(x0, x1));
  const ye = Math.min(h, Math.max(y0, y1));
  if (xe - x < 1 || ye - y < 1) return null;
  return { x, y, width: xe - x, height: ye - y };
}

function toFractions(q: Quadrilateral, frameW: number, frameH: number): Float32Array {
  const out = new Float32Array(8);
  for (let i = 0; i < 4; i++) {
    out[2 * i] = q[i]!.x / frameW;
    out[2 * i + 1] = q[i]!.y / frameH;
  }
  return out;
}

/** Recolecta los candidatos (approxPolyDP a 4 vértices + blancura) de un edge
 *  map dado. [F5-CROP, 2026-10-01] extraído del cuerpo principal para poder
 *  reintentar sobre el mapa DILATADO con épsilon escalado (cadena de
 *  fallback) sin duplicar el código. `canny` no entra: el edge map ya está
 *  computado. Devuelve { polys, contourCount } para el diag de calidad. */
function collectQuadCandidates(
  cv: CvApi,
  edges: PipelineMat,
  imageData: ImageData,
  procW: number,
  procH: number,
  sx: number,
  sy: number,
  epsRatio: number,
): { polys: ScoredPoly[]; contourCount: number } {
  const contours = cv.createMatVector();
  const hierarchy = cv.createMat();
  try {
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const n = cv.contourCount(contours);
    // QuadDetector: top-8 por área → approx → 4 vértices → core (P2: el cap
    // va ANTES de approxPolyDP para no aproximar en vano).
    const minArea = procW * procH * MIN_CONTOUR_AREA_PCT;
    const cands: Array<{ cnt: PipelineMat; area: number }> = [];
    for (let i = 0; i < n; i++) {
      const cnt = cv.getContour(contours, i);
      const area = cv.contourArea(cnt);
      if (area < minArea) {
        cnt.delete();
        continue;
      }
      cands.push({ cnt, area });
    }
    cands.sort((a, b) => b.area - a.area);
    const polys: ScoredPoly[] = [];
    const top = cands.slice(0, MAX_CONTOUR_CANDIDATES);
    for (const { cnt, area } of top) {
      const peri = cv.arcLength(cnt, true);
      const approx = cv.createMat();
      try {
        cv.approxPolyDP(cnt, approx, epsRatio * peri, true);
        if (approx.rows !== 4) continue;
        const pts = [
          { x: approx.data32S[0]!, y: approx.data32S[1]! },
          { x: approx.data32S[2]!, y: approx.data32S[3]! },
          { x: approx.data32S[4]!, y: approx.data32S[5]! },
          { x: approx.data32S[6]!, y: approx.data32S[7]! },
        ];
        // [R4-B2] Blancura del blob sobre el imageData de PROCESO (pts aún en
        // coords de proceso, ANTES de escalar al frame original).
        const whiteness = whitenessOfQuad(imageData, pts, procW, procH);
        polys.push({ points: scalePoly(pts, sx, sy), area: area * sx * sy, whiteness });
      } finally {
        approx.delete();
        cnt.delete();
      }
    }
    // Los contornos fuera del top-8 también deben morir (no entraron al
    // try/finally de arriba): el MatVector se libera abajo, pero los Mats
    // individuales que getContour clonó son responsabilidad nuestra.
    for (const { cnt } of cands.slice(MAX_CONTOUR_CANDIDATES)) {
      cnt.delete();
    }
    return { polys, contourCount: n };
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

/** Procesa un frame (imageData en dims de PROCESO) referido al frame original
 *  (frameW/H). Todos los Mats nacen dentro de withMats().
 *  @param canny override de umbrales (benchmark Fase 0; default = constantes). */
export function processFrame(
  cv: CvApi,
  imageData: ImageData,
  frameW: number,
  frameH: number,
  ts: number,
  canny: { low: number; high: number } = { low: CANNY_LOW, high: CANNY_HIGH },
): ResultReply {
  const procW = imageData.width;
  const procH = imageData.height;
  const sx = frameW / procW;
  const sy = frameH / procH;

  return withMats((track) => {
    const rgba = track(cv.matFromImageData(imageData));
    const gray = track(cv.createMat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const blur = track(cv.createMat());
    cv.GaussianBlur(gray, blur, cv.createSize(5, 5), 0, 0);
    const edges = track(cv.createMat());
    cv.Canny(blur, edges, canny.low, canny.high);

    // [R4-B2] Perfil de priores del worker (config en caliente vía 'config').
    const profileOpts = { profile: docProfile };

    // PASO 1 — camino F1 exacto (Canny → contornos → approx 0.02·peri).
    let collected = collectQuadCandidates(
      cv,
      edges,
      imageData,
      procW,
      procH,
      sx,
      sy,
      APPROX_EPSILON_RATIO,
    );
    let quad = selectQuad(collected.polys, frameW, frameH, TOP_CONTOURS, profileOpts);

    // [F5-CROP, 2026-10-01 — fotos reales issue #2 + sugerencias analizadas]
    // PASO 2 (fallback A — bordes fragmentados): un papel INCLINADO ~35°
    // reparte el gradiente de su borde en más píxeles (la transición se
    // alinea con la diagonal del muestreo) → Canny la corta en tramos y el
    // contorno EXTERIOR nunca cierra → 137-173 fragmentos de <1% y CERO
    // candidatos. Dilatar el edge map (3×3 ×2, gaps <~4px) puentea los
    // tramos y el contorno del papel vuelve a cerrar (evidencia: real5
    // 31.4% área, 4 vértices). Solo corre si el paso 1 NO halló quad — el
    // camino feliz es byte-a-byte el de F1 (sin regresión).
    // PASO 3 (fallback B — papel cortado por el borde del frame): la
    // silueta visible de un papel que SALE del encuadre es un hexágono
    // (6-7 vértices en approx); épsilon 2.5× la colapsa a un quad
    // aproximado (evidencia real1: 7 → 4 vértices con 0.05·peri). El
    // recorte resultante incluye algo de mesa donde el papel se corta —
    // el humano lo ajusta en el editor (F5-MANUAL respeta sus esquinas).
    if (quad === null) {
      const kernel = track(
        cv.getStructuringElement(cv.MORPH_RECT, cv.createSize(3, 3)),
      );
      const dilated = track(cv.createMat());
      cv.dilate(edges, dilated, kernel, 2);
      collected = collectQuadCandidates(
        cv,
        dilated,
        imageData,
        procW,
        procH,
        sx,
        sy,
        APPROX_EPSILON_RATIO,
      );
      quad = selectQuad(collected.polys, frameW, frameH, TOP_CONTOURS, profileOpts);
      if (quad === null) {
        collected = collectQuadCandidates(
          cv,
          dilated,
          imageData,
          procW,
          procH,
          sx,
          sy,
          APPROX_EPSILON_RATIO * 2.5,
        );
        quad = selectQuad(collected.polys, frameW, frameH, TOP_CONTOURS, profileOpts);
      }
    }

    // Stats del crop del quad (contrato quality.ts) o del frame si no hay quad.
    let statSrc: PipelineMat = gray;
    if (quad !== null) {
      const xs = quad.map((c) => c.x);
      const ys = quad.map((c) => c.y);
      // bbox en coords de PROCESO (el roi se corta del gray de proceso)
      const rect = clampRect(
        Math.min(...xs) / sx,
        Math.min(...ys) / sy,
        Math.max(...xs) / sx,
        Math.max(...ys) / sy,
        procW,
        procH,
      );
      if (rect !== null) {
        statSrc = track(cv.roi(gray, rect));
      }
    }
    const lap = track(cv.createMat());
    cv.Laplacian(statSrc, lap, cv.CV_64F);
    const mean = track(cv.createMat());
    const stddev = track(cv.createMat());
    cv.meanStdDev(lap, mean, stddev);
    const s = stddev.doubleAt(0, 0);
    cv.meanStdDev(statSrc, mean, stddev);
    const sd = stddev.doubleAt(0, 0);
    const md = mean.doubleAt(0, 0);
    const qualityInput: RawQualityInput = {
      laplacianVar: Number.isFinite(s) ? s * s : null,
      cropMean: Number.isFinite(md) ? md : null,
      cropStdDev: Number.isFinite(sd) ? sd : null,
      frameW,
      frameH,
      diag: { contourCount: collected.contourCount },
    };
    return {
      type: 'result',
      corners: quad === null ? null : toFractions(quad, frameW, frameH),
      qualityInput,
      ts,
    };
  });
}

/** Píxeles de salida del warp (plano: el worker los envuelve en ImageData real). */
export interface WarpPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Opciones de warpPage. [F5-RAW, 2026-10-01] `unsharp: false` salta el
 *  enfoque del warp (amount 0.5/radius 1.5) — el modo "Original de cámara"
 *  promete fidelidad al sensor y el unsharp, aunque no es filtro de color,
 *  SÍ es un filtro (sugerencia analizada: "si quieres fidelidad 100%, hay
 *  que saltarlo también"). Default `true` = comportamiento §F3 exacto para
 *  todos los demás modos (sin regresión).
 *  [F5-RAW-2, 2026-11 — petición humana] el worker de producción pasa `false`
 *  SIEMPRE (ver unsharpRgba): el blob persistido no puede depender del modo
 *  transitorio de la UI al capturar. La perilla queda para harnesses/Node. */
export interface WarpOpts {
  unsharp?: boolean;
}

/** Rectifica la página (F3-c, PLAN_MAESTRO §F3): homografía quad→recto +
 *  warpPerspective INTER_CUBIC + unsharp (amount/radius del core; saltable
 *  vía opts.unsharp === false para el modo 'raw' — F5-RAW).
 *  `quadPx` en PÍXELES de `foto`; salida `outW×outH` (dims de computeWarpDims).
 *  Todos los Mats nacen dentro de withMats().
 *  Retorna píxeles PLANOS (NO un ImageData real: `putImageData` exige el objeto
 *  con marca del canvas — lo construye el worker con `createImageData`; en Node
 *  no existe el global ImageData y este módulo debe seguir siendo Node-testeable). */
export function warpPage(
  cv: CvApi,
  foto: ImageData,
  quadPx: Quadrilateral,
  outW: number,
  outH: number,
  opts: WarpOpts = {},
): WarpPixels {
  return withMats((track) => {
    const src = track(cv.matFromImageData(foto));
    const M = track(
      cv.getPerspectiveTransform(quadPx, [
        { x: 0, y: 0 },
        { x: outW, y: 0 },
        { x: outW, y: outH },
        { x: 0, y: outH },
      ]),
    );
    const warped = track(cv.createMat());
    cv.warpPerspective(src, warped, M, cv.createSize(outW, outH), cv.INTER_CUBIC);
    if (opts.unsharp === false) {
      // F5-RAW: salida del warp TAL CUAL (solo homografía + interpolación
      // cúbica — esta es la parte geométrica inherente al recorte).
      return {
        width: outW,
        height: outH,
        data: cv.matDataRGBA(warped, outW, outH),
      };
    }
    const blur = track(cv.createMat());
    cv.GaussianBlur(
      warped,
      blur,
      cv.createSize(UNSHARP_KERNEL_SIZE, UNSHARP_KERNEL_SIZE),
      UNSHARP_RADIUS,
      UNSHARP_RADIUS,
    );
    const sharp = track(cv.createMat());
    cv.addWeighted(warped, 1 + UNSHARP_AMOUNT, blur, -UNSHARP_AMOUNT, 0, sharp);
    return {
      width: outW,
      height: outH,
      data: cv.matDataRGBA(sharp, outW, outH),
    };
  });
}

/** [F5-RAW-2, 2026-11 — petición humana] Unsharp §F3 como etapa INDEPENDIENTE
 *  del warp: MISMAS ops/constantes exactas del bloque histórico de warpPage
 *  (GaussianBlur + addWeighted, amount/radius del core). Motivo del move: el
 *  blob que se persiste al agregar página sale del bitmap del warp — si el
 *  modo global era ≠ raw EN EL MOMENTO de la captura, el unsharp quedaba
 *  HORNEADO y el cambio posterior del selector a "Original de cámara" no
 *  podía recuperarlo (el stored no puede depender de un estado de UI
 *  transitorio; residuo medido 2-4/255 de media con las fotos reales). Ahora
 *  handleWarp produce warp PURO siempre y handleEnhance aplica unsharpRgba
 *  para todo modo ≠ raw ANTES de applyMode — mismo orden visual histórico
 *  (enfoque → realce). Recibe ImageData (la salida conserva sus dims); los
 *  Mats viven en withMats como en warpPage (Node-testeable, píxeles planos). */
export function unsharpRgba(cv: CvApi, foto: ImageData): WarpPixels {
  return withMats((track) => {
    const src = track(cv.matFromImageData(foto));
    const blur = track(cv.createMat());
    cv.GaussianBlur(
      src,
      blur,
      cv.createSize(UNSHARP_KERNEL_SIZE, UNSHARP_KERNEL_SIZE),
      UNSHARP_RADIUS,
      UNSHARP_RADIUS,
    );
    const sharp = track(cv.createMat());
    cv.addWeighted(src, 1 + UNSHARP_AMOUNT, blur, -UNSHARP_AMOUNT, 0, sharp);
    return {
      width: foto.width,
      height: foto.height,
      data: cv.matDataRGBA(sharp, foto.width, foto.height),
    };
  });
}

/** Píxeles de salida del enhance (plano: el worker los envuelve en ImageData real). */
export interface EnhancePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Aplica un modo de la cola multipágina (§5-F5) al warped RGBA. DELEGA en
 *  enhanceJs (JS puro dentro del worker — D-F5: opencv.js 4.5.5 no expone
 *  CLAHE/LAB; ver enhanceJs.ts). El parámetro `cv` se conserva en la firma por
 *  contrato (la api del worker es uniforme y permite swap futuro a cv.Mat sin
 *  tocar protocolo); NO se usa hoy. NO crea Mat (withMats no se viola).
 *  _cv:_ sin uso (D-F5). Valida dims: outW/outH deben ser las dims de source.
 *  M4b: `opts` (overrides de calibración) pasa a enhanceToRgba. */
export function applyMode(
  _cv: CvApi,
  warped: Uint8ClampedArray | ImageData,
  mode: EnhanceMode,
  outW: number,
  outH: number,
  opts: EnhanceOpts = {},
): EnhancePixels {
  const src =
    warped instanceof Uint8ClampedArray
      ? warped
      : (warped as ImageData).data ?? new Uint8ClampedArray(0);
  if (outW <= 0 || outH <= 0 || src.length < outW * outH * 4) {
    return { width: outW, height: outH, data: new Uint8ClampedArray(0) };
  }
  return {
    width: outW,
    height: outH,
    data: enhanceToRgba(src, outW, outH, mode, opts),
  };
}

/** Borde de un lado en coords de FOTO (salida de extractBandEdges). */
export interface BandEdges {
  side: 0 | 1 | 2 | 3;
  points: Corner[];
}

/** Píxeles de borde (Canny 50/150, constantes F1) por banda, en coords de foto.
 *  Muestreo con stride + cap derivado de MIN_EDGE_POINTS (×100): acota el costo
 *  en bandas grandes sin nueva constante. Todos los Mats en withMats(). */
export function extractBandEdges(
  cv: CvApi,
  foto: ImageData,
  bands: BandRect[],
): BandEdges[] {
  return withMats((track) => {
    const src = track(cv.matFromImageData(foto));
    const gray = track(cv.createMat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    return bands.map((b) => {
      const crop = track(cv.roi(gray, b));
      const edges = track(cv.createMat());
      cv.Canny(crop, edges, CANNY_LOW, CANNY_HIGH);
      const px = cv.matDataU8(edges, b.width, b.height);
      const cap = MIN_EDGE_POINTS * 100;
      const stride = Math.max(1, Math.floor((b.width * b.height) / cap));
      const points: Corner[] = [];
      for (let i = 0; i < px.length; i += stride) {
        if (px[i]! > 0) {
          if (points.length >= cap) break;
          points.push({ x: b.x + (i % b.width), y: b.y + Math.floor(i / b.width) });
        }
      }
      return { side: b.side, points };
    });
  });
}

/** Línea degenerada: intersecciones siempre null → el blindaje 3 marca el lado
 *  caído y cae a sus esquinas de entrada. (intersectLines: den=0 → null.) */
const DEAD_LINE: LineEq = { a: 0, b: 0, c: 0 };

/** [F5-CROP blindaje, 2026-10-01 — evidencia real1 issue #2] margen (fracción
 *  de la diagonal de la FOTO) fuera del cual una esquina REFINADA se considera
 *  "disparada": dos lados casi paralelas ajustados sobre bordes fragmentados
 *  intersecan a decenas de miles de píxeles (medido: TL a 162k px, dims de
 *  warp 3500×3471 para un recibo 1:3). Esa esquina vuelve al quad de entrada
 *  — fallback LOCAL (las otras 3 conservan su refinado). */
export const REFINE_CORNER_MARGIN_RATIO = 0.05;

/** Refinado fino del quad a resolución de foto (F3-b, blindajes 1-3 §F3):
 *  bandas adaptativas (core) → bordes por banda → fitLineTrimmed (core, trim
 *  por defecto) → refineQuadFromLines (core, fallback POR LADO). Banda sin
 *  puntos suficientes o ajuste fallido → lado caído (DEAD_LINE). Sin bandas
 *  (quad degenerado) → todo caído. NUNCA lanza con entrada finita.
 *  [F5-CROP blindaje] tras refineQuadFromLines: esquina refinada fuera de la
 *  foto + margen (5% de la diagonal) = intersección disparada por líneas
 *  casi paralelas → ESA esquina vuelve al quad de entrada y sus 2 lados
 *  adyacentes se marcan caídos (fallback local, el resto conserva refine). */
export function refineQuad(
  cv: CvApi,
  foto: ImageData,
  quadPx: Quadrilateral,
): RefineResult {
  const bands = computeBandRects(quadPx, foto.width, foto.height);
  if (bands.length === 0) {
    return { quad: quadPx, fellBack: [true, true, true, true] };
  }
  const edges = extractBandEdges(cv, foto, bands);
  const bySide = new Map<number, Corner[]>();
  for (const e of edges) bySide.set(e.side, e.points);
  const lines: [LineEq, LineEq, LineEq, LineEq] = [DEAD_LINE, DEAD_LINE, DEAD_LINE, DEAD_LINE];
  for (let s = 0; s < 4; s++) {
    const pts = bySide.get(s) ?? [];
    if (pts.length < MIN_EDGE_POINTS) continue;
    try {
      // [F5-CROP, sugerencia #4] fitLineRansac (consenso determinista):
      // LSQ puro se torcía con puntos espurios dentro de la banda (pluma/
      // texto/reflejos — evidencia real3 issue #2). RANSAC primero, y si la
      // banda no tiene estructura lineal (throw), se intenta el LSQ
      // recortado histórico como SEGUNDA oportunidad antes de caer el lado.
      lines[s] = fitLineRansac(pts);
    } catch {
      try {
        lines[s] = fitLineTrimmed(pts);
      } catch {
        // ajuste imposible → lado caído (el warp sigue con la entrada)
      }
    }
  }
  const ref = refineQuadFromLines(lines[0], lines[1], lines[2], lines[3], quadPx);
  // Blindaje bounds (F5-CROP): esquina disparada → entrada + lados caídos.
  const m = REFINE_CORNER_MARGIN_RATIO * Math.hypot(foto.width, foto.height);
  const inBounds = (c: Corner): boolean =>
    c.x >= -m && c.x <= foto.width + m && c.y >= -m && c.y <= foto.height + m;
  // [F5-CROP, tope de desplazamiento] una esquina refinada NO puede moverse
  // más de 2× el ancho de banda de sus lados: el inlier del ajuste vive
  // DENTRO de la banda (±bandW/2), así que un desplazamiento mayor es
  // señal de línea torcida (evidencia real3: 263-306px con bandas de 30px).
  // Esas esquinas vuelven a la entrada — mismo tratamiento que bounds.
  const sideBandW = new Map<number, number>();
  for (const b of bands) sideBandW.set(b.side, b.bandW);
  const capFor = (i: number): number =>
    2 *
    Math.max(
      sideBandW.get((i + 3) % 4) ?? BAND_MIN_PX,
      sideBandW.get(i) ?? BAND_MIN_PX,
    );
  const quad: Quadrilateral = [...ref.quad];
  const fellBack: [boolean, boolean, boolean, boolean] = [...ref.fellBack];
  for (let i = 0; i < 4; i++) {
    const displaced =
      Math.hypot(quad[i]!.x - quadPx[i]!.x, quad[i]!.y - quadPx[i]!.y) > capFor(i);
    if (inBounds(quad[i]!) && !displaced) continue;
    quad[i] = { ...quadPx[i]! };
    fellBack[(i + 3) % 4] = true;
    fellBack[i] = true;
  }
  return { quad, fellBack };
}
