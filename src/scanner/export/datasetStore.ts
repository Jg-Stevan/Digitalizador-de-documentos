// src/export/datasetStore.ts — almacén del dataset F6.5 (orden F4, punto 3).
// MÓDULO DOM/IndexedDB: fotos pedestal (downscale a 1600 lado largo → JPEG
// q85) + metadatos del registro (src/core/dataCollect.ts, puro) en la misma
// tupla; exportDataset() empaqueta manifest JSONL + JPEGs en ZIP vía fflate
// (dependencia APROBADA por humano 2026-09-24).
//
// iOS (skill ios-camera-quirks / §5-F5): IndexedDB se purga en PWAs poco
// usadas → el harness llama persist() al iniciar el colector y avisa cuota
// (quotaReport >70%). El opt-in del colector es SIEMPRE apagado por defecto
// (orden F4: "Opt-in explícito default OFF").

import { strToU8, zipSync } from 'fflate';

import {
  TRAINING_LONG_SIDE,
  entryFromCapture,
  quotaReport,
  toJsonl,
  trainingDims,
  type ConditionTag,
  type DatasetDeviceInfo,
  type DatasetEntry,
  type QuotaReport,
} from '../core/dataCollect';
import type { CapturedPhoto } from '../scan/ScanOrchestrator';

/** Calidad JPEG de la foto pedestal del dataset (orden F4 punto 3:
 *  "foto a 1600 lado largo JPEG q85"). q85 equilibra tamaño/disco (~100-200 kB
 *  por foto a 1600px) contra fidelidad para el entrenador F6.5. */
export const TRAINING_JPEG_QUALITY = 0.85;

export interface DatasetStoreOptions {
  /** Info del dispositivo (del CameraProfile del harness). */
  device: DatasetDeviceInfo;
  /** Codificador JPEG del pedestal (inyectable/testeable). Default: canvas. */
  toJpeg?: (bitmap: ImageBitmap, w: number, h: number) => Promise<Blob>;
  makeId?: () => string;
  /** Wrapper de navigator.storage.estimate (inyectable); default real. */
  estimate?: () => Promise<{ usage: number; quota: number } | null>;
}

interface PhotoRecord {
  id: string;
  entry: DatasetEntry;
  jpeg: Blob | null;
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

/** Abre (o crea) la base 'photos' del dataset. El harness la llama una vez. */
export function openDatasetDB(
  dbName = 'mobile-scanner-dataset',
  version = 1,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req: IDBOpenDBRequest = indexedDB.open(dbName, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('openDatasetDB failed'));
  });
}

/** Solidez del almacén en iOS: pide persistencia (evita purga de PWAs poco
 *  usadas — skill ios-camera-quirks). Devuelve si quedó persistido. */
export async function persistDatasetStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.storage?.persist === 'function') {
      return await navigator.storage.persist();
    }
  } catch {
    // sin persist (desktop/Node): no crítico
  }
  return false;
}

/** Ejecuta la foto pedestal por defecto: canvas con drawImage escalado a
 *  trainingDims (lado mayor 1600) → JPEG q85. */
async function defaultToJpeg(bitmap: ImageBitmap, w: number, h: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('datasetStore: sin contexto 2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => {
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob: null'))),
      'image/jpeg',
      TRAINING_JPEG_QUALITY,
    );
  });
}

function defaultMakeId(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  } catch {
    // sin crypto: fallback temporal (basta unicidad local)
  }
  return `cap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class DatasetStore {
  private readonly device: DatasetDeviceInfo;
  private readonly toJpeg: NonNullable<DatasetStoreOptions['toJpeg']>;
  private readonly makeId: () => string;
  private readonly estimate: () => Promise<{ usage: number; quota: number } | null>;

  constructor(
    private readonly idb: IDBDatabase,
    opts: DatasetStoreOptions,
  ) {
    this.device = opts.device;
    this.toJpeg = opts.toJpeg ?? defaultToJpeg;
    this.makeId = opts.makeId ?? defaultMakeId;
    this.estimate =
      opts.estimate ??
      (async () => {
        try {
          if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
            return null;
          }
          const e = await navigator.storage.estimate();
          return e.usage !== undefined && e.quota !== undefined ? { usage: e.usage, quota: e.quota } : null;
        } catch {
          return null;
        }
      });
    this.idb = idb;
  }

  /** Registra una captura (foto pedestal + metadatos). Regla anti-sesgo:
   *  autoQuad de TODAS las capturas queda en la entrada (entryFromCapture);
   *  si luego el humano ajusta, addAdjusted() añade adjustedQuad SIN tocar el
   *  auto. Devuelve el registro (id para addAdjusted). */
  async add(
    photo: CapturedPhoto,
    condicion: ConditionTag,
    fellBack: [boolean, boolean, boolean, boolean] | null = null,
  ): Promise<DatasetEntry> {
    const id = this.makeId();
    const entry = entryFromCapture(photo, this.device, condicion, id, fellBack);
    const d = trainingDims(photo.frameW, photo.frameH, TRAINING_LONG_SIDE);
    const jpeg = d.w > 0 ? await this.toJpeg(photo.bitmap, d.w, d.h) : null;
    const rec: PhotoRecord = { id, entry, jpeg };
    const tx = this.idb.transaction('photos', 'readwrite');
    tx.objectStore('photos').put(rec);
    await txDone(tx);
    return entry;
  }

  /** Añade el quad ajustado al registro ya existente (mismo id → put con
   *  sobrescritura; el conteo "X/300" NO cambia). La foto ya está guardada;
   *  solo se actualiza la metainformación. */
  async addAdjusted(
    id: string,
    photo: CapturedPhoto,
    condicion: ConditionTag,
    fellBack: [boolean, boolean, boolean, boolean] | null = null,
  ): Promise<void> {
    const tx = this.idb.transaction('photos', 'readwrite');
    const store = tx.objectStore('photos');
    const existing = await reqAs<PhotoRecord | undefined>(store.get(id));
    if (existing === undefined) return; // no registrada (colector apagado en captura): nada que hacer
    const entry = entryFromCapture(photo, this.device, condicion, id, fellBack);
    await store.put({ ...existing, entry });
    await txDone(tx);
  }

  /** Capturas registradas (objetivo "Dataset F6.5: X/300"). */
  async count(): Promise<number> {
    const tx = this.idb.transaction('photos', 'readonly');
    const n = await reqAs<number>(tx.objectStore('photos').count());
    return n ?? 0;
  }

  /** Registros en orden de captura (para manifest/export). */
  async entries(): Promise<DatasetEntry[]> {
    const tx = this.idb.transaction('photos', 'readonly');
    const all = await reqAs<PhotoRecord[]>(tx.objectStore('photos').getAll());
    return all
      .map((r) => r.entry)
      .sort((a, b) => a.ts - b.ts);
  }

  /** ZIP del dataset: manifest.jsonl (JSONL, ver dataCollect.toJsonl) +
   *  photos/<id>.jpg. zipSync acota memoria (una sola copia en Uint8Array) —
   *  suficiente para el harness; si el dataset llegara a mover GBs se pasaría
   *  a zip() con workers (fuera de alcance F4). */
  async exportDataset(): Promise<Blob> {
    const recs = await this.allRecords();
    const manifest = toJsonl(recs.map((r) => r.entry));
    const files: Record<string, Uint8Array> = { 'manifest.jsonl': strToU8(manifest) };
    for (const r of recs) {
      if (r.jpeg !== null) {
        files[`photos/${r.id}.jpg`] = new Uint8Array(await r.jpeg.arrayBuffer());
      }
    }
    return new Blob([zipSync(files)], { type: 'application/zip' });
  }

  /** Presupuesto de cuota (>70% → warn; harness avisa — orden F4 punto 3 +
   *  skill iOS §5-F5). */
  async quota(): Promise<QuotaReport> {
    const e = await this.estimate();
    if (e === null) return { pct: null, warn: false };
    return quotaReport(e.usage, e.quota);
  }

  async clear(): Promise<void> {
    const tx = this.idb.transaction('photos', 'readwrite');
    tx.objectStore('photos').clear();
    await txDone(tx);
  }

  private async allRecords(): Promise<PhotoRecord[]> {
    const tx = this.idb.transaction('photos', 'readonly');
    const all = await reqAs<PhotoRecord[]>(tx.objectStore('photos').getAll());
    return all.sort((a, b) => a.entry.ts - b.entry.ts);
  }
}