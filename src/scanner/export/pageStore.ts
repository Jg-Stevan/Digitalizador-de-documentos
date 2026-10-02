// src/export/pageStore.ts — almacén multipágina (§5-F5). MÓDULO DOM/IndexedDB:
// tupla {id, blob (BLob ENCODE: jpeg q90 o png), mode, order, ts}. El orden de
// páginas es un índice numérico explícito (reorder = swap de índices, ver
// pureReorder en src/ui/PageGallery.ts — la lógica pura ahí, el DOM aquí).
//
// iOS (skill ios-camera-quirks / §5-F5): IndexedDB se purga en PWAs poco
// usadas → persist() al abrir y aviso de cuota (reutiliza quotaReport de
// src/core/dataCollect.ts, QUOTA_WARN_FRACTION >70%). API mínima del plan:
// addPage/reorder/remove/pages/count/clear/exportPdf (exportPdf delega en
// pdfExport.ts, que es puro allí y DOM solo para el share aquí).

import { quotaReport, type QuotaReport } from '../core/dataCollect';
import { normalizeEnhanceMode } from '../core/imageModes';
import type { PdfPageSize } from './pdfExport';
import type { EnhanceMode } from '../core/types';

/** Meta <8MB del PDF multipágina (§F5 DoD: "PDF < 3MB" según páginas; la cota
 *  física del plan es 8MB — ver PLAN_MAESTRO §5 límites, no es invento). */
export const PDF_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;

/** Umbral de aviso de cuota REUTILIZADO de dataCollect (no constante nueva:
 *  destino documentado del plan F5 "aviso de páginas sin exportar"). */
export { QUOTA_WARN_FRACTION } from '../core/dataCollect';

export interface PageRecord {
  id: string;
  blob: Blob;
  mode: EnhanceMode;
  order: number;
  ts: number;
}

export interface PageStoreOptions {
  makeId?: () => string;
  estimate?: () => Promise<{ usage: number; quota: number } | null>;
  /** Encoding local del PDF (inyectable; default pdfExport.fromPages).
   *  Recibe `pageSize` (M1) o el flag legacy `a4`. */
  encode?: (pages: PageRecord[], opts?: { a4?: boolean; pageSize?: PdfPageSize }) => Promise<Blob>;
  now?: () => number;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDB tx error'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB tx abort'));
  });
}

function reqAs<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB req error'));
  });
}

/** Abre (o crea) la base 'pages' de la cola multipágina. Idempotente. */
export function openPageDB(dbName = 'mobile-scanner-db', version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req: IDBOpenDBRequest = indexedDB.open(dbName, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pages')) {
        db.createObjectStore('pages', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('openPageDB failed'));
  });
}

/** Solidez del almacén en iOS: pide persistencia (skill ios-camera-quirks). */
export async function persistPageStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.storage?.persist === 'function') {
      return await navigator.storage.persist();
    }
  } catch {
    // sin persist (desktop/Node): no crítico
  }
  return false;
}

function defaultMakeId(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  } catch {
    // sin crypto: fallback temporal (basta unicidad local)
  }
  return `page-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class PageStore {
  private readonly makeId: () => string;
  private readonly estimate: NonNullable<PageStoreOptions['estimate']>;
  private readonly encode: NonNullable<PageStoreOptions['encode']>;

  constructor(
    private readonly idb: IDBDatabase,
    opts: PageStoreOptions,
  ) {
    this.makeId = opts.makeId ?? defaultMakeId;
    this.estimate = opts.estimate ?? defaultEstimate;
    // lazy import: pdfExport importa pdf-lib (grande); solo se carga al
    // exportar — el harness no paga el coste si nunca comparte.
    this.encode =
      opts.encode ??
      (async (pages, pdfOpts = {}) => (await import('./pdfExport')).fromPages(pages, pdfOpts));
  }

  /** Añade una página al final de la cola (order = max+1). */
  async addPage(blob: Blob, mode: EnhanceMode, now: number = Date.now()): Promise<PageRecord> {
    const pages = await this.pages();
    const order = pages.length > 0 ? Math.max(...pages.map((p) => p.order)) + 1 : 0;
    const rec: PageRecord = { id: this.makeId(), blob, mode, order, ts: now };
    const tx = this.idb.transaction('pages', 'readwrite');
    tx.objectStore('pages').put(rec);
    await txDone(tx);
    return rec;
  }

  /** Páginas en orden de cola. */
  async pages(): Promise<PageRecord[]> {
    const tx = this.idb.transaction('pages', 'readonly');
    const all = await reqAs<PageRecord[]>(tx.objectStore('pages').getAll());
    // [RONDA 4 A1, 2026-09-28] 'bw' vuelve a ser un modo VÁLIDO (B/N
    // adaptativo): normalizeEnhanceMode ya NO migra a 'text' — este port
    // Next.js arranca con IndexedDB VACÍA (no hay páginas legadas D-F5-c);
    // las páginas se persisten con el modo global vigente y recargan tal
    // cual. Desconocido sigue cayendo a 'color'.
    return all
      .sort((a, b) => a.order - b.order)
      .map((r) => ({ ...r, mode: normalizeEnhanceMode(r.mode) }));
  }

  async count(): Promise<number> {
    const tx = this.idb.transaction('pages', 'readonly');
    const n = await reqAs<number>(tx.objectStore('pages').count());
    return n ?? 0;
  }

  /** Reordena: mueve id a la posición destino (índice de cola). La lógica de
   *  índices es pura (relocate de PageGallery) — aquí solo persistencia. */
  async reorder(id: string, toIndex: number): Promise<void> {
    const pages = await this.pages();
    const from = pages.findIndex((p) => p.id === id);
    if (from === -1 || toIndex === from) return;
    const ordered = pages.map((p) => p.id);
    const [moved] = ordered.splice(from, 1);
    if (moved === undefined) return;
    const clamped = Math.max(0, Math.min(ordered.length, toIndex));
    ordered.splice(clamped, 0, moved);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const tx = this.idb.transaction('pages', 'readwrite');
    const store = tx.objectStore('pages');
    for (let i = 0; i < ordered.length; i++) {
      const rec = byId.get(ordered[i]!);
      if (rec !== undefined) store.put({ ...rec, order: i });
    }
    await txDone(tx);
  }

  async remove(id: string): Promise<void> {
    const tx = this.idb.transaction('pages', 'readwrite');
    tx.objectStore('pages').delete(id);
    await txDone(tx);
  }

  /** Exporta el PDF multipágina (M1: página adaptativa por defecto; papel
   *  fijo con `pageSize: 'letter'|'a4' o legacy `a4: true`). Avisa si no hay
   *  páginas (null). El share (navigator.share / download) lo hace PageGallery. */
  async exportPdf(
    opts: { a4?: boolean; pageSize?: PdfPageSize; pages?: PageRecord[] } = {},
  ): Promise<Blob | null> {
    const pages = opts.pages ?? (await this.pages());
    if (pages.length === 0) return null;
    return await this.encode(pages, opts);
  }

  /** Presupuesto de cuota (>70% → warn; el harness avisa + recuerda exportar). */
  async quota(): Promise<QuotaReport> {
    const e = await this.estimate();
    if (e === null) return { pct: null, warn: false };
    return quotaReport(e.usage, e.quota);
  }

  async clear(): Promise<void> {
    const tx = this.idb.transaction('pages', 'readwrite');
    tx.objectStore('pages').clear();
    await txDone(tx);
  }
}

const defaultEstimate = async (): Promise<{ usage: number; quota: number } | null> => {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
      return null;
    }
    const e = await navigator.storage.estimate();
    return e.usage !== undefined && e.quota !== undefined
      ? { usage: e.usage, quota: e.quota }
      : null;
  } catch {
    return null;
  }
};