import { describe, expect, it } from "vitest";
import {
  playFireSound,
  playFlightAlertSound,
  type FlightAlertWeaponId,
} from "../weaponSounds";

type TimelineEvent =
  | { readonly kind: "setValue"; readonly time: number; readonly value: number }
  | { readonly kind: "linearRamp"; readonly time: number; readonly value: number }
  | { readonly kind: "exponentialRamp"; readonly time: number; readonly value: number };

interface SimNode {
  readonly id: string;
  readonly incoming: SimNode[];
  connect(target: SimConnectTarget): SimConnectTarget;
}

interface SimConnectTarget {
  readonly incoming: SimNode[];
}

class SimulatedAudioParam implements SimConnectTarget {
  readonly incoming: SimNode[] = [];
  private intrinsic: number;
  private events: TimelineEvent[] = [];

  constructor(defaultValue = 0) {
    this.intrinsic = defaultValue;
  }

  get value(): number {
    return this.intrinsic;
  }

  set value(next: number) {
    this.intrinsic = next;
  }

  setValueAtTime(value: number, startTime: number): AudioParam {
    this.insertEvent({ kind: "setValue", time: startTime, value });
    return this as unknown as AudioParam;
  }

  linearRampToValueAtTime(value: number, endTime: number): AudioParam {
    this.insertEvent({ kind: "linearRamp", time: endTime, value });
    return this as unknown as AudioParam;
  }

  exponentialRampToValueAtTime(value: number, endTime: number): AudioParam {
    this.insertEvent({ kind: "exponentialRamp", time: endTime, value });
    return this as unknown as AudioParam;
  }

  cancelScheduledValues(cancelTime: number): AudioParam {
    this.events = this.events.filter((event) => event.time < cancelTime);
    return this as unknown as AudioParam;
  }

  cancelAndHoldAtTime(cancelTime: number): AudioParam {
    const heldValue = this.valueAt(cancelTime);
    const activeEvent = this.events.find((event) => event.time >= cancelTime);
    this.events = this.events.filter((event) => event.time < cancelTime);
    if (activeEvent) {
      if (activeEvent.kind === "linearRamp" || activeEvent.kind === "exponentialRamp") {
        // Selon Web Audio, cancelAndHoldAtTime tronque la rampe en cours à cancelTime.
        this.insertEvent({ kind: activeEvent.kind, time: cancelTime, value: heldValue });
      } else {
        this.insertEvent({ kind: "setValue", time: cancelTime, value: heldValue });
      }
    }
    return this as unknown as AudioParam;
  }

  valueAt(time: number): number {
    if (this.events.length === 0) return this.intrinsic;
    const first = this.events[0]!;
    if (time < first.time) {
      if (first.kind === "linearRamp") {
        const span = first.time;
        const progress = span > 0 ? Math.max(0, Math.min(1, time / span)) : 1;
        return this.intrinsic + (first.value - this.intrinsic) * progress;
      }
      return this.intrinsic;
    }

    let currentVal = this.intrinsic;
    let currentTime = 0;

    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i]!;
      if (event.time > time) {
        if (event.kind === "linearRamp") {
          const span = event.time - currentTime;
          const progress = span > 0 ? (time - currentTime) / span : 1;
          return currentVal + (event.value - currentVal) * progress;
        }
        if (event.kind === "exponentialRamp") {
          const span = event.time - currentTime;
          const progress = span > 0 ? (time - currentTime) / span : 1;
          return currentVal * (event.value / currentVal) ** progress;
        }
        return currentVal;
      }
      currentVal = event.value;
      currentTime = event.time;
    }

    return currentVal;
  }

  private insertEvent(event: TimelineEvent): void {
    this.events.push(event);
    this.events.sort((a, b) => a.time - b.time);
  }
}

class SimDestination implements SimNode, SimConnectTarget {
  readonly id = "destination";
  readonly incoming: SimNode[] = [];
  connect(target: SimConnectTarget): SimConnectTarget {
    return target;
  }
}

class SimGainNode implements SimNode, SimConnectTarget {
  readonly id: string;
  readonly gain = new SimulatedAudioParam(1);
  readonly incoming: SimNode[] = [];

  constructor(id: string) {
    this.id = id;
  }

  connect(target: SimConnectTarget): SimConnectTarget {
    target.incoming.push(this);
    return target;
  }
}

class SimFilterNode implements SimNode, SimConnectTarget {
  readonly id: string;
  readonly frequency = new SimulatedAudioParam(350);
  readonly incoming: SimNode[] = [];
  type: BiquadFilterType = "lowpass";

  constructor(id: string) {
    this.id = id;
  }

  connect(target: SimConnectTarget): SimConnectTarget {
    target.incoming.push(this);
    return target;
  }
}

class SimOscillatorNode implements SimNode {
  readonly id: string;
  readonly frequency = new SimulatedAudioParam(440);
  readonly incoming: SimNode[] = [];
  type: OscillatorType = "sine";
  startTime = 0;
  stopTime = Number.POSITIVE_INFINITY;
  private phase = 0;

  constructor(id: string) {
    this.id = id;
  }

  connect(target: SimConnectTarget): SimConnectTarget {
    target.incoming.push(this);
    return target;
  }

  start(when = 0): void {
    this.startTime = when;
  }

  stop(when = 0): void {
    this.stopTime = when;
  }

  sampleAt(time: number, dt: number): number {
    if (time < this.startTime || time >= this.stopTime) return 0;
    const freqMod = this.frequency.incoming.reduce(
      (sum, node) => sum + evalNodeAudio(node, time, dt),
      0,
    );
    const freq = Math.max(0, this.frequency.valueAt(time) + freqMod);
    this.phase = (this.phase + freq * dt) % 1;
    switch (this.type) {
      case "sine":
        return Math.sin(this.phase * Math.PI * 2);
      case "triangle":
        return 1 - 4 * Math.abs(Math.round(this.phase - 0.25) - (this.phase - 0.25));
      case "sawtooth":
        return 2 * this.phase - 1;
      case "square":
        return this.phase < 0.5 ? 1 : -1;
      default:
        return Math.sin(this.phase * Math.PI * 2);
    }
  }
}

class SimBufferSourceNode implements SimNode {
  readonly id: string;
  readonly incoming: SimNode[] = [];
  buffer: AudioBuffer | null = null;
  startTime = 0;

  constructor(id: string) {
    this.id = id;
  }

  connect(target: SimConnectTarget): SimConnectTarget {
    target.incoming.push(this);
    return target;
  }

  start(when = 0): void {
    this.startTime = when;
  }
}

function evalNodeAudio(node: SimNode, time: number, dt: number): number {
  if (node instanceof SimOscillatorNode) {
    return node.sampleAt(time, dt);
  }
  if (node instanceof SimBufferSourceNode) {
    return 0;
  }
  if (node instanceof SimGainNode) {
    const sum = node.incoming.reduce((acc, src) => acc + evalNodeAudio(src, time, dt), 0);
    return sum * node.gain.valueAt(time);
  }
  if (node instanceof SimFilterNode) {
    return node.incoming.reduce((acc, src) => acc + evalNodeAudio(src, time, dt), 0);
  }
  return 0;
}

interface SimulatedAudioContext {
  readonly context: AudioContext;
  readonly destination: SimDestination;
  readonly gains: SimGainNode[];
  readonly filters: SimFilterNode[];
  readonly oscillators: SimOscillatorNode[];
  currentTime: number;
}

function createSimulatedAudioContext(options: {
  sampleRate?: number;
  withCancelAndHold?: boolean;
} = {}): SimulatedAudioContext {
  const sampleRate = options.sampleRate ?? 48_000;
  const withCancelAndHold = options.withCancelAndHold ?? true;
  const destination = new SimDestination();
  const gains: SimGainNode[] = [];
  const filters: SimFilterNode[] = [];
  const oscillators: SimOscillatorNode[] = [];
  let count = 0;

  const stripCancelAndHold = (param: SimulatedAudioParam): SimulatedAudioParam => {
    if (!withCancelAndHold) {
      Object.defineProperty(param, "cancelAndHoldAtTime", {
        value: undefined,
        configurable: true,
      });
    }
    return param;
  };

  const sim: SimulatedAudioContext = {
    currentTime: 0,
    destination,
    gains,
    filters,
    oscillators,
    context: {
      get currentTime() {
        return sim.currentTime;
      },
      sampleRate,
      state: "running",
      destination: destination as unknown as AudioDestinationNode,
      createGain() {
        const node = new SimGainNode(`gain-${++count}`);
        stripCancelAndHold(node.gain);
        gains.push(node);
        return node as unknown as GainNode;
      },
      createBiquadFilter() {
        const node = new SimFilterNode(`filter-${++count}`);
        stripCancelAndHold(node.frequency);
        filters.push(node);
        return node as unknown as BiquadFilterNode;
      },
      createOscillator() {
        const node = new SimOscillatorNode(`osc-${++count}`);
        stripCancelAndHold(node.frequency);
        oscillators.push(node);
        return node as unknown as OscillatorNode;
      },
      createBuffer(channels: number, length: number) {
        const channel = new Float32Array(length);
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          getChannelData: () => channel,
        } as unknown as AudioBuffer;
      },
      createBufferSource() {
        return new SimBufferSourceNode(`source-${++count}`) as unknown as AudioBufferSourceNode;
      },
    } as unknown as AudioContext,
  };

  return sim;
}

function findMasterGainChain(sim: SimulatedAudioContext): SimGainNode[] {
  // Trace la chaîne de gains connectée entre le filtre passe-bas de l'alerte et destination.
  const alertFilter = sim.filters.at(-1);
  if (!alertFilter) throw new Error("Missing alert filter node");
  const chain: SimGainNode[] = [];
  let cursor: SimNode | undefined = sim.gains.find((g) => g.incoming.includes(alertFilter));
  while (cursor instanceof SimGainNode) {
    chain.push(cursor);
    cursor = sim.gains.find((g) => g.incoming.includes(cursor!));
  }
  return chain;
}

function renderSampleRange(
  output: Float32Array,
  fromIndex: number,
  toIndex: number,
  sampleRate: number,
  sampleAt: (time: number, dt: number) => number,
): void {
  const dt = 1 / sampleRate;
  for (let i = fromIndex; i < toIndex; i++) {
    output[i] = sampleAt(i / sampleRate, dt);
  }
}

function maxSampleDelta(samples: Float32Array): { delta: number; index: number } {
  let maxDelta = 0;
  let maxIndex = 0;
  for (let i = 1; i < samples.length; i++) {
    const diff = Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0));
    if (diff > maxDelta) {
      maxDelta = diff;
      maxIndex = i;
    }
  }
  return { delta: maxDelta, index: maxIndex };
}

describe("signal rendu à l'arrêt de l'alerte nucléaire", () => {
  it("détecte la discontinuité de l'ancienne séquence cancelScheduledValues + masterGain.gain.value", () => {
    const sampleRate = 48_000;
    const stopIndex = 1792;
    const stopTime = stopIndex / sampleRate; // ~37,33 ms en pleine rampe d'attaque
    const gain = new SimulatedAudioParam(0.0005);
    gain.setValueAtTime(0.0005, 0);
    gain.linearRampToValueAtTime(0.14, 0.045);

    const samples = new Float32Array(Math.ceil(sampleRate * 0.08));
    renderSampleRange(samples, 0, stopIndex, sampleRate, (t) => gain.valueAt(t));

    // Ancienne séquence fautive exécutée à stopTime : cancelScheduledValues + lecture de gain.value (0.0005)
    gain.cancelScheduledValues(stopTime);
    gain.setValueAtTime(Math.max(0.0001, gain.value), stopTime);
    gain.linearRampToValueAtTime(0.0001, stopTime + 0.025);

    renderSampleRange(samples, stopIndex, samples.length, sampleRate, (t) => gain.valueAt(t));

    const { delta, index } = maxSampleDelta(samples);
    expect(index).toBe(stopIndex);
    expect(samples[stopIndex]).toBeCloseTo(0.0005, 5);
    expect(delta).toBeGreaterThan(0.11);
  });

  it("détecte le saut d'un cancelAndHoldAtTime + linearRamp direct après la montée", () => {
    const sampleRate = 48_000;
    const stopTime = 0.08; // après la rampe d'attaque terminée à 0.045 s
    const stopIndex = Math.round(stopTime * sampleRate);
    const gain = new SimulatedAudioParam(0.0005);
    gain.setValueAtTime(0.0005, 0);
    gain.linearRampToValueAtTime(0.14, 0.045);

    const samples = new Float32Array(Math.ceil(sampleRate * 0.12));
    renderSampleRange(samples, 0, stopIndex, sampleRate, (t) => gain.valueAt(t));

    // Sans nœud de coupure séparé, cancelAndHoldAtTime après la rampe n'ancre pas 0.08 s.
    gain.cancelAndHoldAtTime(stopTime);
    gain.linearRampToValueAtTime(0.0001, stopTime + 0.025);

    renderSampleRange(samples, stopIndex, samples.length, sampleRate, (t) => gain.valueAt(t));

    const { delta, index } = maxSampleDelta(samples);
    expect(index).toBe(stopIndex);
    expect(delta).toBeGreaterThan(0.07);
  });

  it.each([
    { weaponId: "NUKE" as FlightAlertWeaponId, attackEnd: 0.045, expectedPeak: 0.14 },
    { weaponId: "THERMONUCLEAR" as FlightAlertWeaponId, attackEnd: 0.06, expectedPeak: 0.15 },
  ])(
    "coupe $weaponId sans clic à n'importe quel instant (avec et sans cancelAndHoldAtTime)",
    ({ weaponId, attackEnd, expectedPeak }) => {
      const sampleRate = 48_000;
      const midRampStop = 1792 / sampleRate; // ~37,33 ms
      const stopTimes = [0, 0.01, midRampStop, attackEnd, 0.08];

      for (const withCancelAndHold of [true, false]) {
        for (const mode of ["fire", "resume"] as const) {
          for (const stopTime of stopTimes) {
            const sim = createSimulatedAudioContext({
              sampleRate,
              withCancelAndHold,
            });
            const alert =
              mode === "fire"
                ? playFireSound(() => sim.context, weaponId)
                : playFlightAlertSound(() => sim.context, weaponId);
            expect(alert).not.toBeNull();

            const chain = findMasterGainChain(sim);
            expect(chain.length).toBe(2);
            const alertOscs = sim.oscillators;
            const alertFilter = sim.filters.at(-1)!;
            const outputGain = sim.gains.find(
              (g) => sim.destination.incoming.includes(g) && (g.incoming.includes(alertFilter) || chain.includes(g)),
            )!;

            const duration = stopTime + 0.05;
            const totalSamples = Math.ceil(sampleRate * duration);
            const stopIndex = Math.round(stopTime * sampleRate);
            const envelope = new Float32Array(totalSamples);
            const waveform = new Float32Array(totalSamples);

            const sampleEnvelope = (t: number) => {
              const oscActive = alertOscs.some((osc) => t >= osc.startTime && t < osc.stopTime);
              if (!oscActive) return 0;
              return chain.reduce((acc, node) => acc * node.gain.valueAt(t), 1);
            };
            const sampleWave = (t: number, dt: number) => evalNodeAudio(outputGain, t, dt);

            // Rendu réel avant l'arrêt, puis exécution de stop() à stopTime, puis rendu de la suite.
            renderSampleRange(envelope, 0, stopIndex, sampleRate, sampleEnvelope);
            renderSampleRange(waveform, 0, stopIndex, sampleRate, sampleWave);

            sim.currentTime = stopTime;
            alert!.stop();

            renderSampleRange(envelope, stopIndex, totalSamples, sampleRate, sampleEnvelope);
            renderSampleRange(waveform, stopIndex, totalSamples, sampleRate, sampleWave);

            const { delta } = maxSampleDelta(envelope);

            // Aucune discontinuité dans l'enveloppe rendue (ancien bug > 0.11)
            expect(delta).toBeLessThanOrEqual(0.0005);

            // À l'arrêt en pleine rampe (~37,33 ms), le gain reste au niveau atteint (> 0.08)
            if (stopTime === midRampStop) {
              expect(envelope[stopIndex - 1]).toBeGreaterThan(0.08);
              expect(envelope[stopIndex]).toBeGreaterThan(0.08);
              expect(Math.abs((envelope[stopIndex] ?? 0) - (envelope[stopIndex - 1] ?? 0))).toBeLessThan(0.0005);
            }

            // En mode cancelAndHoldAtTime, l'enveloppe ne monte plus après stopTime
            if (withCancelAndHold) {
              for (let i = stopIndex + 1; i < envelope.length; i++) {
                expect(envelope[i]).toBeLessThanOrEqual((envelope[i - 1] ?? 0) + 1e-6);
              }
            } else {
              // Sans cancelAndHoldAtTime (Firefox), le pic ne dépasse jamais la cible d'attaque
              for (let i = 0; i < envelope.length; i++) {
                expect(envelope[i]).toBeLessThanOrEqual(expectedPeak + 1e-6);
              }
            }

            // Silence complet une fois les oscillateurs arrêtés à stopTime + 0.03 s
            const afterStopIdx = Math.ceil((stopTime + 0.031) * sampleRate);
            for (let i = afterStopIdx; i < waveform.length; i++) {
              expect(envelope[i]).toBe(0);
              expect(waveform[i]).toBe(0);
            }
          }
        }
      }
    },
  );
});
