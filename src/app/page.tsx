'use client';

// src/app/page.tsx — hosting Next.js del SPA mobile-scanner (repo portado a
// src/scanner/). El DOM replica los IDs que startApp() espera (contrato del
// index.html original). React solo pinta UNA VEZ; toda la interactividad vive
// en el código vanilla del scanner (mismo código que producción).
// Pruebas sin cámara: /?fake=1&autostart=1 (cámara sintética E2E T7).
//
// [FASE 8.1, 2026-11] Rediseño visual sobre el diseño AI Studio del humano
// (e-14-document-scanner.ai.studio): look simple y NO técnico, para público
// general. ESTRUCTURA: app móvil de 480px con topbar + vista Escanear
// (cámara) + hoja de Revisión (staged) + vista Páginas + nav inferior. TODOS
// los IDs del contrato DOM se preservan (los de diagnóstico viven al área
// colapsable "Opciones avanzadas"). Cero cambios en el pipeline.

import { useEffect, useRef, type ReactNode } from 'react';
import { asset } from '@/lib/base';
import './scanner.css';

/* Iconos inline (SVG stroke) — lenguaje visual Material Symbols del diseño,
   sin dependencia de CDN: la PWA funciona offline. */

function Ico({ name, size = 20 }: { name: string; size?: number }): ReactNode {
  const paths: Record<string, ReactNode> = {
    bolt: (
      <>
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </>
    ),
    sliders: (
      <>
        <line x1="4" y1="7" x2="20" y2="7" />
        <circle cx="9" cy="7" r="2.2" fill="currentColor" stroke="none" />
        <line x1="4" y1="17" x2="20" y2="17" />
        <circle cx="15" cy="17" r="2.2" fill="currentColor" stroke="none" />
      </>
    ),
    scan: (
      <>
        <path d="M4 8V5a1 1 0 0 1 1-1h3" />
        <path d="M16 4h3a1 1 0 0 1 1 1v3" />
        <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
        <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      </>
    ),
    pages: (
      <>
        <rect x="4" y="5" width="12" height="16" rx="2" />
        <path d="M9 3h9a2 2 0 0 1 2 2v13" />
      </>
    ),
    share: (
      <>
        <circle cx="6" cy="12" r="2.4" />
        <circle cx="18" cy="6" r="2.4" />
        <circle cx="18" cy="18" r="2.4" />
        <line x1="8.2" y1="10.9" x2="15.8" y2="7.1" />
        <line x1="8.2" y1="13.1" x2="15.8" y2="16.9" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v11" />
        <path d="M7 10l5 5 5-5" />
        <path d="M4 19h16" />
      </>
    ),
    check: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.5 2.5L16 9.5" />
      </>
    ),
    doc: (
      <>
        <path d="M6 2h8l4 4v16H6z" />
        <path d="M14 2v4h4" />
        <line x1="9" y1="13" x2="15" y2="13" />
        <line x1="9" y1="17" x2="15" y2="17" />
      </>
    ),
    close: (
      <>
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11A8 8 0 1 0 18.9 15" />
        <path d="M20 4v7h-7" />
      </>
    ),
    crop: (
      <>
        <path d="M7 3v14a2 2 0 0 0 2 2h12" />
        <path d="M3 7h14a2 2 0 0 1 2 2v12" />
      </>
    ),
    add: (
      <>
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
        <path d="M21 15l-5-5L5 21" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export default function ScannerPage() {
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    let disposed = false;
    // Import dinámico: el árbol del scanner solo existe en cliente (cámara,
    // IndexedDB, Worker). Nada de esto se evalúa durante el SSR.
    void Promise.all([
      import('@/scanner/app/app'),
      import('@/scanner/lab/cerLab'),
    ])
      .then(([{ startApp }, { mountCerLab }]) => {
        if (disposed) return;
        try {
          startApp(document, window);
        } catch (e) {
          const err = document.getElementById('err');
          if (err)
            err.textContent = `Arranque: ${(e as Error).message}. Recarga para reintentar.`;
        }
        mountCerLab(document, window);
      })
      .catch((e: unknown) => {
        const err = document.getElementById('err');
        if (err) err.textContent = `Arranque módulos: ${String(e)}`;
      });
    return () => {
      disposed = true;
    };
  }, []);

  // [FASE 7b, 2026-11] PWA: registro del service worker (conservador — ver
  // public/sw.js) + botón "Instalar app" cuando el navegador ofrece el
  // prompt (Android/Chrome desktop). iOS no emite beforeinstallprompt:
  // ahí mostramos la ruta manual (Compartir → Agregar a pantalla de inicio).
  // Imperativo deliberado: React pinta UNA VEZ; el escáner es vanilla y el
  // hosting no debe re-renderizar por un evento del SO.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const win = window;
    const nav = win.navigator;

    if ('serviceWorker' in nav) {
      // [GH-PAGES] asset(): en project sites el SW vive en /<repo>/sw.js
      // (su scope YA es el basePath — las rutas internas del sw.js se
      // derivan del scope, ver comentario ahí).
      nav.serviceWorker.register(asset('/sw.js')).catch(() => {
        // sin SW la app funciona igual (solo online): silencioso
      });
    }

    const installBtn = document.getElementById('installBtn');
    const iosHint = document.getElementById('iosHint');
    if (installBtn) {
      type PromptableEvent = Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: string }>;
      };
      let deferred: PromptableEvent | null = null;
      const onPrompt = (e: Event): void => {
        e.preventDefault();
        deferred = e as PromptableEvent;
        installBtn.hidden = false;
      };
      const onInstalled = (): void => {
        installBtn.hidden = true;
      };
      win.addEventListener('beforeinstallprompt', onPrompt);
      win.addEventListener('appinstalled', onInstalled);
      installBtn.addEventListener('click', () => {
        void deferred?.prompt();
      });
    }
    // iOS: sin beforeinstallprompt — si no está instalada, guía manual.
    if (iosHint) {
      const isIOS = /iphone|ipad|ipod/i.test(nav.userAgent);
      const standalone =
        (nav as Navigator & { standalone?: boolean }).standalone === true;
      iosHint.hidden = !(isIOS && !standalone);
    }
  }, []);

  // [FASE 8] Navegación de la app (tabs Escanear/Páginas = anclas de scroll
  // — el video NUNCA se oculta: el frameLoop sigue alimentándose de frames
  // reales aunque estés gestionando páginas; cero riesgo para el pipeline).
  // Relé "Repetir": dispara el shutter LÓGICO (mismo botón, mismo código).
  useEffect(() => {
    const viewScan = document.getElementById('viewScan');
    const viewPages = document.getElementById('viewPages');
    const navScan = document.getElementById('navScan');
    const navPages = document.getElementById('navPages');
    const setActive = (which: Element | null): void => {
      navScan?.classList.toggle('active', which === navScan);
      navPages?.classList.toggle('active', which === navPages);
    };
    navScan?.addEventListener('click', () => {
      viewScan?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(navScan);
    });
    navPages?.addEventListener('click', () => {
      viewPages?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(navPages);
    });
    // El pill de filtro lleva a la vista Páginas (el selector global vive ahí)
    document.getElementById('modePill')?.addEventListener('click', () => {
      viewPages?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(navPages);
    });
    // Relé de re-toma: mismo shutter, cero cambios en app.ts
    document.getElementById('repeatBtn')?.addEventListener('click', () => {
      document.getElementById('shutterBtn')?.click();
    });
    // Ajustes → abre el panel de herramientas
    document.getElementById('settingsBtn')?.addEventListener('click', () => {
      const tools = document.querySelector('details.tools') as HTMLDetailsElement | null;
      if (tools) tools.open = true;
      tools?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    setActive(navScan);
  }, []);

  return (
    <div className="mscan">
      {/* Topbar del app (pantalla 5 del diseño): ajustes | título | instalar */}
      <header className="mscan-topbar">
        <button
          id="settingsBtn"
          type="button"
          className="tb-btn"
          aria-label="Abrir opciones avanzadas"
        >
          <Ico name="gear" />
        </button>
        <h1>Escáner</h1>
        <div className="tb-side">
          <button
            id="installBtn"
            type="button"
            hidden
            aria-label="Instalar la aplicación en este dispositivo"
          >
            Instalar app
          </button>
        </div>
        <span id="iosHint" hidden className="mscan-sub">
          iPhone: Comparte → “Agregar a pantalla de inicio”.
        </span>
      </header>

      <main className="mscan-main">
        {/* ================= VISTA ESCANEAR (pantalla 2 del diseño) ======== */}
        <section id="viewScan" aria-label="Escáner de cámara">
          <div className="cam-stage">
            <video id="v" playsInline muted autoPlay />
            <canvas id="ov" className="overlay" width="640" height="480" />
            <div id="dianaGuide" hidden aria-hidden="true" />

            <div className="cam-topband">
              <span className="cam-chip">
                <span className="dot" aria-hidden="true" />
                <b id="mCap">0</b>&nbsp;capturas
              </span>
              <span className="cam-chip neutral" title="Estado del escaneo">
                <b id="mState">—</b>
              </span>
            </div>

            {/* Estado de arranque: desaparece solo cuando startBtn se deshabilita */}
            <div className="cam-start">
              <h2>Escanea tu documento</h2>
              <p className="mscan-sub">
                Apunta la cámara: detectamos los bordes y recortamos solos.
                Todo queda en tu teléfono.
              </p>
              <button id="startBtn" type="button">
                Iniciar cámara
              </button>
              {/* [FASE 9] Subir fotos ya tomadas — mismo recorte automático */}
              <button id="importStartBtn" type="button" className="start-secondary">
                <Ico name="image" />
                Subir fotos de tu galería
              </button>
            </div>
          </div>

          {/* Fila de controles: [filtro | shutter+anillo | linterna] */}
          <div className="cam-controls">
            <button
              id="modePill"
              type="button"
              className="ctl-pill"
              aria-label="Ver y cambiar el modo de realce en Páginas"
            >
              <Ico name="sliders" />
              <span>
                <b id="mMode">Color mejorado</b>
              </span>
            </button>

            <div className="shutter-wrap">
              <canvas id="ring" width="84" height="84" aria-label="Puntuación de calidad" />
              <button id="shutterBtn" type="button" disabled aria-label="Captura manual" />
            </div>

            {/* [FASE 9] Subir fotos de la galería (recorte automático igual
                que la cámara) — mismo selector #importInput. */}
            <button
              id="importBtn"
              type="button"
              aria-label="Subir fotos de tu galería"
            >
              <Ico name="image" />
            </button>

            <button id="torchBtn" type="button" disabled aria-label="Linterna">
              Linterna
            </button>
          </div>

          {/* [FASE 9] Entrada de galería: el selector de archivos lo abre
              app.ts (mismo código vanilla que los demás controles). */}
          <input
            id="importInput"
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-label="Elegir fotos de la galería"
          />

          {/* Banner de guía/errores EN FLUJO (app.ts escribe aquí: mensajes de
              encuadre, reintentos de cámara, etc.). :empty → invisible. */}
          <div id="err" role="alert" aria-live="assertive" />
        </section>

        {/* =========== HOJA DE REVISIÓN DE CAPTURA (pantalla 3) ============
            EN FLUJO bajo los controles. Visibilidad por CSS :has() — aparece
            exactamente cuando hay captura disponible (addBtn habilitado):
            mismo contrato del UI viejo para el flujo AUTO y el STAGED (F6).
            [FASE 8.1] Look simple del diseño AI Studio: sin métricas técnicas
            (Salida/Refinado viven en Opciones avanzadas), acciones con el
            lenguaje del público ("Recortar", "Repetir"). */}
        <div id="reviewSheet" aria-label="Revisión de captura">
          <div className="sheet-handle" aria-hidden="true" />
          <div className="sheet-head">
            <h2>Tu captura</h2>
            <span id="thumbLabel">ÚLTIMA CAPTURA</span>
          </div>
          <div className="sheet-preview">
            <span className="corner tl" aria-hidden="true" />
            <span className="corner tr" aria-hidden="true" />
            <span className="corner bl" aria-hidden="true" />
            <span className="corner br" aria-hidden="true" />
            <canvas id="thumb" width="320" height="240" />
          </div>
          <button id="addBtn" type="button" disabled aria-label="Agregar captura al documento">
            <Ico name="add" />
            Agregar al documento
          </button>
          <div className="sheet-secondary">
            <button id="editBtn" type="button" disabled aria-label="Recortar: ajustar las esquinas de la captura">
              <Ico name="crop" />
              Recortar
            </button>
            <button id="repeatBtn" type="button" aria-label="Repetir la captura">
              <Ico name="refresh" />
              Repetir
            </button>
          </div>
        </div>

        {/* ================= VISTA PÁGINAS (pantalla 5) ==================== */}
        <section id="viewPages" aria-label="Páginas del documento">
          <div className="pages-head">
            <h2>Páginas</h2>
            <button
              id="newDocBtn"
              type="button"
              aria-label="Descartar las páginas y empezar un documento nuevo"
            >
              Nuevo documento
            </button>
            <button id="refreshBtn" type="button" aria-label="Actualizar galería">
              <Ico name="refresh" />
            </button>
          </div>

          {/* Galería: PageGallery renderiza pg-bar (contador + selector de
              modo como chip activo) y pg-grid (tarjetas 2 columnas) */}
          <div id="gallery" />

          <div className="export-bar">
            <button
              id="pdfSizeBtn"
              type="button"
              aria-label="Tamaño de página del PDF: adaptativa, Letter o A4"
            >
              Página PDF: Auto
            </button>
            <button id="pdfBtn" type="button" aria-label="Exportar documento a PDF">
              <Ico name="share" />
              Exportar PDF
            </button>
          </div>
        </section>

        {/* ============ DIAGNÓSTICO Y HERRAMIENTAS (colapsable) ============
            Todos los IDs de telemetría del contrato viven aquí, ocultos del
            look de app pero actualizándose igual (textContent no necesita
            visibilidad). [FASE 8.1] renombrado para el público: "Opciones
            avanzadas" — cero jerga en la superficie. */}
        <details className="tools">
          <summary>
            <Ico name="sliders" />
            Opciones avanzadas
          </summary>
          <div className="tools-body">
            <div className="metrics">
              <div>
                Cámara: <b id="mCam">—</b>
              </div>
              <div>
                FPS: <b id="mFps">—</b>
              </div>
              <div>
                Salida: <b id="mOut">—</b>
              </div>
              <div>
                Refinado: <b id="mRef">—</b>
              </div>
              <div>
                Contornos: <b id="mCont">—</b>
              </div>
              <div>
                Diana CDE: <b id="mDiana">—</b>
              </div>
              <div>
                Estab. quad: <b id="mQuadStab">—</b>
              </div>
              <div id="tMount" />
            </div>

            <pre id="out">…</pre>

            <section className="card" aria-label="Perfil de documento">
              <h3>Perfil de documento</h3>
              <div className="row">
                <label htmlFor="profileSel">
                  Detectar como:
                  <select
                    id="profileSel"
                    defaultValue="auto"
                    aria-label="Perfil de documento para la detección"
                  >
                    <option value="auto">Automático (sin prior)</option>
                    <option value="documento-largo">Documento largo (actas, tirillas)</option>
                    <option value="pagina">Página (carta, A4)</option>
                    <option value="tarjeta">Tarjeta (credenciales)</option>
                  </select>
                </label>
              </div>
              <p>
                Preferencias suaves de encuadre, nunca un rechazo duro: un
                documento fuera de perfil sigue siendo válido.
              </p>
            </section>

            <section className="card" aria-label="Laboratorio CER">
              <h3>Laboratorio CER (calibración)</h3>
              <div id="cerMount" />
            </section>

            <section className="card" aria-label="Modo diana">
              <h3>Diana de calibración</h3>
              <div className="row">
                <label className="sw">
                  <input type="checkbox" id="dianaChk" /> Modo diana
                </label>
                <label>
                  Ancho real (mm):
                  <input
                    id="dianaWidthMm"
                    type="number"
                    min="1"
                    step="0.1"
                    inputMode="decimal"
                    aria-label="Ancho real de la diana en milímetros"
                  />
                </label>
              </div>
            </section>

            <section className="card" aria-label="Ajustes">
              <h3>Ajustes</h3>
              <div className="row">
                <label>
                  DSN de telemetría:
                  <input
                    id="dsnInput"
                    type="text"
                    inputMode="url"
                    placeholder="(vacío = solo conteo local)"
                    aria-label="DSN de telemetría"
                  />
                </label>
                <button id="dsnSave" type="button">
                  Guardar DSN
                </button>
                <button id="teleEvents" type="button">
                  Ver eventos locales
                </button>
              </div>
              <div id="teleLocal" role="status" />
              <p>
                Telemetría opt-in, OFF por defecto: sin activar, 0 bytes salen
                del dispositivo.
              </p>
            </section>
          </div>
        </details>
      </main>

      {/* ============== HOJA DE EXPORTACIÓN EXITOSA (pantalla 4) =========== */}
      <div id="exportSheet" hidden aria-label="Exportación exitosa">
        <button id="expClose" type="button" className="exp-close" aria-label="Cerrar">
          <Ico name="close" />
        </button>
        <div className="exp-icon">
          <Ico name="check" size={28} />
        </div>
        <p className="exp-title">¡PDF generado!</p>
        <p className="exp-sub">Tu documento está listo para compartir</p>
        <div className="exp-file">
          <span className="f-ic">
            <Ico name="doc" />
          </span>
          <span className="f-main">
            <span className="f-name" id="expName">
              scanner.pdf
            </span>
            <span className="f-meta" id="expMeta">
              —
            </span>
          </span>
        </div>
        <div className="exp-actions">
          <button id="expShare" type="button">
            <Ico name="share" />
            Compartir
          </button>
          <button id="expDownload" type="button">
            <Ico name="download" />
            Descargar
          </button>
        </div>
        <button id="expNew" type="button">
          Nuevo documento
        </button>
      </div>

      {/* Comparador de modos (overlay de ModeCompare) */}
      <div id="cmpRoot" />

      {/* ============ EDITOR DE ESQUINAS (pantalla 1, overlay) ============ */}
      <div id="editorRoot" hidden>
        <div className="ed-head">
          <span className="ed-chip">
            <span className="dot" aria-hidden="true" />
            Perspectiva · 4 puntos
          </span>
        </div>
        <canvas id="editorCanvas" width="320" height="240" />
        <div id="editorErr" role="alert" />
        <div className="row" id="editorBtns">
          <button id="editorConfirmBtn" type="button">
            Confirmar
          </button>
          <button id="editorRevertBtn" type="button">
            Detección automática
          </button>
          <button id="editorCancelBtn" type="button">
            Cancelar
          </button>
        </div>
        <div id="editorHelp">
          Arrastra los puntos hasta las esquinas del documento — la lupa te
          ayuda a afinar. Toca Confirmar para aplicar el recorte.
        </div>
      </div>

      {/* Nav inferior: tabs de scroll (el video nunca se oculta) */}
      <nav className="mscan-nav" aria-label="Navegación del escáner">
        <button id="navScan" type="button">
          <Ico name="scan" />
          Escanear
        </button>
        <button id="navPages" type="button">
          <Ico name="pages" />
          Páginas
        </button>
      </nav>

      <footer className="mscan-footer">
        <span>Tus documentos nunca salen de tu teléfono.</span>
        {/* Utilidad SOLO de desarrollo (descarga del zip desde el sandbox).
            El build de producción (GitHub Pages) no lo renderiza — bórralo
            cuando ya no lo necesites junto con su regla .src-dl. */}
        {process.env.NODE_ENV === 'development' && (
          <a className="src-dl" href="/document-scanner-source.zip" download>
            Descargar código (.zip)
          </a>
        )}
      </footer>

      <div id="toast" role="status" aria-live="polite" />
    </div>
  );
}
