import {
  playFireworkPop,
  playVictoryFanfare,
  stopVictoryOscillators,
} from "./celebrationSounds";
import { playNoiseBurst } from "./noiseBurst";
import {
  playTankDestroyedByExplosionSound,
  playTankSadBurialSound,
  playTankTouchLowestFloorSound,
} from "./tankSounds";
import type { EnsureAudioContext } from "./types";
import type { WeaponId } from "../../../types/weapon";
import {
  ALERT_FADE_OUT_SECONDS,
  ALERT_STOP_OFFSET_SECONDS,
  isFlightAlertWeapon,
  playFireSound,
  playFlightAlertSound,
  playImpactSound,
  type ActiveFlightAlert,
  type FlightAlertWeaponId,
} from "./weaponSounds";
import { playZeusAppointmentSound, playZeusStrikeSound } from "./zeusSounds";

/**
 * Audio de combat, extrait de GameEngine (#413).
 *
 * Chaque famille vit dans un module voisin. Les tirs et les impacts sont des
 * tables exhaustives par `WeaponId` : une arme sans entrée ne compile pas.
 * Pour ajouter ou modifier un son, suivre le README (« Ajouter ou modifier un
 * son ») et régénérer l'instantané seulement si le graphe change volontairement.
 */

const SLIDE_INTERVAL_MS = 82;
const ALERT_CLOSE_DRAIN_MS = 20;
const ALERT_CLOSE_FALLBACK_MS =
  Math.ceil(ALERT_STOP_OFFSET_SECONDS * 1000) + ALERT_CLOSE_DRAIN_MS + 5;
const ALERT_CLOSE_MAX_WAIT_MS = 120;

interface PendingFlightAlertFade {
  readonly context: AudioContext;
  readonly alert: ActiveFlightAlert;
  readonly weaponId: FlightAlertWeaponId;
  readonly fadeEndTime: number;
  readonly stopAtTime: number;
  readonly stoppedAtWallMs: number;
  cleanup: () => void;
}

interface PendingFlightAlertResume {
  readonly id: number;
  readonly context: AudioContext;
  readonly weaponId: FlightAlertWeaponId;
  cleanup: () => void;
}

export interface CombatAudioOptions {
  /** Largeur utilisée pour le panoramique stéréo des pops (même valeur que GameEngine.width). */
  getWidth: () => number;
  /** Fabrique injectable; par défaut window.AudioContext, null si indisponible. */
  createContext?: () => AudioContext | null;
  /** Horloge injectable pour la limitation de la glissade; par défaut performance.now(). */
  now?: () => number;
}

export class CombatAudio {
  private audioContext: AudioContext | null = null;
  private activeFlightAlert: ActiveFlightAlert | null = null;
  private readonly fadingFlightAlerts = new Set<PendingFlightAlertFade>();
  private pendingFlightAlertResume: PendingFlightAlertResume | null = null;
  private nextFlightAlertResumeId = 0;
  private readonly victoryOscillators: OscillatorNode[] = [];
  private cancelFinalChord: (() => void) | null = null;
  private readonly lastSlideTimes = new Map<string, number>();
  private readonly getWidth: () => number;
  private readonly createContext: () => AudioContext | null;
  private readonly now: () => number;

  constructor(options: CombatAudioOptions) {
    this.getWidth = options.getWidth;
    this.createContext = options.createContext ?? defaultAudioContext;
    this.now = options.now ?? (() => performance.now());
  }

  playFire(weaponId: WeaponId): void {
    this.stopFlightAlert();
    this.activeFlightAlert = playFireSound(this.ensureContext, weaponId);
  }

  stopFlightAlert(): void {
    this.cancelPendingFlightAlertResume();
    const alert = this.activeFlightAlert;
    if (!alert) {
      this.silenceNonRunningFadingFlightAlerts();
      return;
    }
    this.activeFlightAlert = null;
    const fadeEndTime = alert.stop();
    this.silenceNonRunningFadingFlightAlerts();
    const context = this.audioContext;
    if (!context || context.state !== "running" || fadeEndTime === null) return;
    const stopAtTime = fadeEndTime - ALERT_FADE_OUT_SECONDS + ALERT_STOP_OFFSET_SECONDS;
    const entry: PendingFlightAlertFade = {
      context,
      alert,
      weaponId: alert.weaponId,
      fadeEndTime,
      stopAtTime,
      stoppedAtWallMs: this.now(),
      cleanup: () => {},
    };
    const unsubscribeEnded =
      alert.onEnded?.(() => {
        this.removeFadingFlightAlert(entry);
      }) ?? null;
    const onStateChange = (): void => {
      if (context.state !== "running") {
        this.silenceAndRemoveFadingFlightAlert(entry);
      }
    };
    if (typeof context.addEventListener === "function") {
      context.addEventListener("statechange", onStateChange);
    }
    entry.cleanup = () => {
      unsubscribeEnded?.();
      if (typeof context.removeEventListener === "function") {
        context.removeEventListener("statechange", onStateChange);
      }
    };
    this.fadingFlightAlerts.add(entry);
  }

  /** Reprend uniquement l'alerte continue en vol (sans bruit de mise à feu), de façon idempotente. */
  resumeFlightAlert(weaponId: WeaponId, shouldResume?: () => boolean): void {
    if (!isFlightAlertWeapon(weaponId)) return;
    if (shouldResume && !shouldResume()) return;
    const context = this.ensureContext();
    if (!context || context.state === "closed") return;

    if (context.state === "running") {
      this.clearFadingFlightAlertsOutsideContext(context);
      if (this.activeFlightAlert?.weaponId === weaponId) {
        this.cancelPendingFlightAlertResume();
        return;
      }
      if (this.activeFlightAlert) {
        this.stopFlightAlert();
      }
      const blockingFade = this.getBlockingFade(context);
      if (!blockingFade) {
        this.cancelPendingFlightAlertResume();
        this.activeFlightAlert = playFlightAlertSound(this.ensureContext, weaponId);
        return;
      }
      this.deferFlightAlertResume(context, weaponId, shouldResume, blockingFade);
      return;
    }

    if (this.activeFlightAlert) {
      const current = this.activeFlightAlert;
      this.activeFlightAlert = null;
      current.stop();
    }
    this.silenceAllFadingFlightAlerts();
    this.deferFlightAlertResume(context, weaponId, shouldResume, null);
  }

  playImpact(weaponId: WeaponId): void {
    this.cancelPendingFlightAlertResume();
    if (this.activeFlightAlert?.weaponId === weaponId) {
      this.stopFlightAlert();
    }
    this.silenceNonRunningFadingFlightAlerts();
    const minStartTime = this.getImpactStartTime(weaponId);
    playImpactSound(this.ensureContext, weaponId, minStartTime);
  }

  playZeusAppointment(): void {
    playZeusAppointmentSound(this.ensureContext);
  }

  playZeusStrike(): void {
    playZeusStrikeSound(this.ensureContext);
  }

  playTankDestroyedByExplosion(): void {
    playTankDestroyedByExplosionSound(this.ensureContext);
  }

  playTankSadBurial(): void {
    playTankSadBurialSound(this.ensureContext);
  }

  playTankSliding(playerId: string): void {
    const now = this.now();
    const last = this.lastSlideTimes.get(playerId) ?? 0;
    if (now - last < SLIDE_INTERVAL_MS) return;
    this.lastSlideTimes.set(playerId, now);
    playNoiseBurst(this.ensureContext, 0.032, 0.075, 1950);
  }

  playTankTouchLowestFloor(): void {
    playTankTouchLowestFloorSound(this.ensureContext);
  }

  playVictoryFanfare(): void {
    this.cancelFinalChord?.();
    this.cancelFinalChord = playVictoryFanfare(
      this.ensureContext,
      this.victoryOscillators,
    );
  }

  stopVictoryMusic(): void {
    this.cancelFinalChord?.();
    this.cancelFinalChord = null;
    stopVictoryOscillators(this.victoryOscillators);
  }

  playFireworkPop(x: number): void {
    playFireworkPop(this.ensureContext, this.getWidth, x);
  }

  resetSlideThrottle(): void {
    this.lastSlideTimes.clear();
  }

  /** Arrête l'alerte de vol et la musique puis ferme l'AudioContext après le fondu éventuel (best effort). */
  dispose(): void {
    this.stopFlightAlert();
    this.stopVictoryMusic();
    const audioContext = this.audioContext;
    this.audioContext = null;
    const contextFades = [...this.fadingFlightAlerts];
    this.fadingFlightAlerts.clear();
    for (const entry of contextFades) {
      entry.cleanup();
    }
    if (!audioContext || audioContext.state === "closed") return;
    const latestFade = findLatestFadeForContext(contextFades, audioContext);
    if (latestFade && audioContext.state === "running") {
      const elapsedMs = Math.max(0, this.now() - latestFade.stoppedAtWallMs);
      const remainingFallbackMs = ALERT_CLOSE_FALLBACK_MS - elapsedMs;
      const remainingMaxWaitMs = ALERT_CLOSE_MAX_WAIT_MS - elapsedMs;
      if (remainingMaxWaitMs > 0) {
        closeAudioContextAfterFade(
          audioContext,
          latestFade.alert,
          Math.max(0, remainingFallbackMs),
          remainingMaxWaitMs,
        );
        return;
      }
    }
    if (audioContext.state !== "running") {
      for (const entry of contextFades) {
        if (entry.context === audioContext) {
          entry.alert.silenceImmediately?.();
        }
      }
    }
    closeAudioContextSafely(audioContext);
  }

  private deferFlightAlertResume(
    context: AudioContext,
    weaponId: FlightAlertWeaponId,
    shouldResume: (() => boolean) | undefined,
    initialBlockingFade: PendingFlightAlertFade | null,
  ): void {
    this.cancelPendingFlightAlertResume();
    const id = ++this.nextFlightAlertResumeId;
    const completedFades = new Set<PendingFlightAlertFade>();
    let fadeTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeFadeEnded: (() => void) | null = null;
    let resumeRequested = false;
    let targetMinStartTime = initialBlockingFade?.stopAtTime ?? 0;

    const clearFadeWait = (): void => {
      if (fadeTimer !== null) {
        clearTimeout(fadeTimer);
        fadeTimer = null;
      }
      unsubscribeFadeEnded?.();
      unsubscribeFadeEnded = null;
    };

    const requestContextResume = (): void => {
      if (resumeRequested) return;
      resumeRequested = true;
      if (typeof context.resume !== "function") return;
      try {
        const result = context.resume();
        if (result && typeof result.then === "function") {
          void result.then(() => {
            tryStart();
          }, () => {
            // La reprise peut rester en attente jusqu'au prochain geste ou changement d'état.
          });
        }
      } catch {
        // Ignore synchronous resume errors while statechange listener remains armed.
      }
    };

    const armFadeWait = (fade: PendingFlightAlertFade): void => {
      clearFadeWait();
      targetMinStartTime = Math.max(targetMinStartTime, fade.stopAtTime);
      unsubscribeFadeEnded =
        fade.alert.onEnded?.(() => {
          tryStart(fade);
        }) ?? null;
      const remainingMs = Math.max(
        1,
        Math.ceil((fade.stopAtTime - context.currentTime) * 1000 - 1e-6),
      );
      fadeTimer = setTimeout(() => {
        tryStart(fade);
      }, remainingMs);
    };

    const onStateChange = (): void => {
      tryStart();
    };

    const cleanup = (): void => {
      clearFadeWait();
      if (typeof context.removeEventListener === "function") {
        context.removeEventListener("statechange", onStateChange);
      }
    };

    const tryStart = (completedFade?: PendingFlightAlertFade): void => {
      if (this.pendingFlightAlertResume?.id !== id) return;
      if (completedFade) {
        completedFades.add(completedFade);
      }
      if (this.audioContext !== context || context.state === "closed") {
        this.cancelPendingFlightAlertResume();
        return;
      }
      if (context.state !== "running") {
        clearFadeWait();
        this.silenceFadingFlightAlertsForContext(context);
        targetMinStartTime = 0;
        requestContextResume();
        return;
      }
      const nextBlocking = this.getBlockingFade(context, completedFades);
      if (nextBlocking) {
        armFadeWait(nextBlocking);
        return;
      }
      this.cancelPendingFlightAlertResume();
      if (shouldResume && !shouldResume()) return;
      if (this.activeFlightAlert?.weaponId === weaponId) return;
      if (this.activeFlightAlert) {
        this.stopFlightAlert();
      }
      const minStartTime =
        targetMinStartTime > context.currentTime ? targetMinStartTime : undefined;
      this.activeFlightAlert = playFlightAlertSound(this.ensureContext, weaponId, minStartTime);
    };

    const pending: PendingFlightAlertResume = {
      id,
      context,
      weaponId,
      cleanup,
    };
    if (typeof context.addEventListener === "function") {
      context.addEventListener("statechange", onStateChange);
    }
    this.pendingFlightAlertResume = pending;

    if (initialBlockingFade) {
      armFadeWait(initialBlockingFade);
      return;
    }
    requestContextResume();
  }

  private removeFadingFlightAlert(entry: PendingFlightAlertFade): void {
    if (!this.fadingFlightAlerts.delete(entry)) return;
    entry.cleanup();
  }

  private silenceAndRemoveFadingFlightAlert(entry: PendingFlightAlertFade): void {
    this.removeFadingFlightAlert(entry);
    entry.alert.silenceImmediately?.();
  }

  private silenceNonRunningFadingFlightAlerts(): void {
    for (const entry of [...this.fadingFlightAlerts]) {
      if (entry.context.state !== "running") {
        this.silenceAndRemoveFadingFlightAlert(entry);
      }
    }
  }

  private silenceFadingFlightAlertsForContext(context: AudioContext): void {
    for (const entry of [...this.fadingFlightAlerts]) {
      if (entry.context === context) {
        this.silenceAndRemoveFadingFlightAlert(entry);
      }
    }
  }

  private silenceAllFadingFlightAlerts(): void {
    for (const entry of [...this.fadingFlightAlerts]) {
      this.silenceAndRemoveFadingFlightAlert(entry);
    }
  }

  private clearFadingFlightAlertsOutsideContext(context: AudioContext): void {
    for (const entry of [...this.fadingFlightAlerts]) {
      if (entry.context !== context) {
        this.removeFadingFlightAlert(entry);
      }
    }
  }

  private getBlockingFade(
    context: AudioContext,
    excludedFades?: ReadonlySet<PendingFlightAlertFade>,
  ): PendingFlightAlertFade | null {
    let blocking: PendingFlightAlertFade | null = null;
    for (const entry of [...this.fadingFlightAlerts]) {
      if (entry.context !== context) continue;
      if (context.state !== "running") {
        this.silenceAndRemoveFadingFlightAlert(entry);
        continue;
      }
      if (excludedFades?.has(entry)) continue;
      if (entry.stopAtTime <= context.currentTime) continue;
      if (!blocking || entry.stopAtTime >= blocking.stopAtTime) {
        blocking = entry;
      }
    }
    return blocking;
  }

  private cancelPendingFlightAlertResume(): void {
    const pending = this.pendingFlightAlertResume;
    if (!pending) return;
    this.pendingFlightAlertResume = null;
    pending.cleanup();
  }

  private getImpactStartTime(weaponId: WeaponId): number | undefined {
    if (!isFlightAlertWeapon(weaponId)) return undefined;
    const context = this.audioContext;
    if (!context || context.state !== "running") return undefined;
    let latestFadeEnd: number | undefined;
    for (const entry of this.fadingFlightAlerts) {
      if (entry.context !== context || entry.weaponId !== weaponId) continue;
      if (entry.fadeEndTime <= context.currentTime) continue;
      if (latestFadeEnd === undefined || entry.fadeEndTime > latestFadeEnd) {
        latestFadeEnd = entry.fadeEndTime;
      }
    }
    return latestFadeEnd;
  }

  private readonly ensureContext: EnsureAudioContext = () => {
    if (this.audioContext) return this.audioContext;
    try {
      const created = this.createContext();
      if (!created) return null;
      this.audioContext = created;
      return created;
    } catch {
      return null;
    }
  };
}

function findLatestFadeForContext(
  fades: readonly PendingFlightAlertFade[],
  audioContext: AudioContext,
): PendingFlightAlertFade | null {
  let latest: PendingFlightAlertFade | null = null;
  for (const entry of fades) {
    if (entry.context !== audioContext) continue;
    if (!latest || entry.stopAtTime >= latest.stopAtTime) {
      latest = entry;
    }
  }
  return latest;
}

function closeAudioContextSafely(audioContext: AudioContext): void {
  if (audioContext.state === "closed") return;
  try {
    void audioContext.close().catch(() => {
      // Audio teardown is best-effort during React unmount.
    });
  } catch {
    // Ignore synchronous close errors on torn-down contexts.
  }
}

function closeAudioContextAfterFade(
  audioContext: AudioContext,
  alert: ActiveFlightAlert,
  fallbackMs: number,
  maxWaitMs: number,
): void {
  let finished = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeEnded: (() => void) | null = null;

  const onStateChange = (): void => {
    if (audioContext.state !== "running") {
      finish();
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (maxTimer !== null) {
      clearTimeout(maxTimer);
      maxTimer = null;
    }
    unsubscribeEnded?.();
    unsubscribeEnded = null;
    if (typeof audioContext.removeEventListener === "function") {
      audioContext.removeEventListener("statechange", onStateChange);
    }
    closeAudioContextSafely(audioContext);
  };

  if (audioContext.state !== "running") {
    finish();
    return;
  }

  if (typeof audioContext.addEventListener === "function") {
    audioContext.addEventListener("statechange", onStateChange);
  }

  unsubscribeEnded =
    alert.onEnded?.(() => {
      if (finished) return;
      if (audioContext.state !== "running") {
        finish();
        return;
      }
      if (drainTimer === null) {
        drainTimer = setTimeout(finish, ALERT_CLOSE_DRAIN_MS);
      }
    }) ?? null;

  if (unsubscribeEnded) {
    maxTimer = setTimeout(finish, maxWaitMs);
    return;
  }

  if (fallbackMs <= 0) {
    finish();
    return;
  }
  maxTimer = setTimeout(finish, Math.min(fallbackMs, maxWaitMs));
}

export function defaultAudioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
    return null;
  }
  return new window.AudioContext();
}
