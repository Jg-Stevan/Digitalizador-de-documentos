// src/app/app.ts — SPA de producción (T4).
// [PORT Next.js] El import Vite `?worker&url` fue reemplazado por la constante
// DETECTION_WORKER_URL (bundle clásico pre-compilado en /public/scanner/).
// También expone el blob fuente de la última captura (AppHandles.getSourceBlob
// + evento DOM 'mscan:source') para el Laboratorio CER sin acoplarse a él.
//
// Glue extraído de harnesses/test-harness-f5device.html (flujo completo
// validado en 2 dispositivos) y productionizado: mismos módulos, mismo
// contrato del editor, export adaptativo F6.5, errores F6.4, telemetría F6.3,
// modo diana F4/T8 y panel de ajustes T9. NO reescribe módulos.
//
// Boot resiliente (lección F4-fix-arranque, OBLIGATORIA): si OpenCV o la
// cámara fallan → error visible + botón reintentar; nunca all-or-nothing.
// Shutter manual SIEMPRE visible (requisito del plan).
// Query params (misma convención que los harnesses, los usa la E2E T7):
//   ?fake=1      — cámara sintética (CI sin cámara real)
//   ?autostart=1 — arranca sin pulsar Iniciar

import { DETECTION_WORKER_URL } from './workerUrl';
import { startFrameLoop } from '../camera/frameLoop';
import { CameraController, CameraInitError } from '../camera/CameraController';
import { classifyCameraError } from '../camera/cameraErrors';
import { attachLifecycle, trackIsLive } from '../camera/lifecycle';
import { ScannerView } from '../ui/ScannerView';
import { framingInfo } from '../ui/ScannerView';
import { ScoreView as ScoreRingView } from '../ui/ScoreView';
import { ScanOrchestrator, type CapturedPhoto } from '../scan/ScanOrchestrator';
import { PageGallery, modeLabel, type ExportStep } from '../ui/PageGallery';
import { AdjustEditor } from '../ui/AdjustEditor';
import { ModeCompare } from '../ui/ModeCompare';
import { PageStore, openPageDB, persistPageStorage } from '../export/pageStore';
import { TELEMETRY_KEY_DSN, wireTelemetry } from '../telemetry/harnessTelemetry';
import { cdeReport, DIANA_DEFAULT_WIDTH_MM } from '../core/dianaMath';
import { QuadStabilityBuffer } from '../core/quadStability';
import type { DocProfile, Quadrilateral } from '../core/types';
import type { PdfPageSize } from '../export/pdfExport';
import type { CameraProfile } from '../core/types';
import type { EnhanceMode } from '../core/types';
import { computeProcessDims } from '../workers/protocol';
import type {
  DetectRequest,
  EnhanceRequest,
  EnhanceResult,
  ResultReply,
  WarpRequest,
  WarpResult,
} from '../workers/protocol';
import { JPEG_QUALITY } from '../core/imageModes';
import { makeFakeCamera, type FakeCamera } from './fakeCamera';

/** Respuestas del worker de foto que resuelven un postPhoto pendiente. */
type PhotoReply = ResultReply | WarpResult | EnhanceResult;

const DIANA_WIDTH_STORAGE_KEY = 'mscan:diana:anchoRealMm';

/** [R4-B2] Clave de persistencia del perfil de documento (#profileSel). */
const PROFILE_STORAGE_KEY = 'mscan:docProfile';

/** [R4-B2] Perfiles válidos (los del <select> de page.tsx). */
const VALID_DOC_PROFILES: readonly DocProfile[] = [
  'auto',
  'documento-largo',
  'pagina',
  'tarjeta',
];

const isDocProfile = (v: string): v is DocProfile =>
  (VALID_DOC_PROFILES as readonly string[]).includes(v);

function el<T extends HTMLElement>(doc: Document, id: string): T {
  const node = doc.getElementById(id);
  if (node === null) throw new Error(`SPA: falta #${id} en index.html`);
  return node as T;
}

/** [FASE 8.1, 2026-11] Estado del escáner en lenguaje de gente (el diseño AI
 *  Studio del humano es "no técnico, para el público"): mState nunca muestra
 *  la palabra cruda ("revalidating"). Mapa de visualización PURO — la lógica
 *  del orquestador sigue comparando los valores crudos ('captured', etc.). */
function stateLabel(state: string): string {
  switch (state) {
    case 'idle':
      return 'En pausa';
    case 'detecting':
      return 'Buscando documento…';
    case 'capturing':
      return 'Capturando…';
    case 'revalidating':
      return 'Confirmando…';
    case 'captured':
      return 'Página lista ✓';
    case 'editing':
      return 'Ajustando esquinas';
    default:
      return state;
  }
}

interface AppHandles {
  orch: ScanOrchestrator | null;
  gallery: PageGallery | null;
  editor: AdjustEditor | null;
  compare: ModeCompare | null;
  enhanceMs: () => number;
  /** [RONDA 4] Blob PNG de la última captura aceptada (warped ?? crudo) para
   *  el Laboratorio CER; null antes de la primera captura. */
  getSourceBlob: () => Blob | null;
  /** [FASE 9, 2026-11] Importa fotos de la galería del teléfono con recorte
   *  automático (mismo detect→warp del worker que la cámara). Cableado
   *  público: lo usan los botones de la UI y la E2E. */
  importFiles: (files: File[]) => Promise<void>;
}

/** Arranca la SPA sobre el documento dado. Idempotente por botón: el reintento
 *  tras un fallo NO reconstruye la app (galería/páginas se conservan). */
export function startApp(doc: Document, win: Window): AppHandles {
  const params = new URLSearchParams(win.location.search);
  const useFake = params.get('fake') === '1';

  // [FASE 8] toast como píldora flotante (CSS :empty lo oculta): auto-cierre
  // a los 4.5s — antes era un slot inline fijo y podía quedarse "pegado";
  // flotando sobre la UI una permanencia infinita taparía contenido.
  let toastTimer = 0;
  const toast = (s: string): void => {
    el(doc, 'toast').textContent = s;
    win.clearTimeout(toastTimer);
    if (s !== '') {
      toastTimer = win.setTimeout(() => {
        el(doc, 'toast').textContent = '';
      }, 4500);
    }
  };
  const showErr = (s: string): void => {
    el(doc, 'err').textContent = s;
  };

  const video = el<HTMLVideoElement>(doc, 'v');

  // --- estado de módulo (misma semántica que el harness F5) ---
  let started = false;
  let ctl: CameraController | null = null;
  let camLost = false;
  let profile: CameraProfile | null = null;
  let lastPhoto: CapturedPhoto | null = null;
  let lastSourceBlob: Blob | null = null;
  let lastWarpMeta: {
    refined: boolean;
    fellBack: [boolean, boolean, boolean, boolean] | null;
  } | null = null;
  let photoWorker: Worker | null = null;
  let streamWorker: Worker | null = null; // [R4-B2] hoisted: applyProfile difunde a AMBOS workers
  let pageStore: PageStore | null = null;
  let gallery: PageGallery | null = null;
  // [FASE 9] hoisted: lo crea ensurePhotoPipeline (cámara O importación —
  // quien llegue primero); openCamera lo expone en AppHandles igual que antes.
  let compare: ModeCompare | null = null;
  let orch: ScanOrchestrator | null = null;
  let fake: FakeCamera | null = null;
  let frameResults = 0;
  let captures = 0;
  let startedAt = 0;
  // M1: tamaño de página del PDF (adaptativa por defecto, como Adobe).
  let pageSize: PdfPageSize = 'adaptive';
  const pageSizeLabel = (s: PdfPageSize): string =>
    s === 'adaptive' ? 'Auto' : s === 'letter' ? 'Letter' : 'A4';
  let lastEnhanceMs = 0;
  const pending = new Map<number, (msg: PhotoReply | null) => void>();

  // [FASE 8] hoja de Exportación exitosa: blob del último PDF + relés de
  // share/download (misma lógica que el onExport original, extraída a helper
  // para reutilizarla desde la hoja).
  let lastPdf: Blob | null = null;
  let lastPdfName = '';
  const pdfFileName = (): string => `scanner-${new Date().toISOString().slice(0, 10)}.pdf`;
  const shareOrDownload = async (pdf: Blob, mode: 'share' | 'download'): Promise<void> => {
    const file = new File([pdf], lastPdfName || pdfFileName(), { type: 'application/pdf' });
    const download = (): void => {
      const a = doc.createElement('a');
      a.href = URL.createObjectURL(pdf);
      a.download = file.name;
      a.click();
      win.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    if (mode === 'download') {
      download();
      return;
    }
    const nav = win.navigator;
    if ('share' in nav && typeof nav.share === 'function') {
      const canShareFiles =
        typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
      if (canShareFiles || !('canShare' in nav)) {
        try {
          await nav.share({ files: [file], title: 'Documento escaneado' });
          return;
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') return;
        }
      }
    }
    download();
  };

  // [R4-B2] Perfil de documento persistido (default 'auto'; se aplica al
  // <select> y se difunde a cada worker AL CREARSE — nacen con 'auto').
  let docProfile: DocProfile = 'auto';
  try {
    const savedProfile = win.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (savedProfile !== null && isDocProfile(savedProfile)) docProfile = savedProfile;
  } catch {
    /* almacenamiento bloqueado: 'auto' */
  }
  const postProfile = (worker: Worker | null): void => {
    if (worker) worker.postMessage({ type: 'config', docProfile });
  };
  /** [R4-B2] Guarda en localStorage + difunde a los DOS workers (detect corre
   *  en foto Y stream). Workers recién creados nacen con 'auto' → openCamera
   *  re-aplica tras crear cada uno. */
  const applyProfile = (p: DocProfile): void => {
    docProfile = p;
    try {
      win.localStorage.setItem(PROFILE_STORAGE_KEY, p);
    } catch {
      /* sin persistencia: la sesión sigue con el perfil en memoria */
    }
    postProfile(photoWorker);
    postProfile(streamWorker);
  };
  const profileSel = el<HTMLSelectElement>(doc, 'profileSel');
  profileSel.value = docProfile;
  profileSel.addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
    applyProfile(isDocProfile(value) ? value : 'auto');
  });

  // [R4-B4] Métrica de estabilidad del quad (SOLO reporte — #mQuadStab):
  // medir, no cambiar; auto-shutter/score intactos.
  const quadStab = new QuadStabilityBuffer();

  // --- telemetría F6.3 + ajustes T9 (OFF por defecto, DSN en localStorage) ---
  const telemetry = wireTelemetry(win, doc, doc.getElementById('tMount'));
  const dsnInput = el<HTMLInputElement>(doc, 'dsnInput');
  try {
    dsnInput.value = win.localStorage.getItem(TELEMETRY_KEY_DSN) ?? '';
  } catch {
    dsnInput.value = '';
  }
  el(doc, 'dsnSave').addEventListener('click', () => {
    try {
      if (dsnInput.value.trim() === '') win.localStorage.removeItem(TELEMETRY_KEY_DSN);
      else win.localStorage.setItem(TELEMETRY_KEY_DSN, dsnInput.value.trim());
    } catch {
      toast('No se pudo guardar el DSN (almacenamiento bloqueado)');
      return;
    }
    win.location.reload();
  });
  el(doc, 'teleEvents').addEventListener('click', () => {
    const s = telemetry.telemetry.snapshot();
    el(doc, 'teleLocal').textContent =
      `local: capturados ${s.captured} · enviados ${s.sent} · descartados ${s.dropped}` +
      (s.hasDsn ? ' (con DSN)' : ' (sin DSN — nada sale del dispositivo)');
  });

  // --- modo diana F4/T8 (autoQuad de cada captura; serie A/B en protocolo) ---
  let dianaOn = false;
  let dianaRealWidthMm = DIANA_DEFAULT_WIDTH_MM;
  try {
    const saved = Number(win.localStorage.getItem(DIANA_WIDTH_STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) dianaRealWidthMm = saved;
  } catch {
    /* almacenamiento bloqueado: default */
  }
  const dianaQuads: Quadrilateral[] = [];
  const dianaWidthInput = el<HTMLInputElement>(doc, 'dianaWidthMm');
  dianaWidthInput.value = String(dianaRealWidthMm);
  const renderDiana = (): void => {
    const r = cdeReport(dianaQuads, dianaRealWidthMm);
    el(doc, 'mDiana').textContent = r
      ? `±${r.p95mm.toFixed(2)} mm al 95% (n=${r.count}, media ${r.meanMm.toFixed(2)}±${r.sdMm.toFixed(2)}, outliers ${r.outlierCount}, ancho ${dianaRealWidthMm} mm)`
      : `falta ≥2 (${dianaQuads.length} guardadas)`;
  };
  el(doc, 'dianaChk').addEventListener('change', (ev) => {
    dianaOn = (ev.target as HTMLInputElement).checked;
    if (!dianaOn) dianaQuads.length = 0;
    el(doc, 'dianaGuide').hidden = !dianaOn;
    renderDiana();
  });
  dianaWidthInput.addEventListener('change', () => {
    const value = Number(dianaWidthInput.value);
    if (!(value > 0)) {
      dianaWidthInput.value = String(dianaRealWidthMm);
      return;
    }
    dianaRealWidthMm = value;
    try {
      win.localStorage.setItem(DIANA_WIDTH_STORAGE_KEY, String(value));
    } catch {
      /* sin persistencia: la sesión sigue válida */
    }
    renderDiana();
  });
  renderDiana();

  const closeBitmap = (bitmap: ImageBitmap | null): void => {
    if (!bitmap) return;
    try {
      bitmap.close();
    } catch {
      /* ya cerrado */
    }
  };

  // [RONDA 4] Único punto de escritura del blob fuente + evento DOM para el
  // Laboratorio CER (escucha 'mscan:source', detail = Blob) sin acoplamiento.
  const setSourceBlob = (blob: Blob): void => {
    lastSourceBlob = blob;
    try {
      doc.dispatchEvent(new CustomEvent('mscan:source', { detail: blob }));
    } catch {
      /* CustomEvent ausente (entorno raro): el getter sigue disponible */
    }
  };

  const bitmapToBlob = async (
    bitmap: ImageBitmap,
    mime = 'image/png',
    quality?: number,
  ): Promise<Blob> => {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : doc.createElement('canvas');
    if (canvas instanceof HTMLCanvasElement) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    // [PORT Next.js] Deuda de tipos pre-existente (no de R4): el getContext
    // sobre OffscreenCanvas|HTMLCanvasElement devuelve una unión que incluye
    // ImageBitmapRenderingContext (sin drawImage) — se estrecha al 2D real.
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (ctx === null) throw new Error('thumb: sin contexto 2d');
    ctx.drawImage(bitmap, 0, 0);
    if ('convertToBlob' in canvas) {
      return await (canvas as OffscreenCanvas).convertToBlob({ type: mime, quality });
    }
    const html = canvas as HTMLCanvasElement;
    return await new Promise<Blob>((resolve, reject) => {
      html.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob: null'))), mime, quality);
    });
  };

  const waitWorker = (worker: Worker): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = win.setTimeout(() => reject(new Error('worker timeout')), 90000);
      worker.onmessage = (ev: MessageEvent) => {
        if (ev.data?.type === 'ready') {
          win.clearTimeout(timer);
          el(doc, 'out').textContent = JSON.stringify(
            { opencvUrl: ev.data.opencvUrl ?? null, probe: ev.data.probe ?? null },
            null,
            2,
          );
          resolve();
        }
        if (ev.data?.type === 'error') {
          win.clearTimeout(timer);
          reject(new Error(String(ev.data.message)));
        }
      };
    });

  const receivePhotoMessages = (worker: Worker): void => {
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as PhotoReply | { type: string; message?: string; ts?: number } | null;
      if (!msg) return;
      if (msg.type === 'result' || msg.type === 'warped' || msg.type === 'enhanced') {
        const photo = msg as PhotoReply;
        const resolveMsg = pending.get(photo.ts);
        if (resolveMsg) {
          pending.delete(photo.ts);
          resolveMsg(photo);
        }
      } else if (msg.type === 'busy' && typeof msg.ts === 'number') {
        const resolveMsg = pending.get(msg.ts);
        if (resolveMsg) {
          pending.delete(msg.ts);
          resolveMsg(null);
        }
      } else if (msg.type === 'error') {
        showErr(`Worker: ${String(msg.message ?? 'desconocido')}`);
        for (const resolveMsg of pending.values()) resolveMsg(null);
        pending.clear();
      }
    };
  };

  const postPhoto = (
    msg: DetectRequest | WarpRequest | EnhanceRequest,
    transfer: ImageBitmap[],
  ): Promise<PhotoReply | null> =>
    new Promise<PhotoReply | null>((resolve) => {
      const timer = win.setTimeout(() => {
        pending.delete(msg.ts);
        showErr(`Timeout ts=${msg.ts}`);
        resolve(null);
      }, 30000);
      pending.set(msg.ts, (value) => {
        win.clearTimeout(timer);
        resolve(value);
      });
      photoWorker?.postMessage(msg, transfer);
    });

  const enhanceBlob = async (
    blob: Blob,
    mode: EnhanceMode,
    step?: ExportStep,
  ): Promise<Blob | null> => {
    const bitmap = await win.createImageBitmap(blob);
    const req: EnhanceRequest = { type: 'enhance', bitmap, mode, ts: performance.now() };
    if (step) {
      if (step.maxLongSide) req.maxLongSide = step.maxLongSide;
      if (step.quality) req.quality = step.quality;
    }
    const msg = await postPhoto(req, [bitmap]);
    if (msg?.type === 'enhanced') {
      lastEnhanceMs = msg.elapsedMs;
      return msg.blob;
    }
    return null;
  };
  /** prepare estricto para PageGallery (null → throw; thumbFor lo captura y
   *  cae al original — la galería nunca se rompe con el worker ocupado). */
  const prepareStrict = async (
    source: Blob,
    mode: EnhanceMode,
    step?: ExportStep,
  ): Promise<Blob> => {
    const blob = await enhanceBlob(source, mode, step);
    if (blob === null) throw new Error('enhance falló (worker ocupado)');
    return blob;
  };

  const drawFit = (bitmap: ImageBitmap, label?: string): void => {
    const canvas = el<HTMLCanvasElement>(doc, 'thumb');
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (label) {
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.fillRect(0, 0, canvas.width, 24);
      ctx.fillStyle = '#38bdf8';
      ctx.font = '14px system-ui';
      ctx.fillText(label, 6, 17);
    }
  };

  // --- F6.4: cámara perdida → banner recuperable SIN reconstruir la app ---
  const MSG_LOST = 'Cámara perdida (permiso revocado u otra app la tomó).';
  const markCamLost = (msg: string): void => {
    if (camLost) return;
    camLost = true;
    started = false;
    el<HTMLButtonElement>(doc, 'shutterBtn').disabled = true;
    showErr(`${msg} Toca Iniciar para reintentar (la galería se conserva).`);
    el<HTMLButtonElement>(doc, 'startBtn').disabled = false;
  };
  const wireCameraGuards = (): void => {
    const tr = ctl?.getTrack() ?? null;
    if (tr) tr.addEventListener('ended', () => markCamLost(MSG_LOST));
    // D2: re-perfilar al girar (profile fresco → mCam); ScannerView se
    // auto-resizea en cada render.
    ctl?.watchOrientation((p) => {
      profile = p;
      el(doc, 'mCam').textContent = `${p.label} (${p.trackWidth}×${p.trackHeight})`;
    });
  };
  const reactivateCamera = async (): Promise<void> => {
    el<HTMLButtonElement>(doc, 'startBtn').disabled = true;
    try {
      if (useFake) {
        fake?.stop();
        fake = makeFakeCamera(doc);
        video.srcObject = fake.stream;
        profile = {
          deviceId: 'fake',
          label: 'cámara sintética',
          trackWidth: 640,
          trackHeight: 480,
          aspectRatio: 640 / 480,
          capabilities: { torch: false, focusModes: ['continuous'] },
          capturedAt: Date.now(),
        };
      } else {
        if (ctl === null) ctl = CameraController.browser();
        profile = await ctl.init({ video });
        wireCameraGuards();
      }
      await video.play();
      el(doc, 'mCam').textContent =
        `${profile.label} (${profile.trackWidth}×${profile.trackHeight})`;
      camLost = false;
      started = true;
      el<HTMLButtonElement>(doc, 'shutterBtn').disabled = false;
      el<HTMLButtonElement>(doc, 'torchBtn').disabled = !profile.capabilities.torch;
      el<HTMLButtonElement>(doc, 'torchBtn').textContent = profile.capabilities.torch
        ? 'Linterna'
        : 'Linterna ✕';
      showErr('');
      toast('Cámara recuperada');
      orch?.extendDeadline();
    } catch (e) {
      if (e instanceof CameraInitError) {
        const info = classifyCameraError(e);
        showErr(`Reintento: ${info.title}. ${info.hint}`);
      } else showErr(`Reintento: ${(e as Error).message}`);
      el<HTMLButtonElement>(doc, 'startBtn').disabled = false;
    }
  };
  // Background: rAF/rVFC se congelan solos; al volver se re-arma el plazo de
  // 8s y se valida el track.
  attachLifecycle({
    onHidden() {},
    onVisible() {
      if (!started) return;
      orch?.extendDeadline();
      if (!trackIsLive(ctl?.getTrack() ?? null)) {
        markCamLost('Cámara no disponible tras segundo plano.');
      }
    },
  });

  /** takePhoto con techo: en pistas sintéticas o drivers raros puede no
   *  resolverse NUNCA (colgaría el burst entero — hallazgo E2E T7 en
   *  headless con canvas.captureStream). Timeout → el caller cae a ruta B. */
  const takePhotoWithTimeout = (track: MediaStreamTrack, ms = 4000): Promise<Blob> => {
    const take = new ImageCapture(track).takePhoto();
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = win.setTimeout(() => reject(new Error('takePhoto timeout')), ms);
    });
    return Promise.race([take, timeout]).finally(() => win.clearTimeout(timer));
  };

  const createOrchestrator = (_view: ScannerView, scoreView: ScoreRingView): ScanOrchestrator =>
    new ScanOrchestrator({
      video,
      deps: {
        capturePhoto: async () => {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if ('ImageCapture' in win) {
            try {
              const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
              if (track && track.readyState === 'live') {
                const photo = await takePhotoWithTimeout(track);
                const bitmap = await win.createImageBitmap(photo, {
                  imageOrientation: 'from-image',
                });
                return { bitmap, w: bitmap.width, h: bitmap.height, route: 'A' as const };
              }
            } catch {
              /* cae a ruta B */
            }
          }
          const canvas = doc.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d')?.drawImage(video, 0, 0, w, h);
          return { bitmap: await win.createImageBitmap(canvas), w, h, route: 'B' as const };
        },
        detectPhoto: async (request) => {
          const msg = await postPhoto(request, [request.bitmap]);
          return msg?.type === 'result' ? msg.corners : null;
        },
        requestWarp: async (request) => {
          const copy = await win.createImageBitmap(request.bitmap);
          const msg = await postPhoto({ ...request, bitmap: copy }, [copy]);
          if (msg?.type !== 'warped') return null;
          lastWarpMeta = { refined: msg.refined, fellBack: msg.fellBack };
          return {
            bitmap: msg.bitmap,
            w: msg.w,
            h: msg.h,
            refinedQuad: msg.refinedQuad,
            refined: msg.refined,
            fellBack: msg.fellBack,
          };
        },
        notify: (kind) => {
          if (kind !== 'timeout' && 'vibrate' in win.navigator) win.navigator.vibrate(50);
          return 'none';
        },
        // [F5-RAW, 2026-10-01] Modo global vigente: viaja en cada WarpRequest
        // para que 'raw' ("Original de cámara") salte el unsharp del warp.
        // El gallery nace con setMode('color') y el humano puede cambiarlo
        // en caliente — el getter SIEMPRE lee el valor actual.
        getMode: () => gallery?.getMode() ?? 'color',
      },
      events: {
        onState: (state) => {
          // [FASE 8.1] Lenguaje de gente (el estado crudo vive en pre#out):
          // el público nunca debe leer "revalidating".
          el(doc, 'mState').textContent = stateLabel(state);
          // El editor opera sobre la captura ACEPTADA (contrato F4/F6.5).
          el<HTMLButtonElement>(doc, 'editBtn').disabled = state !== 'captured';
        },
        onScore: (score) => scoreView.render(score.total, score.hint),
        onCaptured: (photo) => {
          captures++;
          el(doc, 'mCap').textContent = String(captures);
          if (lastPhoto && lastPhoto !== photo) {
            // Fix detached-bitmap (2026-09-26): submit/revert devuelven
            // {...p} — cerrar solo lo genuinamente supersedido.
            if (lastPhoto.bitmap !== photo.bitmap) closeBitmap(lastPhoto.bitmap);
            if (lastPhoto.warped !== photo.warped) closeBitmap(lastPhoto.warped);
          }
          lastPhoto = photo;
          const visible = photo.warped ?? photo.bitmap;
          drawFit(visible, photo.warped ? 'Recortada' : 'Sin recorte');
          el(doc, 'thumbLabel').textContent = photo.warped ? 'Recortada' : 'Sin recorte';
          const fb = lastWarpMeta?.fellBack?.filter(Boolean).length ?? null;
          el(doc, 'mRef').textContent = fb === null
            ? 'sí*'
            : fb === 0
              ? 'sí (4/4)'
              : `parcial (${4 - fb}/4)`;
          el(doc, 'mOut').textContent = photo.warped ? `${photo.warpW}×${photo.warpH}` : '—';
          el(doc, 'out').textContent = JSON.stringify(
            {
              route: photo.route,
              warped: photo.warped !== null,
              refined: lastWarpMeta?.refined ?? null,
              fellBack: lastWarpMeta?.fellBack ?? null,
            },
            null,
            2,
          );
          // Diana T8: autoQuad (refinado ?? detección) en px de foto.
          if (dianaOn) {
            const autoQuad = photo.quadRefined ?? photo.quad;
            if (autoQuad) {
              dianaQuads.push(autoQuad);
              if (dianaQuads.length > 60) dianaQuads.shift();
              renderDiana();
            }
          }
          bitmapToBlob(visible)
            .then((blob) => {
              setSourceBlob(blob);
              el<HTMLButtonElement>(doc, 'addBtn').disabled = false;
            })
            .catch((e: Error) => showErr(`Fuente: ${e.message}`));
        },
        onEdited: (photo) => {
          if (lastPhoto && lastPhoto !== photo) {
            if (lastPhoto.bitmap !== photo.bitmap) closeBitmap(lastPhoto.bitmap);
            if (lastPhoto.warped !== photo.warped) closeBitmap(lastPhoto.warped);
          }
          lastPhoto = photo;
          const visible = photo.warped ?? photo.bitmap;
          drawFit(visible, 'Recorte ajustado');
          el(doc, 'thumbLabel').textContent = 'Recorte ajustado';
          // [F6-STAGING, 2026-11 — petición humana] Salida = dims del warp
          // EDITADO (antes la métrica quedaba con las dims de la captura
          // original — confundía la validación del recorte manual).
          el(doc, 'mOut').textContent = photo.warped ? `${photo.warpW}×${photo.warpH}` : '—';
          bitmapToBlob(visible).then((blob) => {
            setSourceBlob(blob);
            el<HTMLButtonElement>(doc, 'addBtn').disabled = false;
          });
        },
        onRetry: (text) => toast(text),
        onTimeout: () => toast('Captura manual o mejora la iluminación'),
      },
    });

  // --- [FASE 9, 2026-11 — petición humana: "si suben algo desde la galería
  // que también lo recorten automáticamente"] Importación desde la galería
  // del teléfono con el MISMO pipeline de la cámara: DetectRequest a
  // 400-clase → WarpRequest con refine (worker de foto). El FSM del
  // orquestador NO participa (la cámara sigue su curso; colisiones
  // transitorias con el worker se resuelven reintentando 1 vez).
  const importInput = el<HTMLInputElement>(doc, 'importInput');
  let importing = false;
  const triggerImport = (): void => {
    if (!importing) importInput.click();
  };

  /** [FASE 9] Worker de foto BAJO DEMANDA (lo caro: carga opencv ~4s). Lo
   *  crea la cámara, la importación de galería o el comparador de modos
   *  (prepare lo garantiza) — nunca el arranque en frío. Guard de vuelo
   *  (promesa cacheada, reset al fallar): cámara + importación concurrentes
   *  comparten UNA creación; el reintento posterior es fresco (como antes). */
  let photoWorkerP: Promise<void> | null = null;
  const ensurePhotoWorker = async (): Promise<void> => {
    if (photoWorker !== null) return;
    if (photoWorkerP === null) {
      photoWorkerP = (async () => {
        // Clásico (SIN type:module): el bundle del worker es IIFE y carga
        // opencv vía importScripts — los module workers lo PROHÍBEN
        // ("Module scripts don't support importScripts()", hallazgo E2E T7).
        const w = new Worker(DETECTION_WORKER_URL);
        await waitWorker(w);
        receivePhotoMessages(w);
        photoWorker = w;
        // [R4-B2] el worker nuevo nace con 'auto': re-aplica el perfil actual.
        postProfile(w);
      })().catch((e: unknown) => {
        photoWorkerP = null; // falló: el próximo llamador reintenta fresco
        throw e;
      });
    }
    await photoWorkerP;
  };

  /** [FASE 9] Cola de páginas + galería BAJO DEMANDA (lo BARATO: IndexedDB,
   *  sin worker). El MISMO bloque que vivía inline en openCamera, extraído e
   *  idempotente. Se llama en el arranque (estado vacío con CTA "Subir fotos"
   *  + páginas persistidas visibles SIN encender la cámara) y lo reutilizan
   * openCamera y la importación: cero creación doble. */
  const buildPageStack = async (): Promise<void> => {
    if (pageStore === null) {
      const db = await openPageDB();
      await persistPageStorage();
      pageStore = new PageStore(db, {});
    }
    if (gallery === null) {
      compare = new ModeCompare({
        root: el(doc, 'cmpRoot'),
        // [FASE 9] el comparador puede abrirse ANTES de cualquier cámara
        // (páginas persistidas de otra sesión): el worker se crea aquí, no
        // en el arranque — solo cuando alguien de verdad lo usa.
        prepare: async (source, mode) => {
          if (photoWorker === null) await ensurePhotoWorker();
          return enhanceBlob(source, mode);
        },
        blobToCanvas: async (blob, maxSide) => {
          const bmp = await win.createImageBitmap(blob);
          const s = maxSide > 0 ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
          const c = doc.createElement('canvas');
          c.width = Math.max(1, Math.round(bmp.width * s));
          c.height = Math.max(1, Math.round(bmp.height * s));
          c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
          return c;
        },
        onPick: (mode) => {
          gallery?.setMode(mode);
          el(doc, 'mMode').textContent = modeLabel(mode);
          toast(`Modo export: ${modeLabel(mode)}`);
        },
        warn: showErr,
      });
      gallery = new PageGallery({
        root: el(doc, 'gallery'),
        store: pageStore,
        // [FASE 9] Las miniaturas se realzan con el worker: en arranque en
        // frío puede estar booteando aún — lo espera (misma promesa en vuelo)
        // en vez de colgar 30s en el timeout de postPhoto. Si opencv falla,
        // thumbFor lo atrapa y cae a miniatura cruda: la galería NUNCA se
        // rompe.
        prepare: async (source, mode, step) => {
          if (photoWorker === null) await ensurePhotoWorker();
          return prepareStrict(source, mode, step);
        },
        compare,
        onModeChange: (mode) => {
          el(doc, 'mMode').textContent = modeLabel(mode);
          toast(`Modo export: ${modeLabel(mode)}`);
        },
        onExport: async (pdf, _pageSize) => {
          // [FASE 8] guarda el blob para los relés de la hoja de export
          lastPdf = pdf;
          lastPdfName = pdfFileName();
          void _pageSize; // PageGallery decide el tamaño; el share/download no lo usa
          await shareOrDownload(pdf, 'share');
        },
        // [FASE 9] CTA del estado vacío → mismo selector de galería.
        onImport: triggerImport,
        warn: showErr,
      });
      gallery.setMode('color');
      await gallery.render();
    }
  };

  /** [FASE 9] Guard de vuelo de la cola de páginas (mismo patrón que el
   *  worker): arranque + cámara + importación concurrentes comparten UNA
   *  creación; si falla se resetea y el próximo llamador reintenta fresco. */
  let pageStackP: Promise<void> | null = null;
  const ensurePageStack = async (): Promise<void> => {
    if (pageStackP === null) {
      pageStackP = buildPageStack().catch((e: unknown) => {
        pageStackP = null; // falló: el próximo llamador reintenta fresco
        throw e;
      });
    }
    await pageStackP;
  };

  /** [FASE 9] Pipeline completo de foto: worker (si falta) + cola de páginas.
   *  Camino de la cámara y de la importación de galería. */
  const ensurePhotoPipeline = async (): Promise<void> => {
    await ensurePhotoWorker();
    await ensurePageStack();
  };

  /** Fracciones 0–1 bien formadas (8 floats finitos) — misma guarda que el
   *  orquestador (isFractions8 es privado allí; esta es local al import). */
  const isFractions8 = (c: Float32Array | null): c is Float32Array => {
    if (c === null || c.length !== 8) return false;
    for (let i = 0; i < 8; i++) {
      if (!Number.isFinite(c[i])) return false;
    }
    return true;
  };

  /** [FASE 9] Detección sobre la foto importada: downscale a 400-clase
   *  (computeProcessDims 'preserve', idéntico a redetectOnPhoto del
   *  orquestador) → DetectRequest. Reintento 1 vez tras 500ms SOLO si no
   *  hubo respuesta (worker 'busy' con una captura de la cámara en ese
   *  instante): una respuesta genuina "sin quad" no se re-procesa. */
  const detectImportQuad = async (
    bitmap: ImageBitmap,
    w: number,
    h: number,
  ): Promise<Float32Array | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const dims = computeProcessDims(w, h, 'preserve');
        const proc = await win.createImageBitmap(bitmap, {
          resizeWidth: dims.w,
          resizeHeight: dims.h,
          resizeQuality: 'low',
        });
        try {
          const req: DetectRequest = {
            type: 'detect',
            bitmap: proc,
            ts: performance.now(),
          };
          const msg = await postPhoto(req, [proc]);
          if (msg?.type === 'result') {
            return isFractions8(msg.corners) ? msg.corners : null;
          }
          // msg null = busy/timeout del worker → reintento (abajo)
        } finally {
          try {
            proc.close();
          } catch {
            /* transferido al worker: él lo cierra */
          }
        }
      } catch {
        /* worker caído → la foto entra completa */
      }
      if (attempt === 0) await new Promise<void>((r) => win.setTimeout(r, 500));
    }
    return null;
  };

  /** [FASE 9] Warp de la foto importada con el quad detectado (fracciones
   *  0–1): copia del bitmap (el worker cierra lo que recibe), modo global
   *  vigente (como warpPhoto — 'raw' salta el unsharp) y SIN 'manual' → el
   *  CornerRefiner actúa (camino AUTO de la cámara). */
  const warpImport = async (
    bitmap: ImageBitmap,
    corners: Float32Array,
  ): Promise<ImageBitmap | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const copy = await win.createImageBitmap(bitmap);
        const req: WarpRequest = {
          type: 'warp',
          bitmap: copy,
          quad: corners,
          ts: performance.now(),
          mode: gallery?.getMode() ?? 'color',
        };
        const msg = await postPhoto(req, [copy]);
        if (msg?.type === 'warped') return msg.bitmap;
      } catch {
        /* warp caído → la foto entra completa */
      }
      if (attempt === 0) await new Promise<void>((r) => win.setTimeout(r, 500));
    }
    return null;
  };

  /** [FASE 9] Techo del lado mayor de import (px). A4 a 300dpi = 2480px:
   *  2600 deja calidad de sobra Y protege memoria/canvas de iOS en lotes
   *  grandes (foto 48MP = 48Mpx > límite ~16.7Mpx del canvas). */
  const IMPORT_LONG_SIDE = 2600;

  const importFromGallery = async (files: File[]): Promise<void> => {
    if (importing || files.length === 0) return;
    importing = true;
    const importBtn = el<HTMLButtonElement>(doc, 'importBtn');
    const importStartBtn = el<HTMLButtonElement>(doc, 'importStartBtn');
    importBtn.disabled = true;
    importStartBtn.disabled = true;
    let added = 0;
    let cropped = 0;
    let unreadable = 0;
    try {
      await ensurePhotoPipeline();
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        // Progreso en lenguaje de gente (el toast se refresca por foto).
        toast(
          files.length === 1
            ? 'Buscando el documento…'
            : `Recortando… ${i + 1} de ${files.length}`,
        );
        let bitmap: ImageBitmap | null = null;
        try {
          // EXIF: 'from-image' aplica la rotación de la foto (mismo
          // tratamiento que la ruta A de takePhoto).
          bitmap = await win.createImageBitmap(file, {
            imageOrientation: 'from-image',
          });
        } catch {
          unreadable++;
          continue;
        }
        try {
          if (Math.max(bitmap.width, bitmap.height) > IMPORT_LONG_SIDE) {
            const s = IMPORT_LONG_SIDE / Math.max(bitmap.width, bitmap.height);
            const small = await win.createImageBitmap(bitmap, {
              resizeWidth: Math.max(1, Math.round(bitmap.width * s)),
              resizeHeight: Math.max(1, Math.round(bitmap.height * s)),
              resizeQuality: 'medium',
            });
            bitmap.close();
            bitmap = small;
          }
          const w = bitmap.width;
          const h = bitmap.height;
          // 1) Detectar el documento (mismo worker/camino que la cámara).
          const corners = await detectImportQuad(bitmap, w, h);
          // 2) Recortar (warp con refine). Sin quad → foto COMPLETA: mejor
          //    perder el recorte que perder la página.
          let out: ImageBitmap | null = null;
          if (corners !== null) {
            out = await warpImport(bitmap, corners);
            if (out !== null) cropped++;
          }
          const visible = out ?? bitmap;
          // JPEG q0.9 deliberado (la cámara guarda PNG de UNA página): un
          // lote de 10 fotos en PNG atascaría el hilo y la cuota; la cola de
          // export re-encodifica igual con el modo global (F6.5).
          const blob = await bitmapToBlob(visible, 'image/jpeg', JPEG_QUALITY);
          if (out !== null) {
            try {
              out.close();
            } catch {
              /* ya cerrado */
            }
          }
          if (!pageStore || !gallery) throw new Error('sin almacenamiento');
          await pageStore.addPage(blob, gallery.getMode());
          await gallery.render();
          added++;
        } finally {
          try {
            bitmap.close();
          } catch {
            /* ya cerrado */
          }
        }
      }
    } catch (e) {
      showErr(`Galería: ${(e as Error).message}`);
    } finally {
      importing = false;
      importBtn.disabled = false;
      importStartBtn.disabled = false;
      if (added > 0) {
        if (added === 1) {
          toast(
            cropped === 1
              ? 'Página agregada — bordes recortados solos ✓'
              : 'Página agregada (no encontramos bordes: quedó completa)',
          );
        } else {
          toast(
            `${added} páginas agregadas · ${cropped} recortadas automáticamente` +
              (unreadable > 0
                ? ` · ${unreadable} ilegible${unreadable === 1 ? '' : 's'}`
                : ''),
          );
        }
        // Llevar a ver el resultado (mismo patrón de las tabs de nav).
        try {
          el(doc, 'viewPages').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch {
          /* ancla best-effort */
        }
      } else if (unreadable > 0) {
        toast('No pudimos leer esas fotos');
      } else {
        toast('No se agregó ninguna página');
      }
    }
  };

  el(doc, 'importBtn').addEventListener('click', triggerImport);
  el(doc, 'importStartBtn').addEventListener('click', triggerImport);
  importInput.addEventListener('change', () => {
    const raw = Array.from(importInput.files ?? []);
    // Reset inmediato: re-elegir el MISMO archivo vuelve a disparar change.
    importInput.value = '';
    const files = raw.filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) {
      if (raw.length > 0) toast('Esas no son fotos');
      return;
    }
    void importFromGallery(files);
  });

  // [FASE 9] Cola de páginas visible desde el arranque (SIN worker): el
  // estado vacío ofrece "Subir fotos de tu galería" y las páginas de una
  // sesión anterior se ven sin encender la cámara. Silencioso si IndexedDB
  // está bloqueado (la cámara re-intenta al pulsar Iniciar, como siempre).
  void ensurePageStack().catch(() => {
    /* sin almacenamiento en frío: openCamera lo reintenta con error visible */
  });
  // Pre-calentamiento del worker (opencv self-hosted, offline): la cámara
  // arranca más rápido y las miniaturas de sesión anterior ya se realzan.
  // Silencioso — si falla, cada consumidor tiene su propio fallback.
  void ensurePhotoWorker().catch(() => {
    /* opencv no cargó en frío: la cámara reintenta con error visible */
  });

  const openCamera = async (): Promise<void> => {
    if (started) return;
    el<HTMLButtonElement>(doc, 'startBtn').disabled = true;
    try {
      if (useFake) {
        fake?.stop();
        fake = makeFakeCamera(doc);
        video.srcObject = fake.stream;
        profile = {
          deviceId: 'fake',
          label: 'cámara sintética',
          trackWidth: 640,
          trackHeight: 480,
          aspectRatio: 640 / 480,
          capabilities: { torch: false, focusModes: ['continuous'] },
          capturedAt: Date.now(),
        };
      } else {
        ctl = CameraController.browser();
        profile = await ctl.init({ video });
        wireCameraGuards();
      }
      await video.play();
      el(doc, 'mCam').textContent = `${profile.label} (${profile.trackWidth}×${profile.trackHeight})`;
      // [FASE 9] worker de foto + cola de páginas + galería: el MISMO bloque
      // que vivía inline aquí, extraído a ensurePhotoPipeline (idempotente) —
      // así la importación de galería lo comparte sin creación doble.
      await ensurePhotoPipeline();
      const view = new ScannerView(video, el<HTMLCanvasElement>(doc, 'ov'));
      const scoreView = new ScoreRingView(el<HTMLCanvasElement>(doc, 'ring'));
      orch = createOrchestrator(view, scoreView);
      const handles: AppHandles = {
        orch,
        gallery,
        editor,
        compare,
        enhanceMs: () => lastEnhanceMs,
        getSourceBlob: () => lastSourceBlob,
        importFiles: importFromGallery,
      };
      (win as unknown as Record<string, unknown>).__app = handles;
      const sw = new Worker(DETECTION_WORKER_URL); // clásico: ver arriba
      streamWorker = sw;
      await waitWorker(sw);
      // [R4-B2] el worker nuevo nace con 'auto': re-aplica el perfil actual.
      postProfile(sw);
      startFrameLoop({
        video,
        worker: sw,
        onStatus: (msg) => {
          if (msg.type === 'error') showErr(msg.message);
        },
        onResult: (quality, ts, corners) => {
          frameResults++;
          orch?.onWorkerResult(quality, corners, ts);
          // [R4-B4: medir, no cambiar — auto-shutter/score intactos].
          quadStab.push(corners); // null se ignora dentro del buffer
          // R4: guía de encuadre NO-bloqueante (solo overlay informativo —
          // no toca auto-shutter ni score).
          const framing = framingInfo(corners, quality.frameW, quality.frameH);
          const hint =
            framing !== null && framing.showHint
              ? `Acerca el documento: llena el encuadre (~${framing.estShortPx}px)`
              : null;
          view.render({ corners, valid: corners !== null }, quality.frameW, quality.frameH, hint);
          if (frameResults % 20 === 0) {
            el(doc, 'mFps').textContent = (
              frameResults /
              ((performance.now() - startedAt) / 1000)
            ).toFixed(1);
          }
          // [R4-B4] cada 10 frames (ventana del buffer): ±px de dispersión.
          if (frameResults % 10 === 0) {
            const v = quadStab.variancePx(quality.frameW, quality.frameH);
            el(doc, 'mQuadStab').textContent =
              v === null ? '—' : `±${v.toFixed(1)} px (n=${quadStab.size()})`;
          }
          if (quality.diag) el(doc, 'mCont').textContent = String(quality.diag.contourCount);
        },
      });
      startedAt = performance.now();
      orch.start();
      started = true;
      el<HTMLButtonElement>(doc, 'shutterBtn').disabled = false;
      el<HTMLButtonElement>(doc, 'torchBtn').disabled = !profile.capabilities.torch;
      el<HTMLButtonElement>(doc, 'torchBtn').textContent = profile.capabilities.torch
        ? 'Linterna'
        : 'Linterna ✕';
      showErr('');
    } catch (e) {
      // F6.4: clasificar SOLO CameraInitError; la cadena opencv pasa intacta.
      if (e instanceof CameraInitError) {
        const info = classifyCameraError(e);
        showErr(`Inicio: ${info.title}. ${info.hint}`);
      } else showErr(`Inicio: ${(e as Error).message}`);
      el<HTMLButtonElement>(doc, 'startBtn').disabled = false;
    }
  };

  // --- editor F6.5 (mismo contrato que F4: submit/revert/cancel) ---
  const fbOf = (
    photo: CapturedPhoto | null,
  ): [boolean, boolean, boolean, boolean] | null =>
    photo && photo.warped && lastWarpMeta ? lastWarpMeta.fellBack : null;
  const editor = new AdjustEditor({
    root: el(doc, 'editorRoot'),
    canvas: el<HTMLCanvasElement>(doc, 'editorCanvas'),
    callbacks: {
      onConfirm: (quad) => {
        void orch
          ?.submitEditedQuad(quad)
          .then((r) => {
            if (r === 'fallback') {
              // [F5-MANUAL] último recurso real: quad irrecuperable (ni el
              // reorden lo saneó) → bounding box con aviso.
              const msg = 'Quad irrecuperable — se guardó el recuadro (bounding box)';
              toast(msg);
              el(doc, 'editorErr').textContent = msg;
            } else {
              el(doc, 'editorErr').textContent = '';
              // [F6-STAGING, 2026-11 — petición humana] la edición vive
              // (staged) hasta el Agregar — guía explícita porque antes se
              // perdía EN SILENCIO bajo la ráfaga de auto-capturas (bug
              // reportado: "no guarda la modificación del corte y dice
              // warped").
              if (r === 'ok') toast('Recorte aplicado — pulsa "Agregar al documento"');
            }
            if (r === 'busy') {
              const msg = 'FSM ocupado — reintenta';
              toast(msg);
              el(doc, 'editorErr').textContent = msg;
              return;
            }
            el(doc, 'editorErr').textContent = '';
            editor.close();
          })
          .catch((e: Error) => {
            const msg = `Confirm: ${e.message}`;
            showErr(msg);
            el(doc, 'editorErr').textContent = msg;
          });
      },
      onRevert: () => {
        void orch
          ?.revertEditedQuad()
          .then((ok) => {
            if (!ok) {
              const msg =
                'Sin detección automática que aplicar (captura manual): ajusta las esquinas y confirma';
              toast(msg);
              el(doc, 'editorErr').textContent = msg;
              return;
            }
            el(doc, 'editorErr').textContent = '';
            if (lastPhoto) void editor.open(lastPhoto, fbOf(lastPhoto));
          })
          .catch((e: Error) => {
            const msg = `Revert: ${e.message}`;
            showErr(msg);
            el(doc, 'editorErr').textContent = msg;
          });
      },
    },
  });

  // --- cableado de botones (shutter SIEMPRE visible; habilitado tras boot) ---
  el(doc, 'startBtn').addEventListener('click', () => {
    void (camLost ? reactivateCamera() : openCamera());
  });
  el(doc, 'shutterBtn').addEventListener('click', () => {
    if (started) void orch?.captureManual();
  });
  let torchOn = false;
  el(doc, 'torchBtn').addEventListener('click', async () => {
    if (!ctl) return;
    const result = await ctl.setTorch(!torchOn);
    if (result !== 'unsupported') torchOn = !torchOn;
    el(doc, 'torchBtn').textContent = result === 'unsupported'
      ? 'Linterna ✕'
      : `Linterna ${torchOn ? 'encendida' : 'apagada'}`;
  });
  el(doc, 'addBtn').addEventListener('click', () => {
    if (!lastSourceBlob || !pageStore || !gallery) return;
    const blob = lastSourceBlob;
    const store = pageStore;
    const gal = gallery;
    persistPageStorage()
      .then(() => store.addPage(blob, gal.getMode()))
      .then(() => gal.render())
      .then(() => {
        toast('Página agregada');
        // [F6-STAGING, 2026-11 — petición humana "no guarda el recorte"]
        // la captura fue CONSUMIDA: reanudar el escaneo. Las capturas
        // manuales/ediciones viven staged SIN cooldown y necesitan este
        // empujón para volver a detecting; con el flujo auto es un no-op o
        // un salto de cooldown (página siguiente más rápido).
        orch?.resumeScanning();
      })
      .catch((e: Error) => showErr(`Página: ${e.message}`));
  });
  el(doc, 'editBtn').addEventListener('click', () => {
    if (!lastPhoto) {
      toast('Captura una página primero');
      return;
    }
    if (orch?.openEditor()) {
      el(doc, 'editorErr').textContent = '';
      void editor.open(lastPhoto, fbOf(lastPhoto));
    } else toast('Editor no disponible ahora (captura primero)');
  });
  el(doc, 'editorConfirmBtn').addEventListener('click', () => editor.onConfirm());
  el(doc, 'editorRevertBtn').addEventListener('click', () => editor.onRevert());
  el(doc, 'editorCancelBtn').addEventListener('click', () => {
    orch?.cancelEditing();
    editor.close();
  });
  el(doc, 'refreshBtn').addEventListener('click', () => {
    if (gallery) void gallery.render();
  });
  el(doc, 'pdfSizeBtn').addEventListener('click', () => {
    pageSize = pageSize === 'adaptive' ? 'letter' : pageSize === 'letter' ? 'a4' : 'adaptive';
    el(doc, 'pdfSizeBtn').textContent = `Página PDF: ${pageSizeLabel(pageSize)}`;
  });
  el(doc, 'pdfBtn').addEventListener('click', () => {
    if (!gallery) return;
    const gal = gallery;
    el<HTMLButtonElement>(doc, 'pdfBtn').disabled = true;
    toast('Procesando modo y generando PDF…');
    gal
      .exportPdf(pageSize)
      .then((result) => {
        if (!result) return;
        // [FASE 8] hoja de Exportación exitosa (pantalla 4 del diseño):
        // resumen + relés Compartir/Descargar sobre el MISMO blob (guardado
        // en onExport). El toast guía permanece como feedback previo.
        toast(
          `PDF: ${result.count} páginas, ${(result.size / 1024 / 1024).toFixed(2)} MB — "Nuevo documento" para escanear otro`,
        );
        el(doc, 'expName').textContent = lastPdfName || pdfFileName();
        el(doc, 'expMeta').textContent = `${result.count} página${
          result.count === 1 ? '' : 's'
        } · ${(result.size / 1024 / 1024).toFixed(2)} MB · PDF`;
        el(doc, 'exportSheet').hidden = false;
      })
      .catch((e: Error) => showErr(`PDF: ${e.message}`))
      .finally(() => {
        el<HTMLButtonElement>(doc, 'pdfBtn').disabled = false;
      });
  });

  // [FASE 8] relés de la hoja de exportación: mismos helpers, cero lógica nueva.
  el(doc, 'expClose').addEventListener('click', () => {
    el(doc, 'exportSheet').hidden = true;
  });
  el(doc, 'expShare').addEventListener('click', () => {
    if (lastPdf) void shareOrDownload(lastPdf, 'share');
  });
  el(doc, 'expDownload').addEventListener('click', () => {
    if (lastPdf) void shareOrDownload(lastPdf, 'download');
  });
  // "Nuevo documento" de la hoja: confirmación en dos pasos (mismo patrón del
  // botón de Páginas — sin diálogo nativo). Armado 5s → confirmar ejecuta.
  {
    const expNew = el<HTMLButtonElement>(doc, 'expNew');
    const EXP_NEW_LABEL = expNew.textContent ?? 'Nuevo documento';
    let expNewArmed = false;
    let expNewTimer = 0;
    const expNewDisarm = (): void => {
      expNewArmed = false;
      win.clearTimeout(expNewTimer);
      expNew.textContent = EXP_NEW_LABEL;
      expNew.classList.remove('danger');
    };
    expNew.addEventListener('click', () => {
      if (!gallery) return;
      if (!expNewArmed) {
        expNewArmed = true;
        expNew.textContent = '¿Descartar las páginas? Toca de nuevo';
        expNew.classList.add('danger');
        expNewTimer = win.setTimeout(expNewDisarm, 5000);
        return;
      }
      expNewDisarm();
      el(doc, 'exportSheet').hidden = true;
      gallery
        .newDocument()
        .then((n) => {
          if (n === 0) toast('No hay páginas: el documento ya estaba vacío');
          else toast(`Documento nuevo — ${n} página${n === 1 ? '' : 's'} descartada${n === 1 ? '' : 's'}`);
        })
        .catch((e: Error) => showErr(`Nuevo documento: ${e.message}`));
    });
  }

  // [FASE 7a, 2026-11 — flujo diario "cuál es el siguiente paso"]
  // "Nuevo documento": descarta la cola persistida (páginas del documento
  // anterior) para empezar otro. Confirmación en DOS PASOS SIN diálogo
  // nativo: en móvil confirm() bloquea y en headless de pruebas se
  // auto-rechaza; primer toque arma el botón 5s con texto explícito, el
  // segundo ejecuta. Cero toques en captura/worker/orchestrator.
  const newDocBtn = el<HTMLButtonElement>(doc, 'newDocBtn');
  const NEWDOC_LABEL = newDocBtn.textContent;
  let newDocArmed = false;
  let newDocTimer = 0;
  const newDocDisarm = (): void => {
    newDocArmed = false;
    win.clearTimeout(newDocTimer);
    newDocBtn.textContent = NEWDOC_LABEL ?? 'Nuevo documento';
    newDocBtn.classList.remove('danger');
  };
  newDocBtn.addEventListener('click', () => {
    if (!gallery || !pageStore) return;
    if (!newDocArmed) {
      const count = el(doc, 'gallery').querySelectorAll('.pg-thumb').length;
      if (count === 0) {
        toast('No hay páginas: el documento ya está vacío');
        return;
      }
      newDocArmed = true;
      newDocBtn.textContent = `¿Descartar ${count} página${count === 1 ? '' : 's'}? Toca de nuevo`;
      newDocBtn.classList.add('danger');
      newDocTimer = win.setTimeout(newDocDisarm, 5000);
      return;
    }
    newDocDisarm();
    gallery
      .newDocument()
      .then((n) => {
        if (n === 0) toast('No hay páginas: el documento ya estaba vacío');
        else toast(`Documento nuevo — ${n} página${n === 1 ? '' : 's'} descartada${n === 1 ? '' : 's'}`);
      })
      .catch((e: Error) => showErr(`Nuevo documento: ${e.message}`));
  });

  if (params.get('autostart') === '1') void openCamera();

  const handles: AppHandles = {
    orch: null,
    gallery: null,
    editor,
    compare: null,
    enhanceMs: () => lastEnhanceMs,
    getSourceBlob: () => lastSourceBlob,
    importFiles: importFromGallery,
  };
  (win as unknown as Record<string, unknown>).__app = handles;
  return handles;
}
