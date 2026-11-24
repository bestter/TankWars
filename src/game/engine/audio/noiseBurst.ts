import type { EnsureAudioContext, ScheduleAudioSource } from "./types";

/**
 * Bruit LFSR 16 bits (graine `0xace1`, prises 0, 2, 3 et 5), passe-bas,
 * balayage seulement si `sweepTo > 0`. Le `try/catch` reste local : une erreur
 * ici n'interrompt pas le reste du son appelant.
 */
export function playNoiseBurst(
  ensure: EnsureAudioContext,
  duration: number,
  volume: number,
  cutoff: number,
  sweepTo?: number,
  startOffset = 0,
): void {
  const ctx = ensure();
  if (!ctx) return;
  prepareNoiseBurst(ctx, (start) => start(ctx.currentTime), duration, volume, cutoff, sweepTo, startOffset);
}

export function prepareNoiseBurst(
  ctx: AudioContext,
  schedule: ScheduleAudioSource,
  duration: number,
  volume: number,
  cutoff: number,
  sweepTo?: number,
  startOffset = 0,
): void {
  try {
    const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);

    // Simple 16-bit LFSR for grittier, more "console noise channel" character (periodicity + buzz)
    // instead of modern white noise. This helps the "NES/ATARI but realistic" feel.
    let lfsr = 0xace1 >>> 0;
    for (let i = 0; i < len; i++) {
      // 16-bit LFSR with common taps (0, 2, 3, 5) for decent length sequence
      const bit = ((lfsr >> 0) ^ (lfsr >> 2) ^ (lfsr >> 3) ^ (lfsr >> 5)) & 1;
      lfsr = ((lfsr >>> 1) | (bit << 15)) >>> 0;
      data[i] = lfsr & 1 ? 0.9 : -0.9; // slightly less than full scale for headroom when layered
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;

    const gain = ctx.createGain();
    gain.gain.value = volume;

    schedule((time) => {
      const t = time + Math.max(0, startOffset);
      gain.gain.setValueAtTime(volume, t);
      gain.gain.linearRampToValueAtTime(0.0004, t + duration);

      // Optional downward sweep for an explosion that blooms, then settles.
      if (sweepTo !== undefined && sweepTo > 0) {
        filter.frequency.setValueAtTime(cutoff, t);
        filter.frequency.linearRampToValueAtTime(sweepTo, t + duration * 0.9);
      }
      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start(t);
    });
  } catch {
    /* silent */
  }
}
