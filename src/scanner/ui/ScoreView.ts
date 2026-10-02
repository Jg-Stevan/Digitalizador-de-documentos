// src/ui/ScoreView.ts — anillo de score + aviso en canvas (F2 Fase 1.4).
// Valor = total 0–1; UN mensaje accionable (selectHint, ya priorizado).
// Matemática pura del anillo testeable; render() con contexto mockeado.

export const RING_OK = '#0ea5e9';
export const RING_WARN = '#eab308';
export const RING_BAD = '#cf222e';

export function ringColor(total: number): string {
  if (total >= 0.8) return RING_OK;
  if (total >= 0.5) return RING_WARN;
  return RING_BAD;
}

/** Fracción de arco 0–1 (clamp) y ángulos del anillo (inicio arriba). */
export function ringAngles(total: number): { start: number; end: number } {
  const f = Math.min(1, Math.max(0, total));
  const start = -Math.PI / 2;
  return { start, end: start + f * Math.PI * 2 };
}

export class ScoreView {
  private ctx: CanvasRenderingContext2D | null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d');
  }

  /** Dibuja anillo + hint; no rompe sin contexto. */
  render(total: number, hint: string | null): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.max(1, Math.min(w, h) / 2 - 6);
    const { start, end } = ringAngles(total);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = ringColor(total);
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.stroke();
    ctx.fillStyle = '#eee';
    ctx.font = '600 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(Math.min(1, Math.max(0, total)) * 100)}`, cx, cy + 7);
    if (hint !== null && hint.length > 0) {
      ctx.font = '500 13px system-ui, sans-serif';
      ctx.fillText(hint, cx, h - 10);
    }
  }
}
