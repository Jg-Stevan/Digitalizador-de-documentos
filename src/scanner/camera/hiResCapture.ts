// src/camera/hiResCapture.ts — primitivas de captura hi-res A/B/C (T5).
// SIN política de disparo (F2) ni re-detección (F3): cada ruta devuelve el
// bitmap + resolución efectiva para telemetría. EXIF: createImageBitmap con
// {imageOrientation:'from-image'} (skill ios-camera-quirks) + fallback.
// Testeable en Node con factory de canvas e ImageCapture/decoder inyectados.

export type CaptureRoute = 'A' | 'B' | 'C';

export interface RouteCapture {
  route: CaptureRoute;
  bitmap: ImageBitmap;
  w: number;
  h: number;
  latencyMs: number;
}

/** La ruta no está disponible en este navegador/dispositivo. */
export class RouteUnsupportedError extends Error {
  constructor(readonly route: CaptureRoute, detail: string) {
    super(`ruta ${route} no soportada: ${detail}`);
    this.name = 'RouteUnsupportedError';
  }
}

/** Calidad JPEG de la ruta B (PLAN_MAESTRO §5-F5: q88-92 → 92). */
export const ROUTE_B_JPEG_QUALITY = 0.92;

export interface CaptureDeps {
  ImageCaptureCtor?: new (track: MediaStreamTrack) => {
    takePhoto(): Promise<Blob>;
  };
  decode(
    blob: Blob,
    options?: ImageBitmapOptions,
  ): Promise<ImageBitmap>;
  createCanvas(w: number, h: number): {
    getContext(id: '2d'): CanvasRenderingContext2D | null;
    toBlob(cb: (b: Blob | null) => void, type?: string, quality?: number): void;
  };
  now(): number;
}

function defaultDeps(): CaptureDeps {
  const hasWindow = typeof window !== 'undefined';
  return {
    ImageCaptureCtor:
      hasWindow && 'ImageCapture' in window
        ? (window.ImageCapture as CaptureDeps['ImageCaptureCtor'])
        : undefined,
    decode: (blob, options) =>
      options !== undefined
        ? createImageBitmap(blob, options)
        : createImageBitmap(blob),
    createCanvas: (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    },
    now: () => performance.now(),
  };
}

function withDefaults(deps?: Partial<CaptureDeps>): CaptureDeps {
  return { ...defaultDeps(), ...deps };
}

/** Decodifica respetando EXIF; si el navegador rechaza la opción, reintenta
 *  sin ella (el bitmap sale sin rotar — el caller lo loguea por dims). */
async function decodeWithExif(
  decode: CaptureDeps['decode'],
  blob: Blob,
): Promise<ImageBitmap> {
  try {
    return await decode(blob, { imageOrientation: 'from-image' });
  } catch {
    return decode(blob);
  }
}

/** Ruta A (Chrome/Android): takePhoto() con AF/AE de hardware → blob → bitmap. */
export async function capturePhoto(
  track: MediaStreamTrack,
  deps?: Partial<CaptureDeps>,
): Promise<RouteCapture> {
  const d = withDefaults(deps);
  if (d.ImageCaptureCtor === undefined) {
    throw new RouteUnsupportedError('A', 'ImageCapture ausente (típico iOS)');
  }
  const t0 = d.now();
  const blob = await new d.ImageCaptureCtor(track).takePhoto();
  const bitmap = await decodeWithExif(d.decode, blob);
  return { route: 'A', bitmap, w: bitmap.width, h: bitmap.height, latencyMs: d.now() - t0 };
}

/** Ruta B (iOS auto): drawImage del video a canvas nativo → JPEG q92 → bitmap. */
export async function captureFrame(
  video: HTMLVideoElement,
  w: number,
  h: number,
  deps?: Partial<CaptureDeps>,
): Promise<RouteCapture> {
  const d = withDefaults(deps);
  const t0 = d.now();
  const canvas = d.createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('ruta B: contexto 2d null');
  ctx.drawImage(video, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b === null ? reject(new Error('ruta B: toBlob null')) : resolve(b)),
      'image/jpeg',
      ROUTE_B_JPEG_QUALITY,
    );
  });
  const bitmap = await decodeWithExif(d.decode, blob);
  return { route: 'B', bitmap, w: bitmap.width, h: bitmap.height, latencyMs: d.now() - t0 };
}

/** Ruta C (iOS manual FULL-RES): files del <input capture> → bitmaps EXIF. */
export async function filesToBitmaps(
  files: File[] | FileList,
  deps?: Partial<CaptureDeps>,
): Promise<RouteCapture[]> {
  const d = withDefaults(deps);
  const t0 = d.now();
  const list = Array.isArray(files) ? files : Array.from(files);
  const out: RouteCapture[] = [];
  for (const f of list) {
    const bitmap = await decodeWithExif(d.decode, f);
    out.push({
      route: 'C',
      bitmap,
      w: bitmap.width,
      h: bitmap.height,
      latencyMs: d.now() - t0,
    });
  }
  return out;
}
