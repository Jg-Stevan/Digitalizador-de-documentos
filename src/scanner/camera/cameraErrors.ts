// src/camera/cameraErrors.ts — clasificación de errores de cámara (F6.4).
// PLAN §F6 fila "Errores": permisos denegados, sin getUserMedia, cámara
// ocupada. PURE: sin DOM — recibe unknown y devuelve código + título + pista
// accionable. Clasifica por err.name Y por el texto del mensaje (el harness
// envuelve errores de la cascada en "getUserMedia falló en 3 niveles: ..." y
// el nombre original viaja dentro del string — ver CameraInitError.cause).

export type CameraErrorCode =
  | 'permission' // NotAllowedError / PermissionDeniedError / SecurityError
  | 'no-device' // NotFoundError / DevicesNotFoundError / sin videoinput
  | 'busy' // NotReadableError / TrackStartError (otra app la sostiene)
  | 'overconstrained' // OverconstrainedError (la cascada ya reintenta)
  | 'unsupported' // sin navigator.mediaDevices / NotSupportedError / no https
  | 'unknown';

export interface CameraErrorInfo {
  code: CameraErrorCode;
  /** Título corto para el banner de error (#err). */
  title: string;
  /** Acción concreta para el usuario (qué tocar / dónde ajustar). */
  hint: string;
  /** true si el botón Iniciar (reintento en la misma página) puede funcionar
   *  después de que el usuario atienda la pista. */
  retryable: boolean;
}

/** Tabla por código: texto de UI en español + semántica de reintento. */
const TABLE: Record<CameraErrorCode, Omit<CameraErrorInfo, 'code'>> = {
  permission: {
    title: 'Permiso de cámara denegado',
    hint: 'Permite la cámara para este sitio en los ajustes del navegador y toca Iniciar de nuevo.',
    retryable: true,
  },
  'no-device': {
    title: 'No se encontró cámara',
    hint: 'Conecta o habilita una cámara y toca Iniciar.',
    retryable: false,
  },
  busy: {
    title: 'Cámara ocupada',
    hint: 'Cierra la otra app o pestaña que la está usando y toca Iniciar.',
    retryable: true,
  },
  overconstrained: {
    title: 'La cámara no aceptó los ajustes pedidos',
    hint: 'Toca Iniciar de nuevo: se reintentará sin restricciones.',
    retryable: true,
  },
  unsupported: {
    title: 'Este navegador no expone cámara',
    hint: 'Actualiza el navegador y abre la app sobre https (o localhost).',
    retryable: false,
  },
  unknown: {
    title: 'No se pudo iniciar la cámara',
    hint: 'Toca Iniciar para reintentar.',
    retryable: true,
  },
};

/** Nombres de DOMException → código (MDN getUserMedia + alias históricos). */
const NAME_MAP: Record<string, CameraErrorCode> = {
  NotAllowedError: 'permission',
  PermissionDeniedError: 'permission',
  SecurityError: 'permission',
  NotFoundError: 'no-device',
  DevicesNotFoundError: 'no-device',
  OverconstrainedError: 'overconstrained',
  ConstraintNotSatisfiedError: 'overconstrained',
  NotReadableError: 'busy',
  TrackStartError: 'busy',
  AbortError: 'busy', // hardware/OS abortó el arranque del track
  NotSupportedError: 'unsupported',
  TypeError: 'unsupported', // navigator.mediaDevices undefined (contexto no seguro)
};

/** Heurísticas de texto para errores envueltos o no estándar. */
function fromMessage(msg: string): CameraErrorCode | null {
  const m = msg.toLowerCase();
  if (/(notallowed|permissiondenied|securityerror|permiso|denegad)/.test(m)) {
    return 'permission';
  }
  if (/(notreadable|trackstart|ocupada|busy|in use|could not start)/.test(m)) {
    return 'busy';
  }
  if (/(notfound|devicesnotfound|sin cámaras|sin camaras|no camera|videoinput)/.test(m)) {
    return 'no-device';
  }
  if (/overconstrained|constraint/.test(m)) return 'overconstrained';
  // "Cannot read properties of undefined (reading getUserMedia)" = TypeError
  // típico de navigator.mediaDevices undefined (contexto no seguro/viejo).
  // Va AL FINAL: la cascada "getUserMedia falló...: NotAllowedError" contiene
  // "getusermedia" y debe caer antes por su nombre interno.
  if (/(mediaservices|mediadevices|getusermedia|notsupported|https|secure context|is not a function)/.test(m)) {
    return 'unsupported';
  }
  return null;
}

/** Extrae el mejor nombre/ mensaje inspeccionable de un unknown. */
function inspect(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name ?? '', message: err.message ?? '' };
  }
  if (typeof err === 'string') return { name: '', message: err };
  if (typeof DOMException === 'function' && err instanceof DOMException) {
    return { name: err.name, message: err.message };
  }
  if (err && typeof err === 'object') {
    const o = err as { name?: unknown; message?: unknown };
    return {
      name: typeof o.name === 'string' ? o.name : '',
      message: typeof o.message === 'string' ? o.message : '',
    };
  }
  return { name: '', message: String(err ?? '') };
}

/** Clasifica un error de cámara para la UI. Nunca lanza. */
export function classifyCameraError(err: unknown): CameraErrorInfo {
  const { name, message } = inspect(err);
  let code: CameraErrorCode = NAME_MAP[name] ?? 'unknown';
  if (code === 'unknown') {
    code = fromMessage(`${name} ${message}`) ?? 'unknown';
  }
  return { code, ...TABLE[code] };
}
