// src/workers/detection.worker.ts — esqueleto funcional del worker (T4).
// Carga OpenCV.js REAL (importScripts + onRuntimeInitialized) con protocolo
// boot/ready/error; procesa frames con backpressure por descarte ({type:'busy'});
// todo cv.Mat dentro de withMats() vía pipeline.processFrame().
// STUB: corners siempre null (F1 conecta el QuadDetector); el E2E mide el
// throughput REAL del preproceso 480p en WASM.
//
// Nota de tipos: tsconfig solo incluye lib DOM (sin WebWorker), así que el
// scope se declara mínimo aquí en vez de tocar la config global.

import type { Quadrilateral } from '../core/types';
import { computeWarpDims, shrinkQuad, SHRINK_QUAD_PX } from '../core/warp';
import type { CvApi } from './pipeline';
import { applyMode, processFrame, refineQuad, setDocProfile, unsharpRgba, warpPage } from './pipeline';
import type { WorkerIn, WorkerOut, CvProbe } from './protocol';
import { opencvCandidateUrls } from './protocol';
import { enhanceMime, JPEG_QUALITY } from '../core/imageModes';

// NOTA (T4): este worker se instancia como CLASSIC worker
// (`new Worker(url)` sin type:module) porque OpenCV.js es UMD y se carga con
// importScripts (inexistente en module workers; el fetch alternativo exigiría
// CORS que el CDN oficial no envía). Vite bundling (dev con ?worker o build
// prod) resuelve los imports ESM del resto del archivo.

declare function importScripts(...urls: string[]): void;

interface WorkerScope {
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerIn>) => void) | null;
}

declare const self: WorkerScope & {
  [k: string]: unknown;
};

function post(msg: WorkerOut, transfer?: Transferable[]): void {
  self.postMessage(msg, transfer);
}

function memorySnapshot(): { jsHeapBytes: number | null; wasmBytes: number | null } {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const memory = (cvRuntime as { memory?: { buffer?: ArrayBuffer } } | null)?.memory;
  return {
    jsHeapBytes: perf.memory?.usedJSHeapSize ?? null,
    wasmBytes: memory?.buffer?.byteLength ?? null,
  };
}

/** Adapta el namespace cv global (any: OpenCV.js no trae tipos) a CvApi. */
function adaptCv(cv: {
  COLOR_RGBA2GRAY: number;
  RETR_LIST: number;
  RETR_EXTERNAL: number;
  CHAIN_APPROX_SIMPLE: number;
  CV_64F: number;
  CV_32F: number;
  INTER_CUBIC: number;
  MORPH_RECT: number;
  matFromImageData(img: ImageData): never;
  matFromArray(rows: number, cols: number, type: number, arr: number[]): { delete(): void };
  Mat: new () => never;
  MatVector: new () => never;
  Size: new (w: number, h: number) => never;
  Rect: new (x: number, y: number, w: number, h: number) => never;
  Point: new (x: number, y: number) => never;
  cvtColor(...a: never[]): void;
  GaussianBlur(...a: never[]): void;
  Canny(...a: never[]): void;
  findContours(...a: never[]): void;
  contourArea(...a: never[]): number;
  arcLength(...a: never[]): number;
  approxPolyDP(...a: never[]): void;
  Laplacian(...a: never[]): void;
  meanStdDev(...a: never[]): void;
  getPerspectiveTransform(...a: never[]): never;
  warpPerspective(...a: never[]): void;
  addWeighted(...a: never[]): void;
  getStructuringElement(...a: never[]): never;
  dilate(...a: never[]): void;
}): CvApi {
  return {
    COLOR_RGBA2GRAY: cv.COLOR_RGBA2GRAY,
    RETR_LIST: cv.RETR_LIST,
    RETR_EXTERNAL: cv.RETR_EXTERNAL,
    CHAIN_APPROX_SIMPLE: cv.CHAIN_APPROX_SIMPLE,
    CV_64F: cv.CV_64F,
    matFromImageData: (img) => cv.matFromImageData(img) as never as ReturnType<CvApi['matFromImageData']>,
    createMat: () => new cv.Mat() as never as ReturnType<CvApi['createMat']>,
    createMatVector: () => new cv.MatVector() as never as ReturnType<CvApi['createMatVector']>,
    createSize: (w, h) => new cv.Size(w, h) as never as ReturnType<CvApi['createSize']>,
    cvtColor: (s, d, c) => cv.cvtColor(s as never, d as never, c as never),
    GaussianBlur: (s, d, k, x, y) =>
      cv.GaussianBlur(s as never, d as never, k as never, x as never, y as never),
    Canny: (s, d, t1, t2) => cv.Canny(s as never, d as never, t1 as never, t2 as never),
    findContours: (img, c, h, m1, m2) =>
      cv.findContours(img as never, c as never, h as never, m1 as never, m2 as never),
    contourCount: (v) => (v as unknown as { size(): number }).size(),
    getContour: (v, i) =>
      (v as unknown as { get(idx: number): unknown }).get(i) as ReturnType<
        CvApi['getContour']
      >,
    contourArea: (m) => cv.contourArea(m as never),
    arcLength: (m, closed) => cv.arcLength(m as never, closed as never),
    approxPolyDP: (s, d, eps, closed) =>
      cv.approxPolyDP(s as never, d as never, eps as never, closed as never),
    Laplacian: (s, d, depth) => cv.Laplacian(s as never, d as never, depth as never),
    meanStdDev: (s, m, v) => cv.meanStdDev(s as never, m as never, v as never),
    roi: (m, r) =>
      (m as unknown as { roi(rect: unknown): unknown }).roi(
        new cv.Rect(r.x, r.y, r.width, r.height),
      ) as ReturnType<CvApi['roi']>,
    INTER_CUBIC: cv.INTER_CUBIC,
    // Los Mats 4×2 temporales nacen y mueren AQUÍ (try/finally); el H
    // retornado lo registra el llamador en withMats().
    getPerspectiveTransform: (src, dst) => {
      const flat = (q: Quadrilateral): number[] => [
        q[0]!.x, q[0]!.y, q[1]!.x, q[1]!.y,
        q[2]!.x, q[2]!.y, q[3]!.x, q[3]!.y,
      ];
      const s = cv.matFromArray(4, 2, cv.CV_32F, flat(src));
      const d = cv.matFromArray(4, 2, cv.CV_32F, flat(dst));
      try {
        return cv.getPerspectiveTransform(s as never, d as never) as never as ReturnType<
          CvApi['getPerspectiveTransform']
        >;
      } finally {
        s.delete();
        d.delete();
      }
    },
    warpPerspective: (src, dst, M, dsize, flags) => {
      // cv.Size es un objeto plano (sin .delete) — solo los Mats se borran.
      const size = new cv.Size(dsize.width, dsize.height);
      cv.warpPerspective(
        src as never,
        dst as never,
        M as never,
        size as never,
        flags as never,
      );
    },
    addWeighted: (s1, a, s2, b, g, dst) =>
      cv.addWeighted(s1 as never, a as never, s2 as never, b as never, g as never, dst as never),
    // [F5-CROP fallback] dilatación del edge map (3×3 ×N) para puentear
    // los gaps del borde de un papel inclinado (evidencia issue #2).
    MORPH_RECT: cv.MORPH_RECT,
    getStructuringElement: (shape, ksize) =>
      cv.getStructuringElement(shape as never, new cv.Size(ksize.width, ksize.height) as never) as never as ReturnType<
        CvApi['getStructuringElement']
      >,
    dilate: (src, dst, kernel, iterations) =>
      cv.dilate(
        src as never,
        dst as never,
        kernel as never,
        new cv.Point(-1, -1) as never,
        iterations as never,
      ),
    // COPIA a Uint8ClampedArray: el buffer WASM se reutiliza tras withMats().
    matDataRGBA: (m, w, h) => {
      const raw = (m as unknown as { data: Uint8Array }).data;
      if (raw.length < w * h * 4) throw new Error('matDataRGBA: Mat menor que la salida');
      return new Uint8ClampedArray(raw.slice(0, w * h * 4));
    },
    // COPIA U8 de un canal (mapa Canny 0/255): mismo buffer reutilizable.
    matDataU8: (m, w, h) => {
      const raw = (m as unknown as { data: Uint8Array }).data;
      if (raw.length < w * h) throw new Error('matDataU8: Mat menor que la banda');
      return raw.slice(0, w * h);
    },
  };
}

let cvApi: CvApi | null = null;
let cvRuntime: unknown = null;
let busy = false;
let canvas: OffscreenCanvas | null = null;
let warpCanvas: OffscreenCanvas | null = null;
let enhanceCanvas: OffscreenCanvas | null = null;

/** Sondeo de la superficie real de opencv.js cargado (D-F5). Verifica la
 *  tesis del explorador ("opencv.js 4.5.5 NO expone createCLAHE ni
 *  COLOR_*Lab; dilate/erode/divide/threshold tampoco de forma fiable") con
 *  dato duro: el nombre existe (typeof function) o el código es número.
 *  El RESULTADO viaja en 'ready' → reporte F5 (harness). */
function probeCvSurface(cv: unknown): CvProbe {
  const isFn = (k: string): boolean => {
    const v = (cv as Record<string, unknown>)[k];
    return typeof v === 'function';
  };
  const isNum = (k: string): boolean => {
    const v = (cv as Record<string, unknown>)[k];
    return typeof v === 'number';
  };
  return {
    createCLAHE: isFn('createCLAHE'),
    COLOR_RGBA2Lab: isNum('COLOR_RGBA2Lab'),
    COLOR_RGB2Lab: isNum('COLOR_RGB2Lab'),
    COLOR_Lab2RGB: isNum('COLOR_Lab2RGB'),
    dilate: isFn('dilate'),
    erode: isFn('erode'),
    divide: isFn('divide'),
    medianBlur: isFn('medianBlur'),
    threshold: isFn('threshold'),
    morphologyEx: isFn('morphologyEx'),
    getStructuringElement: isFn('getStructuringElement'),
    MORPH_RECT: isNum('MORPH_RECT'),
    MORPH_CLOSE: isNum('MORPH_CLOSE'),
    resize: isFn('resize'),
    INTER_AREA: isNum('INTER_AREA'),
    INTER_LINEAR: isNum('INTER_LINEAR'),
    boxFilter: isFn('boxFilter'),
    blur: isFn('blur'),
    split: isFn('split'),
    merge: isFn('merge'),
  };
}

/** Fracciones 0–1 bien formadas (copia local: el worker no importa de scan/). */
function isFractions8(c: Float32Array | null | undefined): c is Float32Array {
  if (c === null || c === undefined || c.length !== 8) return false;
  for (let i = 0; i < 8; i++) {
    if (!Number.isFinite(c[i])) return false;
  }
  return true;
}

post({ type: 'boot', pct: 5 });

/** F6: carga opencv.js de la cadena de candidatos (vendor self-hosted primero,
 *  CDN al final). `importScripts` lanza si la red/HTTP falla → se prueba el
 *  siguiente. Devuelve la URL que SIRVIÓ (observabilidad en dispositivo). */
function loadOpenCv(): string {
  // self.location está sin tipar en el lib de worker del proyecto (hallazgo tsc)
  const wself = self as unknown as { location: { href: string } };
  const candidates = opencvCandidateUrls(wself.location.href);
  const tried: string[] = [];
  for (const url of candidates) {
    try {
      tried.push(url);
      importScripts(url);
      return url;
    } catch {
      // 404 (vendor ausente en este layout) o red/Cloudflare (CDN) → siguiente
    }
  }
  throw new Error(`carga opencv.js falló en ${tried.length} candidatos: ${tried.join(' | ')}`);
}

/** URL de la que efectivamente cargó opencv.js (F6 — viaja en 'ready'). */
let opencvLoadedUrl: string;

try {
  const holder = self as { Module?: { onRuntimeInitialized?: () => void } };
  holder.Module = holder.Module ?? {};
  holder.Module.onRuntimeInitialized = () => {
    const cv = self['cv'];
    if (cv === undefined || cv === null) {
      post({ type: 'error', message: 'opencv.js cargó pero `cv` es undefined' });
      return;
    }
    cvRuntime = cv;
    cvApi = adaptCv(cv as Parameters<typeof adaptCv>[0]);
    post({ type: 'ready', probe: probeCvSurface(cv), opencvUrl: opencvLoadedUrl });
  };
  // importScripts es síncrono y no necesita CORS (script clásico). F6: la
  // cadena de candidatos prueba vendor self-hosted primero y CDN al final; la
  // URL que SIRVIÓ viaja en 'ready' (opencvUrl) para verla en dispositivo.
  opencvLoadedUrl = loadOpenCv();
} catch (e) {
  post({ type: 'error', message: `carga opencv.js falló: ${e instanceof Error ? e.message : String(e)}` });
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  // [R4-B2] Config en caliente del perfil de priores: PRIMERO y sin tocar
  // busy (no procesa píxeles — solo estado de módulo), así NUNCA interfiere
  // con el backpressure por descarte. Aditivo: los mensajes 'config' hacia
  // un bundle viejo simplemente se ignoran.
  if (msg.type === 'config') {
    setDocProfile(msg.docProfile ?? 'auto');
    return;
  }
  if (msg.type === 'warp') {
    handleWarp(msg);
    return;
  }
  if (msg.type === 'enhance') {
    handleEnhance(msg);
    return;
  }
  if (msg.type !== 'detect') return;
  if (cvApi === null) return; // aún cargando: se descarta (backpressure total)
  if (busy) {
    post({ type: 'busy', ts: msg.ts });
    return;
  }
  busy = true;
  const bitmap = msg.bitmap;
  try {
    if (canvas === null || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('OffscreenCanvas 2d null');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const reply = processFrame(cvApi, imageData, bitmap.width, bitmap.height, msg.ts);
    post(reply);
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    try {
      bitmap.close();
    } catch {
      // bitmap ya cerrado/neutered: nada que hacer
    }
    busy = false;
  }
};

/** Rama F3-c: rectifica la foto con el quad final. Mismo backpressure que
 *  'detect' (busy → 'busy'; cv aún cargando → descarte). Un fallo NUNCA
 *  congela el worker (lección F1-a: busy se resetea en finally, también en
 *  'error' — el orquestador lo trata como warp nulo y sigue con la cruda). */
function handleWarp(msg: Extract<WorkerIn, { type: 'warp' }>): void {
  if (cvApi === null) return; // aún cargando: se descarta (backpressure total)
  if (busy) {
    post({ type: 'busy', ts: msg.ts });
    return;
  }
  busy = true;
  const bitmap = msg.bitmap;
  try {
    if (!isFractions8(msg.quad)) throw new Error('warp: quad no son 8 fracciones finitas');
    if (!(bitmap.width > 0) || !(bitmap.height > 0)) throw new Error('warp: dims de foto inválidas');
    if (canvas === null || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('OffscreenCanvas 2d null');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const quadPx: Quadrilateral = [
      { x: msg.quad[0]! * bitmap.width, y: msg.quad[1]! * bitmap.height },
      { x: msg.quad[2]! * bitmap.width, y: msg.quad[3]! * bitmap.height },
      { x: msg.quad[4]! * bitmap.width, y: msg.quad[5]! * bitmap.height },
      { x: msg.quad[6]! * bitmap.width, y: msg.quad[7]! * bitmap.height },
    ];
    // F3-b: refinado ANTES de la homografía (el bitmap ya está decodificado;
    // un mensaje separado lo decodificaría dos veces). Si cae, sigue el quad
    // de entrada (blindaje 3) — el refinado NUNCA falla el warp.
    // [F5-MANUAL, 2026-10-01] quad colocado por el humano: SIN refine (las
    // bandas de Canny ±30px re-capturarían las esquinas hacia los bordes del
    // papel que el usuario movió a propósito — "muevo las esquinas y nada
    // cambia") y SIN shrink 3.5px (las esquinas del humano mandan al píxel).
    // fellBack null = "sin refinado" (assembleRefinedQuad y fbOf lo toleran).
    const manual = msg.manual === true;
    let refQuad = quadPx;
    let fellBack: [boolean, boolean, boolean, boolean] | null = [true, true, true, true];
    if (!manual) {
      try {
        const ref = refineQuad(cvApi, imageData, quadPx);
        refQuad = ref.quad;
        fellBack = ref.fellBack;
      } catch {
        // refine fuera de combate → entrada + 4/4 caído
      }
    } else {
      fellBack = null;
    }
    const refined = fellBack !== null && fellBack.some((f) => !f);
    // [R4-B1] shrink del quad refinado: inset uniforme de 3.5px por lado
    // ANTES de medir dims y aplicar la homografía — el filete de la mesa /
    // borde de tabla queda FUERA del recorte (port del prototipo). El
    // `refinedQuad` reportado al main sigue siendo el SIN shrink: el editor
    // muestra la DETECCIÓN, no el crop. Blindaje dentro de shrinkQuad: ante
    // esquinas agudas/no-finitas cae a la esquina original (nunca lanza).
    // [F5-MANUAL] el quad manual NO se contrae: el humano pidió ESAS esquinas.
    const shrunk = manual ? refQuad : shrinkQuad(refQuad, SHRINK_QUAD_PX);
    const dims = computeWarpDims(shrunk);
    // [F5-RAW-2, 2026-11 — petición humana] warp SIEMPRE puro (unsharp: false
    // para TODO modo): el bitmap que viaja al main se persiste tal cual al
    // agregar página, y el selector de modo puede CAMBIAR después de la
    // captura — si el unsharp se hornea aquí con el modo del momento,
    // "Original de cámara" seleccionado después no puede recuperarlo
    // (residuo de nitidez, mean diff 2-4/255 medido con las fotos reales).
    // El unsharp §F3 vive AHORA en handleEnhance (modo ≠ raw, ANTES de
    // applyMode — mismo orden visual histórico). msg.mode se conserva en el
    // protocolo (campo aditivo) para compatibilidad de bundles.
    const pix = warpPage(cvApi, imageData, shrunk, dims.w, dims.h, {
      unsharp: false,
    });
    if (warpCanvas === null || warpCanvas.width !== dims.w || warpCanvas.height !== dims.h) {
      warpCanvas = new OffscreenCanvas(dims.w, dims.h);
    }
    const octx = warpCanvas.getContext('2d');
    if (octx === null) throw new Error('OffscreenCanvas destino 2d null');
    // F3-e: warpPage retorna píxeles PLANOS (Node-testeable) — putImageData exige
    // un ImageData con marca del canvas; se construye aquí, no en el pipeline.
    const img = octx.createImageData(dims.w, dims.h);
    img.data.set(pix.data);
    octx.putImageData(img, 0, 0);
    const outBitmap = warpCanvas.transferToImageBitmap();
    const refinedQuad = new Float32Array(8);
    for (let i = 0; i < 4; i++) {
      refinedQuad[2 * i] = refQuad[i]!.x / bitmap.width;
      refinedQuad[2 * i + 1] = refQuad[i]!.y / bitmap.height;
    }
    post(
      {
        type: 'warped',
        bitmap: outBitmap,
        w: dims.w,
        h: dims.h,
        ts: msg.ts,
        refinedQuad,
        refined,
        // [F5-MANUAL] null = sin refinado (quad manual): el consumidor
        // (assembleRefinedQuad/fbOf/app mRef) ya tolera null ("sin info").
        fellBack:
          fellBack === null
            ? null
            : ([...fellBack] as [boolean, boolean, boolean, boolean]),
      },
      [outBitmap],
    );
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    try {
      bitmap.close();
    } catch {
      // bitmap ya cerrado/neutered: nada que hacer
    }
    busy = false;
  }
}

/** Rama F5: aplica el modo (§5-F5) al warped y devuelve el Blob ENCODE
 *  (mime según modo: jpeg q90 o png — §F5). Mismo backpressure (busy → 'busy',
 *  cv aún cargando → descarte). NO usa cv.Mat (D-F5: todo el enhance es JS
 *  puro en enhanceJs.ts; applyMode conserva `cv` en la firma por contrato). */
async function handleEnhance(msg: Extract<WorkerIn, { type: 'enhance' }>): Promise<void> {
  if (cvApi === null) return; // aún cargando: se descarta (backpressure total)
  if (busy) {
    post({ type: 'busy', ts: msg.ts });
    return;
  }
  busy = true;
  const startedAt = performance.now();
  const bitmap = msg.bitmap;
  try {
    if (!(bitmap.width > 0) || !(bitmap.height > 0)) {
      throw new Error('enhance: dims de warped inválidas');
    }
    // F6.5: re-escala opcional ANTES del enhance (maxLongSide del request).
    // drawImage con destino menor YA reduce (el navegador interpola); nunca
    // amplía (scale ≤ 1) y respeta dims inválidas → 1px mínimo.
    const maxLong = msg.maxLongSide ?? 0;
    const scale = maxLong > 0 ? Math.min(1, maxLong / Math.max(bitmap.width, bitmap.height)) : 1;
    const tw = Math.max(1, Math.round(bitmap.width * scale));
    const th = Math.max(1, Math.round(bitmap.height * scale));
    if (canvas === null || canvas.width !== tw || canvas.height !== th) {
      canvas = new OffscreenCanvas(tw, th);
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('OffscreenCanvas 2d null (enhance)');
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, tw, th);
    const imageData = ctx.getImageData(0, 0, tw, th);
    // [F5-RAW-2, 2026-11] unsharp §F3 AQUÍ (modo ≠ raw), ANTES de applyMode:
    // el stored ya no trae el enfoque horneado del warp (ver handleWarp).
    // Blindaje: si unsharpRgba falla o devuelve otro tamaño, el enhance
    // continúa SIN él (nunca rompe la cola); 'raw' JAMÁS lo recibe
    // (fidelidad al sensor — petición humana).
    let src: Uint8ClampedArray = imageData.data;
    if (msg.mode !== 'raw') {
      try {
        const sharp = unsharpRgba(cvApi, imageData);
        if (sharp.data.length === src.length) src = sharp.data;
      } catch {
        /* sin unsharp: applyMode solo */
      }
    }
    const pix = applyMode(cvApi, src, msg.mode, tw, th, msg.opts ?? {});
    if (pix.data.length === 0) throw new Error('enhance: salida vacía (dims no cuadran)');
    const mime = enhanceMime(msg.mode);
    if (enhanceCanvas === null || enhanceCanvas.width !== tw || enhanceCanvas.height !== th) {
      enhanceCanvas = new OffscreenCanvas(tw, th);
    }
    const octx = enhanceCanvas.getContext('2d');
    if (octx === null) throw new Error('OffscreenCanvas destino 2d null (enhance)');
    const img = octx.createImageData(tw, th);
    img.data.set(pix.data);
    octx.putImageData(img, 0, 0);
    // convertToBlob es async: el busy se libera tras el fetch del blob
    // (el yoyo bitmap→canvas→blob es el único encode del pipeline F5).
    // F6.5: calidad JPEG parametrizable (export adaptativo); ausente → 0.90.
    const quality = msg.quality ?? JPEG_QUALITY;
    const blob = await enhanceCanvas.convertToBlob({
      type: mime,
      quality: mime === 'image/jpeg' ? quality : undefined,
    });
    post({
      type: 'enhanced',
      blob,
      mime,
      w: tw,
      h: th,
      mode: msg.mode,
      elapsedMs: performance.now() - startedAt,
      memory: memorySnapshot(),
      ts: msg.ts,
    });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    try {
      bitmap.close();
    } catch {
      // bitmap ya cerrado/neutered: nada que hacer
    }
    busy = false;
  }
}
