import { playNoiseBurst } from "./noiseBurst";
import type { EnsureAudioContext } from "./types";

export function playZeusAppointmentSound(ensure: EnsureAudioContext): void {
  const ctx = ensure();
  if (!ctx) return;
  try {
    playNoiseBurst(ensure, 0.24, 0.3, 1100, 90);
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(92, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(42, ctx.currentTime + 0.28);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.31);
  } catch {
    // Audio is optional and must never interrupt combat.
  }
}

export function playZeusStrikeSound(ensure: EnsureAudioContext): void {
  const ctx = ensure();
  if (!ctx) return;
  try {
    playNoiseBurst(ensure, 0.18, 0.45, 3200, 120);
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(180, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(48, ctx.currentTime + 0.22);
    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.24);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.25);
  } catch {
    // Audio is optional and must never interrupt combat.
  }
}
