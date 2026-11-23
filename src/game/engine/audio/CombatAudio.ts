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
  playFireSound,
  playImpactSound,
  type ActiveFlightAlert,
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
    const alert = this.activeFlightAlert;
    if (!alert) return;
    this.activeFlightAlert = null;
    alert.stop();
  }

  playImpact(weaponId: WeaponId): void {
    if (this.activeFlightAlert?.weaponId === weaponId) {
      this.stopFlightAlert();
    }
    playImpactSound(this.ensureContext, weaponId);
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

  /** Arrête l'alerte de vol et la musique puis ferme l'AudioContext (best effort). */
  dispose(): void {
    this.stopFlightAlert();
    this.stopVictoryMusic();
    const audioContext = this.audioContext;
    this.audioContext = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {
        // Audio teardown is best-effort during React unmount.
      });
    }
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

export function defaultAudioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
    return null;
  }
  return new window.AudioContext();
}
