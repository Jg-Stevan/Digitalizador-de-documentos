// F6.3 — Telemetría opt-in (estilo Sentry) para medir aceptación en producción.
// PRINCIPIOS (decisión documentada en PLAN_EVIDENCE/F6/telemetry/):
//  1. OFF por defecto — sin opt-in explícito NUNCA sale un byte del dispositivo.
//  2. Sin SDK externo ni CDN — el plan pide Sentry, pero el SDK por CDN sería
//     otro SPOF (lección F6.1). Enviamos el formato ENVELOPE oficial de Sentry,
//     así apuntar un DSN real en el futuro funciona sin tocar este módulo.
//  3. Sin datos de usuario: solo mensajes de error/stack redactados (sin query
//     strings ni blob: URLs) + contadores. Jamás fotos ni quads.
//  4. Límite de envíos por sesión (TELEMETRY_MAX_EVENTS) contra bucles de error.
//  5. DSN por configuración (localStorage mscan.telemetry.dsn) — vacío por
//     defecto: con opt-in pero sin DSN los eventos se cuentan LOCALMENTE
//     (útil para depurar en dispositivo) y no hay red.
// Núcleo 100% puro (sin DOM ni fetch — se inyectan) → testeable en Node.

export interface TelemetryDsn {
  origin: string;
  publicKey: string;
  projectId: string;
  envelopeUrl: string;
}

/** Acepta DSNs Sentry estándar `https://<publicKey>@<host>/<projectId>`. */
export function parseDsn(raw: string): TelemetryDsn | null {
  const m = /^https:\/\/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)\/(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const [, publicKey, host, projectId] = m;
  return {
    origin: `https://${host}`,
    publicKey,
    projectId,
    envelopeUrl: `https://${host}/api/${projectId}/envelope/`,
  };
}

export const TELEMETRY_MAX_EVENTS = 20;
export const TELEMETRY_REDACT_MAX = 300;
export const TELEMETRY_STACK_MAX = 1200;

/** Quita query strings de URLs y blob: (pueden filtrar IDs de cámara/rutas); trunca. */
export function redactMessage(raw: string, max = TELEMETRY_REDACT_MAX): string {
  let s = String(raw);
  s = s.replace(/(https?:\/\/[^\s?"')\]]+)\?[^\s"')\]]*/g, '$1?…');
  s = s.replace(/blob:[^\s"')\]]+/g, 'blob:…');
  s = s.replace(/file:\/\/[^\s"')\]]+/g, 'file://…');
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

export interface TelemetryEvent {
  kind: 'error' | 'message';
  message: string;
  stack?: string;
  ts: number;
  extra?: Record<string, string | number | boolean | null>;
}

export interface EnvelopeCtx {
  environment: string;
  release: string;
}

/**
 * Sobre mínimo en formato Sentry envelope: línea 1 = {event_id, sent_at},
 * línea 2 = payload del evento (item "event" sin header — válido por spec).
 */
export function buildEnvelope(
  event: TelemetryEvent,
  ctx: EnvelopeCtx,
  uuid: () => string,
): { eventId: string; body: string } {
  // Redacción EN EL PUNTO DE SALIDA (defensa en profundidad: aunque capture()
  // ya redactó, el envelope nunca puede contener query strings ni blob:).
  const eventId = uuid();
  const header = JSON.stringify({ event_id: eventId, sent_at: new Date(event.ts).toISOString() });
  const payload = JSON.stringify({
    platform: 'javascript',
    level: event.kind === 'error' ? 'error' : 'info',
    environment: ctx.environment,
    release: ctx.release,
    message: redactMessage(event.message),
    timestamp: event.ts / 1000,
    ...(event.stack
      ? {
          exception: {
            values: [{ type: 'Error', value: redactMessage(event.message), stacktrace: redactMessage(event.stack, TELEMETRY_STACK_MAX) }],
          },
        }
      : {}),
    ...(event.extra ? { extra: event.extra } : {}),
  });
  return { eventId, body: `${header}\n${payload}\n` };
}

export interface TelemetrySnapshot {
  enabled: boolean;
  hasDsn: boolean;
  captured: number;
  sent: number;
  dropped: number;
  last: string | null;
}

export interface TelemetryDeps {
  now?: () => number;
  uuid?: () => string;
  /** Inyectado por el harness (fetch). Ausente ⇒ sin red aunque haya DSN. */
  send?: (envelope: string, dsn: TelemetryDsn) => void | Promise<void>;
  readStore?: (key: string) => string | null;
  writeStore?: (key: string, value: string) => void;
  /** Notificación tras cada captura (para refrescar el panel del harness). */
  onCapture?: (snapshot: TelemetrySnapshot) => void;
  environment?: string;
  release?: string;
}

export const TELEMETRY_KEY_ENABLED = 'mscan.telemetry.on';
export const TELEMETRY_KEY_DSN = 'mscan.telemetry.dsn';

export interface Telemetry {
  captureError(err: unknown, extra?: Record<string, string | number | boolean | null>): void;
  captureMessage(message: string, extra?: Record<string, string | number | boolean | null>): void;
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  snapshot(): TelemetrySnapshot;
}

export function createTelemetry(deps: TelemetryDeps = {}): Telemetry {
  const now = deps.now ?? (() => Date.now());
  const uuid =
    deps.uuid ??
    (() =>
      globalThis.crypto?.randomUUID?.() ??
      `evt-${now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  const readStore = deps.readStore ?? (() => null);
  const writeStore = deps.writeStore ?? (() => {});
  const ctx: EnvelopeCtx = {
    environment: deps.environment ?? 'harness',
    release: deps.release ?? 'mscan 0.1.0',
  };

  // Opt-in persistente + DSN opcional (configuración, no datos).
  let enabled = readStore(TELEMETRY_KEY_ENABLED) === '1';
  const dsn = parseDsn(readStore(TELEMETRY_KEY_DSN) ?? '');

  let captured = 0;
  let sent = 0;
  let dropped = 0;
  let sendAttempts = 0;
  let last: string | null = null;
  const ring: TelemetryEvent[] = []; // últimos MAX eventos para depuración local

  const snapshot = (): TelemetrySnapshot => ({
    enabled,
    hasDsn: dsn !== null,
    captured,
    sent,
    dropped,
    last,
  });

  function capture(
    kind: TelemetryEvent['kind'],
    message: string,
    stack?: string,
    extra?: Record<string, string | number | boolean | null>,
  ): void {
    const event: TelemetryEvent = {
      kind,
      message: redactMessage(message),
      stack: stack ? redactMessage(stack, TELEMETRY_STACK_MAX) : undefined,
      ts: now(),
      extra,
    };
    captured += 1;
    last = event.message;
    ring.push(event);
    if (ring.length > TELEMETRY_MAX_EVENTS) ring.shift();

    if (!enabled) {
      deps.onCapture?.(snapshot());
      return; // sin opt-in: el evento vive y muere en memoria
    }
    if (dsn && deps.send) {
      if (sendAttempts >= TELEMETRY_MAX_EVENTS) {
        dropped += 1; // límite anti-bucle de errores
      } else {
        sendAttempts += 1;
        const { body } = buildEnvelope(event, ctx, uuid);
        try {
          void Promise.resolve(deps.send(body, dsn)).then(
            () => {
              sent += 1;
              deps.onCapture?.(snapshot());
            },
            () => {
              dropped += 1;
              deps.onCapture?.(snapshot());
            },
          );
        } catch {
          dropped += 1;
        }
      }
    }
    // con opt-in pero sin DSN/send: se cuenta localmente, no sale nada (honesto)
    deps.onCapture?.(snapshot());
  }

  return {
    captureError(err, extra): void {
      if (err instanceof Error) capture('error', err.message, err.stack, extra);
      else capture('error', String(err), undefined, extra);
    },
    captureMessage(message, extra): void {
      capture('message', message, undefined, extra);
    },
    enable(): void {
      enabled = true;
      writeStore(TELEMETRY_KEY_ENABLED, '1');
      deps.onCapture?.(snapshot());
    },
    disable(): void {
      enabled = false;
      writeStore(TELEMETRY_KEY_ENABLED, '0');
      deps.onCapture?.(snapshot());
    },
    isEnabled: () => enabled,
    snapshot,
  };
}
