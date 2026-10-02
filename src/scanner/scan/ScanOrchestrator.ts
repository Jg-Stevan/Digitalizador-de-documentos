// src/scan/ScanOrchestrator.ts — FSM + score en vivo + burst-rank + manual (F2)
// + re-detección sobre la foto (F3-a).
// Consume quality.ts (APROBADO, sin editar) y scoring.ts puro. El worker SOLO
// manda crudos (prohibido tocar pipeline F1): el histograma de exposición se
// muestrea en el main thread (frame completo a ~160px, barato) porque el
// protocolo no lo trae — desviación documentada, consistente con la de
// revalidación. F3-a: la foto ganadora se re-detecta (DetectRequest al worker,
// quad en coords de foto) y se revalida sobre su downscale; el quad del stream
// queda como prior (F4 lo edita si needsEditorReview).
// Deps inyectables (patrón T5) → unit sin navegador. Sin setInterval.

import type { EnhanceMode, Quadrilateral, QualityScore } from '../core/types';
import {
  BLUR_THRESHOLD,
  SHUTTER_SPAN_MS,
  STABILITY_WINDOW_MS,
  computeEccentricityScore,
  computeExposureScore,
  computeSharpnessScore,
  computeStabilityScore,
  computeTotalScore,
  detectionTimedOut,
  shouldTriggerShutter,
} from '../core/quality';
import { quadBoundingBox, scaleQuad, sanitizeManualQuad } from '../core/geometry';
import type { DetectRequest, RawQualityInput, WarpRequest } from '../workers/protocol';
import { computeProcessDims } from '../workers/protocol';
import { assembleRefinedQuad, needsEditorReview } from './cornerRefiner';
import { measureFrame, selectHint, underOverRatios } from './scoring';

export type ScanState =
  | 'idle'
  | 'detecting'
  | 'capturing'
  | 'revalidating'
  | 'captured'
  | 'editing';

export type CaptureRouteTag = 'A' | 'B' | 'burst';

/** Candidato del burst: bitmap vivo + dims + ruta (el perdedor se cierra). */
export interface BurstCandidate {
  bitmap: ImageBitmap;
  w: number;
  h: number;
  route: CaptureRouteTag;
}

/** Foto ganadora (F3-a): bitmap hi-res + quad re-detectado SOBRE la foto en
 *  coordenadas de foto (px). `quadPrior` = quad del stream en fracciones
 *  (SOLO prior/ROI — la orden lo llama priorQuad; se conserva el nombre
 *  existente por compatibilidad con el harness F2). Sin quad en la foto →
 *  fallback al prior escalado a la foto + needsEditorReview (lo consume F4).
 *  Hook F3-b: el CornerRefiner refinará `quad` aquí (hoy pasa sin refinar). */
export interface CapturedPhoto {
  bitmap: ImageBitmap;
  quad: Quadrilateral | null;
  quadPrior: Float32Array | null;
  frameW: number;
  frameH: number;
  revalScore: number;
  ts: number;
  route: CaptureRouteTag;
  needsEditorReview: boolean;
  /** Página rectificada (F3-c): null si no hubo quad o el warp falló — la
   *  captura SIGUE con la cruda (F4 necesita bitmap+quad para re-warp). */
  warped: ImageBitmap | null;
  warpW: number;
  warpH: number;
  /** Quad refinado del WarpResult en coords de foto (F3-b; null si no hubo
   *  warp o el worker no devolvió quad). `quad`/`quadPrior` NO cambian. */
  quadRefined: Quadrilateral | null;
  /** Quad ajustado por el editor F4 en coords de foto (px). Ausente hasta que
   *  el humano confirma un ajuste (submitEditedQuad). `quad`/`quadRefined`
   *  NO cambian con el edit: el auto original sigue disponible para
   *  dataCollect F6.5 (autoQuad = quadRefined ?? quad; regla anti-sesgo). */
  adjustedQuad?: Quadrilateral;
}

export interface ScoreView {
  total: number;
  hint: string | null;
  isBlur: boolean;
  state: ScanState;
}

export interface OrchestratorDeps {
  now(): number;
  /** Hist del frame actual para exposición (null si el video no está listo). */
  sampleExposure(): { hist: number[] } | null;
  /** 2 frames del stream a resolución del track (ruta B). */
  captureBurstFrames(n: number): Promise<BurstCandidate[]>;
  /** 1 takePhoto/drawImage hi-res (null si la ruta A no existe en el device). */
  capturePhoto(): Promise<BurstCandidate | null>;
  /** Downscale a 400-clase para revalidar (computeProcessDims). */
  downscale(bitmap: ImageBitmap, w: number, h: number): Promise<ImageData>;
  /** Bitmap 400-clase de la foto para re-detectar (prod: createImageBitmap
   *  con resize — mismo camino que frameLoop.capture; el worker lo cierra). */
  photoProcessBitmap(bitmap: ImageBitmap, w: number, h: number): Promise<ImageBitmap>;
  /** Re-detección sobre la foto: recibe el DetectRequest y resuelve los
   *  corners en fracciones (o null). Default: null (sin worker cableado →
   *  fallback al prior). El cableado real UI→worker vive en la app. */
  detectPhoto(req: DetectRequest): Promise<Float32Array | null>;
  /** Warp de la foto con el quad final (F3-c): recibe el WarpRequest y
   *  resuelve el bitmap rectificado + dims, o null. Default: null (sin
   *  worker cableado → la captura sigue con la cruda). CONTRATO DE CIERRE:
   *  el dep puede TRANSFERIR/cerrar el bitmap recibido (el worker real lo
   *  cierra); el cableado prod envía una copia (createImageBitmap) si el
   *  crudo debe seguir vivo en CapturedPhoto.bitmap. */
  requestWarp(req: WarpRequest): Promise<{
    bitmap: ImageBitmap;
    w: number;
    h: number;
    refinedQuad: Float32Array | null;
    refined: boolean;
    fellBack: [boolean, boolean, boolean, boolean] | null;
  } | null>;
  /** Feedback de plataforma: 'haptic' si vibró, 'none' si debe flashear UI. */
  notify(kind: 'captured' | 'timeout'): 'haptic' | 'none';
  /** [F5-RAW, 2026-10-01] Modo global vigente de la cola (para decidir si el
   *  warp salta el unsharp en modo 'raw'). Opcional: ausente → 'color'
   *  (unsharp activo — comportamiento pre-F5 exacto, compatible con mocks
   *  de test que no lo cablean). */
  getMode?(): EnhanceMode;
}

/** Gate de revalidación de exposición (F2, ingeniería — ver comentario). */
export const REVAL_MIN_EXPOSURE_SCORE = 0.5;
/** Cooldown post-captura anti doble-disparo (spec F2 Fase 3). */
export const CAPTURE_COOLDOWN_MS = 1500;
/** Ancho del sampler de exposición en main thread (barato, ~160px). */
export const EXPOSURE_SAMPLE_W = 160;

export interface OrchestratorEvents {
  onState(state: ScanState): void;
  onScore(score: ScoreView): void;
  onCaptured(photo: CapturedPhoto): void;
  /** F4: la captura se re-warped (ajuste del editor confirmado o revertido).
   *  `photo` = copia actualizada de la captura (mismo bitmap, nuevo warped;
   *  `adjustedQuad` presente solo si el humano confirmó). */
  onEdited(photo: CapturedPhoto): void;
  onRetry(reason: string): void;
  onTimeout(): void;
}

interface QuadSample {
  t: number;
  quad: Quadrilateral;
}
interface ScoreSample {
  t: number;
  score: number;
}

/** Fracciones 0–1 (Float32Array TL,TR,BR,BL) → quad EN PÍXELES (w×h).
 *  Exportado para F4: el editor trabaja en fracciones y el FSM re-warpéa
 *  con px→fracciones vía quadToFractions (mismos helpers que la detección). */
export function fractionsToQuad(c: Float32Array, w: number, h: number): Quadrilateral {
  return [
    { x: c[0]! * w, y: c[1]! * h },
    { x: c[2]! * w, y: c[3]! * h },
    { x: c[4]! * w, y: c[5]! * h },
    { x: c[6]! * w, y: c[7]! * h },
  ];
}

export function quadToFractions(q: Quadrilateral, w: number, h: number): Float32Array {
  const out = new Float32Array(8);
  for (let i = 0; i < 4; i++) {
    out[2 * i] = q[i]!.x / w;
    out[2 * i + 1] = q[i]!.y / h;
  }
  return out;
}

export interface OrchestratorOptions {
  video?: HTMLVideoElement;
  deps?: Partial<OrchestratorDeps>;
  events?: Partial<OrchestratorEvents>;
  cooldownMs?: number;
}

export class ScanOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly events: OrchestratorEvents;
  private readonly cooldownMs: number;
  private state: ScanState = 'idle';
  private quadHistory: QuadSample[] = [];
  private scoreHistory: ScoreSample[] = [];
  private firstAttempt = 0;
  private lastExposureScore = 1;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCorners: Float32Array | null = null;
  /** Dims del frame que produjo lastCorners (para escalar el prior a la foto). */
  private lastFrameW = 0;
  private lastFrameH = 0;
  /** Última captura aceptada (F4): la guarda el FSM para editar/re-warpéar.
   *  Se reemplaza en cada captura nueva; nunca se muta el objeto emitido
   *  (submitEditedQuad emite una COPIA actualizada). */
  private currentPhoto: CapturedPhoto | null = null;

  constructor(opts: OrchestratorOptions = {}) {
    const video = opts.video;
    this.cooldownMs = opts.cooldownMs ?? CAPTURE_COOLDOWN_MS;
    this.deps = {
      now: () => performance.now(),
      sampleExposure: () => {
        if (video === undefined || video.videoWidth === 0) return null;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        // F2-a Fix 1: histograma sobre el CROP del quad del stream (bbox +
        // 5% de margen; lastCorners se actualiza antes de muestrear, así que
        // es el quad del frame actual) — el frame completo hunde la exposición
        // con fondos oscuros (falso "Muy oscuro" del acta densa). Sin quad →
        // frame completo (comportamiento anterior).
        let sx = 0;
        let sy = 0;
        let sw = vw;
        let sh = vh;
        const qc = this.lastCorners;
        if (qc !== null && qc.length === 8) {
          let minX = 1;
          let minY = 1;
          let maxX = 0;
          let maxY = 0;
          let ok = true;
          for (let i = 0; i < 4; i++) {
            const x = qc[2 * i]!;
            const y = qc[2 * i + 1]!;
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              ok = false;
              break;
            }
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          if (ok && maxX > minX && maxY > minY) {
            const mx = 0.05 * vw;
            const my = 0.05 * vh;
            sx = Math.max(0, Math.floor(minX * vw - mx));
            sy = Math.max(0, Math.floor(minY * vh - my));
            sw = Math.max(1, Math.min(vw, Math.ceil(maxX * vw + mx)) - sx);
            sh = Math.max(1, Math.min(vh, Math.ceil(maxY * vh + my)) - sy);
          }
        }
        const w = EXPOSURE_SAMPLE_W;
        const h = Math.max(1, Math.round((sh / sw) * w));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (ctx === null) return null;
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h);
        const hist = new Array<number>(256).fill(0);
        for (let i = 0; i < d.data.length; i += 4) {
          hist[(d.data[i]! * 77 + d.data[i + 1]! * 150 + d.data[i + 2]! * 29) >> 8]! += 1;
        }
        return { hist };
      },
      captureBurstFrames: async (n: number) => {
        if (video === undefined) throw new Error('burst sin video');
        const out: BurstCandidate[] = [];
        for (let k = 0; k < n; k++) {
          const w = video.videoWidth;
          const h = video.videoHeight;
          const bitmap = await createImageBitmap(video);
          out.push({ bitmap, w, h, route: 'B' });
        }
        return out;
      },
      capturePhoto: async () => null,
      downscale: async (bitmap: ImageBitmap, w: number, h: number) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (ctx === null) throw new Error('downscale: ctx null');
        ctx.drawImage(bitmap, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
      },
      photoProcessBitmap: async (bitmap: ImageBitmap, w: number, h: number) => {
        const crib = (
          globalThis as unknown as {
            createImageBitmap?: (
              b: ImageBitmap,
              o: ImageBitmapOptions,
            ) => Promise<ImageBitmap>;
          }
        ).createImageBitmap;
        if (typeof crib !== 'function') throw new Error('photoProcessBitmap sin createImageBitmap');
        return crib(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
      },
      detectPhoto: async () => null,
      requestWarp: async () => null,
      notify: (kind: 'captured' | 'timeout') => {
        if (kind === 'timeout') return 'none'; // F2-b: vibración SOLO en captura (antes vibraba también en timeout cada 8s → indistinguible; toast ya avisa)
        try {
          const nav = navigator as Navigator & { vibrate?: (p: number) => boolean };
          if (typeof nav.vibrate === 'function' && nav.vibrate(50)) return 'haptic';
        } catch {
          // iOS: sin vibrate → la UI flashea el overlay (skill ios-camera-quirks)
        }
        return 'none';
      },
      ...opts.deps,
    };
    const noop = (): void => {};
    this.events = {
      onState: noop,
      onScore: noop,
      onCaptured: noop,
      onEdited: noop,
      onRetry: noop,
      onTimeout: noop,
      ...opts.events,
    };
  }

  getState(): ScanState {
    return this.state;
  }

  start(): void {
    this.stopTimer();
    this.setState('detecting');
    this.firstAttempt = this.deps.now();
    this.quadHistory = [];
    this.scoreHistory = [];
    this.lastCorners = null; // sin quad heredado (el sampler arranca full-frame)
    this.lastFrameW = 0;
    this.lastFrameH = 0;
  }

  stop(): void {
    this.stopTimer();
    this.currentPhoto = null;
    this.setState('idle');
  }

  /** F6.4 (background): re-arma el plazo de 8s sin tocar el estado. Al volver
   *  de segundo plano los frames estuvieron congelados — sin esto, el primer
   *  resultado dispararía el toast de timeout por tiempo oculto, no por falta
   *  de detección real. No-op fuera de 'detecting' (no interrumpe editor). */
  extendDeadline(): void {
    if (this.state === 'detecting') {
      this.firstAttempt = this.deps.now();
    }
  }

  /** Dispara el timeout de no-detección: 8s sin quad → toast. F2-b: sin
   *  vibración (solo visual — vibrar en timeout cada 8s era indistinguible de
   *  la captura y el humano lo reportó como confusión). */
  onWorkerResult(q: RawQualityInput, corners: Float32Array | null, ts: number): void {
    if (this.state !== 'detecting') return;
    this.lastCorners = corners;
    this.lastFrameW = q.frameW;
    this.lastFrameH = q.frameH;

    const lapVar = q.laplacianVar ?? 0;
    const sharpness = computeSharpnessScore(lapVar);

    const sample = this.deps.sampleExposure();
    let exposureScore = this.lastExposureScore;
    let specularWarn = false;
    let under = 0;
    let over = 0;
    if (sample !== null) {
      const e = computeExposureScore(sample.hist);
      exposureScore = e.score;
      specularWarn = e.specularWarn;
      this.lastExposureScore = e.score;
      ({ under, over } = underOverRatios(sample.hist));
    }

    const now = this.deps.now();
    if (corners !== null) {
      this.quadHistory.push({ t: ts, quad: fractionsToQuad(corners, q.frameW, q.frameH) });
    }
    this.quadHistory = this.quadHistory.filter((s) => now - s.t <= STABILITY_WINDOW_MS + 200);
    const stability = computeStabilityScore(this.quadHistory, ts);

    const eccentricity =
      corners !== null ? computeEccentricityScore(fractionsToQuad(corners, q.frameW, q.frameH), q.frameW, q.frameH) : null;

    const total: QualityScore = computeTotalScore(
      { sharpness, exposure: exposureScore, stability, eccentricity },
      lapVar,
      0,
    );
    this.scoreHistory.push({ t: ts, score: total.total });
    this.scoreHistory = this.scoreHistory.filter((s) => now - s.t <= SHUTTER_SPAN_MS + 200);

    const hint = selectHint({
      hasQuad: corners !== null,
      eccentricity,
      specularWarn,
      underRatio: under,
      overRatio: over,
      stability,
    });
    this.events.onScore({ total: total.total, hint, isBlur: total.isBlur, state: this.state });

    if (shouldTriggerShutter(this.scoreHistory)) {
      void this.runBurst();
      return;
    }
    if (detectionTimedOut(this.firstAttempt, ts)) {
      this.firstAttempt = ts; // re-armar: un toast cada 8s, no spam
      this.deps.notify('timeout');
      this.events.onTimeout();
    }
  }

  /** Botón manual: misma ruta burst+revalidación; funciona sin quad.
   *  [F6-STAGING, 2026-11 — petición humana "no guarda el recorte"]: (a) la
   *  captura manual se RETIENE (staged, sin cooldown — el humano pidió ESA
   *  foto; la auto-captura no debe precipitarse a reemplazarla a los 1.5s);
   *  (b) se admite DESDE 'captured' como re-toma explícita (el shutter dejaba
   *  de estar "muerto" en la ventana post-captura). 'editing' sigue
   *  protegido (busy). Auto (onWorkerResult → runBurst sin stage): intacto. */
  async captureManual(): Promise<'captured' | 'retry' | 'busy'> {
    if (this.state !== 'detecting' && this.state !== 'captured') return 'busy';
    return this.runBurst(true);
  }

  // --- F4: edición manual de esquinas (estado 'editing') ---

  /** Abre el editor sobre la captura actual. SOLO desde 'captured' (la captura
   *  debe existir y el cooldown estar corriendo). AL CANCELAR EL COOLDOWN:
   *  el timer post-captura (ver armCooldown) se suspende mientras se edita —
   *  el usuario no debe ser expulsado a 'detecting' a mitad de un ajuste. Al
   *  salir del editor (submit/cancel) se re-arma el cooldown NORMAL completo. */
  openEditor(): boolean {
    if (this.state !== 'captured' || this.currentPhoto === null) return false;
    this.stopTimer(); // cooldown suspendido en 'editing' (no corre)
    this.setState('editing');
    return true;
  }

  /** Confirma el quad ajustado por el humano (PÍXELES de foto, orden
   *  TL,TR,BR,BL) → re-warp con ese quad (fracciones) → `onEdited` con la
   *  captura actualizada (warped nuevo; `adjustedQuad` seteado; EL AUTO
   *  quad/quadRefined NO cambia — evidencia para dataCollect F6.5, regla
   *  anti-sesgo).
   *  [F5-MANUAL, 2026-10-01 — análisis de sugerencias del humano]:
   *  (1) Validación MANUAL relajada (validateQuadManual): solo validez
   *  geométrica + área >1% — los pisos de detección (25%/10%) y ratios de
   *  lado son heurísticas de Canny, no para un humano. Un recorte pequeño
   *  a mano AHORA se warpéa tal cual (antes caía al bounding box).
   *  (2) Quad cruzado ("mariposa") → se SANEA reordenando (orderPoints ≡
   *  ángulo alrededor del centroide) en vez del bounding box; el bbox queda
   *  como ÚLTIMO recurso (quad irrecuperable) con aviso 'fallback'.
   *  (3) El warp manual viaja con manual:true — el worker SALTA refineQuad
   *  (antes las bandas de Canny ±30px re-capturaban las esquinas hacia los
   *  bordes del papel: "muevo las esquinas y nada cambia") y el shrink
   *  (las esquinas del humano mandan al píxel).
   *  Tras el warp: 'captured' + cooldown normal (exitEditingWithCooldown). */
  async submitEditedQuad(quad: Quadrilateral): Promise<'ok' | 'fallback' | 'busy'> {
    if (this.state !== 'editing' || this.currentPhoto === null) return 'busy';
    const p = this.currentPhoto;
    const sanitized = sanitizeManualQuad(quad, p.frameW, p.frameH);
    const valid = sanitized !== null;
    const warped = await this.warpPhoto(
      p.bitmap,
      p.frameW,
      p.frameH,
      valid ? sanitized : quadBoundingBox(quad),
      { manual: valid },
    );
    const updated: CapturedPhoto = {
      ...p,
      needsEditorReview: !valid, // fallback: el bounding box puede no ser el recorte deseado
      warped: warped.bitmap,
      warpW: warped.w,
      warpH: warped.h,
      adjustedQuad: quad,
      // quad/quadRefined se conservan como auto (no se re-asigna el refinado
      // del re-warp: la evidencia "automática" no debe mezclarse con el ajuste).
    };
    this.currentPhoto = updated;
    this.events.onEdited(updated);
    // [F6-STAGING, 2026-11 — petición humana] la captura EDITADA es trabajo
    // humano: staged SIN cooldown (antes: 1.5s → la auto-captura reemplazaba
    // la edición antes de que el usuario pudiera pulsar "Agregar al
    // documento" — "no guarda la modificación del corte"). Salidas: Agregar
    // (resumeScanning) o re-toma manual (captureManual desde 'captured').
    this.enterStaged();
    return valid ? 'ok' : 'fallback';
  }

  /** Revierte el ajuste: re-warp con el quad automático ORIGINAL
   *  (`quadRefined` si el worker refinó, si no `quad`) y emite `onEdited`;
   *  `adjustedQuad` se descarta. El FSM SIGUE en 'editing' (el editor se
   *  resetea a las esquinas auto y permite seguir ajustando). Devuelve false
   *  si no hay quad automático (nada que re-warpéar — el editor muestra los
   *  defaults 0.2 sin cambio de warp). */
  async revertEditedQuad(): Promise<boolean> {
    if (this.state !== 'editing' || this.currentPhoto === null) return false;
    const p = this.currentPhoto;
    const auto = p.quadRefined ?? p.quad;
    if (auto === null) return false;
    const warped = await this.warpPhoto(p.bitmap, p.frameW, p.frameH, auto);
    const { adjustedQuad: _dropped, ...autoRest } = p;
    void _dropped; // el ajuste se descarta al revertir (no llega al copy)
    const updated: CapturedPhoto = {
      ...autoRest,
      needsEditorReview: p.needsEditorReview || warped.refineNeedsReview,
      warped: warped.bitmap,
      warpW: warped.w,
      warpH: warped.h,
      // quadRefined: conserva el del auto (evidencia).
    };
    this.currentPhoto = updated;
    this.events.onEdited(updated);
    return true;
  }

  /** Cierra el editor sin confirmar (sin re-warp). La captura conserva el
   *  warped que tuviera; el cooldown normal la devuelve a 'detecting'. */
  cancelEditing(): boolean {
    if (this.state !== 'editing') return false;
    this.exitEditingWithCooldown();
    return true;
  }

  /** Salida del estado 'editing' → 'captured' + cooldown normal (decisión
   *  documentada en submitEditedQuad: no hay estado 'saved'; ver también
   *  plan maestro — F5 introducirá la cola multipágina con su estado).
   *  [F6-STAGING] hoy SOLO la usa cancelEditing: cancelar = descartar la
   *  intención de editar → el flujo auto continúa como siempre. El submit
   * NO pasa por aquí (enterStaged — la edición se protege). */
  private exitEditingWithCooldown(): void {
    this.setState('captured');
    this.armCooldown();
  }

  /** [F6-STAGING, 2026-11 — petición humana "no guarda el recorte"] Retiene
   *  la captura vigente en 'captured' SIN cooldown: la auto-captura solo
   * dispara desde 'detecting' (guard de onWorkerResult) y aquí no vuelve a
   *  entrar — la foto/edición queda estable hasta que el usuario decide.
   *  Escenarios: (a) captura manual — el humano pidió ESA foto; (b)
   *  confirmación del editor — la edición de esquinas es trabajo humano que
   *  el cooldown de 1.5s destruía antes del Agregar (bug reportado). Salidas
   *  del staged: resumeScanning (Agregar al documento), re-toma manual
   *  (captureManual acepta 'captured') o cerrar sesión de cámara (stop). */
  private enterStaged(): void {
    this.stopTimer();
    this.setState('captured');
  }

  /** [F6-STAGING] Reanuda el escaneo tras consumir la captura (cableado al
   *  "Agregar al documento" del harness): mismo cuerpo que la expiración
   *  del cooldown. No-op fuera de 'captured' — p.ej. si el usuario agregó
   *  durante un burst en vuelo, el burst completa y SU cooldown lleva el FSM
   *  de vuelta a detecting (nunca dos transiciones simultáneas). */
  resumeScanning(): boolean {
    if (this.state !== 'captured') return false;
    this.stopTimer();
    this.firstAttempt = this.deps.now();
    this.scoreHistory = [];
    this.setState('detecting');
    return true;
  }

  private setState(s: ScanState): void {
    this.state = s;
    this.events.onState(s);
  }

  private stopTimer(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private async runBurst(stage = false): Promise<'captured' | 'retry'> {
    this.setState('capturing');
    let frames: BurstCandidate[] = [];
    try {
      frames = await this.deps.captureBurstFrames(2);
    } catch {
      frames = [];
    }
    let photo: BurstCandidate | null = null;
    try {
      photo = await this.deps.capturePhoto();
    } catch {
      photo = null;
    }
    this.setState('revalidating');
    // Revalidación en orden de llegada: takePhoto primero si existe.
    const ordered = photo !== null ? [photo, ...frames] : frames;
    let best: { c: BurstCandidate; score: number } | null = null;
    let photoPass: { c: BurstCandidate; score: number } | null = null;
    for (const c of ordered) {
      let s: { pass: boolean; score: number };
      try {
        s = await this.revalidate(c);
      } catch {
        s = { pass: false, score: -1 }; // candidato corrupto: pierde, no mata el burst
      }
      if (s.pass) {
        const entry = { c, score: s.score };
        if (best === null || s.score > best.score) best = entry;
        if (c === photo) photoPass = entry;
      }
    }
    const winner = photoPass ?? best;
    // Cerrar perdedores INMEDIATAMENTE (pico de memoria acotado).
    for (const c of ordered) {
      if (winner === null || c !== winner.c) {
        try {
          c.bitmap.close();
        } catch {
          // ya cerrado: nada
        }
      }
    }
    if (winner === null) {
      this.firstAttempt = this.deps.now();
      this.setState('detecting');
      this.events.onRetry('reintentando…');
      return 'retry';
    }
    // F3-a: la foto ganadora es la fuente de verdad. Gate final SOBRE su
    // downscale (revalidate reutilizado — el ranking ya no basta) +
    // re-detección del quad sobre ella. Sin pass → detecting + retry.
    let final: { pass: boolean; score: number };
    try {
      final = await this.revalidate(winner.c);
    } catch {
      final = { pass: false, score: -1 };
    }
    if (!final.pass) {
      try {
        winner.c.bitmap.close();
      } catch {
        // ya cerrado: nada
      }
      this.firstAttempt = this.deps.now();
      this.setState('detecting');
      this.events.onRetry('reintentando…');
      return 'retry';
    }
    const photoQuad = await this.redetectOnPhoto(winner.c);
    const warped = await this.warpPhoto(winner.c.bitmap, winner.c.w, winner.c.h, photoQuad.quad);
    this.setState('captured');
    this.deps.notify('captured');
    const captured: CapturedPhoto = {
      bitmap: winner.c.bitmap,
      quad: photoQuad.quad,
      quadPrior: this.lastCorners,
      frameW: winner.c.w,
      frameH: winner.c.h,
      revalScore: final.score,
      ts: this.deps.now(),
      route: winner.c.route,
      needsEditorReview: photoQuad.needsEditorReview || warped.refineNeedsReview,
      warped: warped.bitmap,
      warpW: warped.w,
      warpH: warped.h,
      quadRefined: warped.quadRefined,
    };
    this.currentPhoto = captured;
    this.events.onCaptured(captured);
    // [F6-STAGING] stage=true (shutter manual): retención SIN cooldown — la
    // auto-captura no reemplaza la foto pedida por el humano. La captura
    // AUTOMÁTICA (runBurst sin stage) sigue EXACTO como antes (cooldown
    // 1.5s) — orden explícita del humano: "captura y recorte automático,
    // no lo toques".
    if (stage) this.enterStaged();
    else this.armCooldown();
    return 'captured';
  }

  /** Cooldown post-captura anti doble-disparo (F2, spec Fase 3). Re-arma el
   *  timer completo; al expirar (solo desde 'captured') vuelve a detecting.
   *  Compartido por runBurst y la salida del editor F4 (la edición suspende
   *  el cooldown en openEditor y lo re-arma al salir — misma ventana normal). */
  private armCooldown(): void {
    this.stopTimer();
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      if (this.state === 'captured') {
        this.firstAttempt = this.deps.now();
        this.scoreHistory = [];
        this.setState('detecting');
      }
    }, this.cooldownMs);
  }

  /** Revalidación a 400-clase (computeProcessDims 'preserve'): rankea los
   *  candidatos del burst y da el gate final sobre la foto ganadora (F3-a).
   *  Pass = gate de nitidez BLUR_THRESHOLD (aprobado) + gate de exposición
   *  REVAL_MIN_EXPOSURE_SCORE (ingeniería F2). Score = lapVar para ranking
   *  (mayor = mejor). Mide frame completo porque el documento domina el
   *  encuadre (desviación documentada del contrato "crop"). */
  private async revalidate(
    c: BurstCandidate,
  ): Promise<{ pass: boolean; score: number }> {
    const dims = computeProcessDims(c.w, c.h, 'preserve');
    const id = await this.deps.downscale(c.bitmap, dims.w, dims.h);
    const m = measureFrame(id);
    const e = computeExposureScore(m.hist);
    const pass = m.laplacianVar >= BLUR_THRESHOLD && e.score >= REVAL_MIN_EXPOSURE_SCORE;
    return { pass, score: m.laplacianVar };
  }

  /** F3-a: re-detección del quad SOBRE la foto ganadora. Downscale a
   *  400-clase → DetectRequest al worker → quad en coords de foto (px).
   *  Sin quad (null o error del worker) → fallback al prior del stream
   *  escalado a la foto con scaleQuad + needsEditorReview (F4 lo edita).
   *  NUNCA reintenta en automático (evita bucle de capturas). Hook F3-b:
   *  el CornerRefiner refinará el quad devuelto aquí (hoy sin refinar). */
  private async redetectOnPhoto(
    c: BurstCandidate,
  ): Promise<{ quad: Quadrilateral | null; needsEditorReview: boolean }> {
    const dims = computeProcessDims(c.w, c.h, 'preserve');
    let corners: Float32Array | null = null;
    try {
      const proc = await this.deps.photoProcessBitmap(c.bitmap, dims.w, dims.h);
      try {
        corners = await this.deps.detectPhoto({ type: 'detect', bitmap: proc, ts: this.deps.now() });
      } finally {
        try {
          proc.close();
        } catch {
          // transferido al worker (él lo cierra) o mock sin close: nada
        }
      }
    } catch {
      corners = null; // sin bitmap de proceso o worker caído → fallback
    }
    if (isFractions8(corners)) {
      return { quad: fractionsToQuad(corners, c.w, c.h), needsEditorReview: false };
    }
    const prior = this.lastCorners;
    if (isFractions8(prior) && this.lastFrameW > 0 && this.lastFrameH > 0) {
      const streamQuad = fractionsToQuad(prior, this.lastFrameW, this.lastFrameH);
      return {
        quad: scaleQuad(streamQuad, c.w / this.lastFrameW, c.h / this.lastFrameH),
        needsEditorReview: true,
      };
    }
    return { quad: null, needsEditorReview: true };
  }

  /** F3-c: warp de la foto ganadora con el quad final (refinado por F3-b si
   *  aterrizó; si no, el quad de foto tal cual — funciona en ambos casos).
   *  F4: reutilizado por submitEditedQuad/revertEditedQuad sobre el bitmap de
   *  la captura (mismo camino, quad distinto). Sin quad -> bitmap null y la
   *  captura sigue con la cruda. NUNCA reintenta (evita bucle de capturas).
   *  [F5-MANUAL] opts.manual: el quad lo puso el humano → WarpRequest.manual
   *  (worker sin refine/shrink). [F5-RAW] el modo global vigente viaja en el
   *  request para que 'raw' salte el unsharp (deps.getMode, default 'color'). */
  private async warpPhoto(
    bitmap: ImageBitmap,
    w: number,
    h: number,
    quad: Quadrilateral | null,
    opts: { manual?: boolean } = {},
  ): Promise<{
    bitmap: ImageBitmap | null;
    w: number;
    h: number;
    quadRefined: Quadrilateral | null;
    refineNeedsReview: boolean;
  }> {
    const none = { bitmap: null, w: 0, h: 0, quadRefined: null, refineNeedsReview: false };
    if (quad === null || !(w > 0) || !(h > 0)) return none;
    for (let i = 0; i < 4; i++) {
      if (!Number.isFinite(quad[i]!.x) || !Number.isFinite(quad[i]!.y)) {
        return none;
      }
    }
    try {
      const r = await this.deps.requestWarp({
        type: 'warp',
        bitmap,
        quad: quadToFractions(quad, w, h),
        ts: this.deps.now(),
        mode: this.deps.getMode?.() ?? 'color',
        manual: opts.manual === true,
      });
      if (r === null || r.bitmap === null) return none;
      // F3-b: ensamblar el quad refinado; un lado caído marca revisión
      // (blindaje 3: fallback + marcar para el editor). fellBack null = worker
      // sin refine (sin info nueva) → el flag queda como lo dejó redetect
      // (sin regresión vs F3-c); solo un reporte explícito marca revisión.
      const asm = assembleRefinedQuad(r, w, h);
      return {
        bitmap: r.bitmap,
        w: r.w,
        h: r.h,
        quadRefined: asm.quad,
        refineNeedsReview: asm.fellBack !== null && needsEditorReview(asm.fellBack),
      };
    } catch {
      return none; // worker caído → sigue la cruda
    }
  }
}

/** Fracciones 0–1 bien formadas (8 floats finitos). */
function isFractions8(c: Float32Array | null): c is Float32Array {
  if (c === null || c.length !== 8) return false;
  for (let i = 0; i < 8; i++) {
    if (!Number.isFinite(c[i])) return false;
  }
  return true;
}
