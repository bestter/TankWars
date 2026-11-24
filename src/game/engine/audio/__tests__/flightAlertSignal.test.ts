import { afterEach, describe, expect, it, vi } from "vitest";
import { CombatAudio } from "../CombatAudio";
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
  disconnected = false;

  constructor(id: string) {
    this.id = id;
  }

  connect(target: SimConnectTarget): SimConnectTarget {
    target.incoming.push(this);
    return target;
  }

  disconnect(): void {
    this.disconnected = true;
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
  private readonly endedListeners = new Set<() => void>();
  private endedEmitted = false;

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

  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") {
      this.endedListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "ended") {
      this.endedListeners.delete(listener);
    }
  }

  emitEndedIfReached(time: number): void {
    if (this.endedEmitted || time < this.stopTime) return;
    this.endedEmitted = true;
    for (const listener of [...this.endedListeners]) {
      this.endedListeners.delete(listener);
      listener();
    }
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
    if (node.disconnected) return 0;
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
  readonly bufferSources: SimBufferSourceNode[];
  currentTime: number;
  state: AudioContextState;
  closedAtTime: number | null;
  setState: (next: AudioContextState) => void;
}

function createSimulatedAudioContext(options: {
  sampleRate?: number;
  withCancelAndHold?: boolean;
  withOscEvents?: boolean;
  initialState?: AudioContextState;
  resumeImplementation?: (sim: SimulatedAudioContext) => Promise<void>;
} = {}): SimulatedAudioContext {
  const sampleRate = options.sampleRate ?? 48_000;
  const withCancelAndHold = options.withCancelAndHold ?? true;
  const withOscEvents = options.withOscEvents ?? true;
  const destination = new SimDestination();
  const gains: SimGainNode[] = [];
  const filters: SimFilterNode[] = [];
  const oscillators: SimOscillatorNode[] = [];
  const bufferSources: SimBufferSourceNode[] = [];
  const stateListeners = new Set<() => void>();
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
    state: options.initialState ?? "running",
    closedAtTime: null,
    destination,
    gains,
    filters,
    oscillators,
    bufferSources,
    setState(next: AudioContextState) {
      if (sim.state === next) return;
      sim.state = next;
      for (const cb of [...stateListeners]) {
        cb();
      }
    },
    context: {
      get currentTime() {
        return sim.currentTime;
      },
      get state() {
        return sim.state;
      },
      sampleRate,
      destination: destination as unknown as AudioDestinationNode,
      addEventListener(type: string, cb: () => void) {
        if (type === "statechange") stateListeners.add(cb);
      },
      removeEventListener(type: string, cb: () => void) {
        if (type === "statechange") stateListeners.delete(cb);
      },
      resume() {
        if (options.resumeImplementation) {
          return options.resumeImplementation(sim);
        }
        sim.setState("running");
        return Promise.resolve();
      },
      close() {
        if (sim.state !== "closed") {
          sim.state = "closed";
          sim.closedAtTime = sim.currentTime;
          for (const cb of [...stateListeners]) {
            cb();
          }
        }
        return Promise.resolve();
      },
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
        if (!withOscEvents) {
          Object.defineProperty(node, "addEventListener", {
            value: undefined,
            configurable: true,
          });
        }
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
        const src = new SimBufferSourceNode(`source-${++count}`);
        bufferSources.push(src);
        return src as unknown as AudioBufferSourceNode;
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("détecte une coupure brutale si AudioContext.close() s'exécute immédiatement lors de dispose()", () => {
    const sampleRate = 48_000;
    const stopTime = 0.08;
    const stopIndex = Math.round(stopTime * sampleRate);
    const totalSamples = Math.ceil(sampleRate * 0.14);

    const sim = createSimulatedAudioContext({ sampleRate });
    const alert = playFireSound(() => sim.context, "NUKE");
    expect(alert).not.toBeNull();
    const chain = findMasterGainChain(sim);
    const envelope = new Float32Array(totalSamples);

    renderSampleRange(envelope, 0, stopIndex, sampleRate, (t) =>
      chain.reduce((acc, node) => acc * node.gain.valueAt(t), 1),
    );

    // Simulation de l'ancien comportement fautif : arrêt suivi d'une fermeture immédiate
    sim.currentTime = stopTime;
    alert!.stop();
    void sim.context.close();
    renderSampleRange(envelope, stopIndex, totalSamples, sampleRate, (t) =>
      sim.closedAtTime !== null && t >= sim.closedAtTime
        ? 0
        : chain.reduce((acc, node) => acc * node.gain.valueAt(t), 1),
    );

    const { delta, index } = maxSampleDelta(envelope);
    expect(index).toBe(stopIndex);
    expect(delta).toBeGreaterThan(0.13);
  });

  it.each(["NUKE", "THERMONUCLEAR"] as const)(
    "laisse le fondu complet atteindre zéro avant la fermeture de AudioContext dans CombatAudio.dispose() (%s)",
    (weaponId) => {
      vi.useFakeTimers();
      const sampleRate = 48_000;
      const disposeTimes = [1792 / sampleRate, 0.08];

      for (const withOscEvents of [true, false]) {
        for (const disposeTime of disposeTimes) {
          let wallMs = 0;
          const sim = createSimulatedAudioContext({ sampleRate, withOscEvents });
          const audio = new CombatAudio({
            getWidth: () => 200,
            createContext: () => sim.context,
            now: () => wallMs,
          });

          audio.playFire(weaponId);
          const chain = findMasterGainChain(sim);
          const alertOscs = sim.oscillators;
          const totalDuration = disposeTime + 0.1;
          const totalSamples = Math.ceil(sampleRate * totalDuration);
          const disposeIndex = Math.round(disposeTime * sampleRate);
          const envelope = new Float32Array(totalSamples);

          const sampleEnvelope = (t: number) => {
            if (sim.closedAtTime !== null && t >= sim.closedAtTime) return 0;
            const oscActive = alertOscs.some((osc) => t >= osc.startTime && t < osc.stopTime);
            if (!oscActive) return 0;
            return chain.reduce((acc, node) => acc * node.gain.valueAt(t), 1);
          };

          renderSampleRange(envelope, 0, disposeIndex, sampleRate, sampleEnvelope);

          sim.currentTime = disposeTime;
          wallMs = Math.round(disposeTime * 1_000);
          audio.dispose();

          // Le contexte ne ferme pas immédiatement pendant le fondu
          expect(sim.state).toBe("running");

          // Avance milliseconde par milliseconde pour simuler l'horloge audio et les timers réels
          let cursorIdx = disposeIndex;
          while (cursorIdx < totalSamples) {
            const nextIdx = Math.min(totalSamples, cursorIdx + Math.round(sampleRate * 0.001));
            renderSampleRange(envelope, cursorIdx, nextIdx, sampleRate, sampleEnvelope);
            cursorIdx = nextIdx;
            wallMs += 1;
            sim.currentTime += 0.001;
            for (const osc of alertOscs) {
              osc.emitEndedIfReached(sim.currentTime);
            }
            vi.advanceTimersByTime(1);
          }

          expect(sim.state).toBe("closed");
          expect(sim.closedAtTime).not.toBeNull();
          expect(sim.closedAtTime!).toBeGreaterThanOrEqual(disposeTime + 0.03);
          expect(sim.closedAtTime!).toBeLessThanOrEqual(disposeTime + 0.065);

          // Enveloppe totalement continue jusqu'à 0 (aucune coupure brutale à close())
          const { delta } = maxSampleDelta(envelope);
          expect(delta).toBeLessThanOrEqual(0.0005);

          const closeSampleIdx = Math.round(sim.closedAtTime! * sampleRate);
          expect(envelope[Math.max(0, closeSampleIdx - 1)]).toBe(0);
          expect(envelope[Math.min(totalSamples - 1, closeSampleIdx)]).toBe(0);
        }
      }
    },
  );

  it.each([
    { weaponId: "NUKE" as FlightAlertWeaponId, expectedTargetPeak: 0.14 },
    { weaponId: "THERMONUCLEAR" as FlightAlertWeaponId, expectedTargetPeak: 0.15 },
  ])(
    "neutralise l'ancienne sirène à 2,000 s lors d'une interruption et ne rejoue qu'une sirène à la reprise (%s)",
    async ({ weaponId, expectedTargetPeak }) => {
      const sampleRate = 48_000;
      const resumeAt = 2;
      const resumeIndex = resumeAt * sampleRate;
      const totalSamples = Math.ceil(sampleRate * 2.1);

      for (const suspendBeforeStop of [true, false]) {
        let resolveResume!: () => void;
        const sim = createSimulatedAudioContext({
          sampleRate,
          resumeImplementation: (target) =>
            new Promise<void>((resolve) => {
              resolveResume = () => {
                target.setState("running");
                resolve();
              };
            }),
        });
        const audio = new CombatAudio({
          getWidth: () => 200,
          createContext: () => sim.context,
        });

        audio.playFire(weaponId);
        const firstChain = findMasterGainChain(sim);
        const firstOscs = [...sim.oscillators];
        const firstGainSnapshotCount = sim.gains.length;
        const firstFilterSnapshotCount = sim.filters.length;

        // Avance jusqu'à t = 2,000 s puis suspension (avant ou juste après arrêt) et reprise
        sim.currentTime = resumeAt;
        if (suspendBeforeStop) {
          sim.setState("suspended");
          audio.stopFlightAlert();
        } else {
          audio.stopFlightAlert();
          sim.setState("suspended");
        }
        audio.resumeFlightAlert(weaponId, () => true);

        // Tant que resume() n'a pas résolu, aucune nouvelle sirène n'est créée
        expect(sim.oscillators).toHaveLength(firstOscs.length);

        resolveResume();
        await Promise.resolve();
        await Promise.resolve();

        const secondOscs = sim.oscillators.slice(firstOscs.length);
        expect(secondOscs.length).toBeGreaterThanOrEqual(3);
        for (const osc of secondOscs) {
          expect(osc.startTime).toBe(resumeAt);
        }

        const secondFilter = sim.filters.slice(firstFilterSnapshotCount).at(-1)!;
        const secondGains = sim.gains.slice(firstGainSnapshotCount);
        const secondChain: SimGainNode[] = [];
        let cursor: SimNode | undefined = secondGains.find((g) => g.incoming.includes(secondFilter));
        while (cursor instanceof SimGainNode) {
          secondChain.push(cursor);
          cursor = secondGains.find((g) => g.incoming.includes(cursor!));
        }
        expect(secondChain).toHaveLength(2);

        const sampleChain = (
          chainNodes: readonly SimGainNode[],
          oscNodes: readonly SimOscillatorNode[],
          t: number,
        ): number => {
          if (chainNodes.some((node) => node.disconnected)) return 0;
          const active = oscNodes.some((osc) => t >= osc.startTime && t < osc.stopTime);
          if (!active) return 0;
          return chainNodes.reduce((acc, node) => acc * node.gain.valueAt(t), 1);
        };

        const oldEnvelope = new Float32Array(totalSamples);
        const newEnvelope = new Float32Array(totalSamples);
        renderSampleRange(oldEnvelope, resumeIndex, totalSamples, sampleRate, (t) =>
          sampleChain(firstChain, firstOscs, t),
        );
        renderSampleRange(newEnvelope, resumeIndex, totalSamples, sampleRate, (t) =>
          sampleChain(secondChain, secondOscs, t),
        );

        // L'ancienne sirène reste rigoureusement à 0 sur tout t >= 2,000 s (y compris 2,000..2,025 s)
        for (let i = resumeIndex; i < totalSamples; i++) {
          expect(oldEnvelope[i]).toBe(0);
        }

        // La nouvelle sirène monte normalement depuis 2,000 s sans addition avec l'ancienne
        expect(newEnvelope[resumeIndex]).toBeCloseTo(0.0005, 4);
        expect(newEnvelope[totalSamples - 1]).toBeCloseTo(expectedTargetPeak, 4);
      }
    },
  );

  it.each(["NUKE", "THERMONUCLEAR"] as const)(
    "termine complètement le fondu (2,025 s) avant le démarrage de la détonation à l'impact à 2,000 s (%s)",
    (weaponId) => {
      const sampleRate = 48_000;
      const impactTime = 2;
      const impactIndex = impactTime * sampleRate;
      const fadeEndTime = impactTime + 0.025;
      const fadeEndIndex = Math.round(fadeEndTime * sampleRate);
      const totalSamples = Math.ceil(sampleRate * 2.06);

      const sim = createSimulatedAudioContext({ sampleRate });
      const audio = new CombatAudio({
        getWidth: () => 200,
        createContext: () => sim.context,
      });

      audio.playFire(weaponId);
      const alertChain = findMasterGainChain(sim);
      const alertOscs = [...sim.oscillators];
      const oscCountBeforeImpact = sim.oscillators.length;
      const bufferCountBeforeImpact = sim.bufferSources.length;

      sim.currentTime = impactTime;
      audio.stopFlightAlert();
      audio.playImpact(weaponId);

      const alertEnvelope = new Float32Array(totalSamples);
      renderSampleRange(alertEnvelope, impactIndex, totalSamples, sampleRate, (t) => {
        if (alertChain.some((node) => node.disconnected)) return 0;
        const oscActive = alertOscs.some((osc) => t >= osc.startTime && t < osc.stopTime);
        if (!oscActive) return 0;
        return alertChain.reduce((acc, node) => acc * node.gain.valueAt(t), 1);
      });

      // Pendant [2,000 ; 2,025[, la sirène décroît continûment et atteint exactement 0 à 2,025 s
      expect(alertEnvelope[impactIndex]).toBeGreaterThan(0.1);
      for (let i = impactIndex + 1; i <= fadeEndIndex; i++) {
        expect(alertEnvelope[i]).toBeLessThanOrEqual((alertEnvelope[i - 1] ?? 0) + 1e-6);
      }
      expect(alertEnvelope[fadeEndIndex]).toBe(0);

      // Aucune couche de détonation ne démarre avant 2,025 s; les premières démarrent exactement à 2,025 s
      const impactOscStarts = sim.oscillators
        .slice(oscCountBeforeImpact)
        .map((osc) => osc.startTime);
      const impactBufferStarts = sim.bufferSources
        .slice(bufferCountBeforeImpact)
        .map((src) => src.startTime);
      const allDetonationStarts = [...impactOscStarts, ...impactBufferStarts];

      expect(allDetonationStarts.length).toBeGreaterThanOrEqual(4);
      expect(Math.min(...allDetonationStarts)).toBe(fadeEndTime);
      for (const startTime of allDetonationStarts) {
        expect(startTime).toBeGreaterThanOrEqual(fadeEndTime);
      }

      // Contrôle sans sirène active à t = 2,000 s : démarrage immédiat sans délai
      const simNoAlert = createSimulatedAudioContext({ sampleRate });
      simNoAlert.currentTime = impactTime;
      const audioNoAlert = new CombatAudio({
        getWidth: () => 200,
        createContext: () => simNoAlert.context,
      });
      audioNoAlert.playImpact(weaponId);
      const noAlertStarts = [
        ...simNoAlert.oscillators.map((osc) => osc.startTime),
        ...simNoAlert.bufferSources.map((src) => src.startTime),
      ];
      expect(Math.min(...noAlertStarts)).toBe(impactTime);
    },
  );

  it.each([
    { weaponId: "NUKE" as FlightAlertWeaponId, expectedTargetPeak: 0.14 },
    { weaponId: "THERMONUCLEAR" as FlightAlertWeaponId, expectedTargetPeak: 0.15 },
  ])(
    "supprime tout chevauchement d'enveloppe à 48 000 Hz sur retour rapide (3,000 s -> 3,010 s) en contexte running (%s)",
    ({ weaponId, expectedTargetPeak }) => {
      vi.useFakeTimers();
      const sampleRate = 48_000;
      const hideAt = 3;
      const returnAt = 3.01;
      const fadeEndAt = 3.025;
      const endAt = 3.1;
      const startIndex = Math.round(2.99 * sampleRate);
      const totalSamples = Math.ceil(endAt * sampleRate);

      const sim = createSimulatedAudioContext({ sampleRate });
      const audio = new CombatAudio({
        getWidth: () => 200,
        createContext: () => sim.context,
      });

      audio.playFire(weaponId);
      const oldChain = findMasterGainChain(sim);
      const oldOscs = [...sim.oscillators];
      const oldGainCount = sim.gains.length;
      const oldFilterCount = sim.filters.length;

      sim.currentTime = hideAt;
      audio.stopFlightAlert();

      const oldEnvelope = new Float32Array(totalSamples);
      const newEnvelope = new Float32Array(totalSamples);

      const sampleChain = (
        chainNodes: readonly SimGainNode[],
        oscNodes: readonly SimOscillatorNode[],
        t: number,
      ): number => {
        if (chainNodes.some((node) => node.disconnected)) return 0;
        const active = oscNodes.some((osc) => t >= osc.startTime && t < osc.stopTime);
        if (!active) return 0;
        return chainNodes.reduce((acc, node) => acc * node.gain.valueAt(t), 1);
      };

      let cursorIdx = startIndex;
      let resumedTriggered = false;
      let newChain: SimGainNode[] | null = null;
      let newOscs: SimOscillatorNode[] = [];

      while (cursorIdx < totalSamples) {
        const currentTime = cursorIdx / sampleRate;
        if (!resumedTriggered && currentTime >= returnAt) {
          resumedTriggered = true;
          sim.currentTime = returnAt;
          audio.resumeFlightAlert(weaponId, () => true);
          // Aucune nouvelle sirène active dès 3,010 s
          expect(sim.oscillators).toHaveLength(oldOscs.length);
        }

        const nextIdx = Math.min(totalSamples, cursorIdx + Math.round(sampleRate * 0.001));
        renderSampleRange(oldEnvelope, cursorIdx, nextIdx, sampleRate, (t) =>
          sampleChain(oldChain, oldOscs, t),
        );
        if (newChain) {
          renderSampleRange(newEnvelope, cursorIdx, nextIdx, sampleRate, (t) =>
            sampleChain(newChain!, newOscs, t),
          );
        }

        cursorIdx = nextIdx;
        sim.currentTime = cursorIdx / sampleRate;
        for (const osc of oldOscs) {
          osc.emitEndedIfReached(sim.currentTime);
        }
        if (resumedTriggered) {
          vi.advanceTimersByTime(1);
        }

        if (!newChain && sim.oscillators.length > oldOscs.length) {
          newOscs = sim.oscillators.slice(oldOscs.length);
          const newFilter = sim.filters.slice(oldFilterCount).at(-1)!;
          const addedGains = sim.gains.slice(oldGainCount);
          const chain: SimGainNode[] = [];
          let cursor: SimNode | undefined = addedGains.find((g) => g.incoming.includes(newFilter));
          while (cursor instanceof SimGainNode) {
            chain.push(cursor);
            cursor = addedGains.find((g) => g.incoming.includes(cursor!));
          }
          expect(chain).toHaveLength(2);
          newChain = chain;
        }
      }

      expect(newChain).not.toBeNull();
      expect(newOscs.length).toBeGreaterThanOrEqual(3);
      for (const osc of newOscs) {
        expect(osc.startTime).toBeGreaterThanOrEqual(3.03);
      }

      // L'ancienne sirène descend à 0 à 3,025 s et la nouvelle ne démarre jamais tant qu'oldEnvelope > 0
      const fadeEndIndex = Math.round(fadeEndAt * sampleRate);
      expect(oldEnvelope[fadeEndIndex]).toBe(0);
      for (let i = startIndex; i < totalSamples; i++) {
        expect((oldEnvelope[i] ?? 0) > 0 && (newEnvelope[i] ?? 0) > 0).toBe(false);
      }

      // La nouvelle sirène atteint son palier normal avant 3,100 s
      expect(newEnvelope[totalSamples - 1]).toBeCloseTo(expectedTargetPeak, 4);
    },
  );
});
