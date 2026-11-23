import type { WeaponId } from "../../../types/weapon";
import { playNoiseBurst } from "./noiseBurst";
import type { EnsureAudioContext } from "./types";

/**
 * Tables exhaustives : une arme ajoutée à `WeaponId` sans entrée fait échouer
 * le build. BULLET et BULLDOZER restent muets au tir, explicitement.
 * Les armes nucléaires retournent une poignée d'alerte continue en vol.
 * Le guide est dans le README, section « Ajouter ou modifier un son ».
 */

export type FlightAlertWeaponId = "NUKE" | "THERMONUCLEAR";

export function isFlightAlertWeapon(weaponId: WeaponId): weaponId is FlightAlertWeaponId {
  return weaponId === "NUKE" || weaponId === "THERMONUCLEAR";
}

export interface ActiveFlightAlert {
  readonly weaponId: FlightAlertWeaponId;
  stop(): void;
}

type WeaponFireSound = (
  ctx: AudioContext,
  ensure: EnsureAudioContext,
  now: number,
) => ActiveFlightAlert | null;

type FlightAlertSound = (
  ctx: AudioContext,
  now: number,
) => ActiveFlightAlert;

type WeaponImpactSound = (
  ctx: AudioContext,
  ensure: EnsureAudioContext,
  now: number,
) => void;

const ALERT_FADE_OUT_SECONDS = 0.025;
const ALERT_STOP_OFFSET_SECONDS = 0.03;

function createFlightAlertHandle(
  weaponId: FlightAlertWeaponId,
  ctx: AudioContext,
  masterGain: GainNode,
  stopGain: GainNode,
  oscillators: readonly OscillatorNode[],
): ActiveFlightAlert {
  let stopped = false;
  return {
    weaponId,
    stop(): void {
      if (stopped) return;
      stopped = true;
      let stopAt: number | undefined;
      try {
        const stopTime = ctx.currentTime;
        stopAt = stopTime + ALERT_STOP_OFFSET_SECONDS;
        if (typeof masterGain.gain.cancelAndHoldAtTime === "function") {
          try {
            masterGain.gain.cancelAndHoldAtTime(stopTime);
          } catch {
            /* ignore */
          }
        }
        stopGain.gain.setValueAtTime(1, stopTime);
        stopGain.gain.linearRampToValueAtTime(0, stopTime + ALERT_FADE_OUT_SECONDS);
      } catch {
        /* ignore */
      }
      for (const osc of oscillators) {
        try {
          osc.stop(stopAt);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function playSilentFire(): null {
  // Aucun oscillateur et aucun bruit : le contexte a déjà été demandé par l'appelant.
  return null;
}

function playMissileFire(ctx: AudioContext, ensure: EnsureAudioContext, now: number): null {
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
  return null;
}

function playGrenadeFire(ctx: AudioContext, ensure: EnsureAudioContext, now: number): null {
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
  return null;
}

function playClusterFire(_ctx: AudioContext, ensure: EnsureAudioContext): null {
  // Multiple small noisy "submunition release" pops — not clean chirps
  for (let k = 0; k < 4; k++) {
    playNoiseBurst(ensure, 0.045, 0.15, 2600 + k * 120, 900);
  }
  return null;
}

function startNukeFlightAlert(
  ctx: AudioContext,
  now: number,
): ActiveFlightAlert {
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const lfo = ctx.createOscillator();
  const voiceGain1 = ctx.createGain();
  const voiceGain2 = ctx.createGain();
  const lfoGain1 = ctx.createGain();
  const lfoGain2 = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const masterGain = ctx.createGain();
  const stopGain = ctx.createGain();

  osc1.type = "sawtooth";
  osc1.frequency.value = 690;
  osc2.type = "triangle";
  osc2.frequency.value = 920;

  lfo.type = "sine";
  lfo.frequency.value = 2.6;
  lfoGain1.gain.value = 155;
  lfoGain2.gain.value = 195;

  voiceGain1.gain.value = 0.65;
  voiceGain2.gain.value = 0.35;

  filter.type = "lowpass";
  filter.frequency.value = 1650;

  masterGain.gain.value = 0.0005;
  masterGain.gain.setValueAtTime(0.0005, now);
  masterGain.gain.linearRampToValueAtTime(0.14, now + 0.045);
  stopGain.gain.value = 1;

  lfo.connect(lfoGain1);
  lfoGain1.connect(osc1.frequency);
  lfo.connect(lfoGain2);
  lfoGain2.connect(osc2.frequency);

  osc1.connect(voiceGain1);
  voiceGain1.connect(filter);
  osc2.connect(voiceGain2);
  voiceGain2.connect(filter);
  filter.connect(masterGain);
  masterGain.connect(stopGain);
  stopGain.connect(ctx.destination);

  osc1.start(now);
  osc2.start(now);
  lfo.start(now);

  return createFlightAlertHandle("NUKE", ctx, masterGain, stopGain, [osc1, osc2, lfo]);
}

function playNukeFire(
  ctx: AudioContext,
  ensure: EnsureAudioContext,
  now: number,
): ActiveFlightAlert {
  // Short launch ignition thump + continuous shrill Cold War air-raid alert in flight
  playNoiseBurst(ensure, 0.14, 0.16, 680, 180);
  return startNukeFlightAlert(ctx, now);
}

function startThermonuclearFlightAlert(
  ctx: AudioContext,
  now: number,
): ActiveFlightAlert {
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const lfoFreq = ctx.createOscillator();
  const lfoFilter = ctx.createOscillator();
  const voiceGain1 = ctx.createGain();
  const voiceGain2 = ctx.createGain();
  const lfoFreqGain1 = ctx.createGain();
  const lfoFreqGain2 = ctx.createGain();
  const lfoFilterGain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const masterGain = ctx.createGain();
  const stopGain = ctx.createGain();

  osc1.type = "sawtooth";
  osc1.frequency.value = 310;
  osc2.type = "square";
  osc2.frequency.value = 440;

  lfoFreq.type = "triangle";
  lfoFreq.frequency.value = 0.95;
  lfoFreqGain1.gain.value = 72;
  lfoFreqGain2.gain.value = 96;

  lfoFilter.type = "sine";
  lfoFilter.frequency.value = 1.9;
  lfoFilterGain.gain.value = 320;

  voiceGain1.gain.value = 0.62;
  voiceGain2.gain.value = 0.38;

  filter.type = "lowpass";
  filter.frequency.value = 920;

  masterGain.gain.value = 0.0005;
  masterGain.gain.setValueAtTime(0.0005, now);
  masterGain.gain.linearRampToValueAtTime(0.15, now + 0.06);
  stopGain.gain.value = 1;

  lfoFreq.connect(lfoFreqGain1);
  lfoFreqGain1.connect(osc1.frequency);
  lfoFreq.connect(lfoFreqGain2);
  lfoFreqGain2.connect(osc2.frequency);
  lfoFilter.connect(lfoFilterGain);
  lfoFilterGain.connect(filter.frequency);

  osc1.connect(voiceGain1);
  voiceGain1.connect(filter);
  osc2.connect(voiceGain2);
  voiceGain2.connect(filter);
  filter.connect(masterGain);
  masterGain.connect(stopGain);
  stopGain.connect(ctx.destination);

  osc1.start(now);
  osc2.start(now);
  lfoFreq.start(now);
  lfoFilter.start(now);

  return createFlightAlertHandle("THERMONUCLEAR", ctx, masterGain, stopGain, [
    osc1,
    osc2,
    lfoFreq,
    lfoFilter,
  ]);
}

function playThermonuclearFire(
  ctx: AudioContext,
  ensure: EnsureAudioContext,
  now: number,
): ActiveFlightAlert {
  // Brief heavy launch thump + continuous deep ominous Cold War tritone klaxon (distinct from NUKE)
  playNoiseBurst(ensure, 0.18, 0.18, 500, 110);
  return startThermonuclearFlightAlert(ctx, now);
}

function playDrillerFire(ctx: AudioContext, ensure: EnsureAudioContext, now: number): null {
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
  return null;
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
} satisfies Record<WeaponId, WeaponFireSound>;

const FLIGHT_ALERT_SOUNDS = {
  NUKE: startNukeFlightAlert,
  THERMONUCLEAR: startThermonuclearFlightAlert,
} satisfies Record<FlightAlertWeaponId, FlightAlertSound>;

export function playFlightAlertSound(
  ensure: EnsureAudioContext,
  weaponId: FlightAlertWeaponId,
): ActiveFlightAlert | null {
  const ctx = ensure();
  if (!ctx) return null;
  try {
    return FLIGHT_ALERT_SOUNDS[weaponId](ctx, ctx.currentTime);
  } catch {
    /* silent */
    return null;
  }
}

export function playFireSound(
  ensure: EnsureAudioContext,
  weaponId: WeaponId,
): ActiveFlightAlert | null {
  const ctx = ensure();
  if (!ctx) return null;
  try {
    const now = ctx.currentTime;
    // Goal: move away from clean PONG-style square/saw beeps toward short, noisy, percussive
    // "launch reports" in the spirit of old TankWars / Scorched Earth on NES/ATARI-era hardware,
    // with continuous Cold War flight alerts for NUKE and THERMONUCLEAR.
    return FIRE_SOUNDS[weaponId](ctx, ensure, now);
  } catch {
    /* silent */
    return null;
  }
}

function playThermonuclearImpact(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // Massive multi-wave megaton detonation: shockfront + secondary blast + seismic fallout
  // Controlled headroom so it stays imposing and distinct from NUKE without saturating.
  playNoiseBurst(ensure, 1.15, 0.3, 2200, 55);
  playNoiseBurst(ensure, 0.95, 0.22, 1100, 42, 0.22);
  playNoiseBurst(ensure, 0.8, 0.14, 420, 30, 0.52);

  // Primary deep sub-bass drop
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "triangle";
  osc1.frequency.value = 62;
  gain1.gain.value = 0.3;
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.frequency.setValueAtTime(62, now);
  osc1.frequency.linearRampToValueAtTime(22, now + 0.85);
  gain1.gain.setValueAtTime(0.3, now);
  gain1.gain.linearRampToValueAtTime(0.00015, now + 1.25);
  osc1.stop(now + 1.32);

  // Delayed filtered tectonic rumble harmonic
  const osc2 = ctx.createOscillator();
  const filter2 = ctx.createBiquadFilter();
  const gain2 = ctx.createGain();
  osc2.type = "sawtooth";
  osc2.frequency.value = 46;
  filter2.type = "lowpass";
  filter2.frequency.value = 320;
  gain2.gain.value = 0.16;
  osc2.connect(filter2);
  filter2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now + 0.1);
  osc2.frequency.setValueAtTime(46, now + 0.1);
  osc2.frequency.linearRampToValueAtTime(19, now + 1.15);
  filter2.frequency.setValueAtTime(320, now + 0.1);
  filter2.frequency.linearRampToValueAtTime(80, now + 1.2);
  gain2.gain.setValueAtTime(0.16, now + 0.1);
  gain2.gain.linearRampToValueAtTime(0.0001, now + 1.3);
  osc2.stop(now + 1.38);
}

function playNukeImpact(ctx: AudioContext, ensure: EnsureAudioContext, now: number): void {
  // Recognizable two-stage nuclear detonation: crisp shockfront + echo + bass punch + crackle
  playNoiseBurst(ensure, 0.72, 0.28, 2400, 110);
  playNoiseBurst(ensure, 0.55, 0.18, 950, 65, 0.16);

  // Nuclear bass punch with downward pitch drop
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "triangle";
  osc1.frequency.value = 88;
  gain1.gain.value = 0.28;
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.frequency.setValueAtTime(88, now);
  osc1.frequency.linearRampToValueAtTime(34, now + 0.45);
  gain1.gain.setValueAtTime(0.28, now);
  gain1.gain.linearRampToValueAtTime(0.0002, now + 0.72);
  osc1.stop(now + 0.78);

  // Filtered fallout roar texture
  const osc2 = ctx.createOscillator();
  const filter2 = ctx.createBiquadFilter();
  const gain2 = ctx.createGain();
  osc2.type = "sawtooth";
  osc2.frequency.value = 145;
  filter2.type = "lowpass";
  filter2.frequency.value = 520;
  gain2.gain.value = 0.11;
  osc2.connect(filter2);
  filter2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now);
  osc2.frequency.setValueAtTime(145, now);
  osc2.frequency.linearRampToValueAtTime(48, now + 0.52);
  filter2.frequency.setValueAtTime(520, now);
  filter2.frequency.linearRampToValueAtTime(120, now + 0.56);
  gain2.gain.setValueAtTime(0.11, now);
  gain2.gain.linearRampToValueAtTime(0.0002, now + 0.58);
  osc2.stop(now + 0.64);
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
} satisfies Record<WeaponId, WeaponImpactSound>;

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
