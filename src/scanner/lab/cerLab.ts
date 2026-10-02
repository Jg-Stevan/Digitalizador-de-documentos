// src/scanner/lab/cerLab.ts — Laboratorio CER (RONDA 4 §R4-C + §R4-D2/D3).
// Port del harness f5device (sección CER) + mejoras de la Ronda 4:
//
// QUÉ MIDE: por cada zona de la página (impresa/manuscrita) y cada variante
// de enhance activa → enhance con el worker REAL (mismo bundle de producción,
// instancia propia) → OCR (Tesseract.js v5, spa+eng) → CER contra la
// referencia de la zona (OCR de la banda original, o texto manual exacto).
//
// R4-C — protocolo CER arreglado (el corazón de esta tarea):
// - C2: la zona impresa recorta x∈[0.06,0.94] para EXCLUIR los textos
//   verticales de borde; la guía de referencia viaja en el placeholder.
// - C1: tras computar TODAS las hipótesis de una zona, si
//   refChars < 0.8 × mediana(hypChars de las variantes) → warning visible
//   por zona y TODAS sus filas se marcan invalid (CER gris/tachado + badge,
//   fuera del ranking). El CER>1 de la sesión histórica (ref 178 chars vs
//   hipótesis 385-415) queda detectado por construcción.
//
// R4-A4/A2b — grupo de variantes "bw": B/N adaptativo (Bradley-Roth default)
// + tunings de T/ventana + Sauvola (k 0.34 default, variantes k02/k05).
// R4-D2/D3 — grupo "flat-field": normalización de iluminación opt-in por
// variante (gray-ff/text-ff/color-ff/bw-ff). El modo natural NUNCA la lleva
// (referencia visual — garantizado en el worker).
//
// UI: DOM vanilla dentro de #cerMount (hereda .mscan de scanner.css + un
// <style> propio del laboratorio). Fuente: evento 'mscan:source' (captura
// aceptada) o <input type="file"> (probar sin cámara).

import { DETECTION_WORKER_URL } from '../app/workerUrl';
import type { EnhanceMode } from '../core/types';
import type { EnhanceOpts } from '../workers/enhanceJs';
import type { EnhanceRequest, EnhanceResult, WorkerOut } from '../workers/protocol';

export interface CerLabHandles {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Zonas y variantes
// ---------------------------------------------------------------------------

/** [M4b + R4-C2] Zonas del CER partido (impresa = encabezado superior,
 *  manuscrita = resto). La impresa recorta x∈[0.06,0.94] para EXCLUIR los
 *  textos verticales de borde (guía C2 del plan RONDA 4). */
export interface CerZone {
  id: string;
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

export const CER_ZONES: readonly CerZone[] = [
  { id: 'impresa', y0: 0, y1: 0.4, x0: 0.06, x1: 0.94 },
  { id: 'manuscrita', y0: 0.4, y1: 1, x0: 0, x1: 1 },
];

/** Grupo de variantes — toggle por grupo para acortar sesiones. */
export type CerGroup = 'base' | 'bw' | 'ff';

export interface CerVariant {
  id: string;
  mode: EnhanceMode;
  opts?: EnhanceOpts;
  group: CerGroup;
}

/** [M4b base + R4-A4/A2b bw + R4-D2 ff] Tabla de variantes del laboratorio. */
export const CER_VARIANTS: readonly CerVariant[] = [
  // base (M4b — las 6 históricas, números comparables con sesiones previas)
  { id: 'color', mode: 'color', group: 'base' },
  { id: 'gray', mode: 'gray', group: 'base' },
  { id: 'gray-p95', mode: 'gray', opts: { grayWhitePct: 0.95 }, group: 'base' },
  { id: 'natural', mode: 'natural', group: 'base' },
  { id: 'text', mode: 'text', group: 'base' },
  { id: 'text-sin-bp', mode: 'text', opts: { textBlackPoint: 0 }, group: 'base' },
  // bw (R4-A: B/N adaptativo con umbral local; default Bradley-Roth,
  // variante Sauvola A2b — compiten por datos en la misma sesión)
  { id: 'bw', mode: 'bw', group: 'bw' },
  { id: 'bw-t12', mode: 'bw', opts: { bwT: 0.12 }, group: 'bw' },
  { id: 'bw-t20', mode: 'bw', opts: { bwT: 0.2 }, group: 'bw' },
  { id: 'bw-s16', mode: 'bw', opts: { bwWindowRatio: 1 / 16 }, group: 'bw' },
  { id: 'bw-s8', mode: 'bw', opts: { bwWindowRatio: 1 / 8 }, group: 'bw' },
  { id: 'bw-sauvola', mode: 'bw', opts: { bwMethod: 'sauvola' }, group: 'bw' },
  { id: 'bw-sauvola-k02', mode: 'bw', opts: { bwMethod: 'sauvola', bwSauvolaK: 0.2 }, group: 'bw' },
  { id: 'bw-sauvola-k05', mode: 'bw', opts: { bwMethod: 'sauvola', bwSauvolaK: 0.5 }, group: 'bw' },
  // flat-field (R4-D2: normalización de iluminación ANTES del modo, opt-in;
  // el combo máximo bw-ff = flat-field + umbral local; natural NUNCA)
  { id: 'gray-ff', mode: 'gray', opts: { flatField: true }, group: 'ff' },
  { id: 'text-ff', mode: 'text', opts: { flatField: true }, group: 'ff' },
  { id: 'color-ff', mode: 'color', opts: { flatField: true }, group: 'ff' },
  { id: 'bw-ff', mode: 'bw', opts: { flatField: true }, group: 'ff' },
];

// ---------------------------------------------------------------------------
// Matemática del CER (port verbatim del harness f5 — comparabilidad)
// ---------------------------------------------------------------------------

/** Normalización OCR: lowercase NFD sin diacríticos, solo [a-z0-9]. */
export function normalizeOcr(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Distancia de edición O(n·m) con una sola fila (port del harness). */
export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** CER = levenshtein(ref, hyp) / |ref| — 1 si la referencia es vacía. */
export function cerOf(reference: string, hypothesis: string): number {
  const ref = normalizeOcr(reference);
  const hyp = normalizeOcr(hypothesis);
  return ref.length ? levenshtein(ref, hyp) / ref.length : 1;
}

/** Mediana inferior (n par → elemento n/2−1, determinista como el proyecto). */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1]!;
}

/** [R4-C1] ¿La referencia cubre el texto completo de la zona?
 *  refChars < 0.8 × mediana(hypChars de las variantes) → inválida. */
export function referenceIncomplete(refChars: number, hypChars: number[]): boolean {
  return refChars < 0.8 * medianOf(hypChars);
}

// ---------------------------------------------------------------------------
// Tesseract.js v5 (CDN, mismo loader del harness f5)
// ---------------------------------------------------------------------------

interface TesseractLoggerMsg {
  status: string;
  progress: number;
}

interface TesseractLike {
  recognize(
    image: Blob,
    langs: string,
    options: { logger?: (m: TesseractLoggerMsg) => void },
  ): Promise<{ data: { text: string } }>;
}

let tesseractPromise: Promise<TesseractLike> | null = null;

/** Carga Tesseract.js v5 desde CDN (una sola vez por página). Si el CDN
 *  falla → error claro; se reintenta en la próxima sesión. */
function loadTesseract(doc: Document, win: Window): Promise<TesseractLike> {
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise<TesseractLike>((resolve, reject) => {
    const existing = (win as unknown as { Tesseract?: TesseractLike }).Tesseract;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = doc.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = () => {
      const T = (win as unknown as { Tesseract?: TesseractLike }).Tesseract;
      if (T) resolve(T);
      else reject(new Error('Tesseract CDN cargó sin API'));
    };
    script.onerror = () => {
      tesseractPromise = null; // permite reintentar en la próxima sesión
      reject(new Error('Tesseract CDN no cargó (sin red o CDN bloqueado)'));
    };
    doc.head.appendChild(script);
  });
  return tesseractPromise;
}

// ---------------------------------------------------------------------------
// Tipos de resultado (JSON descargable + render)
// ---------------------------------------------------------------------------

export interface CerRow {
  variant: string;
  zone: string;
  /** CER normalizado (0 = perfecto). null = esta variante falló (error). */
  cer: number | null;
  blobBytes: number | null;
  /** [M4a] re-encode JPEG q0.9 de los MISMOS píxeles (solo PNG). */
  jpegBytes: number | null;
  referenceChars: number;
  hypothesisChars: number;
  text: string;
  /** [R4-C1] fila invalidada por referencia incompleta de SU zona. */
  invalid: boolean;
  /** Fallo de enhance/OCR de ESTA variante (la sesión sigue con las demás). */
  error?: string;
}

export interface CerResultJson {
  ts: number;
  source: 'capture' | 'file';
  zones: CerZone[];
  variants: string[];
  manualRefs: Record<string, string>;
  rows: CerRow[];
}

// ---------------------------------------------------------------------------
// Utilidades de imagen (port del harness, con recorte X para C2)
// ---------------------------------------------------------------------------

/** Ancho máximo de la miniatura de cada fila. */
const CER_THUMB_W = 96;

const sleep = (win: Window, ms: number): Promise<void> =>
  new Promise((resolve) => {
    win.setTimeout(resolve, ms);
  });

/** Recorta la banda [y0,y1]×[x0,x1] (fracciones) de un blob → PNG.
 *  C2: x0/x1 excluyen los textos verticales de borde en la zona impresa. */
async function cropBand(
  win: Window,
  doc: Document,
  blob: Blob,
  y0Frac: number,
  y1Frac: number,
  x0Frac = 0,
  x1Frac = 1,
): Promise<Blob> {
  const bitmap = await win.createImageBitmap(blob);
  try {
    const x0 = Math.max(0, Math.floor(bitmap.width * x0Frac));
    const x1 = Math.min(bitmap.width, Math.ceil(bitmap.width * x1Frac));
    const y0 = Math.max(0, Math.floor(bitmap.height * y0Frac));
    const y1 = Math.min(bitmap.height, Math.ceil(bitmap.height * y1Frac));
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const canvas = doc.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('cropBand: contexto 2d null');
    ctx.drawImage(bitmap, x0, y0, w, h, 0, 0, w, h);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (out === null) throw new Error('cropBand: toBlob null');
    return out;
  } finally {
    bitmap.close();
  }
}

/** [M4a] Bytes del JPEG q0.9 de los MISMOS píxeles (solo tiene sentido
 *  compararlo cuando el encode del modo es PNG). */
async function jpegSizeOf(win: Window, doc: Document, blob: Blob): Promise<number | null> {
  const bitmap = await win.createImageBitmap(blob);
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(bitmap, 0, 0);
    const jpeg = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    return jpeg ? jpeg.size : null;
  } finally {
    bitmap.close();
  }
}

/** Miniatura (canvas ≤96px de ancho) del blob enhanceado. El clic lo abre
 *  en pestaña nueva vía blob URL (el link lo añade el render). */
async function thumbnailCanvas(
  win: Window,
  doc: Document,
  blob: Blob,
): Promise<HTMLCanvasElement> {
  const bitmap = await win.createImageBitmap(blob);
  try {
    const scale = Math.min(1, CER_THUMB_W / bitmap.width);
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.className = 'cer-thumb';
    const ctx = canvas.getContext('2d');
    if (ctx !== null) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Montaje del panel
// ---------------------------------------------------------------------------

const CER_CSS = `
.cerlab .cer-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0; }
.cerlab .cer-chip { background: #222; border-radius: 6px; padding: 7px; font-size: 12px; }
.cerlab .cer-chip-err { color: #f87171; font-weight: 700; }
.cerlab .cer-status { min-height: 20px; margin: 8px 0; font-size: 12px; }
.cerlab .cer-status.cer-err { color: #f87171; font-weight: 700; }
.cerlab .cer-warn { color: #fbbf24; font-size: 12px; font-weight: 600; margin: 6px 0 0 0; }
.cerlab .cer-warn[hidden] { display: none; }
.cerlab .cer-zones { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; margin: 8px 0; }
.cerlab .cer-zone { background: #181818; border: 1px solid #444; border-radius: 6px; padding: 8px; }
.cerlab .cer-zone label { display: block; font-size: 12px; color: #9ca3af; margin-bottom: 4px; }
.cerlab .cer-zone textarea { width: 100%; box-sizing: border-box; min-height: 84px; background: #111; color: #ddd; border: 1px solid #555; border-radius: 6px; padding: 8px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.cerlab .cer-zone textarea:focus-visible { outline: 3px solid #38bdf8; outline-offset: 2px; }
.cerlab .cer-tablewrap { overflow-x: auto; margin: 8px 0; }
.cerlab tr.cer-invalid { opacity: 0.55; }
.cerlab tr.cer-invalid td.cer-cer { text-decoration: line-through; color: #9ca3af; }
.cerlab .cer-badge-invalid { display: inline-block; background: #fbbf24; color: #3a2a00; font-size: 10px; font-weight: 700; border-radius: 4px; padding: 1px 5px; margin-left: 5px; text-decoration: none; }
.cerlab .cer-cer-err { color: #f87171; }
.cerlab .cer-thumb { border: 1px solid #555; display: block; width: 96px; height: auto; background: #000; }
.cerlab a.cer-thumb-link { display: inline-block; }
.cerlab .cer-rank { margin: 8px 0; font-size: 12px; }
.cerlab .cer-rank[hidden] { display: none; }
.cerlab .cer-rank ol { margin: 4px 0 0 18px; padding: 0; }
.cerlab .cer-note { color: #9ca3af; font-size: 12px; margin: 8px 0 0 0; }
`;

interface CerSource {
  blob: Blob;
  kind: 'capture' | 'file';
  w: number;
  h: number;
}

/** Datos de render de una fila (el canvas/URL no viajan en el JSON). */
interface RowRender {
  row: CerRow;
  thumb: HTMLCanvasElement | null;
  url: string | null;
}

export function mountCerLab(doc: Document, win: Window): CerLabHandles {
  const root = doc.getElementById('cerMount');
  if (root === null) return { dispose(): void {} };

  // --- DOM del panel (vanilla, clases .mscan globales + estilo propio) ---
  root.textContent = '';
  const style = doc.createElement('style');
  style.textContent = CER_CSS;
  root.appendChild(style);

  const panel = doc.createElement('div');
  panel.className = 'cerlab';
  root.appendChild(panel);

  const workerChip = doc.createElement('span');
  workerChip.className = 'cer-chip';
  const sourceChip = doc.createElement('span');
  sourceChip.className = 'cer-chip';
  sourceChip.textContent = 'Fuente: sin fuente — captura una página o carga una imagen';
  const chips = doc.createElement('div');
  chips.className = 'cer-chips';
  chips.append(workerChip, sourceChip);
  panel.appendChild(chips);

  const setWorkerChip = (text: string, isError = false): void => {
    workerChip.textContent = `Worker: ${text}`;
    workerChip.classList.toggle('cer-chip-err', isError);
  };
  setWorkerChip('cargando OpenCV…');

  const runBtn = doc.createElement('button');
  runBtn.type = 'button';
  runBtn.textContent = 'Calibrar fuente actual';
  runBtn.disabled = true;
  const jsonBtn = doc.createElement('button');
  jsonBtn.type = 'button';
  jsonBtn.textContent = 'Descargar JSON';
  jsonBtn.disabled = true;
  const fileLabel = doc.createElement('label');
  fileLabel.textContent = 'Cargar imagen… ';
  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.setAttribute('aria-label', 'Cargar imagen para calibrar sin cámara');
  fileLabel.appendChild(fileInput);
  const btnRow = doc.createElement('div');
  btnRow.className = 'row';
  btnRow.append(runBtn, jsonBtn, fileLabel);
  panel.appendChild(btnRow);

  // --- Toggles de grupos de variantes (acortar sesiones) ---
  const groupOn: Record<CerGroup, boolean> = { base: true, bw: true, ff: true };
  const groupChecks: HTMLInputElement[] = [];
  const groupDefs: { key: CerGroup; label: string }[] = [
    { key: 'base', label: 'Base (color, gris, texto)' },
    { key: 'bw', label: 'B/N adaptativo (umbral local + Sauvola)' },
    { key: 'ff', label: 'Flat-field (normalización de iluminación)' },
  ];
  const groupsRow = doc.createElement('div');
  groupsRow.className = 'row';
  for (const def of groupDefs) {
    const label = doc.createElement('label');
    label.className = 'sw';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.addEventListener('change', () => {
      groupOn[def.key] = input.checked;
    });
    label.append(input, doc.createTextNode(def.label));
    groupChecks.push(input);
    groupsRow.appendChild(label);
  }
  panel.appendChild(groupsRow);

  // --- Referencias manuales por zona (C1/C2) ---
  const refEls: Record<string, HTMLTextAreaElement> = {};
  const warnEls: Record<string, HTMLDivElement> = {};
  const placeholders: Record<string, string> = {
    impresa:
      'Texto EXACTO y COMPLETO de la zona (vacío = OCR del original). ' +
      'Impresa: todo el encabezado hasta y=0.4; excluye los textos verticales de borde.',
    manuscrita:
      'Texto EXACTO y COMPLETO de la zona (vacío = OCR del original). ' +
      'Manuscrita: todo el texto desde y=0.4 hasta el final de la página.',
  };
  const zoneBoxes = doc.createElement('div');
  zoneBoxes.className = 'cer-zones';
  for (const zone of CER_ZONES) {
    const box = doc.createElement('div');
    box.className = 'cer-zone';
    const label = doc.createElement('label');
    label.htmlFor = `cerRef-${zone.id}`;
    const cropNote =
      zone.x0 > 0 || zone.x1 < 1 ? ` · x ${zone.x0}–${zone.x1} (sin bordes)` : '';
    label.textContent = `Referencia manual ${zone.id} (y ${zone.y0}–${zone.y1}${cropNote}):`;
    const ta = doc.createElement('textarea');
    ta.id = `cerRef-${zone.id}`;
    ta.rows = 4;
    ta.spellcheck = false;
    ta.placeholder = placeholders[zone.id] ?? '';
    const warn = doc.createElement('div');
    warn.className = 'cer-warn';
    warn.hidden = true;
    box.append(label, ta, warn);
    refEls[zone.id] = ta;
    warnEls[zone.id] = warn;
    zoneBoxes.appendChild(box);
  }
  panel.appendChild(zoneBoxes);

  // --- Tabla de resultados ---
  const tableWrap = doc.createElement('div');
  tableWrap.className = 'cer-tablewrap';
  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const h of [
    'Variante',
    'Zona',
    'CER',
    'Bytes',
    'JPEG q0.9',
    'Ref/hip',
    'Miniatura',
    'Texto',
  ]) {
    const th = doc.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const cerBody = doc.createElement('tbody');
  table.append(thead, cerBody);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  const statusEl = doc.createElement('div');
  statusEl.className = 'cer-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.textContent = 'Sin calibrar todavía.';
  panel.appendChild(statusEl);

  const rankEl = doc.createElement('div');
  rankEl.className = 'cer-rank';
  rankEl.hidden = true;
  const rankTitle = doc.createElement('strong');
  rankTitle.textContent = 'Ranking CER manuscrito (solo filas válidas, ascendente):';
  const rankList = doc.createElement('ol');
  rankEl.append(rankTitle, rankList);
  panel.appendChild(rankEl);

  const note = doc.createElement('p');
  note.className = 'cer-note';
  note.textContent =
    'Referencia por defecto = OCR de la banda original (metodología M4b). ' +
    'El CER es válido solo si la referencia cubre el texto completo de la zona — ' +
    'el warning C1 lo detecta.';
  panel.appendChild(note);

  // --- Estado ---
  let disposed = false;
  let running = false;
  let worker: Worker | null = null;
  let workerReady = false;
  let source: CerSource | null = null;
  let lastResult: CerResultJson | null = null;
  let bootTimer = 0;
  const blobUrls: string[] = [];

  const setStatus = (text: string, isError = false): void => {
    statusEl.textContent = text;
    statusEl.classList.toggle('cer-err', isError);
  };

  const trackUrl = (url: string): string => {
    blobUrls.push(url);
    return url;
  };

  const updateRunButton = (): void => {
    runBtn.disabled = running || !workerReady || source === null;
  };

  const setBusy = (busy: boolean): void => {
    runBtn.disabled = busy || !workerReady || source === null;
    jsonBtn.disabled = busy || lastResult === null;
    fileInput.disabled = busy;
    for (const cb of groupChecks) cb.disabled = busy;
    for (const zone of CER_ZONES) refEls[zone.id]!.disabled = busy;
  };

  // --- Fuente: evento 'mscan:source' (captura) o file input ---
  const setSource = (blob: Blob, kind: 'capture' | 'file'): void => {
    source = { blob, kind, w: 0, h: 0 };
    const kindLabel = kind === 'capture' ? 'captura' : 'archivo';
    sourceChip.textContent = `Fuente: lista (${kindLabel}) — midiendo…`;
    updateRunButton();
    void (async () => {
      const s = source;
      if (s === null) return;
      let w = 0;
      let h = 0;
      try {
        const bmp = await win.createImageBitmap(blob);
        w = bmp.width;
        h = bmp.height;
        bmp.close();
      } catch {
        /* dims desconocidas — el label queda sin WxH */
      }
      if (source !== s) return; // llegó otra fuente mientras medíamos
      source = { blob: s.blob, kind: s.kind, w, h };
      sourceChip.textContent =
        h > 0
          ? `Fuente: lista ${w}×${h} (${kindLabel})`
          : `Fuente: lista (${kindLabel})`;
      updateRunButton();
    })();
  };

  const onSourceEvent = (ev: Event): void => {
    const detail = (ev as CustomEvent<Blob>).detail;
    if (detail instanceof Blob) setSource(detail, 'capture');
  };
  doc.addEventListener('mscan:source', onSourceEvent);

  fileInput.addEventListener('change', () => {
    const file = fileInput.files !== null && fileInput.files.length > 0 ? fileInput.files[0]! : null;
    if (file !== null) setSource(file, 'file');
    fileInput.value = ''; // permite recargar el MISMO archivo
  });

  // Fuente que ya existía al montar (captura previa al montaje del panel).
  const appHandles = (win as unknown as { __app?: { getSourceBlob?: () => Blob | null } }).__app;
  const existingBlob = appHandles?.getSourceBlob?.();
  if (existingBlob != null) setSource(existingBlob, 'capture');

  // --- Worker propio del laboratorio (enhance real, protocolo de protocol.ts) ---
  let tsSeq = 0;
  type EnhanceReply = EnhanceResult | 'busy' | null;
  const pendingEnhance = new Map<number, (value: EnhanceReply) => void>();

  const postEnhance = (req: EnhanceRequest, transfer: ImageBitmap[]): Promise<EnhanceReply> =>
    new Promise<EnhanceReply>((resolve) => {
      const w = worker;
      if (w === null || disposed) {
        resolve(null);
        return;
      }
      const timer = win.setTimeout(() => {
        pendingEnhance.delete(req.ts);
        resolve(null);
      }, 30000);
      pendingEnhance.set(req.ts, (value) => {
        win.clearTimeout(timer);
        resolve(value);
      });
      w.postMessage(req, transfer);
    });

  /** Enhance por el worker real. 'busy' → reintenta ≤3 veces con backoff
   *  150ms (bitmap NUEVO por intento: el transferable queda del worker). */
  const MAX_BUSY_RETRIES = 3;
  const BUSY_BACKOFF_MS = 150;
  const enhanceBlob = async (
    blob: Blob,
    mode: EnhanceMode,
    opts?: EnhanceOpts,
  ): Promise<{ blob: Blob; mime: 'image/jpeg' | 'image/png' } | null> => {
    for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt++) {
      const bitmap = await win.createImageBitmap(blob);
      const req: EnhanceRequest = { type: 'enhance', bitmap, mode, ts: ++tsSeq };
      if (opts) req.opts = opts;
      const reply = await postEnhance(req, [bitmap]);
      if (reply === null) return null;
      if (reply === 'busy') {
        if (attempt === MAX_BUSY_RETRIES) return null;
        setStatus(`Worker ocupado — reintentando (${attempt + 1}/${MAX_BUSY_RETRIES})…`);
        await sleep(win, BUSY_BACKOFF_MS);
        continue;
      }
      return { blob: reply.blob, mime: reply.mime };
    }
    return null;
  };

  try {
    worker = new Worker(DETECTION_WORKER_URL);
  } catch (e) {
    setWorkerChip(`no se pudo crear (${e instanceof Error ? e.message : String(e)})`, true);
  }

  // 'ready' (timeout 90s) habilita los botones; un error temprano lo deja
  // visible en rojo sin romper el panel. Un 'ready' tardío igual habilita.
  bootTimer = win.setTimeout(() => {
    if (!workerReady) setWorkerChip('timeout (90s) — OpenCV no cargó', true);
  }, 90000);

  if (worker !== null) {
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as WorkerOut | null;
      if (msg === null || typeof msg !== 'object') return;
      if (msg.type === 'boot') {
        setWorkerChip(`OpenCV cargando… ${msg.pct}%`);
        return;
      }
      if (msg.type === 'ready') {
        workerReady = true;
        win.clearTimeout(bootTimer);
        setWorkerChip('listo');
        updateRunButton();
        return;
      }
      if (msg.type === 'enhanced') {
        const settle = pendingEnhance.get(msg.ts);
        if (settle) {
          pendingEnhance.delete(msg.ts);
          settle(msg);
        }
        return;
      }
      if (msg.type === 'busy') {
        const settle = pendingEnhance.get(msg.ts);
        if (settle) {
          pendingEnhance.delete(msg.ts);
          settle('busy');
        }
        return;
      }
      if (msg.type === 'error') {
        const message = String(msg.message ?? 'desconocido');
        setWorkerChip(workerReady ? `error: ${message}` : message, true);
        if (!workerReady) win.clearTimeout(bootTimer);
        for (const settle of pendingEnhance.values()) settle(null);
        pendingEnhance.clear();
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      setWorkerChip(`error de worker: ${ev.message || 'desconocido'}`, true);
    };
  }

  // --- OCR (Tesseract.js v5, spa+eng) con progreso en la línea de estado ---
  const recognize = async (blob: Blob, label: string): Promise<string> => {
    const T = await loadTesseract(doc, win);
    setStatus(`OCR ${label}…`);
    const result = await T.recognize(blob, 'spa+eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          setStatus(`OCR ${label}: ${Math.round(m.progress * 100)}%`);
        }
      },
    });
    return result.data.text;
  };

  // --- Render de filas / ranking ---
  const renderRow = (render: RowRender): void => {
    const { row, thumb, url } = render;
    const tr = doc.createElement('tr');
    if (row.invalid) tr.className = 'cer-invalid';
    const td = (value: string): HTMLTableCellElement => {
      const cell = doc.createElement('td');
      cell.textContent = value;
      return cell;
    };
    tr.appendChild(td(row.variant));
    tr.appendChild(td(row.zone));
    const cerCell = doc.createElement('td');
    cerCell.className = 'cer-cer';
    if (row.cer === null) {
      cerCell.textContent = 'error';
      cerCell.title = row.error ?? 'fallo de enhance/OCR';
      cerCell.classList.add('cer-cer-err');
    } else {
      cerCell.textContent = `${(row.cer * 100).toFixed(2)}%`;
      if (row.invalid) {
        const badge = doc.createElement('span');
        badge.className = 'cer-badge-invalid';
        badge.textContent = 'inválida';
        cerCell.appendChild(badge);
      }
    }
    tr.appendChild(cerCell);
    tr.appendChild(td(row.blobBytes === null ? '—' : String(row.blobBytes)));
    tr.appendChild(td(row.jpegBytes === null ? '—' : String(row.jpegBytes)));
    tr.appendChild(td(`${row.referenceChars}/${row.hypothesisChars}`));
    const thumbCell = doc.createElement('td');
    if (thumb !== null && url !== null) {
      const link = doc.createElement('a');
      link.className = 'cer-thumb-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Abrir la imagen completa en una pestaña nueva';
      link.appendChild(thumb);
      thumbCell.appendChild(link);
    } else {
      thumbCell.textContent = '—';
    }
    tr.appendChild(thumbCell);
    tr.appendChild(td(row.text.slice(0, 180)));
    cerBody.appendChild(tr);
  };

  /** Bonus honesto: ranking CER manuscrito ascendente (top 5), solo filas
   *  válidas — la métrica que el plan considera comparable. */
  const renderRanking = (rows: CerRow[]): void => {
    const valid = rows.filter(
      (r) => r.zone === 'manuscrita' && r.cer !== null && !r.invalid && r.error === undefined,
    );
    rankList.textContent = '';
    if (valid.length === 0) {
      rankEl.hidden = true;
      return;
    }
    valid.sort((a, b) => (a.cer as number) - (b.cer as number));
    for (const r of valid.slice(0, 5)) {
      const li = doc.createElement('li');
      const cer = r.cer as number;
      li.textContent = `${r.variant} — CER ${(cer * 100).toFixed(2)}% (${r.hypothesisChars} chars de hipótesis)`;
      rankList.appendChild(li);
    }
    rankEl.hidden = false;
  };

  // --- Sesión de calibración (runCer port del harness + C1) ---
  const runCer = async (): Promise<void> => {
    if (running) return;
    if (worker === null || !workerReady) {
      setStatus('El worker no está listo (OpenCV cargando o falló)', true);
      return;
    }
    if (source === null) {
      setStatus('Sin fuente — captura una página o carga una imagen', true);
      return;
    }
    const active = CER_VARIANTS.filter((v) => groupOn[v.group]);
    if (active.length === 0) {
      setStatus('Activa al menos un grupo de variantes', true);
      return;
    }

    // M4b: la fuente se CONGELA al iniciar (el auto-shutter podría
    // recapturar a mitad de la tabla y mezclar fuentes entre referencia y
    // variantes).
    const src = source;
    running = true;
    setBusy(true);
    cerBody.textContent = '';
    rankEl.hidden = true;
    for (const zone of CER_ZONES) warnEls[zone.id]!.hidden = true;
    const rows: CerRow[] = [];
    const manualRefs: Record<string, string> = {};
    try {
      for (const zone of CER_ZONES) {
        const rawRef = refEls[zone.id]!.value;
        manualRefs[zone.id] = rawRef;
        // Referencia efectiva: manual (si no vacía) u OCR de la banda ORIGINAL.
        let reference: string;
        if (rawRef.trim() !== '') {
          reference = rawRef;
          setStatus(`Referencia manual ${zone.id} (${rawRef.length} chars)`);
        } else {
          setStatus(`Recortando banda original ${zone.id}…`);
          const refBand = await cropBand(win, doc, src.blob, zone.y0, zone.y1, zone.x0, zone.x1);
          reference = await recognize(refBand, `ref-${zone.id}`);
        }
        const refNorm = normalizeOcr(reference);
        const zoneRows: CerRow[] = [];
        const zoneRender: RowRender[] = [];

        for (const variant of active) {
          setStatus(`Enhance ${variant.id}+${zone.id}…`);
          let render: RowRender;
          try {
            const enhanced = await enhanceBlob(src.blob, variant.mode, variant.opts);
            if (enhanced === null) {
              throw new Error(`enhance ${variant.id} falló (worker ocupado o error)`);
            }
            // Miniatura + URL ANTES del crop: se trabaja desde enhanced.blob
            // (mismos píxeles que exportaría la cola de producción).
            const url = trackUrl(URL.createObjectURL(enhanced.blob));
            const thumb = await thumbnailCanvas(win, doc, enhanced.blob);
            const band = await cropBand(
              win,
              doc,
              enhanced.blob,
              zone.y0,
              zone.y1,
              zone.x0,
              zone.x1,
            );
            const text = await recognize(band, `${variant.id}+${zone.id}`);
            const hypNorm = normalizeOcr(text);
            let jpegBytes: number | null = null;
            if (enhanced.mime === 'image/png') {
              jpegBytes = await jpegSizeOf(win, doc, enhanced.blob);
            }
            const row: CerRow = {
              variant: variant.id,
              zone: zone.id,
              cer: cerOf(reference, text),
              blobBytes: enhanced.blob.size,
              jpegBytes,
              referenceChars: refNorm.length,
              hypothesisChars: hypNorm.length,
              text,
              invalid: false,
            };
            render = { row, thumb, url };
          } catch (e) {
            // Fallo de ESTA variante → fila de error y la sesión SIGUE
            // (otro agente compila los opts nuevos; el panel no se rompe).
            const message = e instanceof Error ? e.message : String(e);
            setStatus(`⚠ ${variant.id}+${zone.id}: ${message}`, true);
            render = {
              row: {
                variant: variant.id,
                zone: zone.id,
                cer: null,
                blobBytes: null,
                jpegBytes: null,
                referenceChars: refNorm.length,
                hypothesisChars: 0,
                text: '',
                invalid: false,
                error: message,
              },
              thumb: null,
              url: null,
            };
          }
          zoneRows.push(render.row);
          zoneRender.push(render);
        }

        // [R4-C1] Validación de la referencia DESPUÉS de todas las
        // hipótesis de la zona: refChars < 0.8×mediana(hypChars) → todas
        // las filas de la zona quedan invalid (no entran al ranking).
        const hypChars = zoneRows.map((r) => r.hypothesisChars);
        if (referenceIncomplete(refNorm.length, hypChars)) {
          for (const r of zoneRows) r.invalid = true;
          const warn = warnEls[zone.id]!;
          warn.textContent =
            `⚠ Referencia incompleta para esta zona (ref ${refNorm.length} chars ` +
            `< 0.8×mediana ${medianOf(hypChars)}) — filas marcadas inválidas, ` +
            'NO entran al ranking';
          warn.hidden = false;
        }
        for (const r of zoneRender) renderRow(r);
        rows.push(...zoneRows);
      }

      lastResult = {
        ts: Date.now(),
        source: src.kind,
        zones: [...CER_ZONES],
        variants: active.map((v) => v.id),
        manualRefs,
        rows,
      };
      (win as unknown as Record<string, unknown>).__cerDone = true; // convención E2E
      jsonBtn.disabled = false;
      const validCount = rows.filter((r) => !r.invalid && r.cer !== null).length;
      setStatus(`CER completado — ${rows.length} filas (${validCount} válidas).`);
    } catch (e) {
      // Fallo fatal (OCR/CDN, banda de referencia): estado rojo, botones
      // vuelven — el panel nunca se rompe.
      setStatus(`CER: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      running = false;
      setBusy(false);
      renderRanking(rows);
    }
  };

  runBtn.addEventListener('click', () => {
    void runCer();
  });

  // --- Descarga JSON (estructura del harness f5 + invalid/error) ---
  const downloadJson = (): void => {
    if (lastResult === null) return;
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `f5-cer-${Date.now()}.json`;
    a.click();
    win.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  jsonBtn.addEventListener('click', downloadJson);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    win.clearTimeout(bootTimer);
    try {
      worker?.terminate();
    } catch {
      /* ya muerto */
    }
    worker = null;
    doc.removeEventListener('mscan:source', onSourceEvent);
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls.length = 0;
  };

  return { dispose };
}
