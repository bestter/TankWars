export interface RNG {
  /** Return a number in [0, 1) */
  next(): number;
}

/** Default implementation using Web Crypto (browser + Cloudflare Workers compatible). */
function defaultSecureRandom(): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] / (0xffffffff + 1);
}

const defaultRNG: RNG = { next: defaultSecureRandom };

let currentRNG: RNG = defaultRNG;

/**
 * The function used everywhere for random in simulation.
 * It delegates to the currently injected RNG (allows server to use a seeded one for determinism).
 */
export function secureRandom(): number {
  return currentRNG.next();
}

/** Allow injecting a different RNG (seeded for deterministic server simulation / replays). */
export function setRNG(rng: RNG): void {
  currentRNG = rng;
}

/** Reset to the default secure crypto RNG. */
export function resetRNG(): void {
  currentRNG = defaultRNG;
}

/** The active RNG (use this instead of calling secureRandom directly in simulation paths). */
export function getRNG(): RNG {
  return currentRNG;
}

/**
 * Simple seeded PRNG (mulberry32). Good enough for game simulation determinism.
 * Use on the server (DO) when running authoritative fast-forward so clients can replay
 * the exact same random sequence for visual effects if they receive the seed.
 */
export function createSeededRNG(seed: number): RNG {
  let s = seed >>> 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
