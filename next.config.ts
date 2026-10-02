import type { NextConfig } from "next";

// [GH-PAGES] Export ESTÁTICO: GitHub Pages solo sirve archivos planos (sin
// servidor Node). La app es 100% cliente (cámara + worker + IndexedDB), así
// que `next build` genera out/ con HTML + assets listos para publicar.
//
// basePath: los "project sites" de GitHub Pages viven en /<repo>/ (p.ej.
// https://usuario.github.io/escaner/). El workflow de Actions
// (.github/workflows/deploy.yml) define NEXT_PUBLIC_BASE_PATH=/<repo> al
// construir; en dev — y en repos usuario.github.io / dominios propios — queda
// vacío y las rutas son exactamente las de siempre.
// Las rutas públicas que referenciamos a mano (manifest, iconos, sw.js,
// worker) se prefijan vía src/lib/base.ts (asset()).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  // Sin next/image en la app; requerido (y seguro) para export estático.
  images: { unoptimized: true },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
