// src/ui/ScannerView.ts — overlay del polígono en vivo (F1 Fase 2).
// Video + canvas con object-fit: contain y matemática display↔nativo portada
// del spike (allí demostrada con drag a 0px error). Polígono verde si el quad
// es válido, rojo si no; sin handles editables (F4) y sin suavizado entre
// frames (prohibido por el spec F1 sin espec UX). Aviso D2: "gira el teléfono"
// cuando el documento es más alto que ancho y el frame está en landscape.
// La matemática es pura y testeada; solo render() toca el canvas.

import { computeWarpDims } from '../core/warp';
import type { Quadrilateral } from '../core/types';

export interface DisplayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rect del video dentro del canvas con object-fit: contain. */
export function displayRect(
  cw: number,
  ch: number,
  vw: number,
  vh: number,
): DisplayRect {
  if (!(cw > 0) || !(ch > 0) || !(vw > 0) || !(vh > 0)) {
    return { x: 0, y: 0, w: Math.max(0, cw), h: Math.max(0, ch) };
  }
  const a = vw / vh;
  let w: number;
  let h: number;
  if (cw / ch > a) {
    h = ch;
    w = ch * a;
  } else {
    w = cw;
    h = cw / a;
  }
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

export function native2disp(
  nx: number,
  ny: number,
  r: DisplayRect,
  nw: number,
  nh: number,
): { x: number; y: number } {
  return { x: r.x + (nx / nw) * r.w, y: r.y + (ny / nh) * r.h };
}

export function disp2native(
  dx: number,
  dy: number,
  r: DisplayRect,
  nw: number,
  nh: number,
): { x: number; y: number } {
  return { x: ((dx - r.x) / r.w) * nw, y: ((dy - r.y) / r.h) * nh };
}

/** D2: quad válido más alto que ancho (en px del frame) + frame en landscape
 *  → sugerir girar el teléfono a vertical. corners en fracciones 0–1. */
export function shouldSuggestPortrait(
  corners: Float32Array,
  frameW: number,
  frameH: number,
): boolean {
  if (corners.length !== 8 || !(frameW > frameH)) return false;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (let i = 0; i < 4; i++) {
    const x = corners[2 * i]!;
    const y = corners[2 * i + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return (maxY - minY) * frameH > (maxX - minX) * frameW;
}

export interface OverlayState {
  /** Esquinas en fracciones del frame (orden TL,TR,BR,BL) o null. */
  corners: Float32Array | null;
  /** validateQuad del productor (worker usa selectQuad: null = inválido). */
  valid: boolean;
}

// ---------------------------------------------------------------------------
// R4 — guía de encuadre para documentos alargados (hallazgo #2 reencuadrado)
// ---------------------------------------------------------------------------

/** R4: fracción del ancho del frame bajo la cual se sugiere acercar el
 *  documento. PROVISIONAL (geometría pura, sin datos de usuarios aún) —
 *  documentado en el dossier; no es umbral de calidad del pipeline. */
export const FRAMING_WIDTH_FRAC = 0.8;
/** R4: si el quad ya llena ≥95% de la altura, un 1:3 está al máximo físico
 *  del sensor (el encuadre, no el cap, manda) → NO mostrar el hint. */
export const FRAMING_HEIGHT_FRAC = 0.95;

export interface FramingInfo {
  /** Ancho del quad / ancho del frame (0–1). */
  quadFracW: number;
  /** Alto del quad / alto del frame (0–1). */
  quadFracH: number;
  /** Lado corto estimado de salida en px (política V1 vigente) — a ESCALA
   *  DE FRAME: el warp corre sobre la foto (≈2–3× más densa), así que el
   *  número absoluto subestima; lo que guía es que es MONÓTONO con el
   *  encuadre (acercar el documento → número mayor). */
  estShortPx: number;
  /** ¿Mostrar "acerca el documento"? */
  showHint: boolean;
}

/** % del frame que ocupa el quad + resolución estimada de salida (R4).
 *  corners en fracciones 0–1 (mismo espacio que OverlayState). Inválido →
 *  null (nunca lanza; el overlay simplemente no sugiere nada). */
export function framingInfo(
  corners: Float32Array | null,
  frameW: number,
  frameH: number,
): FramingInfo | null {
  if (corners === null || corners.length !== 8 || !(frameW > 0) || !(frameH > 0)) {
    return null;
  }
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (let i = 0; i < 4; i++) {
    const x = corners[2 * i]!;
    const y = corners[2 * i + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const quadFracW = Math.max(0, maxX - minX);
  const quadFracH = Math.max(0, maxY - minY);
  const quad: Quadrilateral = [
    { x: minX * frameW, y: minY * frameH },
    { x: maxX * frameW, y: minY * frameH },
    { x: maxX * frameW, y: maxY * frameH },
    { x: minX * frameW, y: maxY * frameH },
  ];
  const dims = computeWarpDims(quad);
  return {
    quadFracW,
    quadFracH,
    estShortPx: Math.min(dims.w, dims.h),
    // Al máximo físico (1:3 llenando la altura) no se molesta al humano.
    showHint: quadFracW < FRAMING_WIDTH_FRAC && quadFracH < FRAMING_HEIGHT_FRAC,
  };
}

export const OVERLAY_OK = '#38bdf8';
export const OVERLAY_BAD = '#cf222e';
export const PORTRAIT_HINT = 'Gira el teléfono en vertical';

export class ScannerView {
  private ctx: CanvasRenderingContext2D | null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d');
  }

  /** Sincroniza el canvas con su tamaño CSS. */
  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = Math.max(1, w);
      this.canvas.height = Math.max(1, h);
    }
  }

  /** Dibuja el overlay; devuelve píxeles dibujados (0 si no había contexto).
   *  El caller mide latencia ts→post-render (Fase 2.4). */
  render(
    state: OverlayState,
    frameW: number,
    frameH: number,
    hint: string | null = null,
  ): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    this.resize();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    const vw = this.video.videoWidth || frameW;
    const vh = this.video.videoHeight || frameH;
    const r = displayRect(cw, ch, vw, vh);
    const ok = state.valid && state.corners !== null;
    ctx.strokeStyle = ok ? OVERLAY_OK : OVERLAY_BAD;
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (ok && state.corners !== null) {
      for (let i = 0; i < 4; i++) {
        const p = native2disp(
          state.corners[2 * i]! * frameW,
          state.corners[2 * i + 1]! * frameH,
          r,
          frameW,
          frameH,
        );
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    } else {
      ctx.strokeRect(6, 6, cw - 12, ch - 12);
    }
    ctx.stroke();
    if (hint !== null && hint.length > 0) {
      ctx.fillStyle = OVERLAY_OK;
      ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillText(hint, 12, 24);
    }
  }
}
