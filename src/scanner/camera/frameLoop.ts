// src/camera/frameLoop.ts — bucle de envío de frames al DetectionWorker (T4).
// requestVideoFrameCallback con fallback rAF (como el spike); envía cada frame
// como ImageBitmap transferable a 480p (downscale en createImageBitmap) SOLO
// si el worker está libre — flag local por mensajes result/busy, SIN cola.
// El descarte por flag + el 'busy' del worker son las dos capas de backpressure.

import type { RawQualityInput, ResizeMode, WorkerOut } from '../workers/protocol';
import { computeProcessDims } from '../workers/protocol';

export interface FrameLoopDeps {
  /** Agenda el próximo frame; devuelve handle cancelable. Default: rVFC o rAF. */
  requestFrame(cb: () => void): number;
  cancelFrame(handle: number): void;
  /** Captura y reduce el frame actual a (w,h). Default: createImageBitmap. */
  capture(video: HTMLVideoElement, w: number, h: number): Promise<ImageBitmap>;
  now(): number;
}

export interface FrameLoopOptions {
  video: HTMLVideoElement;
  worker: Worker;
  /** Modo de resize del envío (F1: 'preserve' por defecto — decisión Fase 0). */
  resizeMode?: ResizeMode;
  /** F1: corners en fracciones (o null) como 3er parámetro (aditivo). */
  onResult?: (q: RawQualityInput, ts: number, corners: Float32Array | null) => void;
  onStatus?: (msg: WorkerOut) => void;
  /** Inyección para tests (por defecto usa rVFC/rAF + createImageBitmap). */
  deps?: Partial<FrameLoopDeps>;
}

export interface FrameLoopStats {
  sent: number;
  dropped: number;
  /** Fallos consecutivos de capture() (hallazgo 7 auditoría F1; 0 = racha limpia). */
  captureErrors: number;
}

export interface FrameLoopHandle {
  stop(): void;
  stats(): FrameLoopStats;
}

export function startFrameLoop(opts: FrameLoopOptions): FrameLoopHandle {
  const mode: ResizeMode = opts.resizeMode ?? 'preserve';
  const deps: FrameLoopDeps = {
    requestFrame: (cb) => {
      if (typeof opts.video.requestVideoFrameCallback === 'function') {
        return opts.video.requestVideoFrameCallback(cb);
      }
      return requestAnimationFrame(cb);
    },
    cancelFrame: (h) => {
      if (typeof opts.video.cancelVideoFrameCallback === 'function') {
        opts.video.cancelVideoFrameCallback(h);
      } else {
        cancelAnimationFrame(h);
      }
    },
    capture: (video, w, h) =>
      createImageBitmap(video, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'low',
      }),
    now: () => performance.now(),
    ...opts.deps,
  };

  let stopped = false;
  let handle = 0;
  let workerBusy = false;
  let sent = 0;
  let dropped = 0;
  let captureErrors = 0;

  const schedule = (): void => {
    if (stopped) return;
    handle = deps.requestFrame(tick);
  };

  const tick = (): void => {
    if (stopped) return;
    schedule(); // la cadencia no espera a la captura (rVFC manda)
    if (workerBusy) {
      dropped++;
      return;
    }
    workerBusy = true;
    const dims = computeProcessDims(
      opts.video.videoWidth,
      opts.video.videoHeight,
      mode,
    );
    deps
      .capture(opts.video, dims.w, dims.h)
      .then((bitmap) => {
        if (stopped) {
          bitmap.close();
          return;
        }
        sent++;
        captureErrors = 0; // racha limpia: el worker volvió a recibir
        opts.worker.postMessage({ type: 'detect', bitmap, ts: deps.now() }, [bitmap]);
      })
      .catch(() => {
        // Captura fallida (video detenido a mitad): liberar el flag.
        workerBusy = false;
        captureErrors++;
      });
  };

  opts.worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const msg = ev.data;
    if (msg.type === 'result') {
      workerBusy = false;
      opts.onResult?.(msg.qualityInput, msg.ts, msg.corners);
    } else if (msg.type === 'busy') {
      // El worker sigue con el frame en vuelo: se espera su 'result'.
    } else if (msg.type === 'error') {
      // F1-a (auditoría): un error NO puede congelar el loop — el frame en
      // vuelo se perdió, pero el siguiente debe enviarse (el worker ya liberó
      // su propio flag en finally). El error viaja por onStatus para log/UI.
      workerBusy = false;
      opts.onStatus?.(msg);
    } else {
      opts.onStatus?.(msg);
    }
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      deps.cancelFrame(handle);
      opts.worker.terminate();
    },
    stats: () => ({ sent, dropped, captureErrors }),
  };
}
