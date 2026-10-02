// src/ui/ModeCompare.ts — comparador de modos con UNA captura (D-F5-e).
// Petición humana (2026-09-27): "que con una captura podamos ver todos los
// modos para ver cómo están calibrados" — antes había que cambiar el modo y
// re-renderizar (o exportar) una vez por modo para comparar. El overlay corre
// el MISMO prepare del export (worker enhance real) una vez POR MODO sobre una
// copia reducida de la página y pinta los resultados lado a lado con etiqueta,
// badge del modo vigente y estadísticas de calibración por modo.
// [RONDA 4 A1, 2026-09-28] el set son 5 modos: entra 'bw' (B/N adaptativo).
//
// Patrón T5/PageGallery: DOM FINO (contexto inyectado por constructor, sin
// document global); la matemática (estadísticas de luma) es PURA y vive aquí
// para tests Node. El harness inyecta blobToCanvas/prepare (mismo worker que
// la cámara/galería) y onPick (elige el modo global desde un tile).
//
// Métricas por modo — umbrales IDÉNTICOS al diagnóstico D-F5-d "banda gris"
// (PLAN_EVIDENCE/F5/diagnostico-D-F5-d-grises/, PIL convert('L') = BT.601):
//   tinta  = % luma < 100         (trazos)
//   gris   = % 100 ≤ luma < 215   (banda gris — la queja original)
//   papel  = % luma ≥ 215         (blanco limpio)
//   mediana de luma               (tono global del papel)
// Son estadísticas de PREVIEW (~900px de lado mayor): representativas para
// calibración porque los operadores del modo 'text' son globales (percentil
// / curva S), invariantes a escala; el export PDF usa resolución completa.

import type { EnhanceMode } from '../core/types';
import { modeLabel } from './PageGallery';
import { previewDims } from './AdjustEditor';

// ---------------------------------------------------------------------------
// Matemática pura (tests Node)
// ---------------------------------------------------------------------------

/** Umbral superior de "tinta" (luma < 100) — D-F5-d. */
export const INK_MAX_LUMA = 100;
/** Umbral inferior de "papel" (luma ≥ 215) — D-F5-d (banda gris = el resto). */
export const PAPER_MIN_LUMA = 215;

/** Modos comparados, en el orden del selector de la galería. [RONDA 4 A1,
 *  2026-09-28] 'bw' (B/N adaptativo) entra como quinto modo: la grilla CSS
 *  `.cmp-grid` es auto-flow de 2 columnas — 5 tiles queda bien (la última
 *  celda queda suelta, sin hacks de layout). */
export const COMPARE_MODES: readonly EnhanceMode[] = ['raw', 'color', 'gray', 'natural', 'text', 'bw'];

/** Lado mayor de la copia reducida que se enhancea por modo. 900px: suficiente
 *  para estadísticas estables y para juzgar densidad de tinta en el tile
 *  (~220px), barato para el worker (5 enhances de ~900px ≈ 1 thumb del export
 *  adaptativo). No es un constante de pipeline — es geometría UI de preview. */
export const COMPARE_PREVIEW_LONG_SIDE = 900;

/** Lado mayor de cada tile (mismas reglas contain que las miniaturas). */
export const COMPARE_TILE_LONG_SIDE = 220;

export interface CalibStats {
  /** % de píxeles con luma < INK_MAX_LUMA (1 decimal). */
  inkPct: number;
  /** % con INK_MAX_LUMA ≤ luma < PAPER_MIN_LUMA (1 decimal). */
  grayPct: number;
  /** % con luma ≥ PAPER_MIN_LUMA (1 decimal). */
  paperPct: number;
  /** Mediana inferior de luma (entero 0-255). */
  medianLuma: number;
}

/** Redondeo a 1 decimal (mitad simétrica, como el resto del proyecto). */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Estadísticas de calibración de una imagen. Acepta RGBA (channels=4,
 *  ImageData.data) o gris de 1 canal (channels=1). Luma BT.601 redondeada —
 *  MISMA fórmula que PIL convert('L') usada en el diagnóstico D-F5-d. PURO:
 *  no toca DOM ni canvas; el llamador pasa los píxeles ya leídos.
 *  Imagen vacía o channels inválido → stats en cero (contrato: nunca lanza). */
export function calibrationStats(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: 1 | 4,
): CalibStats {
  const n = width * height;
  const hist = new Array<number>(256).fill(0);
  if (!(n > 0) || (channels !== 1 && channels !== 4) || data.length < n * channels) {
    return { inkPct: 0, grayPct: 0, paperPct: 0, medianLuma: 0 };
  }
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    let luma: number;
    if (channels === 1) {
      luma = data[o] as number;
    } else {
      const r = data[o] as number;
      const g = data[o + 1] as number;
      const b = data[o + 2] as number;
      luma = Math.round((r * 299 + g * 587 + b * 114) / 1000);
    }
    hist[luma]!++;
  }
  const ink = hist.slice(0, INK_MAX_LUMA).reduce((a, b) => a + b, 0);
  const gray = hist.slice(INK_MAX_LUMA, PAPER_MIN_LUMA).reduce((a, b) => a + b, 0);
  const paper = n - ink - gray;
  // Mediana inferior: primer valor cuya acumulada alcanza ceil(n/2)
  // (para n par da el elemento (n/2)-1 de la lista ordenada — determinista).
  const target = Math.ceil(n / 2);
  let cum = 0;
  let median = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v]!;
    if (cum >= target) {
      median = v;
      break;
    }
  }
  return {
    inkPct: round1((ink / n) * 100),
    grayPct: round1((gray / n) * 100),
    paperPct: round1((paper / n) * 100),
    medianLuma: median,
  };
}

/** Línea de estadísticas del tile (formato fijo, testeado). */
export function statsLine(s: CalibStats): string {
  const p = (x: number): string => x.toFixed(1);
  return `tinta ${p(s.inkPct)}% · gris ${p(s.grayPct)}% · papel ${p(s.paperPct)}% · med ${s.medianLuma}`;
}

// ---------------------------------------------------------------------------
// M5 — grid honesto: subtítulos, recomendación, bandas de detalle 1:1
// ---------------------------------------------------------------------------

/** Subtítulo de una línea por modo (copy M5d — lo que cada modo ES).
 *  [RONDA 4 A1] 'bw': umbral local Bradley-Roth — el fondo queda BLANCO
 *  uniforme ante cualquier gradiente de iluminación (§R4-1c). */
export function modeSubtitle(mode: EnhanceMode): string {
  switch (mode) {
    case 'raw':
      // [F5-RAW] honesto: recorte+perspectiva SÍ, retoque de color NUNCA.
      return 'Solo recorte y perspectiva — sin filtros';
    case 'color':
      // [F5-RAW + copy-falso] el copy viejo "Foto original tal cual" era
      // FALSO: este modo aplica remoción de sombras + CLAHE (contraste
      // adaptado). Copy corregido — sugerencia analizada del humano.
      return 'Color con contraste adaptado (CLAHE)';
    case 'gray':
      return 'Blanco y negro suave';
    case 'natural':
      return 'Fondo blanco, todo legible';
    case 'text':
      // R6: el copy prometía reconocimiento óptico y el producto NO lo hace
      // (no-goal del MVP). La heurística stats→modo optimiza legibilidad
      // HUMANA; el dato de calibración apunta a gray si algún día se midiera
      // CER (ver DOSSIER §10 nota M5d): impresa gray 0.2526 vs text 0.3668.
      return 'Máximo contraste, fondo blanco puro';
    case 'bw':
      return 'Umbral local, fondo blanco uniforme';
  }
}

/** Perfil de "documento bien resuelto" (M5d): papel dominante y blanco,
 *  tinta en rango legible (ni vacío ni mancha). */
export const RECOMMEND_PAPER_MIN = 70;
export const RECOMMEND_INK_MIN = 3;
export const RECOMMEND_INK_MAX = 12;
export const RECOMMEND_MEDIAN_MIN = 235;

function fitsDocProfile(s: CalibStats): boolean {
  return (
    s.paperPct >= RECOMMEND_PAPER_MIN &&
    s.inkPct >= RECOMMEND_INK_MIN &&
    s.inkPct <= RECOMMEND_INK_MAX &&
    s.medianLuma >= RECOMMEND_MEDIAN_MIN
  );
}

/** Modo recomendado para el documento (badge M5d): el primero en prioridad
 *  natural > text > bw > gray > color que cumpla el perfil; fallback 'color'.
 *  [RONDA 4 A1] 'bw' entra TERCERO: el binario 0/255 cumple el perfil
 *  (papel ≥70%, tinta 3–12%) con más margen que gray, pero detrás de los
 *  modos con antialias (natural/text) que preservan fotografías/escalas.
 *  Sin OCR en producción (no-goal): la heurística solo lee las stats que ya
 *  se calculan. La selección sigue siendo GLOBAL (el humano confirma). */
export function recommendMode(stats: Record<EnhanceMode, CalibStats>): EnhanceMode {
  const priority: readonly EnhanceMode[] = ['natural', 'text', 'bw', 'gray', 'color'];
  for (const mode of priority) {
    if (fitsDocProfile(stats[mode])) return mode;
  }
  return 'color';
}

/** Fracción vertical de la cabecera (QR + códigos + título del acta). */
export const STRIP_HEADER_FRAC = 0.15;
/** Fracción vertical de la zona manuscrita/firmas (inferior). */
export const STRIP_MANUSCRIPT_FRAC = 0.2;
/** Bandas horizontales para buscar la de máxima densidad de tinta. */
export const DENSE_BAND_COUNT = 12;

/** Índice de la banda horizontal (0..count-1, de arriba a abajo) con mayor
 *  % de tinta (luma < INK_MAX_LUMA). Luma de 1 canal. Empate → la superior.
 *  Vacío → 0 (nunca lanza). */
export function densestBand(
  luma: ArrayLike<number>,
  w: number,
  h: number,
  count: number = DENSE_BAND_COUNT,
): number {
  const n = w * h;
  if (!(n > 0) || !(count > 0) || luma.length < n) return 0;
  let best = 0;
  let bestInk = -1;
  for (let b = 0; b < count; b++) {
    const y0 = Math.floor((b * h) / count);
    const y1 = Math.max(y0 + 1, Math.floor(((b + 1) * h) / count));
    let ink = 0;
    let total = 0;
    for (let y = y0; y < Math.min(y1, h); y++) {
      for (let x = 0; x < w; x++) {
        total++;
        if ((luma[y * w + x] as number) < INK_MAX_LUMA) ink++;
      }
    }
    if (total > 0 && ink / total > bestInk) {
      bestInk = ink / total;
      best = b;
    }
  }
  return best;
}

export interface StripRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Las 3 tiras de detalle 1:1 en coords de la imagen (M5c): cabecera (15%
 *  superior), banda de máxima densidad de tinta, manuscrita (20% inferior).
 *  Mismas coords para todos los modos = comparación honesta. Nunca lanza;
 *  dims inválidas → rects vacíos. */
export function stripRects(
  w: number,
  h: number,
  denseBand: number,
  bandCount: number = DENSE_BAND_COUNT,
): [StripRect, StripRect, StripRect] {
  if (!(w > 0) || !(h > 0) || !(bandCount > 0)) {
    const empty: StripRect = { x: 0, y: 0, w: 0, h: 0 };
    return [empty, empty, empty];
  }
  const header: StripRect = { x: 0, y: 0, w, h: Math.max(1, Math.round(h * STRIP_HEADER_FRAC)) };
  const band = Math.max(0, Math.min(bandCount - 1, denseBand));
  const y0 = Math.floor((band * h) / bandCount);
  const y1 = Math.max(y0 + 1, Math.floor(((band + 1) * h) / bandCount));
  const dense: StripRect = { x: 0, y: y0, w, h: Math.min(y1, h) - y0 };
  const manuH = Math.max(1, Math.round(h * STRIP_MANUSCRIPT_FRAC));
  const manuscript: StripRect = { x: 0, y: h - manuH, w, h: manuH };
  return [header, dense, manuscript];
}

// ---------------------------------------------------------------------------
// Overlay (DOM fino — deps inyectadas; el harness pasa el worker real)
// ---------------------------------------------------------------------------

/** Contrato mínimo que PageGallery consume (structural typing: cualquier
 *  objeto con open() sirve — el ModeCompare de abajo lo implementa). */
export interface ModeCompareOpener {
  open(source: Blob, currentMode: EnhanceMode): Promise<void> | void;
}

export interface ModeCompareDeps {
  /** Contenedor del overlay (se llena en open(), se vacía en close()). */
  root: HTMLElement;
  /** Mismo prepare que la galería (worker enhance real; el paso adaptativo
   *  del export NO aplica aquí — preview a calidad fija). Puede devolver
   *  null si el enhance falla → tile con el original y etiqueta de error. */
  prepare: (source: Blob, mode: EnhanceMode) => Promise<Blob | null>;
  /** Blob → canvas contenido a maxLongSide (inyectable/testeable; el harness
   *  usa createImageBitmap + drawImage). maxLongSide ≤ 0 = sin re-escala. */
  blobToCanvas: (blob: Blob, maxLongSide: number) => Promise<HTMLCanvasElement>;
  /** Tap en un tile → el humano eligió ese modo como GLOBAL (la galería
   *  responde con setMode; per-page override sigue PROHIBIDO — orden F5). */
  onPick?: (mode: EnhanceMode) => void;
  /** Cierre del overlay (✕). */
  onClose?: () => void;
  /** Aviso no fatal (un enhance falló → ese tile muestra el original). */
  warn?: (msg: string) => void;
}

/** Generación del open() vigente: los enhances son secuenciales y el humano
 *  puede cerrar/reabrir en medio → cada render valida su token antes de
 *  tocar el DOM (sin carreras, mismo esquema que thumbCache de la galería). */
export interface ViewerState {
  mode: EnhanceMode;
  scale: number;
  tx: number;
  ty: number;
  open: boolean;
}

/** Zoom del visor: mín/máx (8× basta para grano de tinta a 1:1). */
export const VIEWER_MIN_SCALE = 1;
export const VIEWER_MAX_SCALE = 8;

export class ModeCompare implements ModeCompareOpener {
  private readonly deps: ModeCompareDeps;
  private generation = 0;
  private openFlag = false;
  /** Fuente full-res de la página abierta (el visor enhancea por modo). */
  private viewerSource: Blob | null = null;
  private viewerMode: EnhanceMode = 'color';
  private viewerGen = 0;
  private viewerOpenFlag = false;
  /** Transform del visor: vive FUERA del modo (cambiar de chip lo conserva). */
  private viewerTransform = { scale: 1, tx: 0, ty: 0 };
  private viewerCanvas: HTMLCanvasElement | null = null;

  constructor(deps: ModeCompareDeps) {
    this.deps = deps;
  }

  isOpen(): boolean {
    return this.openFlag;
  }

  isViewerOpen(): boolean {
    return this.viewerOpenFlag;
  }

  /** Estado del visor para asserts E2E (transform conservado entre modos). */
  viewerState(): ViewerState | null {
    if (!this.viewerOpenFlag) return null;
    return {
      mode: this.viewerMode,
      scale: this.viewerTransform.scale,
      tx: this.viewerTransform.tx,
      ty: this.viewerTransform.ty,
      open: true,
    };
  }

  close(): void {
    this.generation++; // invalida cualquier tile en vuelo
    this.closeViewer(); // el visor vive dentro del root: se va con él
    this.openFlag = false;
    this.deps.root.textContent = '';
    this.deps.root.classList.remove('on');
    this.deps.onClose?.();
  }

  /** Abre el comparador para UNA página: copia reducida a ~900px, enhances
   *  SECUENCIALES por modo (mismo worker que la cámara — nunca saturar) y
   *  tiles con label + stats. Reabrir sobre uno abierto reemplaza el
   *  contenido. [RONDA 4] 5 modos (entra 'bw' — B/N adaptativo). */
  async open(source: Blob, currentMode: EnhanceMode): Promise<void> {
    this.generation++;
    const gen = this.generation;
    this.openFlag = true;
    const doc = this.deps.root.ownerDocument;

    // Copia reducida UNA vez (todos los enhances la comparten). toBlob puede
    // devolver null en canvas opacado → fallback al blob original (solo
    // cuesta más worker, el resultado es idéntico).
    let smallBlob: Blob = source;
    try {
      const small = await this.deps.blobToCanvas(source, COMPARE_PREVIEW_LONG_SIDE);
      const blob = await new Promise<Blob | null>((res) => small.toBlob(res, 'image/jpeg', 0.92));
      if (blob) smallBlob = blob;
    } catch {
      // sin downscale seguimos con el original
    }
    if (gen !== this.generation) return; // cerraron/reabrieron mientras tanto

    const root = this.deps.root;
    root.textContent = '';
    root.classList.add('on');

    const head = doc.createElement('div');
    head.className = 'cmp-head';
    const title = doc.createElement('b');
    title.textContent = 'Comparar modos — una captura';
    head.appendChild(title);
    const closeBtn = doc.createElement('button');
    closeBtn.className = 'cmp-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Cerrar comparador');
    closeBtn.addEventListener('click', () => this.close());
    head.appendChild(closeBtn);
    root.appendChild(head);

    const grid = doc.createElement('div');
    grid.className = 'cmp-grid';
    root.appendChild(grid);

    const note = doc.createElement('div');
    note.className = 'cmp-note';
    note.textContent =
      `Vista de calibración: preview ~${COMPARE_PREVIEW_LONG_SIDE}px enhanceada con el mismo pipeline del export. ` +
      'Pulsa un tile para ampliarlo (zoom + tiras 1:1); "Usar" lo hace global. El PDF se exporta a resolución completa.';
    root.appendChild(note);

    // Tile placeholder inmediato (feedback mientras el worker enhancea).
    const tiles = new Map<EnhanceMode, HTMLElement>();
    for (const mode of COMPARE_MODES) {
      const tile = doc.createElement('div');
      tile.className = 'cmp-tile';
      tile.dataset.mode = mode;
      if (mode === currentMode) tile.classList.add('current');
      const ph = doc.createElement('div');
      ph.className = 'cmp-stats';
      ph.textContent = '…';
      tile.appendChild(ph);
      grid.appendChild(tile);
      tiles.set(mode, tile);
    }

    // Blobs → canvas por tile con cache del tile actual (para stats se lee
    // el ImageData del canvas ya dibujado — sin segundas pasadas).
    // M5a: smoothing alto + backing a devicePixelRatio (el grid se ve
    // "menos sucio" aunque siga siendo miniatura).
    const drawTileCanvas = async (blob: Blob): Promise<HTMLCanvasElement> => {
      const big = await this.deps.blobToCanvas(blob, 0);
      const d = previewDims(big.width, big.height, COMPARE_TILE_LONG_SIDE);
      const view = doc.defaultView ?? null;
      const dpr = Math.min(
        3,
        Math.max(1, Math.round(view?.devicePixelRatio ?? 1)),
      );
      const c = doc.createElement('canvas');
      c.width = Math.max(1, d.w * dpr);
      c.height = Math.max(1, d.h * dpr);
      c.style.width = `${d.w}px`;
      c.style.height = `${d.h}px`;
      const ctx = c.getContext('2d');
      if (ctx === null) throw new Error('cmp: sin contexto 2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.scale(dpr, dpr);
      ctx.drawImage(big, 0, 0, d.w, d.h);
      return c;
    };

    const statsByMode = new Map<EnhanceMode, CalibStats>();

    const fillTile = (
      mode: EnhanceMode,
      canvas: HTMLCanvasElement,
      fallbackLabel: string,
    ): void => {
      if (gen !== this.generation) return;
      const tile = tiles.get(mode);
      if (!tile) return;
      tile.textContent = '';
      canvas.className = 'cmp-canvas';
      tile.appendChild(canvas);
      const label = doc.createElement('div');
      label.className = 'cmp-label';
      label.textContent = modeLabel(mode) + fallbackLabel;
      tile.appendChild(label);
      const sub = doc.createElement('div');
      sub.className = 'cmp-sub';
      sub.textContent = modeSubtitle(mode);
      tile.appendChild(sub);
      const stats = doc.createElement('div');
      stats.className = 'cmp-stats';
      const ctx = canvas.getContext('2d');
      if (ctx !== null) {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const st = calibrationStats(img.data, canvas.width, canvas.height, 4);
        statsByMode.set(mode, st);
        stats.textContent = statsLine(st);
        // a11y M5: el tile anuncia sus stats (E2E lo verifica).
        tile.setAttribute(
          'aria-label',
          `${modeLabel(mode)}: ${statsLine(st)}. Pulsa para ampliar.`,
        );
      }
      tile.appendChild(stats);
      // M5b: el tap abre el VISOR (la comparación real); la elección global
      // vive en el botón "Usar" (antes el tap elegía — contrato pick intacto
      // vía onPick, distinta affordance).
      tile.setAttribute('role', 'button');
      tile.tabIndex = 0;
      const openViewer = (): void => {
        // Fuente FULL-RES (no el preview 900px): el zoom y las tiras 1:1
        // necesitan píxeles reales — un enhance por modo a demanda.
        void this.openViewer(source, mode);
      };
      tile.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('.cmp-use') !== null) return;
        openViewer();
      });
      tile.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openViewer();
        }
      });
      const useBtn = doc.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'cmp-use';
      useBtn.textContent = 'Usar';
      useBtn.setAttribute('aria-label', `Usar ${modeLabel(mode)} como modo global`);
      useBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        for (const t of tiles.values()) t.classList.toggle('current', t === tile);
        this.deps.onPick?.(mode);
      });
      tile.appendChild(useBtn);
    };

    for (const mode of COMPARE_MODES) {
      if (gen !== this.generation) return;
      try {
        const prepared = await this.deps.prepare(smallBlob, mode);
        if (gen !== this.generation) return;
        const canvas = await drawTileCanvas(prepared ?? smallBlob);
        fillTile(mode, canvas, prepared ? '' : ' (sin enhance)');
        if (!prepared) this.deps.warn?.(`Comparar: enhance ${mode} falló — tile con el original.`);
      } catch (e) {
        // El overlay nunca se rompe por un modo: tile de error y seguimos.
        const tile = tiles.get(mode);
        if (tile) {
          tile.textContent = '';
          const label = doc.createElement('div');
          label.className = 'cmp-label';
          label.textContent = `${modeLabel(mode)} — error`;
          tile.appendChild(label);
          const msg = doc.createElement('div');
          msg.className = 'cmp-stats';
          msg.textContent = e instanceof Error ? e.message : String(e);
          tile.appendChild(msg);
        }
      }
    }

    // M5d: badge "Recomendado" (solo si TODOS los modos rindieron stats).
    // [RONDA 4] la clave 'bw' entra al Record con las MISMAS stats del flujo
    // (calibrationStats sobre el blob resultado — luma del tile, idéntico
    // cálculo que los demás modos; el binario 0/255 simplemente cae en las
    // bandas tinta/papel con gris ≈ 0).
    if (gen === this.generation && statsByMode.size === COMPARE_MODES.length) {
      const rec = recommendMode({
        raw: statsByMode.get('raw')!,
        color: statsByMode.get('color')!,
        gray: statsByMode.get('gray')!,
        natural: statsByMode.get('natural')!,
        text: statsByMode.get('text')!,
        bw: statsByMode.get('bw')!,
      });
      const tile = tiles.get(rec);
      if (tile) {
        const badge = doc.createElement('span');
        badge.className = 'cmp-badge';
        badge.textContent = 'Recomendado';
        tile.querySelector('.cmp-label')?.appendChild(doc.createTextNode(' '));
        tile.querySelector('.cmp-label')?.appendChild(badge);
        tile.setAttribute(
          'aria-label',
          `${tile.getAttribute('aria-label') ?? modeLabel(rec)} Recomendado.`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // M5b/M5c — visor A/B a pantalla completa (zoom/pan conservados + tiras 1:1)
  // -------------------------------------------------------------------------

  closeViewer(): void {
    this.viewerGen++; // invalida enhances en vuelo del visor
    this.viewerOpenFlag = false;
    this.releaseViewerCanvas();
    const viewer = this.deps.root.querySelector('.cmp-viewer');
    viewer?.remove();
  }

  private releaseViewerCanvas(): void {
    if (this.viewerCanvas !== null) {
      this.viewerCanvas.width = 0;
      this.viewerCanvas.height = 0;
      this.viewerCanvas = null;
    }
  }

  /** Abre el visor para un modo (tap en tile). El enhance es full-res desde
   *  la fuente (una llamada al worker por cambio de modo — secuencial,
   *  a demanda del humano). El transform se conserva entre modos. */
  async openViewer(source: Blob, mode: EnhanceMode): Promise<void> {
    this.viewerGen++;
    const gen = this.viewerGen;
    this.viewerSource = source;
    this.viewerMode = mode;
    this.viewerOpenFlag = true;
    const doc = this.deps.root.ownerDocument;
    this.deps.root.querySelector('.cmp-viewer')?.remove();

    const viewer = doc.createElement('div');
    viewer.className = 'cmp-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', `Comparador ampliado — ${modeLabel(mode)}`);

    const bar = doc.createElement('div');
    bar.className = 'v-bar';
    const back = doc.createElement('button');
    back.type = 'button';
    back.className = 'v-btn';
    back.textContent = '←';
    back.setAttribute('aria-label', 'Volver al grid');
    back.addEventListener('click', () => this.closeViewer());
    const title = doc.createElement('b');
    title.className = 'v-title';
    title.textContent = `${modeLabel(mode)} — ${modeSubtitle(mode)}`;
    const closeX = doc.createElement('button');
    closeX.type = 'button';
    closeX.className = 'v-btn';
    closeX.textContent = '✕';
    closeX.setAttribute('aria-label', 'Cerrar visor');
    closeX.addEventListener('click', () => this.closeViewer());
    bar.append(back, title, closeX);
    viewer.appendChild(bar);

    const chips = doc.createElement('div');
    chips.className = 'v-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Cambiar de modo (conserva zoom y posición)');
    for (const m of COMPARE_MODES) {
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'v-chip';
      chip.dataset.mode = m;
      chip.textContent = modeLabel(m);
      chip.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
      chip.addEventListener('click', () => {
        void this.renderViewerMode(m);
      });
      chips.appendChild(chip);
    }
    const useBtn = doc.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'v-chip v-use-global';
    useBtn.textContent = 'Usar este modo';
    useBtn.setAttribute('aria-label', 'Usar el modo visible como modo global');
    useBtn.addEventListener('click', () => {
      this.deps.onPick?.(this.viewerMode);
      this.closeViewer();
      this.close();
    });
    chips.appendChild(useBtn);
    viewer.appendChild(chips);

    const stage = doc.createElement('div');
    stage.className = 'v-stage';
    const main = doc.createElement('canvas');
    main.className = 'v-main';
    main.style.touchAction = 'none';
    stage.appendChild(main);
    const loading = doc.createElement('div');
    loading.className = 'v-loading';
    loading.textContent = 'Enhanceando a resolución completa…';
    stage.appendChild(loading);
    viewer.appendChild(stage);

    const zoom = doc.createElement('div');
    zoom.className = 'v-zoom';
    const mkBtn = (text: string, label: string, fn: () => void): HTMLButtonElement => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'v-btn';
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', fn);
      return b as HTMLButtonElement;
    };
    const zoomLabel = doc.createElement('span');
    zoomLabel.className = 'v-zoom-label';
    zoomLabel.setAttribute('aria-live', 'polite');
    zoom.append(
      mkBtn('−', 'Reducir zoom', () => this.zoomViewer(0.5, true)),
      zoomLabel,
      mkBtn('+', 'Ampliar zoom', () => this.zoomViewer(2, true)),
      mkBtn('1:1', 'Zoom 1:1 (píxel real)', () => this.setViewerScale(1)),
    );
    viewer.appendChild(zoom);

    const strips = doc.createElement('div');
    strips.className = 'v-strips';
    viewer.appendChild(strips);

    this.deps.root.appendChild(viewer);
    this.wireViewerGestures(main);
    viewer.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.closeViewer();
      else if (ev.key === '+' || ev.key === '=') this.zoomViewer(2, true);
      else if (ev.key === '-') this.zoomViewer(0.5, true);
    });
    back.focus();
    if (gen !== this.viewerGen) return;
    await this.renderViewerMode(mode);
  }

  private zoomViewer(factor: number, center: boolean): void {
    const t = this.viewerTransform;
    const next = Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, t.scale * factor));
    if (next === t.scale) return;
    if (center) {
      // Zoom al centro del stage: compensa la traslación (origen 0,0).
      const stage = this.deps.root.querySelector('.v-stage') as HTMLElement | null;
      const cx = (stage?.clientWidth ?? 300) / 2;
      const cy = (stage?.clientHeight ?? 300) / 2;
      const k = next / t.scale;
      t.tx = cx - (cx - t.tx) * k;
      t.ty = cy - (cy - t.ty) * k;
    }
    t.scale = next;
    this.applyViewerTransform();
  }

  private setViewerScale(scale: number): void {
    const t = this.viewerTransform;
    t.scale = Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, scale));
    if (t.scale === 1) {
      t.tx = 0;
      t.ty = 0;
    }
    this.applyViewerTransform();
  }

  private applyViewerTransform(): void {
    const viewer = this.deps.root.querySelector('.cmp-viewer');
    const main = viewer?.querySelector('.v-main') as HTMLCanvasElement | null;
    const label = viewer?.querySelector('.v-zoom-label');
    const t = this.viewerTransform;
    if (main) main.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
    if (label) label.textContent = `${Math.round(t.scale * 100)}%`;
  }

  /** Pan con 1 dedo + pinch con 2 (pointer events; el stage no hace scroll). */
  private wireViewerGestures(main: HTMLCanvasElement): void {
    const active = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    main.addEventListener('pointerdown', (ev) => {
      active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      try {
        main.setPointerCapture(ev.pointerId);
      } catch {
        /* sin captura: el pan sigue funcionando */
      }
      if (active.size === 2) {
        const [a, b] = [...active.values()];
        pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
      ev.preventDefault();
    });
    main.addEventListener('pointermove', (ev) => {
      const prev = active.get(ev.pointerId);
      if (!prev) return;
      const dx = ev.clientX - prev.x;
      const dy = ev.clientY - prev.y;
      active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const t = this.viewerTransform;
      if (active.size === 2) {
        const [a, b] = [...active.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (pinchDist > 0 && dist > 0) this.setViewerScale(t.scale * (dist / pinchDist));
        pinchDist = dist;
      } else {
        t.tx += dx;
        t.ty += dy;
        this.applyViewerTransform();
      }
    });
    const release = (ev: PointerEvent): void => {
      active.delete(ev.pointerId);
      pinchDist = 0;
    };
    main.addEventListener('pointerup', release);
    main.addEventListener('pointercancel', release);
    main.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.zoomViewer(ev.deltaY < 0 ? 1.25 : 0.8, false);
    });
    main.addEventListener('dblclick', () => this.setViewerScale(1));
  }

  /** Renderiza un modo en el visor CONSERVANDO el transform (M5b). Enhance
   *  full-res desde la fuente + tiras 1:1 con las mismas coords (M5c). */
  private async renderViewerMode(mode: EnhanceMode): Promise<void> {
    const gen = this.viewerGen;
    const source = this.viewerSource;
    const viewer = this.deps.root.querySelector('.cmp-viewer');
    if (!this.viewerOpenFlag || source === null || viewer === null) return;
    this.viewerMode = mode;
    const doc = this.deps.root.ownerDocument;
    const main = viewer.querySelector('.v-main') as HTMLCanvasElement | null;
    const loading = viewer.querySelector('.v-loading');
    const strips = viewer.querySelector('.v-strips');
    const title = viewer.querySelector('.v-title');
    if (main === null || strips === null) return;
    if (loading) loading.textContent = `Enhanceando ${modeLabel(mode)}…`;
    viewer.setAttribute('aria-label', `Comparador ampliado — ${modeLabel(mode)}`);
    if (title) title.textContent = `${modeLabel(mode)} — ${modeSubtitle(mode)}`;
    for (const chip of viewer.querySelectorAll('.v-chip')) {
      const el = chip as HTMLElement;
      el.setAttribute('aria-pressed', el.dataset.mode === mode ? 'true' : 'false');
    }
    let blob: Blob | null = null;
    try {
      blob = await this.deps.prepare(source, mode);
    } catch {
      blob = null;
    }
    if (gen !== this.viewerGen) return;
    const canvas = await this.deps.blobToCanvas(blob ?? source, 0);
    if (gen !== this.viewerGen) return;
    this.releaseViewerCanvas();
    this.viewerCanvas = canvas;
    // Stage contain: el canvas se muestra encajado; el zoom parte de 1.
    main.width = canvas.width;
    main.height = canvas.height;
    const mctx = main.getContext('2d');
    if (mctx === null) return;
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(canvas, 0, 0);
    if (loading) loading.remove();
    this.applyViewerTransform();

    // Tiras 1:1 (mismas coords para todos los modos — comparación honesta).
    strips.textContent = '';
    const img = mctx.getImageData(0, 0, canvas.width, canvas.height);
    const luma = new Uint8ClampedArray(canvas.width * canvas.height);
    for (let i = 0; i < luma.length; i++) {
      const o = i * 4;
      luma[i] = (img.data[o]! * 77 + img.data[o + 1]! * 150 + img.data[o + 2]! * 29) >> 8;
    }
    const rects = stripRects(canvas.width, canvas.height, densestBand(luma, canvas.width, canvas.height));
    const names = ['Cabecera 1:1', 'Tinta densa 1:1', 'Manuscrita 1:1'];
    rects.forEach((r, i) => {
      const fig = doc.createElement('figure');
      fig.className = 'v-strip-fig';
      const c = doc.createElement('canvas');
      c.className = 'v-strip';
      c.width = Math.max(1, r.w);
      c.height = Math.max(1, r.h);
      const cctx = c.getContext('2d');
      // 1:1 real: drawImage sin re-escala desde el canvas full-res.
      cctx?.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const cap = doc.createElement('figcaption');
      cap.textContent = `${names[i]} — ${modeLabel(mode)}`;
      fig.append(c, cap);
      strips.appendChild(fig);
    });
  }
}
