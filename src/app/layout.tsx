import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { asset } from "@/lib/base";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "mobile-scanner — digitalizador de documentos",
  description:
    "Digitalizador de documentos 100% navegador: cámara, detección de bordes con OpenCV.js, recorte automático, modos de enhance y export PDF. Ronda 4: B/N adaptativo + precisión de captura.",
  keywords: ["mobile-scanner", "document scanner", "OpenCV.js", "PDF", "Next.js"],
  // [FASE 7b, 2026-11] PWA instalable: manifest local + iconos propios del
  // escáner (antes un logo remoto de CDN — dependencia externa innecesaria).
  // [GH-PAGES] asset(): prefija el basePath del deploy (/repo en project
  // sites de GitHub Pages, "" en dev y en usuario.github.io).
  manifest: asset("/manifest.webmanifest"),
  icons: {
    icon: [
      { url: asset("/icons/icon-192.png"), sizes: "192x192", type: "image/png" },
      { url: asset("/icons/icon-512.png"), sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: asset("/icons/icon-192.png"), sizes: "192x192", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black",
    title: "Escáner",
  },
};

// [FASE 7b] themeColor del PWA: barra de estado en standalone acorde al
// tema oscuro del escáner (#111 de scanner.css).
export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
