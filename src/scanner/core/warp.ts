// src/core/warp.ts — dimensiones de salida del warp + parámetros unsharp (PLAN_MAESTRO §F3).
// SIN DOM ni OpenCV: 100% testeable en Node. El aspecto de salida sale del quad
// MEDIDO (largos de lados), NUNCA de aspect ratios hardcodeados: el video es un
// crop del sensor y la foto otro encuadre (T1-R4) — solo el quad manda.

import type { Quadrilateral } from './types';
import type { LineEq } from './geometry';
import { intersectLines } from './geometry';

// --- Constantes DADAS por §F3 (NO recalcular; comentario de origen) ---

/** §F3 (presupuesto de memoria): lado largo máximo de salida del warp
 *  (3500/11 ≈ 318 DPI en carta → cap VALIDADO, sin cambio numérico). */
export const WARP_MAX_LONG_SIDE = 3500;

/** §F3 (pipeline H: "unsharp 0.5/1.5"): cantidad de unsharp masking. */
export const UNSHARP_AMOUNT = 0.5;

/** §F3 (pipeline H: "unsharp 0.5/1.5"): radio/sigma del blur gaussiano del unsharp. */
export const UNSHARP_RADIUS = 1.5;

/** Kernel impar ≥3 derivado de UNSHARP_RADIUS para el GaussianBlur del unsharp
 *  (2·ceil(2·r)+1; r=1.5 → 7). Derivado, no calibrado: cualquier impar ≥3 vale. */
export const UNSHARP_KERNEL_SIZE =
  Math.max(3, 2 * Math.ceil(2 * UNSHARP_RADIUS) + 1);

function sideLen(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Dims de salida del warp desde el quad en PÍXELES de la foto.
 *  Ancho = máx(top, bottom), alto = máx(left, right); escala UNIFORME solo para
 *  reducir hasta WARP_MAX_LONG_SIDE (nunca amplía). Salida entera ≥1px.
 *  Quad degenerado/no-finito → 1×1 (nunca lanza: el worker no debe morir). */
export function computeWarpDims(quad: Quadrilateral): {
  w: number;
  h: number;
} {
  const w0 = Math.max(sideLen(quad[0], quad[1]), sideLen(quad[2], quad[3]));
  const h0 = Math.max(sideLen(quad[1], quad[2]), sideLen(quad[3], quad[0]));
  if (!Number.isFinite(w0) || !Number.isFinite(h0)) {
    return { w: 1, h: 1 };
  }
  const s =
    Math.max(w0, h0) > WARP_MAX_LONG_SIDE
      ? WARP_MAX_LONG_SIDE / Math.max(w0, h0)
      : 1;
  return {
    w: Math.max(1, Math.round(w0 * s)),
    h: Math.max(1, Math.round(h0 * s)),
  };
}

// ---------------------------------------------------------------------------
// M2 — política V2 PROPUESTA (data-gated, NO activa por defecto).
// Problema (E2): el cap 3500 del lado largo deja el lado corto del acta 1:3
// en ~1111px, y la letra vive en el eje corto. La V2 pone un PISO de 1600px
// en el lado corto con techos de 4800px largo / 9.5MP área (un 3:4 actual
// ya produce 9.2MP: el techo de área no regresa nada).
// COMPUERTA (obligatoria antes de activar — ver PLAN_EVIDENCE/M2-*/):
//   1) memoria/tiempo del warp a ~7.5MP en diana N≥20 gama baja;
//   2) CER zona impresa before/after ≥10% mejora relativa (M4b);
//   3) si no hay mejora, la enmienda SE RETIRA (el cap actual sigue).
// computeWarpDims (V1) sigue siendo el camino de producción.
// ---------------------------------------------------------------------------

/** M2: piso del lado corto (letras del acta en el eje corto). */
export const WARP_V2_MIN_SHORT_SIDE = 1600;
/** M2: techo del lado largo (la cámara entrega 8.3MP; el warp ya los procesa). */
export const WARP_V2_MAX_LONG_SIDE = 4800;
/** M2: techo de área en megapíxeles (3:4 actual = 9.2MP: no regresa nada). */
export const WARP_V2_MAX_AREA_MP = 9.5;

/** Dims V2 desde lados medidos w0×h0 (px de foto). Escala UNIFORME s:
 *  intenta s↑ = 1600/min (piso de lado corto); solo se aplica si el largo
 *  resultante ≤ 4800 y el área ≤ 9.5MP; si no cabe, s = el mayor que cumple
 *  AMBOS techos (puede quedar bajo el piso — se documenta, no se recorta).
 *  Nunca 0/NaN: inválido → 1×1. Acta 1:3 1221×3664 → 1600×4800 (~7.7MP). */
export function computeWarpDimsV2(
  w0: number,
  h0: number,
): { w: number; h: number; floored: boolean } {
  if (!(w0 > 0) || !(h0 > 0) || !Number.isFinite(w0) || !Number.isFinite(h0)) {
    return { w: 1, h: 1, floored: false };
  }
  const minSide = Math.min(w0, h0);
  const maxSide = Math.max(w0, h0);
  const areaMP = (w0 * h0) / 1e6;
  let s = 1;
  let floored = minSide >= WARP_V2_MIN_SHORT_SIDE;
  if (!floored) {
    const sUp = WARP_V2_MIN_SHORT_SIDE / minSide;
    if (
      maxSide * sUp <= WARP_V2_MAX_LONG_SIDE &&
      areaMP * sUp * sUp <= WARP_V2_MAX_AREA_MP
    ) {
      s = sUp;
      floored = true;
    } else {
      // No cabe el piso: lo máximo que respetan ambos techos.
      s = Math.min(
        WARP_V2_MAX_LONG_SIDE / maxSide,
        Math.sqrt(WARP_V2_MAX_AREA_MP / areaMP),
      );
    }
  }
  // Techos SIEMPRE (también cuando el piso ya se cumplía de entrada).
  s = Math.min(
    s,
    WARP_V2_MAX_LONG_SIDE / maxSide,
    Math.sqrt(WARP_V2_MAX_AREA_MP / areaMP),
  );
  // R3: `floored` se recalcula DESPUÉS de los techos finales — en casos
  // extremos (p. ej. panorama 1:12) los techos pueden dejar el lado corto
  // bajo el piso aunque el piso "cupiera" en el cálculo previo.
  floored = Math.min(w0, h0) * s >= WARP_V2_MIN_SHORT_SIDE;
  return {
    w: Math.max(1, Math.round(w0 * s)),
    h: Math.max(1, Math.round(h0 * s)),
    floored,
  };
}

// ---------------------------------------------------------------------------
// R4-B1 — shrinkQuad (padding interno antes del warp).
// Port del prototipo (documentDetector.ts): contrae el quad `px` píxeles por
// LADO hacia adentro ANTES de computeWarpDims/warpPage — el filete de la
// mesa/borde de tabla que rodea el papel queda FUERA del recorte (hallazgo
// del QA visual: intrusión de fondo en el borde superior de la pág 2).
// Verificación B1 (plan §R4-B): el warp actual NO tenía nada equivalente
// (warpPage mapea el quad EXACTO al rect de salida, cero padding interno).
// ---------------------------------------------------------------------------

/** [R4-B1] Inset uniforme por lado, en px de la FOTO (port del prototipo:
 *  3.5px excluye el filete de mesa del recorte). */
export const SHRINK_QUAD_PX = 3.5;

/** [R4-B1] Contrae cada LADO del quad `px` px hacia adentro y re-intersecta
 *  los lados adyacentes desplazados.
 *
 *  Entrada ESPERADA (contrato del flujo warp): quad convexo en orden canónico
 *  TL,TR,BR,BL (horario con y hacia abajo). Para cada lado i (p_i → p_{i+1}):
 *  dirección e = p_{i+1}−p_i; normal interior unitaria n = (−e.y, e.x)/|e|
 *  (verificación con cuadrado TL(0,0),TR(1,0),BR(1,1),BL(0,1): n del lado
 *  superior = (0,1) → apunta a y+, al interior ✓). Recta del lado:
 *  a·x + b·y + c = 0 con (a,b)=n (ya unitaria), c = −(n·p_i); desplazada
 *  hacia adentro px: c' = c − px. La esquina i nace de la intersección de la
 *  recta del lado (i−1 mod 4) desplazada con la del lado i desplazada (mismo
 *  convenio que refineQuadFromLines: TL = lados 3+0).
 *
 *  BLINDAJE (nunca lanza): si la intersección no existe (lados casi paralelos
 *  — intersectLines devuelve null), no es finita, o se desvía de la esquina
 *  ORIGINAL más de 10·px (esquinas muy agudas: el inset "dispara" la
 *  intersección a lo largo de la bisectriz), ESA esquina conserva el valor de
 *  entrada — el shrink puede quedar parcial, nunca degenera el quad. Quad de
 *  entrada no-finito → devuelve el MISMO quad (el flujo downstream ya rechaza
 *  no-finitos); px no-finito → copia de la entrada. */
export function shrinkQuad(quad: Quadrilateral, px: number): Quadrilateral {
  for (const c of quad) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      return quad; // downstream (warpPhoto/computeWarpDims) ya rechaza no-finitos
    }
  }
  if (!Number.isFinite(px)) {
    return [{ ...quad[0]! }, { ...quad[1]! }, { ...quad[2]! }, { ...quad[3]! }];
  }
  // Recta de cada lado desplazada px hacia adentro; lado degenerado (longitud
  // ~0) → "línea muerta" (a=b=0) cuya intersección es siempre null → esa
  // esquina cae a la original.
  const lines: LineEq[] = [];
  for (let i = 0; i < 4; i++) {
    const p = quad[i]!;
    const q = quad[(i + 1) % 4]!;
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const len = Math.hypot(ex, ey);
    if (!(len > 1e-12)) {
      lines.push({ a: 0, b: 0, c: 0 });
      continue;
    }
    const a = -ey / len; // n = (−e.y, e.x)/|e| (interior, horario y-abajo)
    const b = ex / len;
    lines.push({ a, b, c: -(a * p.x + b * p.y) - px });
  }
  const maxShift = 10 * Math.abs(px);
  return [0, 1, 2, 3].map((i) => {
    const hit = intersectLines(lines[(i + 3) % 4]!, lines[i]!);
    const orig = quad[i]!;
    if (
      hit !== null &&
      Number.isFinite(hit.x) &&
      Number.isFinite(hit.y) &&
      Math.hypot(hit.x - orig.x, hit.y - orig.y) <= maxShift
    ) {
      return hit;
    }
    return { ...orig }; // blindaje: esquina original (shrink parcial)
  }) as unknown as Quadrilateral;
}
