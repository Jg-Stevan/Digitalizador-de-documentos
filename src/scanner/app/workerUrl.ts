// src/scanner/app/workerUrl.ts — URL del bundle clásico del detection worker.
// El worker vive pre-compilado (esbuild --format=iife) en /public/scanner/
// para poder usar importScripts() de OpenCV.js (UMD), prohibido en module
// workers. Construcción: `bun run build:worker` (package.json).
// [F5-RAW-2, 2026-11 — validación en dispositivo] `?v=` bust de caché: el
// bundle se sirve con el MISMO nombre de archivo y el navegador del celular
// puede tener el viejo en su caché HTTP — la query cambia la URL y fuerza
// la descarga del worker vigente. Bump en cada rebuild con cambios de
// comportamiento (v6 = warp puro + unsharp en enhance).
// [GH-PAGES] asset(): en project sites de GitHub Pages el worker vive en
// /<repo>/scanner/… — OpenCV se resuelve RELATIVO al propio worker (ver
// opencvCandidateUrls en workers/protocol.ts), así que solo esta URL
// necesita el prefijo.
import { asset } from '@/lib/base';

export const DETECTION_WORKER_URL = asset('/scanner/detection-worker.js?v=6');
