// src/lib/base.ts — basePath de despliegue para GitHub Pages.
//
// [GH-PAGES] GitHub Pages sirve los "project sites" en /<nombre-del-repo>/
// (los repos usuario.github.io y los dominios propios van en la raíz).
//
// Doble estrategia (hallazgo del build de validación: Turbopack no siempre
// inlinea NEXT_PUBLIC_BASE_PATH del shell en el bundle CLIENTE, aunque sí
// en el prerender del servidor):
//  - Servidor (prerender del layout, metadata del <head>): valor del build
//    (NEXT_PUBLIC_BASE_PATH=/<repo> definido por el workflow de Actions).
//  - Navegador (registro del SW, URL del worker): se deriva de la URL REAL
//    — la app se sirve en la raíz de su basePath, así que el pathname menos
//    el trailing slash ES el basePath. Funciona en /<repo>/, en la raíz e
//    incluso tras un dominio propio sin recompilar.
//
// Next ya prefija automáticamente los assets que ÉL genera (/_next/...);
// este helper cubre los archivos públicos que referenciamos a mano:
// manifest (server), iconos (server), sw.js y el bundle del worker (client).

/** Base path efectivo ("/repo" en project sites, "" en dev / raíz). */
export const BASE_PATH: string = computeBasePath();

function computeBasePath(): string {
  // Servidor (prerender): valor inyectado por el build de Pages.
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  }
  // Navegador: la URL real manda. El app vive en la RAÍZ de su basePath
  // ("/repo/", "/") — quitamos "index.html" y el slash final.
  return window.location.pathname
    .replace(/index\.html$/, '')
    .replace(/\/+$/, '');
}

/** Prefija una ruta pública absoluta ("/x") con el basePath del deploy. */
export function asset(path: string): string {
  return `${BASE_PATH}${path}`;
}
