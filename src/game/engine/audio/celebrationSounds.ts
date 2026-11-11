import { secureRandom } from "../../../utils/random";
import type { EnsureAudioContext } from "./types";

export function stopVictoryOscillators(oscillators: OscillatorNode[]): void {
  oscillators.forEach((osc) => {
    try {
      osc.stop();
    } catch {
      /* ignore */
    }
  });
  oscillators.length = 0;
}

export function playVictoryFanfare(
  ensure: EnsureAudioContext,
  oscillators: OscillatorNode[],
): () => void {
  const ctx = ensure();
  if (!ctx) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  try {
    const notes = [60, 64, 67, 72, 76, 79, 84]; // C major arpeggio (joyful)
    const noteDuration = 0.18;

    stopVictoryOscillators(oscillators);

    notes.forEach((midiNote, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      const frequency = 440 * 2 ** ((midiNote - 69) / 12);

      osc.type = "sawtooth";
      osc.frequency.value = frequency;

      filter.type = "lowpass";
      filter.frequency.value = 1800;

      gain.gain.value = 0.18;

      const now = ctx.currentTime + index * noteDuration * 0.85;
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.linearRampToValueAtTime(0.001, now + noteDuration * 1.6);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + noteDuration * 2.2);

      oscillators.push(osc);
    });

    // Accord final à 1,1 s. La fonction retournée annule ce minuteur.
    timer = setTimeout(() => {
      timer = null;
      const c2 = ensure();
      if (!c2) return;
      try {
        const chordNotes = [72, 76, 79, 84];
        chordNotes.forEach((midiNote, i) => {
          const osc = c2.createOscillator();
          const gain = c2.createGain();
          const freq = 440 * 2 ** ((midiNote - 69) / 12);

          osc.type = i === 0 ? "square" : "sawtooth";
          osc.frequency.value = freq;

          gain.gain.value = 0.12;
          const start = c2.currentTime;
          gain.gain.setValueAtTime(0.12, start);
          gain.gain.linearRampToValueAtTime(0.001, start + 1.8);

          osc.connect(gain);
          gain.connect(c2.destination);
          osc.start();
          osc.stop(start + 2.2);
        });
      } catch {
        /* silent */
      }
    }, 1100);
  } catch {
    cancel();
    return () => {};
  }
  return cancel;
}

/** Pop spatialisé. Le crépitement reste branché sur le panoramique quand il existe. */
export function playFireworkPop(
  ensure: EnsureAudioContext,
  getWidth: () => number,
  x: number,
): void {
  const ctx = ensure();
  if (!ctx) return;

  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    let panner: StereoPannerNode | null = null;
    if (typeof ctx.createStereoPanner === "function") {
      panner = ctx.createStereoPanner();
      const panValue = Math.max(-1, Math.min(1, (x / getWidth()) * 2 - 1));
      panner.pan.value = panValue;
    }

    // Base explosion thud using a triangle wave with rapid pitch decay
    osc.type = "triangle";
    const baseFreq = 120 + secureRandom() * 50;
    osc.frequency.setValueAtTime(baseFreq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(25, ctx.currentTime + 0.12);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(350, ctx.currentTime);

    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

    osc.connect(filter);
    if (panner) {
      filter.connect(panner);
      panner.connect(gain);
    } else {
      filter.connect(gain);
    }
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.16);

    // Micro crackle pop (high pitch white-noise simulation with sawtooth) for sparkle feel
    if (secureRandom() < 0.38) {
      const crackleOsc = ctx.createOscillator();
      const crackleGain = ctx.createGain();

      crackleOsc.type = "sawtooth";
      crackleOsc.frequency.setValueAtTime(
        900 + secureRandom() * 1100,
        ctx.currentTime,
      );
      crackleGain.gain.setValueAtTime(0.015, ctx.currentTime);
      crackleGain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.04);

      if (panner) {
        crackleOsc.connect(panner);
      } else {
        crackleOsc.connect(crackleGain);
      }
      crackleGain.connect(ctx.destination);

      crackleOsc.start();
      crackleOsc.stop(ctx.currentTime + 0.05);
    }
  } catch {
    // Audio failed or blocked - silently ignore
  }
}
