// public/sw.js — [FASE 7b, 2026-11] Service worker MÍNIMO y conservador para
// PWA instalable. Diseñado para convivir con el dev server de Next sin riesgo
// de contenido rancio mientras se itera:
//
//  - cache-first SOLO para estáticos inmutables: OpenCV vendorizado y el
//    bundle del worker (se cachea con SU query ?v=N — bump de versión =
//    miss natural, sin tocar este archivo) + iconos/manifest.
//  - network-first para navegación y chunks /_next/static: online SIEMPRE
//    gana la red (dev-safe); offline cae a la última copia vista.
//  - Todo lo demás: passthrough (el SW no responde, cero interferencia).
//
// El pipeline del escáner (cámara, worker de detección, UI) NO se toca:
// esto vive en el hosting, no en src/scanner.

const CORE = 'mscan-core-v1';
const RUNTIME = 'mscan-runtime-v1';
const RUNTIME_MAX_ENTRIES = 120;

/** Estáticos vendorizados inmutables (cache-first). El bundle del worker se
 *  pide con query ?v=N: la clave de caché incluye la query, así que bump de
 *  versión refresca solo. */
// [GH-PAGES] Base path dinámico: GitHub Pages sirve los "project sites" en
// /<repo>/ (usuario.github.io y dominios propios van en la raíz). El SW se
// registra en <base>/sw.js, así que SU SCOPE ya ES el basePath — se deriva de
// él sin configurar nada. En dev el scope es "/" → BASE '' (rutas idénticas).
const BASE = new URL(self.registration.scope).pathname.replace(/\/+$/, '');

const CORE_PATHS = new Set([`${BASE}/vendor/opencv-4.5.5.js`, `${BASE}/scanner/detection-worker.js`]);

/** Precache del núcleo (OpenCV pesa ~9MB — allSettled: si falla, la app
 *  sigue funcionando online y el fetch handler lo cachea al primer uso). */
const PRECACHE_URLS = [
  `${BASE}/vendor/opencv-4.5.5.js`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
  `${BASE}/icons/icon-maskable-512.png`,
  `${BASE}/manifest.webmanifest`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CORE);
      await Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CORE && k !== RUNTIME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Inmutables vendorizados + iconos: cache-first.
  if (CORE_PATHS.has(url.pathname) || url.pathname.startsWith(`${BASE}/icons/`)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // Navegación y chunks estáticos: red primero (dev-safe), caché de respaldo.
  if (req.mode === 'navigate' || url.pathname.startsWith(`${BASE}/_next/static/`)) {
    event.respondWith(networkFirst(req));
  }
  // El resto (API, HMR websocket, etc.): passthrough total.
});

async function cacheFirst(req) {
  const cache = await caches.open(CORE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    return hit ?? offlineFallback();
  }
}

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME);
  try {
    const res = await fetch(req);
    if (res.ok) {
      await capRuntime(cache);
      await cache.put(req, res.clone());
    }
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      // [GH-PAGES] shell relativo al scope (no a la raíz del origen): en un
      // project site el documento cacheado vive en /<repo>/.
      const shell = await cache.match(`${BASE}/`);
      if (shell) return shell;
    }
    return offlineFallback();
  }
}

/** Tope de entradas del runtime: en dev los chunks giran en cada recompila —
 *  sin tope la caché crece sin fin. Recorta las más viejas (orden FIFO de
 *  inserción en keys()). */
async function capRuntime(cache) {
  const keys = await cache.keys();
  if (keys.length <= RUNTIME_MAX_ENTRIES) return;
  const excess = keys.length - RUNTIME_MAX_ENTRIES;
  await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
}

function offlineFallback() {
  return new Response('Sin conexión y sin copia en caché.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
