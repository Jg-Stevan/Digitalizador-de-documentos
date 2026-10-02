// src/workers/withMats.ts — wrapper de memoria OpenCV.js (skill opencv-wasm-memoria).
// REGLA NO NEGOCIABLE (PLAN_MAESTRO §9): todo cv.Mat / cv.MatVector nace dentro
// de withMats() y su .delete() está garantizado en `finally` — ni en la rama
// feliz, ni en early-return, ni si el pipeline lanza a mitad. El GC del
// navegador NO ve la memoria WASM. Puro y testeable en Node con mocks.

/** Mínimo que withMats necesita de un Mat/MatVector: saber morirse. */
export interface MatLike {
  delete(): void;
}

/** Registra un Mat para su destrucción garantizada. Devuelve el mismo objeto
 *  para permitir `const m = track(new cv.Mat())`. */
export type MatTracker = <M extends MatLike>(m: M) => M;

/** Ejecuta `fn` y destruye en orden LIFO todo lo registrado, siempre. */
export function withMats<T>(fn: (track: MatTracker) => T): T {
  const tracked: MatLike[] = [];
  const track: MatTracker = (m) => {
    tracked.push(m);
    return m;
  };
  try {
    return fn(track);
  } finally {
    for (let i = tracked.length - 1; i >= 0; i--) {
      tracked[i]!.delete();
    }
  }
}
