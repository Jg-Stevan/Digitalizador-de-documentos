// src/camera/CameraController.ts — selección, apertura y perfil de cámara (T5).
// F0 días 3-5 + hallazgos D2/D3. Reutiliza CameraProfile/CameraCapabilities de
// core/types.ts (SOLO lectura — prohibido modificar core/ aprobado).
// Testeable en Node: dependencias de medios inyectables (navegador real solo
// en los defaults). La verificación en dispositivo físico es HUMANA (AGENTS.md).

import type { CameraProfile } from '../core/types';
import { classifyCameraError, type CameraErrorCode } from './cameraErrors';

/** Error de arranque de cámara CON código clasificado (F6.4). Conserva el
 *  mensaje histórico (los tests asertan /3 niveles/ y /sin cámaras/) y añade
 *  .code para la UI + .cause para diagnóstico/telemetría. */
export class CameraInitError extends Error {
  readonly code: CameraErrorCode;
  constructor(
    message: string,
    code: CameraErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'CameraInitError';
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Capacidades medidas de UNA cámara (vía track abierto temporalmente). */
export interface CameraProbe {
  deviceId: string;
  label: string;
  focusModes: string[];
  torch: boolean;
  maxWidth: number;
  maxHeight: number;
}

export interface CameraChoice {
  probe: CameraProbe;
  /** Avisos no fatales (fallback fixed-focus, sin etiqueta back, etc.). */
  warnings: string[];
}

/** Presupuesto de píxeles del getUserMedia inicial (SIN ratio — disciplina
 *  T4.3: solo ancho ideal; el alto lo negocia el navegador). */
export const IDEAL_CAPTURE_WIDTH = 3840;

/** Etiqueta de cámara trasera (heurística de label; enumerateDevices no da
 *  facingMode — ver chooseMainCamera para el fallback documentado). */
const BACK_LABEL_RE = /back|rear|environment|trasera|posterior|arri[eè]re/i;

/** Modos de foco que cuentan como autofocus REAL (regla D3, T1-R4). */
const REAL_AF_MODES = new Set(['continuous', 'single-shot']);

export function hasRealAutofocus(focusModes: string[]): boolean {
  return focusModes.some((m) => REAL_AF_MODES.has(m.toLowerCase()));
}

/** Palabras que delatan un grupo NO-principal (ultra-wide/tele) en el label.
 *  D6 (F1-b): iOS no expone focusMode y todos los grupos dan el mismo track
 *  (D5) — el sort por resolución es ciego y eligió la ultra-wide en el iPhone. */
export const LENS_WORDS_RE = /ultra|gran angular|wide|angular|tele|teleobjetivo/i;

/** Nº de palabras del label (aprox de "términos de lente": menos = más simple). */
function wordCount(label: string): number {
  return label.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Regla D3: traseras con autofocus real → desempate por max resolución.
 *  Sin AF en ninguna → rama D6 (F1-b): preferir el grupo SIMPLE trasero (sin
 *  palabras de lente); entre simples, menos palabras y luego más resolución
 *  (D5: las resoluciones de grupos virtuales son idénticas/ciegas, así que el
 *  conteo de palabras manda y la resolución solo desempata).
 *  Sin etiquetas traseras → se consideran TODAS + warning (facingMode no está
 *  disponible pre-stream; documentado como último fallback). */
export function chooseMainCamera(probes: CameraProbe[]): CameraChoice | null {
  if (probes.length === 0) return null;
  const warnings: string[] = [];
  const backs = probes.filter((p) => BACK_LABEL_RE.test(p.label));
  const pool = backs.length > 0 ? backs : probes;
  if (backs.length === 0) {
    warnings.push('sin etiqueta trasera: se evalúan todas (facingMode no disponible pre-stream)');
  }
  const withAf = pool.filter((p) => hasRealAutofocus(p.focusModes));
  const byRes = (a: CameraProbe, b: CameraProbe) =>
    b.maxWidth * b.maxHeight - a.maxWidth * a.maxHeight;
  if (withAf.length > 0) {
    const best = [...withAf].sort(byRes)[0]!;
    return { probe: best, warnings };
  }
  // Rama D6: sin autofocus real (típico iOS) — heurística por label.
  const simples = pool.filter((p) => !LENS_WORDS_RE.test(p.label));
  const ranked =
    simples.length > 0
      ? [...simples].sort(
          (a, b) => wordCount(a.label) - wordCount(b.label) || byRes(a, b),
        )
      : [...pool].sort(
          (a, b) => a.label.length - b.label.length || byRes(a, b),
        );
  const fallback = ranked[0]!;
  if (simples.length === 0) {
    warnings.push(`sin grupo simple, usando "${fallback.label}"`);
  }
  warnings.push(`sin autofocus real: fallback a "${fallback.label}" (fixed-focus, D6)`);
  return { probe: fallback, warnings };
}

export interface MediaDeps {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Abre la cámara solo para leer capabilities y la cierra (F0, una vez). */
  probeDevice(deviceId: string, label: string): Promise<CameraProbe>;
  now(): number;
}

export interface ControllerInit {
  /** deviceId preferido (salta la elección D3; útil para tests/harness). */
  deviceId?: string;
  video?: HTMLVideoElement;
}

function readCapsNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export class CameraController {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private profile: CameraProfile | null = null;
  readonly warnings: string[] = [];

  constructor(private readonly deps: MediaDeps) {}

  /** Defaults del navegador real. */
  static browser(): CameraController {
    return new CameraController({
      enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      probeDevice: async (deviceId, label) => {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId } },
        });
        try {
          const t = s.getVideoTracks()[0]!;
          const c = t.getCapabilities() as MediaTrackCapabilities & {
            focusMode?: string[];
            torch?: boolean;
            width?: { max?: number };
            height?: { max?: number };
          };
          return {
            deviceId,
            label: label || t.label,
            focusModes: Array.isArray(c.focusMode) ? c.focusMode : [],
            torch: c.torch === true,
            maxWidth: readCapsNumber(c.width?.max),
            maxHeight: readCapsNumber(c.height?.max),
          };
        } finally {
          for (const t of s.getTracks()) t.stop();
        }
      },
      now: () => Date.now(),
    });
  }

  async init(opts: ControllerInit = {}): Promise<CameraProfile> {
    // Desbloqueo de etiquetas (F1-a): en origen fresco los labels/deviceIds
    // vienen vacíos hasta conceder permiso — se pide un stream genérico y se
    // cierra (patrón del spike). Sin cámara, enumerate lo confirma abajo.
    // F6.4: el error del desbloqueo se CONSERVA — si los probes mueren todos
    // (síntoma típico de permiso denegado) clasifica el fallo REAL en vez de
    // mentir con "sin cámaras".
    let unlockErr: unknown = null;
    try {
      const unlock = await this.deps.getUserMedia({ video: true });
      for (const t of unlock.getTracks()) t.stop();
    } catch (e) {
      unlockErr = e; // Sigue a enumerate: dictamina si hay cámaras o no.
    }
    const devices = await this.deps.enumerateDevices();
    const videos = devices.filter((d) => d.kind === 'videoinput');
    const probes: CameraProbe[] = [];
    for (const d of videos) {
      try {
        probes.push(await this.deps.probeDevice(d.deviceId, d.label));
      } catch {
        this.warnings.push(`probe falló para "${d.label || d.deviceId}": descartada`);
      }
    }
    let deviceId = opts.deviceId;
    if (deviceId === undefined) {
      const choice = chooseMainCamera(probes);
      if (choice === null) {
        const unlockInfo = classifyCameraError(unlockErr);
        if (unlockErr !== null && unlockInfo.code === 'permission') {
          // enumerate devuelve lista con labels vacíos sin permiso: los probes
          // fallan todos y parece "sin cámaras" — el desbloqueo dice la verdad.
          throw new CameraInitError(
            `sin cámaras videoinput disponibles (${unlockInfo.title.toLowerCase()})`,
            'permission',
            { cause: unlockErr },
          );
        }
        throw new CameraInitError('sin cámaras videoinput disponibles', 'no-device');
      }
      this.warnings.push(...choice.warnings);
      deviceId = choice.probe.deviceId;
    }
    // Apertura con presupuesto de píxeles; fallbacks en cascada.
    const attempts: MediaStreamConstraints[] = [
      { video: { deviceId: { exact: deviceId }, width: { ideal: IDEAL_CAPTURE_WIDTH } } },
      { video: { deviceId: { exact: deviceId } } },
      { video: true },
    ];
    let lastErr: unknown = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        this.stream = await this.deps.getUserMedia(attempts[i]!);
        if (i > 0) this.warnings.push(`getUserMedia fallback nivel ${i} (sin presupuesto/sin deviceId)`);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (this.stream === null) {
      throw new CameraInitError(
        `getUserMedia falló en 3 niveles: ${String(lastErr)}`,
        classifyCameraError(lastErr).code,
        { cause: lastErr },
      );
    }
    const track = this.stream.getVideoTracks()[0];
    if (track === undefined) {
      throw new CameraInitError('stream sin video track', 'unknown');
    }
    this.track = track;
    if (opts.video !== undefined) opts.video.srcObject = this.stream;
    this.profile = this.buildProfile();
    return this.profile;
  }

  getProfile(): CameraProfile | null {
    return this.profile;
  }

  /** Track de video activo o null (F6.4: el harness escucha 'ended' para
   *  detectar permiso revocado en vivo / cámara arrebatada por otra app). */
  getTrack(): MediaStreamTrack | null {
    return this.track;
  }

  /** Re-lee getSettings()/getCapabilities (D2: llamar al girar el teléfono). */
  async refreshProfile(): Promise<CameraProfile> {
    if (this.track === null) throw new Error('refreshProfile sin init');
    this.profile = this.buildProfile();
    return this.profile;
  }

  /** Torch con degradación silenciosa (skill ios-camera-quirks). */
  async setTorch(on: boolean): Promise<'on' | 'off' | 'unsupported'> {
    if (this.track === null) return 'unsupported';
    const caps = this.track.getCapabilities() as MediaTrackCapabilities & {
      torch?: boolean;
    };
    if (caps.torch !== true) return 'unsupported';
    try {
      await this.track.applyConstraints({
        advanced: [{ torch: on } as MediaTrackConstraintSet],
      });
      return on ? 'on' : 'off';
    } catch {
      return 'unsupported';
    }
  }

  /** Re-perfila al cambiar orientación/tamaño (D2); devuelve desapuntador. */
  watchOrientation(cb: (profile: CameraProfile) => void): () => void {
    const handler = (): void => {
      this.refreshProfile().then(cb, () => {});
    };
    const so = window.screen.orientation;
    if (so !== undefined && so !== null) so.addEventListener('change', handler);
    window.addEventListener('resize', handler);
    return () => {
      if (so !== undefined && so !== null) so.removeEventListener('change', handler);
      window.removeEventListener('resize', handler);
    };
  }

  stop(): void {
    if (this.stream !== null) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    this.track = null;
  }

  private buildProfile(): CameraProfile {
    const track = this.track!;
    const s = track.getSettings();
    const c = track.getCapabilities() as MediaTrackCapabilities & {
      focusMode?: string[];
      torch?: boolean;
      zoom?: { max?: number };
    };
    const w = readCapsNumber(s.width);
    const h = readCapsNumber(s.height);
    return {
      deviceId: readCapsString(s.deviceId),
      label: track.label,
      trackWidth: w,
      trackHeight: h,
      aspectRatio: h > 0 ? w / h : 0,
      capabilities: {
        torch: c.torch === true,
        focusModes: Array.isArray(c.focusMode) ? c.focusMode : [],
        zoom: typeof c.zoom?.max === 'number' ? c.zoom.max : undefined,
      },
      capturedAt: this.deps.now(),
    };
  }
}

function readCapsString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
