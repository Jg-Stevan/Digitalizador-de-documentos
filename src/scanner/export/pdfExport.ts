// src/export/pdfExport.ts — densidad del PDF multipágina (§5-F5 + M1).
// PURO en la parte que importa (pdf-lib funciona en Node: empaqueta páginas
// ENCODE de la cola sin tocar canvas ni IndexedDB — solo Blob → bytes).
// M1 (2026-09-27): página ADAPTATIVA por defecto (aspecto exacto de la imagen
// warped, lado largo ≤ 792pt — como el ideal Adobe 255.6×792); Letter/A4
// quedan como opción explícita para impresión. Mismos píxeles, otra caja.

import { PDFDocument } from 'pdf-lib';
import type { PageRecord } from './pageStore';

/** Página Letter en pt (D1 del plan; opción de impresión, ya no default). */
export const LETTER_PT: readonly [number, number] = [612, 792];

/** Página A4 en pt (opción del export F5 — paper A4 de la spec, no invento). */
export const A4_PT: readonly [number, number] = [595.28, 841.89];

/** Lado largo máximo de la página adaptativa en pt (11 in — el ideal Adobe
 *  mide 792pt de largo; el ancho deriva del aspecto medido, NUNCA de un
 *  ratio hardcodeado — regla del repo). */
export const ADAPTIVE_MAX_LONG_PT = 792;

/** Caja de página del export: adaptativa (default M1) o papel fijo. */
export type PdfPageSize = 'adaptive' | 'letter' | 'a4';

/** Dims de página adaptativa desde la imagen: aspecto EXACTO imgW×imgH con el
 *  lado largo capado a `maxLong` pt (E-44/E-14 1:3 1111×3332 → ~264×792pt,
 *  ~303 DPI idéntico píxel a píxel al Letter anterior pero sin márgenes
 *  fantasma). Dims inválidas → 1×1 (nunca lanza). */
export function adaptivePagePts(
  imgW: number,
  imgH: number,
  maxLong: number = ADAPTIVE_MAX_LONG_PT,
): { w: number; h: number } {
  if (!(imgW > 0) || !(imgH > 0) || !(maxLong > 0)) return { w: 1, h: 1 };
  const s = Math.min(1, maxLong / Math.max(imgW, imgH));
  return {
    w: Math.max(1, imgW * s),
    h: Math.max(1, imgH * s),
  };
}

/** Empaqueta las páginas en un PDF de una página por folio (imagen encajada
 *  en el folio con márgenes, proporción preservada). No genera metadatos
 *  protegidos; las imágenes se insertan tal cual (blobs ya ENCODE en la cola). */
export async function fromPages(
  pages: PageRecord[],
  opts: { a4?: boolean; pageSize?: PdfPageSize } = {},
): Promise<Blob> {
  return new Blob([new Uint8Array(await pdfBytes(pages, opts))], { type: 'application/pdf' });
}

/** Bytes del PDF generado (núcleo Node-testeable sin Blob si hiciera falta —
 *  probar embed + conteo de folios con PDFDocument.load). */
export async function pdfBytes(
  pages: PageRecord[],
  opts: { a4?: boolean; pageSize?: PdfPageSize } = {},
): Promise<Uint8Array> {
  // M1: `a4` legacy mapea a papel fijo; sin pageSize el default es adaptativo.
  const pageSize: PdfPageSize = opts.pageSize ?? (opts.a4 ? 'a4' : 'adaptive');
  const doc = await PDFDocument.create();

  for (const p of [...pages].sort((a, b) => a.order - b.order)) {
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    const img =
      p.blob.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const box =
      pageSize === 'letter'
        ? { w: LETTER_PT[0], h: LETTER_PT[1] }
        : pageSize === 'a4'
          ? { w: A4_PT[0], h: A4_PT[1] }
          : adaptivePagePts(img.width, img.height);
    const scale = Math.min(box.w / img.width, box.h / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const page = doc.addPage([box.w, box.h]);
    page.drawImage(img, {
      x: (box.w - w) / 2,
      y: (box.h - h) / 2,
      width: w,
      height: h,
    });
  }
  return new Uint8Array(await doc.save());
}