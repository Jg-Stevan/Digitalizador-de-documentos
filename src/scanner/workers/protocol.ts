// src/workers/protocol.ts — contrato de mensajes UI ⇄ DetectionWorker (T4).
// Fijado por PLAN_MAESTRO §3 ("W"): requestVideoFrameCallback/ImageBitmap
// transferable → corners + score; backpressure por DESCARTE (nunca encolar).
// Vive en workers/ (no en core/) para no tocar la lógica aprobada de T2/T3.
// Corners en FRACCIONES (0–1) del frame, orden TL,TR,BR,BL — como el spike.

/** Resolución de proceso SQUASH (T4): fallback cuando se desconoce el aspecto
 *  del video o resizeMode='squash'. */
export const PROCESS_WIDTH = 640;
export const PROCESS_HEIGHT = 480;

/** Lado mayor de proceso en modo PRESERVE (F1-opt P3: 400 — era 480).
 *  Origen: F1-opt P3, aprobación humana A-primero (2026-09-22); evidencia P1/P2:
 *  bottleneck Exynos = costo fijo por píxel (−30% píxeles esperado ≈ +20-30%
 *  FPS). Trade-off: menor precisión de detección AMORTIGUADA por el
 *  CornerRefiner de F3 (refina a resolución completa sobre la foto hi-res).
 *  9:16 → 225×400. Evidencia: PLAN_EVIDENCE/F1-opt/bench-400.json. */
export const PROCESS_LONG_SIDE = 400;

export type ResizeMode = 'squash' | 'preserve';

/** Dims de proceso: preserve escala el lado mayor a 480 manteniendo aspecto;
 *  squash usa el fallback 640×480 (también si las dims del video son inválidas). */
export function computeProcessDims(
  videoW: number,
  videoH: number,
  mode: ResizeMode,
): { w: number; h: number } {
  if (mode !== 'preserve' || !(videoW > 0) || !(videoH > 0)) {
    return { w: PROCESS_WIDTH, h: PROCESS_HEIGHT };
  }
  const s = PROCESS_LONG_SIDE / Math.max(videoW, videoH);
  return {
    w: Math.max(1, Math.round(videoW * s)),
    h: Math.max(1, Math.round(videoH * s)),
  };
}

import type { DocProfile, EnhanceMode } from '../core/types';

/** URL pineada del build oficial de OpenCV.js que carga el worker (T4).
 *  4.5.5: última con ruta estable verificada (4.10.0 devuelve 404 en ese path).
 *  F6: es el ÚLTIMO recurso — primero se intentan las copias self-hosted
 *  (vendor/), el CDN es fallback. */
export const OPENCV_CDN_URL = 'https://docs.opencv.org/4.5.5/opencv.js';

/** Nombre de archivo del vendor self-hosted (F6). Cambiar aquí si se actualiza
 *  la versión — y reemplazar el archivo en vendor/. */
export const OPENCV_VENDOR_FILENAME = 'opencv-4.5.5.js';

/** Cadena de candidatos de carga de opencv.js para UN worker cuya URL de script
 *  es `workerScriptUrl` (F6 — migra el punto único de fallo del CDN).
 *
 *  Orden (primero el más estable):
 *  1. `../../vendor/<file>` — layouts desplegados: worker en `fN/assets/detection.worker-*.js`
 *     (GitHub Pages `/mobile-scanner/` → raíz `vendor/`) y dev Vite (`/src/workers/` →
 *     `public/` servido en `/vendor`).
 *  2. `../vendor/<file>` — worker a un nivel de la raíz (`/assets/…` en un build
 *     plano) con vendor hermanado.
 *  3. CDN pineado (docs.opencv.org) — último recurso; Cloudflare devuelve 403 a
 *     datacenters (hallazgo F4-fix-arranque), por eso el local va primero.
 *
 *  PURA y Node-testeable: resuelve con `new URL()` sobre la URL del worker. */
export function opencvCandidateUrls(workerScriptUrl: string): string[] {
  const out: string[] = [];
  for (const rel of [`../../vendor/${OPENCV_VENDOR_FILENAME}`, `../vendor/${OPENCV_VENDOR_FILENAME}`]) {
    const u = new URL(rel, workerScriptUrl);
    if (!out.includes(u.href)) out.push(u.href);
  }
  out.push(OPENCV_CDN_URL);
  return out;
}

/** UI → Worker: un frame para procesar. `bitmap` viaja como TRANSFERABLE
 *  (el worker lo cierra tras leerlo; el main thread pierde acceso). */
export interface DetectRequest {
  type: 'detect';
  bitmap: ImageBitmap;
  /** Timestamp del frame (performance.now del main thread) para latencia. */
  ts: number;
}

/** Entrada cruda de calidad que el worker devuelve por frame (F1: valores
 *  CRUDOS — el QualityScorer del core los consume en F2, no se cablea aquí).
 *  NOTA F1-a (hallazgo 5 auditoría): en streams portrait con PRESERVE el crop
 *  sale a ~270×480, no 480p exactos — consistente entre frames, pero los
 *  umbrales (BLUR_THRESHOLD/SHARPNESS_NORM) se RECALIBRAN en F2 con reales. */
export interface RawQualityInput {
  /** Varianza del Laplaciano sobre el CROP del quad (contrato 480p de
   *  quality.ts); frame completo si no hay quad. null si no medible. */
  laplacianVar: number | null;
  /** Media del crop en gris (null si no medible). */
  cropMean: number | null;
  /** Desviación del crop en gris (null si no medible). */
  cropStdDev: number | null;
  frameW: number;
  frameH: number;
  /** Diagnóstico F2-a (ADITIVO, opcional): nº de contornos encontrados —
    para elegir la palanca de FPS con dato (caso "documento denso"), no teoría. */
  diag?: {
    contourCount: number;
  };
}

/** Worker → UI: resultado. `corners` = 8 floats (x,y × TL,TR,BR,BL) en
 *  fracciones 0–1, o null si no hay quad (stub T4: siempre null — F1 lo llena). */
export interface ResultReply {
  type: 'result';
  corners: Float32Array | null;
  qualityInput: RawQualityInput;
  /** Eco del ts del request (cálculo de latencia en UI). */
  ts: number;
}

/** UI → Worker: recortar la foto con el quad final (F3-c, PLAN_MAESTRO §F3).
 *  `quad` = 8 floats (x,y × TL,TR,BR,BL) en FRACCIONES 0–1 de la foto (mismo
 *  convenio que ResultReply.corners). `bitmap` viaja como TRANSFERABLE
 *  (el worker lo cierra tras leerlo; el main thread pierde acceso).
 *  [F5-RAW, 2026-10-01] `mode` (ADITIVO, opcional): cuando es 'raw' el
 *  worker SALTA el unsharp del warp — fidelidad al sensor del "Original de
 *  cámara". Ausente = unsharp vigente (compatibilidad exacta con bundles
 *  viejos: no rompe nada).
 *  [F5-MANUAL, 2026-10-01] `manual: true` (ADITIVO, opcional): el quad lo
 *  colocó el HUMANO en el editor — el worker SALTA refineQuad (las bandas de
 *  Canny re-capturarían las esquinas hacia los bordes del papel que EL
 *  usuario movió a propósito) y SALTA el shrink 3.5px ("el manual respeta
 *  tus esquinas al píxel"). Ausente/false = camino auto (refine + shrink). */
export interface WarpRequest {
  type: 'warp';
  bitmap: ImageBitmap;
  quad: Float32Array;
  /** Timestamp del request (performance.now del main thread) para latencia. */
  ts: number;
  /** Modo global vigente (F5-RAW): 'raw' salta el unsharp del warp. */
  mode?: EnhanceMode;
  /** Quad editado por el humano (F5-MANUAL): sin refine, sin shrink. */
  manual?: boolean;
}

/** Worker → UI: página rectificada (F3-c). `bitmap` transferible de vuelta
 *  (el main lo cierra al consumirlo). `w/h` = dims de salida del warp.
 *  F3-b: `refinedQuad` = quad refinado en fracciones de foto (o el de entrada
 *  si todo cayó); `refined` = algún lado se ajustó; `fellBack[4]` = lados
 *  caídos al quad de entrada (blindaje 3, lo consume F4). */
export interface WarpResult {
  type: 'warped';
  bitmap: ImageBitmap;
  w: number;
  h: number;
  /** Eco del ts del request (cálculo de latencia en UI). */
  ts: number;
  refinedQuad: Float32Array | null;
  refined: boolean;
  fellBack: [boolean, boolean, boolean, boolean] | null;
}

/** UI → Worker: aplicar un modo de la cola multipágina (§5-F5) al warped.
 *  `bitmap` = warped RGBA (dims outW×outH): viaja como TRANSFERABLE. El modo
 *  es GLOBAL (per-page override PROHIBIDO — orden F5). */
export interface EnhanceRequest {
  type: 'enhance';
  bitmap: ImageBitmap;
  mode: EnhanceMode;
  /** Eco del ts del request (cálculo de latencia en UI). */
  ts: number;
  /** F6.5 (hallazgo validación humana: PDF 5.3MB/3págs > DoD 3MB): calidad
   *  JPEG opcional (0-1) para el encode del resultado. Ausente →
   *  JPEG_QUALITY (0.90, comportamiento idéntico al pre-F6.5). PNG la
   *  ignora. */
  quality?: number;
  /** F6.5: lado mayor máximo opcional del RESULTADO — el worker re-escala el
   *  bitmap ANTES del enhance (drawImage ya escala al pintar el canvas
   *  destino). 0/ausente = sin re-escala. Nunca amplía (scale ≤ 1). */
  maxLongSide?: number;
  /** M4b: overrides puntuales del modo (A/B de calibración desde el harness
   *  CER, p. ej. textBlackPoint 0 vs default). Ausente = constantes vigentes.
   *  Nunca lo usa la cola de producción (el modo es GLOBAL y fijo). */
  opts?: import('../workers/enhanceJs').EnhanceOpts;
}

/** Worker → UI: resultado del enhance (§5-F5). `blob` ya ENCODE (mime según
 *  modo: jpeg q90 o png) — el main lo cierra al consumirlo... si un objeto
 *  Blob se cierra, en realidad es transferible por structured clone en
 *  postMessage como el resto; `w/h` = dims del bitmap de entrada. */
export interface EnhanceResult {
  type: 'enhanced';
  blob: Blob;
  mime: 'image/jpeg' | 'image/png';
  w: number;
  h: number;
  mode: EnhanceMode;
  elapsedMs: number;
  memory?: { jsHeapBytes: number | null; wasmBytes: number | null };
  /** Eco del ts del request (cálculo de latencia en UI). */
  ts: number;
}

/** Worker → UI: llegó un frame mientras procesaba → DESCARTADO (el descarte
 *  ES el mecanismo de backpressure; la UI además lo evita con su flag). */
export interface BusyReply {
  type: 'busy';
  ts: number;
}

/** Worker → UI: progreso de carga de OpenCV.js (importScripts es síncrono;
 *  solo hay hitos gruesos: 5% inicio, 100% queda cubierto por 'ready'). */
export interface BootMsg {
  type: 'boot';
  pct: number;
}

/** Worker → UI: OpenCV.js listo (onRuntimeInitialized). */
export interface ReadyMsg {
  type: 'ready';
  /** Sondeo de la superficie real de opencv.js 4.5.5 (D-F5 — evidencia del
   *  enhance JS puro): qué símbolos existen de verdad en el namespace `cv`
   *  cargado. OPCIONAL y ADITIVO: los consumidores que solo miran `type`
   *  siguen funcionando. */
  probe?: CvProbe;
  /** URL de la que SE CARGÓ opencv.js (F6 — observabilidad: en dispositivo se
   *  ve si vino del vendor self-hosted o del CDN). OPCIONAL y ADITIVO. */
  opencvUrl?: string;
}

/** Resultado del sondeo de superficie de opencv.js (D-F5). Cada campo = ¿existe
 *  el símbolo en el namespace `cv`? Aditivo a 'ready' para el reporte F5. */
export interface CvProbe {
  createCLAHE: boolean;
  COLOR_RGBA2Lab: boolean;
  COLOR_RGB2Lab: boolean;
  COLOR_Lab2RGB: boolean;
  dilate: boolean;
  erode: boolean;
  divide: boolean;
  medianBlur: boolean;
  threshold: boolean;
  morphologyEx: boolean;
  getStructuringElement: boolean;
  MORPH_RECT: boolean;
  MORPH_CLOSE: boolean;
  resize: boolean;
  INTER_AREA: boolean;
  INTER_LINEAR: boolean;
  boxFilter: boolean;
  blur: boolean;
  split: boolean;
  merge: boolean;
}

/** Worker → UI: fallo (red al cargar opencv.js o excepción en pipeline). */
export interface ErrorMsg {
  type: 'error';
  message: string;
}

/** UI → Worker: [R4-B2] config en caliente del perfil de priores de
 *  selectQuad (docProfile). ADITIVO: los workers con bundle viejo lo
 *  ignoran sin romperse (tipo desconocido → no-op), y los nuevos nacen
 *  con 'auto' — el main re-aplica el perfil tras crear cada worker. No
 *  lleva bitmap ni interfere con el backpressure (no toca `busy`). */
export interface ConfigRequest {
  type: 'config';
  docProfile?: DocProfile;
}

export type WorkerIn = DetectRequest | WarpRequest | EnhanceRequest | ConfigRequest;
export type WorkerOut =
  | ResultReply
  | WarpResult
  | EnhanceResult
  | BusyReply
  | BootMsg
  | ReadyMsg
  | ErrorMsg;
