// src/core/geometry.ts — núcleo geométrico del cuadrilátero (PLAN_MAESTRO §8, §5-F1/F3).
// SIN DOM ni OpenCV: 100% testeable en Node.
// Los lados se numeran 0=top, 1=right, 2=bottom, 3=left; la esquina n es la
// intersección de los lados (n+3)%4 y n (TL=3+0, TR=0+1, BR=1+2, BL=2+3).

import type { Corner, Quadrilateral } from './types';

export type { Corner, Quadrilateral };

/** Ecuación de recta ax + by + c = 0, normalizada (a²+b² = 1) salvo (0,0,0). */
export interface LineEq {
  a: number;
  b: number;
  c: number;
}

// --- Constantes EXACTAS dadas por el plan (NO recalcular; comentario de origen) ---

/** §5-F1 (Validación estricta): el quad debe cubrir >25% del área del frame. */
export const QUAD_MIN_AREA_RATIO = 0.25;

/** [F5-CROP, 2026-10-01 — fotos reales issue #2 + sugerencias analizadas]:
 *  umbral de área para la DETECCIÓN AUTOMÁTICA. El 25% §F1 es la razón #1
 *  de que el auto falle con documentos a distancia normal — un documento
 *  fotografiado sobre una mesa rara vez llena 1/4 del encuadre (evidencia:
 *  las fotos reales del humano, Galaxy A56, documento ~10-40% del frame).
 *  10% mantiene el gate anti-ruido (un pedazo de fondo NO pasa por
 *  documento) y los gates de calidad existentes (whiteness, laplaciana,
 *  revalidación) compensan los falsos positivos. El 25% estricto §F1 sigue
 *  vigente como default de validateQuad para otros consumidores. */
export const QUAD_MIN_AREA_RATIO_DETECT = 0.1;

/** [F5-MANUAL, 2026-10-01] piso de área del quad MANUAL del editor: 1%.
 *  Los pisos de área son heurísticas de plausibilidad para CONTORNOS de
 *  Canny, no para un humano que colocó 4 esquinas a propósito — 1% solo
 *  protege contra un click degenerado accidental (anti-esquinas-todas-en
 *  el-mismo-punto). */
export const QUAD_MIN_AREA_RATIO_MANUAL = 0.01;

/** §5-F1 ("aristas mínimas"): cada lado ≥ 5% del lado mayor (rechaza proporciones ~20:1). */
export const MIN_SIDE_RATIO = 0.05;

/** §5-F3 (blindaje 1): banda adaptativa — mínimo de 30px de banda. */
export const BAND_MIN_PX = 30;

/** §5-F3 (blindaje 1): banda adaptativa — 1.5% de la longitud del lado. */
export const BAND_PCT_OF_SIDE = 0.015;

/** §5-F3 (blindaje 2): excluir 12% del extremo de cada lado del ajuste de línea. */
export const TRIM_FRACTION = 0.12;

/** Tolerancia relativa del gate de aspect ratio del video vs. la foto hi-res (F3). */
export const AR_TOLERANCE = 0.01;

/** Reescribe los 4 puntos en orden canónico TL,TR,BR,BL usando suma y diferencia de
 *  coordenadas (§8): TL = mín(x+y), BR = máx(x+y), TR = máx(x−y), BL = mín(x−y).
 *  LIMITACIÓN conocida (F5-CROP, 2026-10-01, evidencia real1 issue #2): en quads
 *  rotados ~45° un mismo punto puede ser mín(x+y) Y máx(x−y) → colisión →
 *  throw "degenerado" aunque el quad sea perfectamente convexo. Para esos
 *  casos existe orderPointsAngle (orden angular alrededor del centroide). */
export function orderPoints(pts: Corner[]): Quadrilateral {
  if (pts.length !== 4) {
    throw new Error(`orderPoints: se esperan exactamente 4 puntos, recibí ${pts.length}`);
  }
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.x - p.y);
  const idxMin = (v: number[]) => v.indexOf(Math.min(...v));
  const idxMax = (v: number[]) => v.indexOf(Math.max(...v));
  const tl = idxMin(sums);
  const br = idxMax(sums);
  const tr = idxMax(diffs);
  const bl = idxMin(diffs);
  const idxs = new Set([tl, tr, br, bl]);
  if (idxs.size !== 4) {
    throw new Error('orderPoints: cuadrilátero degenerado (coordenadas empatadas)');
  }
  return [pts[tl], pts[tr], pts[br], pts[bl]];
}

/** [F5-CROP, 2026-10-01] Orden canónico por ÁNGULO alrededor del centroide
 *  (TL,TR,BR,BL): para un quad CONVEXO los 4 ángulos son distintos módulo
 *  2π → el sort nunca colisiona (a diferencia de suma/diferencia, que
 *  degenera en rotaciones ~45° — el fallback B del pipeline produce
 *  exactamente esos quads). El punto inicial es el de ángulo más cercano a
 *  −135° (arriba-izquierda en pantalla, y hacia abajo); el resto sigue el
 *  orden cíclico del perímetro (propiedad de los polígonos convexos). El
 *  resultado es horario en coords de pantalla = mismo convenio que
 *  orderPoints. Solo exige 4 puntos finitos: si dos ángulos empatan
 *  exactamente (quad degenerado real, área ~0) lanza. */
export function orderPointsAngle(pts: Corner[]): Quadrilateral {
  if (pts.length !== 4) {
    throw new Error(`orderPointsAngle: se esperan exactamente 4 puntos, recibí ${pts.length}`);
  }
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error('orderPointsAngle: coordenadas no finitas');
    }
    cx += p.x / 4;
    cy += p.y / 4;
  }
  const angled = pts.map((p, i) => ({ i, a: Math.atan2(p.y - cy, p.x - cx) }));
  angled.sort((u, v) => u.a - v.a);
  // Punto de arranque: ángulo más cercano a -3π/4 (TL en pantalla, y-abajo).
  let bestStart = 0;
  let bestDist = Infinity;
  for (let k = 0; k < 4; k++) {
    let d = Math.abs(angled[k]!.a + (3 * Math.PI) / 4);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < bestDist) {
      bestDist = d;
      bestStart = k;
    }
  }
  const out: Corner[] = [];
  for (let k = 0; k < 4; k++) {
    out.push(pts[angled[(bestStart + k) % 4]!.i]!);
  }
  // Guarda de degenerado real: ángulos empatados (dos puntos en la misma
  // dirección desde el centroide → área ~0). El sort es estable así que el
  // orden existe, pero el quad no es warpéable — MISMA política que
  // orderPoints (throw) para que el caller lo descarte igual.
  for (let k = 1; k < 4; k++) {
    const prev = angled[(bestStart + k - 1) % 4]!.a;
    const cur = angled[(bestStart + k) % 4]!.a;
    if (Math.abs(cur - prev) < 1e-9) {
      throw new Error('orderPointsAngle: cuadrilátero degenerado (ángulos empatados)');
    }
  }
  return out as unknown as Quadrilateral;
}

/** Área del cuadrilátero por shoelace (siempre ≥ 0). */
export function quadArea(q: Quadrilateral): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Convexidad estricta: los 4 productos vectoriales de aristas consecutivas tienen
 *  el mismo signo y ninguno es ~0 (puntos colineales → no convexo). */
export function isConvex(q: Quadrilateral): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[i];
    const p1 = q[(i + 1) % 4]!;
    const p2 = q[(i + 2) % 4]!;
    const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (Math.abs(cross) < 1e-12) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function orient(p: Corner, q: Corner, r: Corner): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

/** Cruce PROPIAMENTE interior de dos segmentos (excluye tocar en extremos). */
function segmentsCross(a: Corner, b: Corner, c: Corner, d: Corner): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** true si las aristas opuestas se cruzan en el interior ("mariposa"). */
export function hasSelfIntersection(q: Quadrilateral): boolean {
  return segmentsCross(q[0], q[1], q[2], q[3]) || segmentsCross(q[1], q[2], q[3], q[0]);
}

/** Razón de cada lado respecto al lado MAYOR: [top, right, bottom, left].
 *  «Rechazar 20:1» (§5-F1) = alguna razón < 0.05. */
export function sideRatios(q: Quadrilateral): [number, number, number, number] {
  const len = (i: number) =>
    Math.hypot(q[(i + 1) % 4]!.x - q[i].x, q[(i + 1) % 4]!.y - q[i].y);
  const sides: [number, number, number, number] = [len(0), len(1), len(2), len(3)];
  const max = Math.max(...sides);
  if (max < 1e-12) return [0, 0, 0, 0];
  return [sides[0] / max, sides[1] / max, sides[2] / max, sides[3] / max];
}

/** Validación estricta (§5-F1): convexo + sin auto-intersección + área >
 *  `minAreaRatio` (default QUAD_MIN_AREA_RATIO = 25% del frame) + sides
 *  mínimos (MIN_SIDE_RATIO sobre el lado mayor). [F5-CROP] `minAreaRatio`
 *  parametrizable: la DETECCIÓN pasa 0.10 (QUAD_MIN_AREA_RATIO_DETECT). */
export function validateQuad(
  q: Quadrilateral,
  frameW: number,
  frameH: number,
  minAreaRatio: number = QUAD_MIN_AREA_RATIO,
): boolean {
  if (!isConvex(q) || hasSelfIntersection(q)) return false;
  if (quadArea(q) <= minAreaRatio * frameW * frameH) return false;
  const ratios = sideRatios(q);
  for (const r of ratios) {
    if (r < MIN_SIDE_RATIO) return false;
  }
  return true;
}

/** [F5-MANUAL, 2026-10-01] Validación del quad colocado por el HUMANO en el
 *  editor: solo exige que sea geométricamente warpéable (convexo + no
 *  cruzado + coordenadas finitas) + piso de área 1% (anti-click degenerado).
 *  SIN pisos de área de detección (25%/10%) ni ratios de lado: son
 *  heurísticas de plausibilidad para contornos de Canny — el humano mandó
 *  (sugerencia analizada: "para quads manuales el gate debe ser solo validez
 *  geométrica; sin pisos de área"). Un recorte fino a mano es VÁLIDO aquí. */
export function validateQuadManual(q: Quadrilateral, frameW: number, frameH: number): boolean {
  for (const c of q) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return false;
  }
  if (!isConvex(q) || hasSelfIntersection(q)) return false;
  return quadArea(q) > QUAD_MIN_AREA_RATIO_MANUAL * frameW * frameH;
}

/** [F5-MANUAL] Sanea un quad cruzado ("mariposa") re-ordenando los 4 puntos
 *  al orden canónico TL,TR,BR,BL — orderPoints primero y, si colisiona
 *  (rotación ~45°, el hallazgo real1), orderPointsAngle (ángulo alrededor
 *  del centroide — deshace el cruce igual). Devuelve null si ningún reorden
 *  pasa validateQuadManual (ahí el flujo cae al bounding box, último
 *  recurso documentado). Nunca lanza. */
export function sanitizeManualQuad(
  q: Quadrilateral,
  frameW: number,
  frameH: number,
): Quadrilateral | null {
  if (validateQuadManual(q, frameW, frameH)) return q;
  for (const order of [orderPoints, orderPointsAngle]) {
    try {
      const ordered = order(q);
      if (validateQuadManual(ordered, frameW, frameH)) return ordered;
    } catch {
      // degenerado (coordenadas empatadas / ángulos empatados): siguiente
    }
  }
  return null;
}

/** Bounding box axis-aligned del quad en orden TL,TR,BR,BL (2026-09-26, petición
 *  humana: el quad inválido DEJA de bloquear el guardado — capturas trocidas se
 *  pueden guardar). Si el quad tiene coordenadas no finitas, se propagan: el
 *  consumidor (warpPhoto) ya rechaza quads no finitos. Es el rectángulo seguro
 *  que reemplaza un quad cruzado/degenerado para warpPerspective. */
export function quadBoundingBox(q: Quadrilateral): Quadrilateral {
  const xs = q.map((c) => c.x);
  const ys = q.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

/** Gate F3 (§5-F3): ¿w1/h1 ≈ w2/h2 dentro de tol relativa? PROHIBIDO hardcodear
 *  ratios (16:9/4:3): todo llega por parámetros. */
export function sameAspectRatio(
  w1: number,
  h1: number,
  w2: number,
  h2: number,
  tol: number = AR_TOLERANCE,
): boolean {
  const r1 = w1 / h1;
  const r2 = w2 / h2;
  if (!Number.isFinite(r1) || !Number.isFinite(r2)) return false;
  return Math.abs(r1 - r2) <= tol * Math.max(r1, r2);
}

/** Escala anisotrópica (sx ≠ sy permitido) — útil p. ej. al mapear entre resoluciones. */
export function scaleQuad(q: Quadrilateral, sx: number, sy: number): Quadrilateral {
  return [
    { x: q[0].x * sx, y: q[0].y * sy },
    { x: q[1].x * sx, y: q[1].y * sy },
    { x: q[2].x * sx, y: q[2].y * sy },
    { x: q[3].x * sx, y: q[3].y * sy },
  ];
}

/** Mínimos cuadrados descartando el `trim` de cada extremo (blindaje 2 §5-F3).
 *  Ordena por eje dominante (mayor dispersión) y ajusta la recta al 76% central. */
export function fitLineTrimmed(points: Corner[], trim: number = TRIM_FRACTION): LineEq {
  if (points.length < 2) {
    throw new Error(`fitLineTrimmed: se requieren ≥ 2 puntos (recibí ${points.length})`);
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const dominantX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
  const sorted = [...points].sort((p, q) => (dominantX ? p.x - q.x : p.y - q.y));
  const trimN = Math.max(0, Math.floor(sorted.length * trim));
  const kept = trimN * 2 < sorted.length ? sorted.slice(trimN, sorted.length - trimN) : sorted;

  if (dominantX) {
    const fit = leastSquares(kept.map((p) => p.x), kept.map((p) => p.y));
    // y = m·x + b → −m·x + y − b = 0  ⇒  a=−m, b=1, c=−b
    if (fit) return normalizeLine(-fit.m, 1, -fit.b);
    const xm = mean(kept.map((p) => p.x));
    return normalizeLine(1, 0, -xm); // vertical
  }
  const fit = leastSquares(kept.map((p) => p.y), kept.map((p) => p.x));
  // x = m·y + b → x − m·y − b = 0  ⇒  a=1, b=−m, c=−b
  if (fit) return normalizeLine(1, -fit.m, -fit.b);
  const ym = mean(kept.map((p) => p.y));
  return normalizeLine(0, 1, -ym); // horizontal
}

/** Ajuste y=m·x+b (o null si degenerado: todos los x iguales). */
function leastSquares(x: number[], y: number[]): { m: number; b: number } | null {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]!;
    sy += y[i]!;
    sxy += x[i]! * y[i]!;
    sxx += x[i]! * x[i]!;
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const m = (n * sxy - sx * sy) / den;
  const b = (sy - m * sx) / n;
  return { m, b };
}

// --- [F5-CROP, 2026-10-01] RANSAC de línea para el refinado de lados ----
// (sugerencia #4 del análisis humano: "hoy una pluma, dedo o grapa que
// cruce la banda tuerce la recta ajustada y desplaza la esquina" —
// evidencia real3 issue #2: esquinas refinadas desplazadas 263-306px).

/** Distancia máx (px) de un punto a la recta para contar como inlier. */
export const RANSAC_INLIER_PX = 5;

/** Nº de modelos candidatos del consenso (pares sistemáticos ×3 offsets). */
export const RANSAC_MAX_MODELS = 24;

/** [F5-CROP, sugerencia #4] Ajuste de recta por CONSENSO (RANSAC
 *  DETERMINISTA — muestreo sistemático, no aleatorio: Node-testeable y
 *  reproducible): genera hasta RANSAC_MAX_MODELS candidatos desde pares
 *  de puntos {k, k+offset} (offsets n/4, n/2, 3n/4 — los puntos de banda
 *  llegan en orden raster, así que cada par cruza tramos distintos de la
 *  banda), cuenta inliers a distancia ≤ RANSAC_INLIER_PX y el modelo con
 *  MÁS inliers gana; la recta final es fitLineTrimmed sobre SUS inliers
 *  (LSQ refinado). Puntos espurios (texto dentro de la banda, reflejos,
 *  fragmentos del otro borde) quedan FUERA del ajuste. Degenerado (<2
 *  puntos, o ningún modelo con ≥2 inliers) → throw: el caller (pipeline)
 *  trata el lado como caído, igual que fitLineTrimmed. */
export function fitLineRansac(
  points: Corner[],
  inlierPx: number = RANSAC_INLIER_PX,
  maxModels: number = RANSAC_MAX_MODELS,
): LineEq {
  if (points.length < 2) {
    throw new Error(`fitLineRansac: se requieren ≥ 2 puntos (recibí ${points.length})`);
  }
  const n = points.length;
  const offsets = [Math.max(1, Math.floor(n / 4)), Math.max(1, Math.floor(n / 2)), Math.max(1, Math.floor((3 * n) / 4))];
  let bestInliers: Corner[] | null = null;
  let bestCount = 1; // un modelo necesita ≥2 inliers para ganar
  let models = 0;
  for (const off of offsets) {
    for (let k = 0; k < n && models < maxModels; k++) {
      if (off >= n && k > 0) break; // pares idénticos: un solo k basta
      const a = points[k]!;
      const b = points[(k + off) % n]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.hypot(dx, dy) < 1e-6) continue; // par degenerado: siguiente
      // Recta por 2 puntos, normalizada: (dy)·x + (−dx)·y + c = 0.
      const la = dy;
      const lb = -dx;
      const lc = -(la * a.x + lb * a.y);
      const norm = Math.hypot(la, lb);
      const A = la / norm;
      const B = lb / norm;
      const C = lc / norm;
      const inliers: Corner[] = [];
      for (const p of points) {
        if (Math.abs(A * p.x + B * p.y + C) <= inlierPx) inliers.push(p);
      }
      models++;
      if (inliers.length > bestCount) {
        bestCount = inliers.length;
        bestInliers = inliers;
      }
    }
  }
  if (bestInliers === null) {
    throw new Error('fitLineRansac: ningún modelo con ≥2 inliers (banda sin estructura lineal)');
  }
  return fitLineTrimmed(bestInliers, 0); // LSQ sobre los inliers, sin trim extra
}

/** Normaliza la línea a un vector normal unitario (a²+b²=1). (0,0,0) es inválido. */
function normalizeLine(a: number, b: number, c: number): LineEq {
  const n = Math.hypot(a, b);
  if (n < 1e-12) {
    throw new Error(`normalizeLine: línea degenerada (a=${a}, b=${b})`);
  }
  return { a: a / n, b: b / n, c: c / n };
}

function mean(v: number[]): number {
  return v.reduce((acc, x) => acc + x, 0) / v.length;
}

/** Intersección de dos rectas; null si casi paralelas (|den| < 1e-12). */
export function intersectLines(l1: LineEq, l2: LineEq): Corner | null {
  const den = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(den) < 1e-12) return null;
  const x = (l1.b * l2.c - l2.b * l1.c) / den;
  const y = (l1.c * l2.a - l2.c * l1.a) / den;
  return { x, y };
}

/** Resultado del refinado por líneas (blindaje 3 §5-F3). */
export interface RefineResult {
  quad: Quadrilateral;
  /** 0=top, 1=right, 2=bottom, 3=left — true si ese lado cayó al quad 480p. */
  fellBack: [boolean, boolean, boolean, boolean];
}

/** 4 rectas (una por lado) → 4 intersecciones en orden TL,TR,BR,BL.
 *  Si alguna esquina es null o la validación global falla (convexidad +
 *  no-auto-intersección + área>0), fallback POR LADO al quad de entrada:
 *  - fellBack[i]=true cuando AMBAS esquinas del lado i son null;
 *  - una esquina null aislada marca sus 2 lados adyacentes (TL depende de lados 3+0);
 *  - validación global fallida con todas las esquinas presentes → fallback de los 4. */
export function refineQuadFromLines(
  topL: LineEq,
  rightL: LineEq,
  bottomL: LineEq,
  leftL: LineEq,
  fallback: Quadrilateral,
): RefineResult {
  const refined: (Corner | null)[] = [
    intersectLines(leftL, topL), // TL (lados 3+0)
    intersectLines(topL, rightL), // TR (lados 0+1)
    intersectLines(rightL, bottomL), // BR (lados 1+2)
    intersectLines(bottomL, leftL), // BL (lados 2+3)
  ];
  const bad = refined.map((c) => c === null);

  // Caso feliz: todas presentes y cuadrilátero válido.
  const r0 = refined[0];
  const r1 = refined[1];
  const r2 = refined[2];
  const r3 = refined[3];
  if (r0 && r1 && r2 && r3) {
    const cand: Quadrilateral = [r0, r1, r2, r3];
    if (isConvex(cand) && !hasSelfIntersection(cand) && quadArea(cand) > 0) {
      return { quad: cand, fellBack: [false, false, false, false] };
    }
  }

  const fellBack: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  if (bad.some(Boolean)) {
    // Lado i cae si AMBAS esquinas que lo delimitan son null.
    for (let i = 0; i < 4; i++) {
      fellBack[i] = bad[i] === true && bad[(i + 1) % 4] === true;
    }
    // Esquina null aislada (ningún lado con ambas null): caen sus 2 lados adyacentes,
    // (n+3)%4 y n, para que esa esquina siempre tenga fallback de 480p.
    for (let i = 0; i < 4; i++) {
      if (bad[i] && !fellBack[(i + 3) % 4] && !fellBack[i]) {
        fellBack[(i + 3) % 4] = true;
        fellBack[i] = true;
      }
    }
  } else {
    // Todas las esquinas existen pero la validación global falló: blindaje 3 → 4/4.
    fellBack[0] = true;
    fellBack[1] = true;
    fellBack[2] = true;
    fellBack[3] = true;
  }

  // Ensamblado: la esquina n usa la del quad 480p si cualquiera de sus 2 lados cayó;
  // si no, la refinada (el invariante garantiza que entonces no es null).
  const quad = [0, 1, 2, 3].map((i) => {
    if (fellBack[(i + 3) % 4] || fellBack[i]) return fallback[i];
    const rc = refined[i];
    if (rc === null) {
      throw new Error('refineQuadFromLines: invariante roto (esquina null sin fallback)');
    }
    return rc;
  }) as unknown as Quadrilateral;

  return { quad, fellBack };
}