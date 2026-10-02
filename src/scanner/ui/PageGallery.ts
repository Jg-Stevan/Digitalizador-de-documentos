// src/ui/PageGallery.ts — galería multipágina (§5-F5). DOM FINO (patrón T5,
// mismo esquema que AdjustEditor): contexto inyectado por constructor, la
// matemática (relocate/thumbDims/umbral de arrastre) es PURA y vive en este
// archivo para tests Node. Miniaturas ~200px (orden F5), reorder por arrastre
// touch (pointer events, umbral 44px de touch — mismo EDITOR_TOUCH_PX que el
// editor F4), delete, contador, selector GLOBAL de modo (per-page override
// PROHIBIDO), Exportar PDF → navigator.share o download, aviso de cuota
// (>70%, quotaReport de dataCollect) y recordatorio de exportar si quedan
// páginas sin exportar. D-F5-e: botón "⚖" por página → comparador de los
// modos con UNA captura (ModeCompare, mismo worker vía prepare). [RONDA 4]
// el set son 5 modos: color/gray/natural/text + 'bw' (B/N adaptativo).
//
// Constantes nuevas: NINGUNA de pipeline — solo la geometría UI "dada" por el
// orden F5 (~200px miniaturas) y el umbral de 44px reutilizado de AdjustEditor.

import type { EnhanceMode } from '../core/types';
import { JPEG_QUALITY } from '../core/imageModes';
import { PDF_SIZE_LIMIT_BYTES } from '../export/pageStore';
import type { PdfPageSize } from '../export/pdfExport';
import type { PageRecord, PageStore } from '../export/pageStore';
import { EDITOR_TOUCH_PX, previewDims } from './AdjustEditor';
import type { ModeCompareOpener } from './ModeCompare';

// ---------------------------------------------------------------------------
// Matemática pura (tests Node)
// ---------------------------------------------------------------------------

/** Reordena una lista de ids: mueve el elemento `from` a la posición `to`
 *  (índices de la lista, como la cola — mismas reglas que Array.prototype.splice
 *  para tap/click: el destino es la posición en la lista ANTES de remover).
 *  Índices inválidos → copia intacta. NO muta la entrada. */
export function relocate(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids];
  const out = ids.slice();
  const [moved] = out.splice(from, 1);
  if (moved === undefined) return out;
  const clamped = Math.max(0, Math.min(out.length, to));
  out.splice(clamped, 0, moved);
  return out;
}

/** Dims de la miniatura (contain, ~200px lado mayor — orden F5). Reutiliza
 *  previewDims de AdjustEditor (misma geometría contain, sin duplicar). */
export function thumbDims(w: number, h: number): { w: number; h: number } {
  return previewDims(w, h, 200);
}

/** ¿Supera el movimiento de arrastre el umbral de 44px touch (orden F5,
 *  mismo umbral táctil que el editor F4)? Distancia euclídea. */
export function shouldStartDrag(dx: number, dy: number, threshold: number = EDITOR_TOUCH_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

/** Índice de cola para un punto (px del contenedor) dadas las cajas de las
  *  miniaturas (bboxes de la galería): el centro más cercano debajo del punto.
  *  Sin cajas → -1. PURO y testeable (el arrastre solo reordena sobre
  *  miniaturas, nunca fuera del contenedor). */
export function indexAtPoint(
  x: number,
  y: number,
  boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export async function preparePages(
  pages: readonly PageRecord[],
  mode: EnhanceMode,
  prepare: (source: Blob, mode: EnhanceMode, step?: ExportStep) => Promise<Blob>,
  step?: ExportStep,
): Promise<PageRecord[]> {
  const out: PageRecord[] = [];
  for (const p of pages) {
    const blob = await prepare(p.blob, mode, step);
    if (blob === null) throw new Error(`enhance falló para la página ${p.order + 1}`);
    out.push({ ...p, blob, mode });
  }
  return out;
}

/** Texto del modo para el selector (D-F5-c 2026-09-26: nomenclatura del set
 *  de filtros de Adobe Scan elegido por el humano; [RONDA 4 A1] 'bw' entra
 *  como "B/N adaptativo" — terminología GENÉRICA de escáner de documentos,
 *  PROHIBIDA cualquier cadena que mencione formatos específicos — directriz
 *  humana 28-sep, §R4 rev.2). [F5-RAW + copy-falso, 2026-10-01 — análisis de
 *  sugerencias]: 'raw' = "Original de cámara" (passthrough real) y 'color'
 *  se renombra de "Color original" a "Color mejorado" — el copy viejo
 *  prometía "original" pero el modo APLICA sombras+CLAHE: promesa falsa que
 *  confundió al usuario (bug reportado "el color original tiene algún
 *  filtro?" — sí, los tiene: ahora el nombre lo dice honesto). */
export function modeLabel(mode: EnhanceMode): string {
  switch (mode) {
    case 'raw':
      return 'Original de cámara';
    case 'color':
      return 'Color mejorado';
    case 'gray':
      return 'Escala de grises';
    case 'natural':
      return 'Color automático';
    case 'text':
      return 'Texto claro';
    case 'bw':
      return 'B/N adaptativo';
  }
}

/** [FASE 8.1, 2026-11] Subtítulo del modo, patrón de las tarjetas de filtro
 *  del diseño AI Studio del humano ("Binarizado E-14 / Bradley-Roth
 *  Adaptativo"): el nombre técnico baja a descripción corta y amable — el
 *  público elige por QUÉ QUIERE EL RESULTADO, no por el algoritmo. */
export function modeSub(mode: EnhanceMode): string {
  switch (mode) {
    case 'raw':
      return 'Tal cual la capturó la cámara';
    case 'color':
      return 'Colores vivos y parejos';
    case 'gray':
      return 'Blanco y negro suave';
    case 'natural':
      return 'Foto fiel al papel';
    case 'text':
      return 'Letras nítidas, fondo blanco';
    case 'bw':
      return 'Máximo contraste para leer';
  }
}

// --- F6.5: export adaptativo (hallazgo de la validación humana F5) --------
// Lote 1 del humano: 3 páginas arrugadas → 5.28MB (> DoD 3MB) con q0.90 y
// sin re-escala; la página con textura ruidosa costó 1.9MB (el ruido no
// comprime). Medido con las imágenes reales del humano: cap 2200px + q0.78
// → 2.1MB total. Estrategia: PRIMER intento SIEMPRE a máxima calidad (el
// documento limpio típico pasa de una); solo si supera el presupuesto se
// re-encode en pasos más agresivos. Nunca amplía (maxLongSide 0 = tal cual).

/** Un paso de re-encode del export: lado mayor máximo (0 = sin límite) y
 *  calidad JPEG (PNG/bw la ignora). */
export interface ExportStep {
  maxLongSide: number;
  quality: number;
}

/** Pasos del export adaptativo, de MÁS a MENOS calidad. Paso 0 = identidad
 *  (q0.90, sin re-escala — comportamiento pre-F6.5). Los valores 2/3 salen
 *  del experimento con las páginas reales de la validación (2600/q0.82 →
 *  ~3.3MB·3págs; 2200/q0.78 → ~2.1MB·3págs). */
export const EXPORT_STEPS: readonly ExportStep[] = [
  { maxLongSide: 0, quality: JPEG_QUALITY },
  { maxLongSide: 2600, quality: 0.82 },
  { maxLongSide: 2200, quality: 0.78 },
];

/** Presupuesto de tamaño del PDF por número de páginas (bytes). Origen: DoD
 *  F5 "3 páginas → PDF <3MB" generalizado a ~1MB/página con PISO de 3MB
 *  (documentos de 1-2 páginas no deben degradarse por un presupuesto menor
 *  al del DoD) y TECHO de 8MB (PDF_SIZE_LIMIT_BYTES — aviso vigente). */
export function pdfBudgetBytes(count: number): number {
  if (!(count > 0)) return 0;
  const mb = Math.min(Math.max(count, 3), PDF_SIZE_LIMIT_BYTES / (1024 * 1024));
  return Math.round(mb * 1024 * 1024);
}

// ---------------------------------------------------------------------------
// Clase (DOM ligera; deps inyectadas; sin document global salvo helpers que
// llegan por parámetro)
// ---------------------------------------------------------------------------

export interface PageGalleryDeps {
  /** Contenedor de la galería (se pinta en render()). */
  root: HTMLElement;
  store: PageStore;
  /** Fabricador de miniatura (blob → canvas ~200px; inyectable/testeable).
   *  Default: canvas 2d con drawImage + downscale a thumbDims. */
  makeThumb?: (blob: Blob) => Promise<HTMLCanvasElement>;
  /** Transforma el warped almacenado al modo global vigente antes del PDF.
   *  Default: usa el blob almacenado (para consumidores ya realzados).
   *  F6.5: `step` opcional (maxLongSide/quality) para el export adaptativo —
   *  los consumidores que lo ignoran siguen funcionando sin cambios. */
  prepare?: (source: Blob, mode: EnhanceMode, step?: ExportStep) => Promise<Blob>;
  /** Comparte el PDF (navigator.share; el harness decide share vs download).
   *  Devuelve false si el usuario canceló. Default: download vía <a>. */
  onExport?: (pdf: Blob, pageSize: PdfPageSize) => Promise<void>;
  /** Cambio de modo GLOBAL (harness la reenvía al worker/cola). */
  onModeChange?: (mode: EnhanceMode) => void;
  /** D-F5-e: comparador de modos con UNA captura (opcional — los consumidores
   *  que no lo conectan no ven el botón y nada más cambia). El botón "⚖" de
   *  cada miniatura abre el overlay con los modos + stats de calibración. */
  compare?: ModeCompareOpener;
  /** [FASE 9, 2026-11] CTA del estado vacío "Subir fotos de tu galería":
   *  la delega el harness (abre el selector de archivos y corre el MISMO
   *  detect→warp que la cámara). Opcional — sin cablear no se pinta nada. */
  onImport?: () => void;
  /** Aviso al usuario (cuota >70%, recordatorio de exportar). */
  warn?: (msg: string) => void;
}

/** Galería F5. render() pinta las páginas del store; el resto son delegaciones
 *  finas a PageStore (que persiste). El arrastre es pointer-event con umbral
 *  44px y reordena sobre bboxes (indexAtPoint). */
export class PageGallery {
  private readonly root: HTMLElement;
  private readonly store: PageStore;
  private readonly makeThumb: NonNullable<PageGalleryDeps['makeThumb']>;
  private readonly onExport: NonNullable<PageGalleryDeps['onExport']>;
  private readonly prepare: NonNullable<PageGalleryDeps['prepare']>;
  private readonly onModeChange: ((mode: EnhanceMode) => void) | undefined;
  private readonly compare: ModeCompareOpener | undefined;
  private readonly onImport: (() => void) | undefined;
  private readonly warn: ((msg: string) => void) | undefined;
  private mode: EnhanceMode = 'color';
  private pages: PageRecord[] = [];
  /** El usuario exportó en ESTA sesión: el aviso "sin exportar" se muestra
   *  mientras haya páginas en la cola y no se haya exportado aún. */
  private exportedThisSession = false;
  private boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  /** F6.5: cache de miniaturas PROCESADAS con el modo vigente — render() es
   *  frecuente (add/delete/reorder) y re-enhance por página en cada render
   *  saturaría el worker (mismo worker que la cámara). Clave id|modo|tam;
   *  tope simple: >60 entradas → clear (las thumbs son ~200px, baratas). */
  private thumbCache = new Map<string, HTMLCanvasElement>();

  constructor(deps: PageGalleryDeps) {
    this.root = deps.root;
    this.store = deps.store;
    this.onModeChange = deps.onModeChange;
    this.compare = deps.compare;
    this.onImport = deps.onImport;
    this.warn = deps.warn;
    this.prepare = deps.prepare ?? (async (source) => source);
    this.makeThumb =
      deps.makeThumb ??
      (async (blob) => {
        const doc = this.root.ownerDocument;
        const url = URL.createObjectURL(blob);
        try {
          const img = new Image();
          img.src = url;
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('thumb: imagen ilegible'));
          });
          const d = thumbDims(img.naturalWidth, img.naturalHeight);
          const c = doc.createElement('canvas');
          c.width = d.w;
          c.height = d.h;
          const ctx = c.getContext('2d');
          if (ctx === null) throw new Error('thumb: sin contexto 2d');
          ctx.drawImage(img, 0, 0, d.w, d.h);
          return c;
        } finally {
          URL.revokeObjectURL(url);
        }
      });
    const doc = this.root.ownerDocument;
    this.onExport =
      deps.onExport ??
      (async (pdf, a4) => {
        await defaultExport(doc, pdf, a4);
      });
  }

  /** Reflexión del modo global actual (el harness la mantiene sincronizada;
   *  el worker la aplica en el próximo enhance). */
  setMode(mode: EnhanceMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // F6.5: las miniaturas muestran el RESULTADO del modo (hallazgo humano:
    // "los modos solo se ven al exportar" era una trampa de UX). Re-render
    // con cache — solo re-enhance de las páginas cuyo (id|modo) cambió.
    void this.render().catch(() => {
      // sin cámara/store caído el render no debe romper el cambio de modo
    });
  }
  getMode(): EnhanceMode {
    return this.mode;
  }

  /** Pinta la galería (miniaturas ~200px, contador, estados). El harness la
   *  llama tras cada mutación de la cola. */
  async render(): Promise<void> {
    this.pages = await this.store.pages();
    this.root.textContent = '';
    const doc = this.root.ownerDocument;

    // Barra: contador + selector global de modo.
    const bar = doc.createElement('div');
    bar.className = 'pg-bar';
    const counter = doc.createElement('span');
    counter.className = 'pg-count';
    counter.textContent = `${this.pages.length} página${this.pages.length === 1 ? '' : 's'}`;
    bar.appendChild(counter);
    const sel = doc.createElement('select');
    sel.className = 'pg-mode';
    // [FASE 8.1] aria: el select ya se anuncia solo; el subtítulo describirá
    // la elección en lenguaje de gente (patrón del diseño AI Studio).
    sel.setAttribute('aria-label', 'Filtro de realce de todo el documento');
    // [F5-RAW, 2026-10-01] 'raw' ("Original de cámara") PRIMERO del selector
    // — es la referencia de fidelidad y la respuesta directa al pedido del
    // usuario ("deja el modo original como lo capta desde la cámara").
    // [RONDA 4 A1] 'bw' entra al selector global (orden del comparador:
    // color, gray, natural, text, bw).
    for (const m of ['raw', 'color', 'gray', 'natural', 'text', 'bw'] as const) {
      const opt = doc.createElement('option');
      opt.value = m;
      opt.textContent = modeLabel(m);
      sel.appendChild(opt);
    }
    sel.value = this.mode;
    // [FASE 8.1] Subtítulo del modo vigente ("nombre + descripción" del
    // diseño): se pinta BAJO el chip y se refresca al cambiar el select.
    const modeSubEl = doc.createElement('span');
    modeSubEl.className = 'pg-mode-sub';
    modeSubEl.textContent = modeSub(this.mode);
    sel.addEventListener('change', () => {
      this.setMode(sel.value as EnhanceMode); // F6.5: setMode re-renderiza thumbs
      this.onModeChange?.(this.mode);
    });
    bar.appendChild(sel);
    bar.appendChild(modeSubEl);
    this.root.appendChild(bar);

    // [FASE 8.1] Estado vacío: primera visita del público — guiar en vez de
    // mostrar un contador en 0 (render() es additive: nada de lógica nueva).
    // [FASE 9] El estado vacío también ofrece el camino SIN cámara: subir
    // fotos de la galería (con el mismo recorte automático).
    if (this.pages.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'pg-empty';
      const emptyTitle = doc.createElement('span');
      emptyTitle.className = 'pg-empty-title';
      emptyTitle.textContent = 'Aún no hay páginas';
      const emptySub = doc.createElement('span');
      emptySub.textContent =
        'Escanea con la cámara o sube fotos de tu galería — recortamos los bordes solos.';
      empty.appendChild(emptyTitle);
      empty.appendChild(emptySub);
      if (this.onImport) {
        const cta = doc.createElement('button');
        cta.type = 'button';
        cta.className = 'pg-empty-cta';
        cta.textContent = 'Subir fotos de tu galería';
        cta.setAttribute(
          'aria-label',
          'Subir fotos de la galería del teléfono y recortarlas automáticamente',
        );
        cta.addEventListener('click', () => this.onImport?.());
        empty.appendChild(cta);
      }
      this.root.appendChild(empty);
    }

    // Miniaturas reordenables.
    const grid = doc.createElement('div');
    grid.className = 'pg-grid';
    const thumbs: HTMLElement[] = [];
    for (const p of this.pages) {
      const t = doc.createElement('div');
      t.className = 'pg-thumb';
      t.dataset.id = p.id;
      const canvas = await this.thumbFor(p);
      canvas.className = 'pg-thumb-img';
      t.appendChild(canvas);
      // D-F5-e: comparar los modos con ESTA captura (overlay ModeCompare).
      // stopPropagation en click; el pointerdown del arrastre también la
      // excluye (mismo guard que pg-del en bindReorder).
      if (this.compare) {
        const cmp = doc.createElement('button');
        cmp.className = 'pg-cmp';
        cmp.type = 'button';
        cmp.textContent = '⚖';
        cmp.setAttribute('aria-label', `Comparar modos de la página ${p.order + 1}`);
        cmp.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void this.compare?.open(p.blob, this.mode);
        });
        t.appendChild(cmp);
      }
      const del = doc.createElement('button');
      del.className = 'pg-del';
      del.type = 'button';
      del.textContent = '✕';
      del.setAttribute('aria-label', `Quitar página ${p.order + 1}`);
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await this.store.remove(p.id);
        await this.render();
      });
      t.appendChild(del);
      const tag = doc.createElement('div');
      tag.className = 'pg-mode-tag';
      // F6.5: la miniatura YA muestra el resultado del modo global — el tag
      // deja de repetir el modo de captura (obsoleto: el modo es global y se
      // aplica al export) y nombra lo que se ve.
      tag.textContent = modeLabel(this.mode);
      t.appendChild(tag);
      grid.appendChild(t);
      thumbs.push(t);
    }
    this.root.appendChild(grid);
    this.bindReorder(thumbs);

    // Recordatorio: páginas SIN exportar al cerrar (solo si hay páginas y no
    // se exportó desde que se abrió la sesión — el plan pide el aviso).
    if (!this.exportedThisSession && this.pages.length > 0) {
      const hint = doc.createElement('div');
      hint.className = 'pg-hint';
      hint.textContent = 'Quedan páginas sin exportar: pulsa "Exportar PDF" antes de cerrar.';
      this.root.appendChild(hint);
    }

    // Cuota >70% → aviso (reutiliza quotaReport de dataCollect).
    try {
      const q = await this.store.quota();
      if (q.warn) this.warn?.(`Cuota de almacenamiento al ${Math.round((q.pct ?? 0) * 100)}% — exporta y descarga el PDF.`);
    } catch {
      // sin estimador: no crítico
    }
  }

  /** Exporta el PDF de la cola (M1: página adaptativa por defecto; papel
   *  fijo con 'letter'/'a4') y limpia el recordatorio. Devuelve bytes para
   *  el reporte (el harness mide el meta).
   *  F6.5: export ADAPTATIVO — primer intento a máxima calidad; si supera el
   *  presupuesto (pdfBudgetBytes) re-encodea en pasos EXPORT_STEPS hasta
   *  caber (o agotar pasos: gana el más pequeño construido). */
  async exportPdf(pageSize: PdfPageSize = 'adaptive'): Promise<{ size: number; count: number } | null> {
    const pages = await this.store.pages();
    if (pages.length === 0) return null;
    const budget = pdfBudgetBytes(pages.length);
    let best: { pdf: Blob; count: number } | null = null;
    for (const step of EXPORT_STEPS) {
      const prepared = await preparePages(pages, this.mode, this.prepare, step);
      const pdf = await this.store.exportPdf({ pageSize, pages: prepared });
      if (pdf === null) return null;
      if (best === null || pdf.size < best.pdf.size) best = { pdf, count: prepared.length };
      if (pdf.size <= budget) break;
    }
    if (best === null) return null;
    const pdf = best.pdf;
    if (pdf.size > PDF_SIZE_LIMIT_BYTES) {
      this.warn?.(`PDF de ${(pdf.size / 1024 / 1024).toFixed(1)} MB supera el techo de 8 MB — reduce páginas.`);
    }
    await this.onExport(pdf, pageSize);
    this.exportedThisSession = true;
    return { size: pdf.size, count: best.count };
  }

  /** [FASE 7a, 2026-11 — flujo diario, petición "cuál es el siguiente paso"]
   *  Vacía la cola persistida para empezar OTRO documento. Hasta ahora
   *  pageStore.clear() no tenía cableado UI y la sesión siguiente ACUMULABA
   *  sobre el documento anterior (gap reportado al cerrar FASE 6). La
   *  confirmación (dos pasos, sin diálogo nativo) vive en el harness/app.ts:
   *  aquí solo la operación atómica. Devuelve las páginas que había (0 = no
   *  había nada que descartar). Reset de exportedThisSession + thumbCache:
   *  el documento nuevo arranca limpio (aviso de "sin exportar" otra vez
   *  activo). NO toca captura/worker/orchestrator (zona protegida R1/R2). */
  async newDocument(): Promise<number> {
    const pages = await this.store.pages();
    if (pages.length === 0) return 0;
    await this.store.clear();
    this.exportedThisSession = false;
    this.thumbCache.clear();
    await this.render();
    return pages.length;
  }

  /** Miniatura de una página PROCESADA con el modo global vigente (F6.5),
   *  con cache id|modo|tam y fallback al blob original si el enhance falla
   *  (worker ocupado por la cámara → la galería nunca se rompe). */
  private async thumbFor(p: PageRecord): Promise<HTMLCanvasElement> {
    const key = `${p.id}|${this.mode}|${p.blob.size}`;
    const hit = this.thumbCache.get(key);
    if (hit) return hit;
    let canvas: HTMLCanvasElement;
    try {
      const processed = await this.prepare(p.blob, this.mode);
      canvas = processed === null ? await this.makeThumb(p.blob) : await this.makeThumb(processed);
    } catch {
      canvas = await this.makeThumb(p.blob);
    }
    if (this.thumbCache.size > 60) this.thumbCache.clear();
    this.thumbCache.set(key, canvas);
    return canvas;
  }

  // --- internals ---

  /** Arrastre touch con umbral 44px: pointerdown → si supera el umbral se
   *  arrastra (la miniatura sigue al dedo con transform), pointerup sobre otra
   *  miniatura → store.reorder (relocate + indexAtPoint, ambos puros). */
  private bindReorder(thumbs: HTMLElement[]): void {
    this.boxes = thumbs.map((t) => {
      const r = t.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    for (let i = 0; i < thumbs.length; i++) {
      const t = thumbs[i]!;
      t.style.touchAction = 'none';
      let startX = 0;
      let startY = 0;
      let from = -1;
      let dragging = false;
      t.addEventListener('pointerdown', (e) => {
        const cl = (e.target as HTMLElement).classList;
        if (cl.contains('pg-del') || cl.contains('pg-cmp')) return;
        from = i;
        startX = e.clientX;
        startY = e.clientY;
        dragging = false;
        t.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      t.addEventListener('pointermove', (e) => {
        if (from === -1) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging) {
          if (!shouldStartDrag(dx, dy)) return;
          dragging = true;
          t.classList.add('pg-dragging');
        }
        t.style.transform = `translate(${dx}px, ${dy}px) scale(1.05)`;
      });
      const end = async (e?: PointerEvent): Promise<void> => {
        if (from === -1) return;
        const wasDrag = dragging;
        t.classList.remove('pg-dragging');
        t.style.transform = '';
        if (wasDrag && e !== undefined) {
          const to = indexAtPoint(e.clientX, e.clientY, this.boxes);
          if (to !== -1 && to !== from) {
            const ids = this.pages.map((p) => p.id);
            const next = relocate(ids, from, to);
            // Aplica el orden y persiste (un solo mensaje al store: reorder
            // del origen + aquí la secuencia completa vía store.reorder).
            await this.applyOrder(next);
          }
        }
        from = -1;
        dragging = false;
      };
      t.addEventListener('pointerup', (e) => {
        void end(e);
      });
      t.addEventListener('pointercancel', () => {
        void end();
      });
    }
  }

  /** Aplica una secuencia de ids a la cola persistida (reorder al índice de
   *  cada página según la secuencia) y re-renderiza. */
  private async applyOrder(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
      await this.store.reorder(ids[i]!, i);
    }
    await this.render();
  }
}

/** Export por defecto: descarga vía <a download>. El harness puede inyectar
navigator.share en su lugar (share en iOS, download en desktop). */
async function defaultExport(doc: Document, pdf: Blob, _pageSize: PdfPageSize): Promise<void> {
  const a = doc.createElement('a');
  a.href = URL.createObjectURL(pdf);
  a.download = `scanner-${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}