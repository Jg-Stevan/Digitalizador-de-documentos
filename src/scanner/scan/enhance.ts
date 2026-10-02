// src/scan/enhance.ts — modos de procesamiento (PLAN_MAESTRO §5-F5).
//
// TODO (F5): 4 modos — color (CLAHE canal L en LAB), gris, B/N (Sauvola con
// ventana parametrizada por DPI), natural (sin CLAHE). Encoding JPEG q88-92 /
// PNG para B/N. Sin implementación en T2.
export const ENHANCE_TODO =
  '4 modos color/gray/bw/natural — F5, PLAN_MAESTRO §5-F5' as const;