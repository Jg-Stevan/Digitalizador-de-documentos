// src/camera/lifecycle.ts — supervivencia a background y pérdida de track (F6.4).
// PLAN §F6 fila "Errores": rotación, background; checklist: permisos revocados.
// Diseño: rAF/rVFC ya pausan solos con la pestaña oculta (los navegadores no
// disparan frames) — NO se toca FrameLoop. Lo que sí hay que gestionar:
//  (1) al volver, re-armar el plazo de 8s del orquestador (el tiempo oculto no
//      debe disparar el toast de timeout) — onVisible.
//  (2) al volver, validar que el track siga vivo (iOS puede matar el stream en
//      background; el usuario puede revocar el permiso) — trackIsLive.
// PURE-friendly: deps inyectables para vitest; el default usa document.

export interface LifecycleDeps {
  /** Suscribe el listener de visibilidad (default: document). */
  addListener(type: 'visibilitychange', cb: () => void): void;
  removeListener(type: 'visibilitychange', cb: () => void): void;
  /** Estado actual (default: () => document.hidden). */
  isHidden(): boolean;
}

export interface LifecycleHooks {
  /** Pestaña oculta: el loop se congela solo; gancho para métricas/pausa. */
  onHidden(): void;
  /** Pestaña visible otra vez: re-armar deadlines + health check del track. */
  onVisible(): void;
}

const BROWSER_DEPS: LifecycleDeps = {
  addListener: (type, cb) => document.addEventListener(type, cb),
  removeListener: (type, cb) => document.removeEventListener(type, cb),
  isHidden: () => document.hidden,
};

/**
 * Track utilizable: readyState 'live'. `muted` NO invalida (es transitorio:
 * autofocus/exposición en iOS lo parpadean) — el health check estricto es solo
 * 'ended'. null/undefined = sin track abierto = vivo (nada que perder).
 */
export function trackIsLive(
  track: { readyState: string } | null | undefined,
): boolean {
  if (track === null || track === undefined) return true;
  return track.readyState === 'live';
}

/** Instala los ganchos de visibilidad; devuelve desapuntador idempotente. */
export function attachLifecycle(
  hooks: LifecycleHooks,
  deps: LifecycleDeps = BROWSER_DEPS,
): () => void {
  const handler = (): void => {
    if (deps.isHidden()) hooks.onHidden();
    else hooks.onVisible();
  };
  deps.addListener('visibilitychange', handler);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    deps.removeListener('visibilitychange', handler);
  };
}
