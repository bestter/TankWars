import { playNoiseBurst } from "./noiseBurst";
import type { EnsureAudioContext } from "./types";

export function playTankDestroyedByExplosionSound(ensure: EnsureAudioContext): void {
  const ctx = ensure();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;

    // Tank vaporized by direct/splash hit — big noisy boom + debris crackle
    // Primary is a longer LFSR noise with strong downward sweep
    playNoiseBurst(ensure, 0.38, 0.29, 2400, 180);

    // Low dirty body (triangle for that old console bass thump)
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 58;
    gain.gain.value = 0.32;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    gain.gain.setValueAtTime(0.32, now);
    gain.gain.linearRampToValueAtTime(0.0003, now + 0.42);
    osc.stop(now + 0.48);
  } catch {
    /* silent */
  }
}

export function playTankSadBurialSound(ensure: EnsureAudioContext): void {
  const ctx = ensure();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;

    // Burial / falling off the bottom: slow noisy "whoosh of falling into the pit"
    // + final wet/muffled splat. Much less musical, more "realistic old game" dirt sound.
    // Long filtered noise sweep down (air + dirt falling)
    playNoiseBurst(ensure, 0.65, 0.22, 1450, 95);

    // Final low "splat into the abyss" — reuse the floor thump character but softer/sadder
    const t2 = now + 0.48;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 48;
    gain.gain.value = 0.21;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t2);
    gain.gain.setValueAtTime(0.21, t2);
    gain.gain.linearRampToValueAtTime(0.0002, t2 + 0.38);
    osc.stop(t2 + 0.45);

    // Extra low muffled tail for the "sinking" finality (scheduled via offset)
    playNoiseBurst(ensure, 0.32, 0.14, 260, 80, 0.52);
  } catch {
    /* silent */
  }
}

export function playTankTouchLowestFloorSound(ensure: EnsureAudioContext): void {
  const ctx = ensure();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    // Heavy low thump — keep the character the user liked, but use triangle + swept LFSR noise
    // for a bit more "dirt" while staying percussive and satisfying.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 48;
    gain.gain.value = 0.36;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    gain.gain.setValueAtTime(0.36, now);
    gain.gain.linearRampToValueAtTime(0.0003, now + 0.38);
    osc.stop(now + 0.45);

    // Muffled impact noise with a little sweep
    playNoiseBurst(ensure, 0.26, 0.19, 380, 110);
  } catch {
    /* silent */
  }
}
