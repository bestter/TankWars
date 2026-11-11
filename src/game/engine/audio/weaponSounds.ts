import type { WeaponId } from "../../../types/weapon";
import { playNoiseBurst } from "./noiseBurst";
import type { EnsureAudioContext } from "./types";

/**
 * Tables exhaustives : une arme ajoutée à `WeaponId` sans entrée fait échouer
 * le build. BULLET et BULLDOZER restent muets au tir, explicitement.
 * Le guide est dans le README, section « Ajouter ou modifier un son ».
 */

type WeaponSound = (
  ctx: AudioContext,
  ensure: EnsureAudioContext,
  now: number,
) => void;

function playSilentFire(): void {
  // Aucun oscillateur et aucun bruit : le contexte a déjà été demandé par l'appelant.
}

function playMissileFire(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // Classic rocket launch: mid noise whoosh + quick low "thump" body
  playNoiseBurst(ensure, 0.09, 0.22, 1800, 420);
  // subtle low end "report"
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle"; // more "NES triangle channel" feel than sine
  osc.frequency.value = 95;
  gain.gain.value = 0.18;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  gain.gain.setValueAtTime(0.18, now);
  gain.gain.linearRampToValueAtTime(0.0005, now + 0.07);
  osc.stop(now + 0.09);
}

function playGrenadeFire(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // Lobbed: shorter, slightly higher noise "pop" with a little tail
  playNoiseBurst(ensure, 0.07, 0.26, 2400, 650);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.value = 140;
  gain.gain.value = 0.15;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.linearRampToValueAtTime(0.0004, now + 0.09);
  osc.stop(now + 0.11);
}

function playClusterFire(_ctx: AudioContext, ensure: EnsureAudioContext): void {
  // Multiple small noisy "submunition release" pops — not clean chirps
  for (let k = 0; k < 4; k++) {
    playNoiseBurst(ensure, 0.045, 0.15, 2600 + k * 120, 900);
  }
}

function playNukeFire(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // Deep heavy launch rumble
  playNoiseBurst(ensure, 0.28, 0.28, 650, 140);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = 55;
  gain.gain.value = 0.35;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  gain.gain.setValueAtTime(0.35, now);
  gain.gain.linearRampToValueAtTime(0.0003, now + 0.26);
  osc.stop(now + 0.32);
}

function playThermonuclearFire(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // Massive thermonuclear launch — deeper/longer than nuke
  playNoiseBurst(ensure, 0.36, 0.33, 520, 85);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = 38;
  gain.gain.value = 0.38;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  gain.gain.setValueAtTime(0.38, now);
  gain.gain.linearRampToValueAtTime(0.0002, now + 0.38);
  osc.stop(now + 0.42);
}

function playDrillerFire(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // Rapid noisy "drilling / boring" texture — series of gritty ticks
  for (let k = 0; k < 5; k++) {
    playNoiseBurst(ensure, 0.028, 0.18, 3200 - k * 180, 1100);
  }
  // low "motor" hum underneath
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.value = 85;
  gain.gain.value = 0.12;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.frequency.setValueAtTime(85, now);
  osc.frequency.linearRampToValueAtTime(72, now + 0.12);
  gain.gain.setValueAtTime(0.12, now);
  gain.gain.linearRampToValueAtTime(0.0004, now + 0.13);
  osc.stop(now + 0.15);
}

const FIRE_SOUNDS = {
  MISSILE: playMissileFire,
  GRENADE: playGrenadeFire,
  CLUSTER: playClusterFire,
  NUKE: playNukeFire,
  THERMONUCLEAR: playThermonuclearFire,
  DRILLER: playDrillerFire,
  BULLET: playSilentFire,
  BULLDOZER: playSilentFire,
} satisfies Record<WeaponId, WeaponSound>;

export function playFireSound(ensure: EnsureAudioContext, weaponId: WeaponId): void {
  const ctx = ensure();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    // Goal: move away from clean PONG-style square/saw beeps toward short, noisy, percussive
    // "launch reports" in the spirit of old TankWars / Scorched Earth on NES/ATARI-era hardware.
    // Heavy use of noise (LFSR) + a little low tone for body. Short, gritty, not melodic.
    FIRE_SOUNDS[weaponId](ctx, ensure, now);
  } catch {
    /* silent */
  }
}

function playThermonuclearImpact(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // HUGE bomb sound: long multi-layer nuclear rumble + aftershocks (deeper + longer than nuke)
  playNoiseBurst(ensure, 0.82, 0.39, 1750, 48);
  playNoiseBurst(ensure, 0.62, 0.28, 880, 35, 0.18);
  // deep body layers
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "triangle";
  osc1.frequency.value = 32;
  gain1.gain.value = 0.46;
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  gain1.gain.setValueAtTime(0.46, now);
  gain1.gain.linearRampToValueAtTime(0.00015, now + 0.85);
  osc1.stop(now + 0.92);

  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "sawtooth";
  osc2.frequency.value = 28;
  gain2.gain.value = 0.22;
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now + 0.12);
  osc2.frequency.setValueAtTime(28, now + 0.12);
  osc2.frequency.linearRampToValueAtTime(22, now + 0.75);
  gain2.gain.setValueAtTime(0.22, now + 0.12);
  gain2.gain.linearRampToValueAtTime(0.0001, now + 0.95);
  osc2.stop(now + 1.0);
}

function playNukeImpact(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // Huge dirty explosion
  playNoiseBurst(ensure, 0.55, 0.32, 2100, 95);
  // very low body
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = 42;
  gain.gain.value = 0.42;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  gain.gain.setValueAtTime(0.42, now);
  gain.gain.linearRampToValueAtTime(0.0002, now + 0.6);
  osc.stop(now + 0.7);
}

function playClusterImpact(_ctx: AudioContext, ensure: EnsureAudioContext): void {
  // Several small noisy secondary blasts
  for (let k = 0; k < 3; k++) {
    playNoiseBurst(ensure, 0.13, 0.18, 2800, 420);
  }
}

function playStandardImpact(
  ctx: AudioContext,
  ensure: EnsureAudioContext,
  now: number,
  startCut: number,
  endCut: number,
): void {
  // Standard missile/grenade/driller/bullet/bulldozer hit
  playNoiseBurst(ensure, 0.22, 0.26, startCut, endCut);

  // light low body
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = 78;
  gain.gain.value = 0.17;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  gain.gain.setValueAtTime(0.17, now);
  gain.gain.linearRampToValueAtTime(0.0003, now + 0.18);
  osc.stop(now + 0.22);
}

const IMPACT_SOUNDS = {
  THERMONUCLEAR: playThermonuclearImpact,
  NUKE: playNukeImpact,
  CLUSTER: playClusterImpact,
  MISSILE: (ctx, ensure, now) => playStandardImpact(ctx, ensure, now, 1950, 160),
  GRENADE: (ctx, ensure, now) => playStandardImpact(ctx, ensure, now, 1950, 380),
  DRILLER: (ctx, ensure, now) => playStandardImpact(ctx, ensure, now, 3200, 160),
  BULLET: (ctx, ensure, now) => playStandardImpact(ctx, ensure, now, 1950, 160),
  BULLDOZER: (ctx, ensure, now) => playStandardImpact(ctx, ensure, now, 1950, 160),
} satisfies Record<WeaponId, WeaponSound>;

export function playImpactSound(ensure: EnsureAudioContext, weaponId: WeaponId): void {
  const ctx = ensure();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;

    // Make impacts feel like real old-school artillery hits: the noise is the star.
    // Use LFSR noise + downward filter sweep (bright crackle → low rumble).
    // Only a little low triangle body for the "oomph", not a clean pongy tone.
    IMPACT_SOUNDS[weaponId](ctx, ensure, now);
  } catch {
    /* silent */
  }
}
