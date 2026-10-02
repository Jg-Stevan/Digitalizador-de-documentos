// src/core/quadStability.ts — [R4-B4] métrica de estabilidad del quad.
// PURO (sin DOM ni OpenCV): buffer de las últimas N detecciones (corners en
// FRACCIONES del frame, TL,TR,BR,BL) y dispersión espacial media en px.
// SOLO REPORTE (f4): el auto-shutter/score de producción quedan intactos —
// medir, no cambiar. Inspirado en el prototipo (buffer de 10 frames con
// varianza espacial ≤16px → "LOCK"), portado aquí como métrica visible
// (#mQuadStab) para decidir CON DATO si la compuerta de captura lo adopta
// en una ronda posterior.

/** Ventana del buffer (10 frames, como el prototipo). */
export const QUAD_STABILITY_WINDOW = 10;

/** Mínimo de muestras para reportar dispersión (con 1 muestra la distancia
 *  a la esquina promedio es 0 por construcción — no informa nada). */
const MIN_SAMPLES = 2;

/** [R4-B4] Ring-buffer de quads detectados (fracciones) + dispersión px.
 *  `push` ignora silenciosamente corners null/incompletos/no-finitos (nunca
 *  lanza: una detección mala no puede romper la métrica); conserva las
 *  últimas QUAD_STABILITY_WINDOW muestras válidas. */
export class QuadStabilityBuffer {
  private readonly samples: Float32Array[] = [];

  /** Añade una detección (8 fracciones TL,TR,BR,BL) si es válida. */
  push(corners: Float32Array | null): void {
    if (corners === null || corners.length !== 8) return;
    for (let i = 0; i < 8; i++) {
      if (!Number.isFinite(corners[i])) return;
    }
    this.samples.push(new Float32Array(corners)); // copia defensiva
    if (this.samples.length > QUAD_STABILITY_WINDOW) {
      this.samples.shift();
    }
  }

  /** Muestras válidas actualmente en el buffer (para el reporte "(n=N)"). */
  size(): number {
    return this.samples.length;
  }

  /** Dispersión espacial del quad en px: para cada una de las 4 esquinas, la
   *  distancia euclidiana MEDIA de esa esquina en cada frame a la esquina
   *  PROMEDIO del buffer, convertida a px con las dims del frame ACTUAL
   *  (fracción x × frameW, fracción y × frameH), y media sobre las 4
   *  esquinas. <2 muestras o dims inválidas → null. Nunca lanza. */
  variancePx(frameW: number, frameH: number): number | null {
    const n = this.samples.length;
    if (n < MIN_SAMPLES) return null;
    if (!(frameW > 0) || !(frameH > 0) || !Number.isFinite(frameW) || !Number.isFinite(frameH)) {
      return null;
    }
    // Esquina promedio (en fracciones) por cada una de las 4.
    const mean = new Float64Array(8);
    for (const s of this.samples) {
      for (let i = 0; i < 8; i++) mean[i] += s[i]!;
    }
    for (let i = 0; i < 8; i++) mean[i] /= n;
    // Distancia euclidiana media de cada frame a la esquina promedio,
    // agregada por esquina y promediada sobre las 4.
    let total = 0;
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (const s of this.samples) {
        const dx = (s[2 * c]! - mean[2 * c]!) * frameW;
        const dy = (s[2 * c + 1]! - mean[2 * c + 1]!) * frameH;
        acc += Math.hypot(dx, dy);
      }
      total += acc / n;
    }
    const result = total / 4;
    return Number.isFinite(result) ? result : null;
  }
}
