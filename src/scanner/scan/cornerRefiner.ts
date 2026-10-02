// src/scan/cornerRefiner.ts — ensamblado del refinado (F3-b, PLAN_MAESTRO §F3).
// Lógica PURA (sin DOM ni OpenCV): convierte el WarpResult del worker a quad en
// coords de foto + decide revisión de editor para F4. Los píxeles viven en el
// worker (pipeline.refineQuad); aquí solo se ensambla su respuesta.

import type { Quadrilateral } from '../core/types';
import type { WarpResult } from '../workers/protocol';

export interface AssembledRefine {
  /** Quad refinado en PÍXELES de foto; null si el worker no devolvió quad. */
  quad: Quadrilateral | null;
  /** Eco de WarpResult.refined (algún lado se ajustó). */
  refined: boolean;
  /** Lados caídos al quad de entrada (blindaje 3); null si no hubo refine. */
  fellBack: [boolean, boolean, boolean, boolean] | null;
}

/** Ensambla el quad refinado del WarpResult a coords de foto. Entrada inválida
 *  (quad ausente/malformado o dims no-positivas) → quad null sin lanzar. */
export function assembleRefinedQuad(
  r: Pick<WarpResult, 'refinedQuad' | 'refined' | 'fellBack'>,
  photoW: number,
  photoH: number,
): AssembledRefine {
  const fb = r.fellBack ?? null;
  const q = r.refinedQuad;
  if (q === null || q.length !== 8 || !(photoW > 0) || !(photoH > 0)) {
    return { quad: null, refined: false, fellBack: fb };
  }
  for (let i = 0; i < 8; i++) {
    if (!Number.isFinite(q[i])) return { quad: null, refined: false, fellBack: fb };
  }
  return {
    quad: [
      { x: q[0]! * photoW, y: q[1]! * photoH },
      { x: q[2]! * photoW, y: q[3]! * photoH },
      { x: q[4]! * photoW, y: q[5]! * photoH },
      { x: q[6]! * photoW, y: q[7]! * photoH },
    ],
    refined: r.refined,
    fellBack: fb,
  };
}

/** Blindaje 3 para F4: algún lado en fallback (o refine ausente) → el editor
 *  debe revisar. null = desconocido → revisar (seguro por defecto). */
export function needsEditorReview(
  fellBack: [boolean, boolean, boolean, boolean] | null,
): boolean {
  return fellBack === null || fellBack.some((f) => f);
}