// src/core/types.ts — tipos compartidos del núcleo (PLAN_MAESTRO §8).
// SIN DOM: testeable en Node (corre el mismo código que producción).

/** Punto en el plano de la imagen. Contrato: coordenadas en píxeles de la imagen
 *  en la que se midió el quad (frame de video o foto hi-res, nunca mezclar). */
export interface Corner {
  x: number;
  y: number;
}

/** Cuadrilátero en orden canónico FIJO: [TL, TR, BR, BL] (§8 y §5-F3).
 *  Cualquier corner puede indexarse por posición; orderPoints() garantiza el orden. */
export type Quadrilateral = [Corner, Corner, Corner, Corner];

/** Score de calidad compuesto (PLAN_MAESTRO §5-F2/T3). Todos los componentes 0–1.
 *  Medido sobre el CROP del documento a resolución fija, nunca sobre frame completo. */
export interface QualityScore {
  /** Nitidez: Var(Laplacian) normalizada sobre el crop. */
  sharpness: number;
  /** Exposición: distancia de percentiles 5/95 del histograma a un rango sano. */
  exposure: number;
  /** Estabilidad: 1 − varianza normalizada de quads en ventana temporal de 600ms (F2-b). */
  stability: number;
  /** Excentricidad del quad: esquinas pegadas a bordes = territorio de distorsión de lente. */
  eccentricity: number;
  /** Brillo especular: fracción de píxeles >248 (info irrecuperable por CLAHE). */
  specular: number;
  /** Ponderado 0.4·sharpness + 0.3·exposure + 0.3·stability (§5-F2). */
  total: number;
  /** true si el crop está borroso (isBlur derivado del componente de nitidez). */
  isBlur: boolean;
}

/** Capacidades del track reportadas por getCapabilities() (§5-F0). */
export interface CameraCapabilities {
  torch: boolean;
  focusModes: string[];
  zoom?: number;
}

/** Perfil de la cámara/track medido en runtime (§5-F0). Nada de esto se asume:
 *  lo llena CameraController + el spike F0 (ejecución SOLO humana). */
export interface CameraProfile {
  deviceId: string;
  label: string;
  trackWidth: number;
  trackHeight: number;
  /** Aspect ratio del track: trackWidth / trackHeight. */
  aspectRatio: number;
  capabilities: CameraCapabilities;
  /** DPI efectivo = anchoQuadPx / anchoPapel(in) — medido por captura (§4).
   *  Opcional: lo llena el spike F0; ausente hasta entonces. */
  dpiRuntime?: number;
  /** Timestamp UNIX (ms) de la medición del perfil. */
  capturedAt: number;
}

/** Modo de procesamiento de la cola multipágina (§5-F5). Compartido por
 *  ScanPage, el protocolo del worker (EnhanceRequest) y el export de PDF.
 *  Per-page override PROHIBIDO (orden F5): el modo es global.
 *  D-F5-c (2026-09-26): 'bw' (Sauvola) se RETIRÓ y entró 'text'.
 *  [RONDA 4 A1, 2026-09-28] 'bw' VUELVE como ciudadano de primera: modo
 *  "B/N adaptativo" con umbral LOCAL Bradley-Roth (+ variante Sauvola en el
 *  laboratorio). Id interno genérico `bw`; PROHIBIDA cualquier cadena visible
 *  al usuario que mencione un formato de documento específico.
 *  [F5-RAW, 2026-10-01 — petición humana + análisis de sugerencias]: 'raw'
 *  = "Original de cámara": SOLO recorte/perspectiva del warp, CERO retoque
 *  de color/contraste (sin sombras, sin CLAHE) y SIN el unsharp de warpPage
 *  (el modo viaja en el WarpRequest para que el worker lo salte). Encode
 *  PNG sin pérdida. */
export type EnhanceMode = 'raw' | 'color' | 'gray' | 'natural' | 'text' | 'bw';

/** [RONDA 4 B2] Perfil GENÉRICO de documento para los priores suaves de
 *  selectQuad (preferencias, NUNCA rechazo duro: un documento fuera de
 *  perfil sigue siendo válido — regla del escáner genérico).
 *  - 'auto': sin prior de aspecto (comportamiento pre-R4, solo blancura).
 *  - 'documento-largo': actas/tirillas — aspecto 1.3–4.5 vertical.
 *  - 'pagina': carta/A4 — aspecto 1.2–1.6 en ambas orientaciones.
 *  - 'tarjeta': credenciales — aspecto 0.6–0.8 horizontal. */
export type DocProfile = 'auto' | 'documento-largo' | 'pagina' | 'tarjeta';

/** Página escaneada dentro de la cola multipágina (§5-F5). */
export interface ScanPage {
  id: string;
  /** Blob del resultado warpeado; opcional hasta exportar. */
  blob?: Blob;
  /** Quad final (auto o ajustado) en orden TL,TR,BR,BL. */
  quad: Quadrilateral;
  /** Modo de procesamiento (§5-F5): 4 modos del pipeline. */
  mode: EnhanceMode;
  /** Índice de orden en la cola multipágina. */
  order: number;
}

/** Anchos de papel de referencia en pulgadas (D1: carta como referencia). */
export const PAPER_SIZES_IN = {
  letter: 8.5,
  a4: 8.27,
} as const;

export type PaperSizeKey = keyof typeof PAPER_SIZES_IN;

/** Formato por defecto (D1 — carta): la diana F4 y el export F5 usan Letter,
 *  A4 queda como alternativa documentada. */
export const PAPER_DEFAULT_IN: PaperSizeKey = 'letter';