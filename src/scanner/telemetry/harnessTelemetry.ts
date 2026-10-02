// F6.3 — Wiring DOM de la telemetría para los harnesses (patrón del proyecto:
// DOM ligera con contexto inyectado; la lógica pura vive en telemetry.ts).
// Crea el renglón del panel: botón toggle (opt-in persistente) + contadores;
// engancha window error/unhandledrejection ADITIVAMENTE (no pisa los handlers
// existentes de arranque) y expone window.__telemetry para E2E (precedente
// __orch/__editor).
import {
  TELEMETRY_KEY_DSN,
  createTelemetry,
  type Telemetry,
  type TelemetryDsn,
  type TelemetrySnapshot,
} from './telemetry';

export interface HarnessTelemetry {
  telemetry: Telemetry;
  refresh(): void;
}

export function wireTelemetry(
  win: Window,
  doc: Document,
  mount: HTMLElement | null,
): HarnessTelemetry {
  const readStore = (key: string): string | null => win.localStorage.getItem(key);
  const writeStore = (key: string, value: string): void => {
    try {
      win.localStorage.setItem(key, value);
    } catch {
      /* Safari privado: el opt-in no persiste, la sesión sigue siendo honesta */
    }
  };

  // Envío con fetch SOLO si hay DSN configurado — el núcleo ya lo gatea.
  const send = (envelope: string, dsn: TelemetryDsn): Promise<void> =>
    fetch(dsn.envelopeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=mscan/0.1.0`,
      },
      body: envelope,
    }).then((res) => {
      if (!res.ok) throw new Error(`sentry ${res.status}`);
    });

  const telemetry = createTelemetry({ readStore, writeStore, send });

  let btn: HTMLButtonElement | null = null;
  let stat: HTMLSpanElement | null = null;
  const refresh = (): void => {
    const s: TelemetrySnapshot = telemetry.snapshot();
    if (!btn || !stat) return; // sin panel: los hooks globales siguen activos
    btn.textContent = s.enabled ? 'ON' : 'OFF';
    stat.textContent = s.hasDsn
      ? `capturados ${s.captured} · enviados ${s.sent}${s.dropped ? ` · descartados ${s.dropped}` : ''}`
      : `local ${s.captured} (sin DSN — nada sale del dispositivo)`;
  };

  if (mount) {
    btn = doc.createElement('button');
    btn.id = 'tBtn';
    stat = doc.createElement('span');
    stat.id = 'tStat';
    const row = doc.createElement('div');
    row.append(doc.createTextNode('telemetría: '), btn, doc.createTextNode(' '), stat);
    mount.append(row);
    btn.onclick = (): void => {
      if (telemetry.isEnabled()) telemetry.disable();
      else telemetry.enable();
      refresh();
    };
  }

  telemetry.snapshot(); // asegura lectura inicial
  refresh();

  // Hooks globales ADITIVOS: los handlers de arranque del harness (window.onerror)
  // siguen intactos — esto alimenta SOLO la telemetría.
  win.addEventListener('error', (ev) => {
    const err = (ev as ErrorEvent).error ?? (ev as ErrorEvent).message;
    telemetry.captureError(err instanceof Error ? err : Error(String(err)));
    refresh();
  });
  win.addEventListener('unhandledrejection', (ev) => {
    telemetry.captureError((ev as PromiseRejectionEvent).reason ?? 'promesa rechazada');
    refresh();
  });

  (win as unknown as { __telemetry?: Telemetry }).__telemetry = telemetry;
  return { telemetry, refresh };
}

export { TELEMETRY_KEY_DSN };
