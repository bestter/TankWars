/**
 * Faux AudioContext de test. Il enregistre le graphe Web Audio dans l'ordre
 * des appels, sans dépendre d'un navigateur. L'empreinte du bruit est prise
 * quand le tampon est affecté à sa source, donc après le remplissage LFSR.
 */

const SAMPLE_RATE = 44_100;

export interface RecordingSession {
  readonly AudioContext: new () => AudioContext;
  borrowContext(): AudioContext;
  render(): string;
}

export function createRecordingSession(options: {
  stereoPanner: boolean;
}): RecordingSession {
  let active: RecordingState | null = null;

  function create(): AudioContext {
    active = new RecordingState(options.stereoPanner);
    return active.facade;
  }

  function RecordingAudioContext(this: unknown): AudioContext {
    return create();
  }

  return {
    AudioContext: RecordingAudioContext as unknown as new () => AudioContext,
    borrowContext: create,
    render: () => {
      const lines = active?.lines ?? [];
      return `${lines.join("\n")}\n`;
    },
  };
}

class RecordingState {
  readonly lines: string[] = [];
  readonly facade: AudioContext;
  private readonly buffers = new WeakMap<object, RecordedBuffer>();
  private readonly counts = {
    osc: 0,
    gain: 0,
    filter: 0,
    panner: 0,
    buffer: 0,
    source: 0,
  };

  constructor(stereoPanner: boolean) {
    const destination: RecordedNode = { id: "destination" };
    const facade: Partial<AudioContext> & {
      createStereoPanner?: () => StereoPannerNode;
    } = {
      currentTime: 0,
      sampleRate: SAMPLE_RATE,
      destination: destination as unknown as AudioDestinationNode,
      state: "running",
      close: () => Promise.resolve(),
      createOscillator: () => this.createOscillator(),
      createGain: () => this.createGain(),
      createBiquadFilter: () => this.createFilter(),
      createBuffer: (channels, length, sampleRate) =>
        this.createBuffer(channels, length, sampleRate),
      createBufferSource: () => this.createBufferSource(),
    };
    if (stereoPanner) {
      facade.createStereoPanner = () => this.createPanner();
    }
    this.facade = facade as AudioContext;
  }

  private createOscillator(): OscillatorNode {
    const id = `osc-${(this.counts.osc += 1)}`;
    this.lines.push(`createOscillator ${id}`);
    return new RecordedOscillator(this, id) as unknown as OscillatorNode;
  }

  private createGain(): GainNode {
    const id = `gain-${(this.counts.gain += 1)}`;
    this.lines.push(`createGain ${id}`);
    return new RecordedGain(this, id) as unknown as GainNode;
  }

  private createFilter(): BiquadFilterNode {
    const id = `filter-${(this.counts.filter += 1)}`;
    this.lines.push(`createBiquadFilter ${id}`);
    return new RecordedFilter(this, id) as unknown as BiquadFilterNode;
  }

  private createPanner(): StereoPannerNode {
    const id = `panner-${(this.counts.panner += 1)}`;
    this.lines.push(`createStereoPanner ${id}`);
    return new RecordedPanner(this, id) as unknown as StereoPannerNode;
  }

  private createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer {
    const id = `buffer-${(this.counts.buffer += 1)}`;
    this.lines.push(
      `createBuffer ${id} channels=${channels} length=${length} sampleRate=${sampleRate}`,
    );
    const buffer = new RecordedBuffer(id, channels, length, sampleRate);
    this.buffers.set(buffer, buffer);
    return buffer as unknown as AudioBuffer;
  }

  private createBufferSource(): AudioBufferSourceNode {
    const id = `source-${(this.counts.source += 1)}`;
    this.lines.push(`createBufferSource ${id}`);
    return new RecordedBufferSource(this, id) as unknown as AudioBufferSourceNode;
  }

  connect(sourceId: string, target: object): void {
    const id = recordedId(target);
    this.lines.push(`connect ${sourceId} -> ${id}`);
  }

  rememberBuffer(value: object | null): string {
    if (value === null) return "null";
    const buffer = this.buffers.get(value);
    if (!buffer) return "unknown";
    return `${buffer.id} fingerprint=${fingerprintChannel(buffer.data)}`;
  }
}

interface RecordedNode {
  id: string;
}

function recordedId(target: object): string {
  if ("id" in target && typeof target.id === "string") return target.id;
  return "unknown";
}

class RecordedParam {
  private current = 0;
  private readonly lines: string[];
  private readonly label: string;
  private readonly now: () => number;

  constructor(state: RecordingState, label: string) {
    this.lines = state.lines;
    this.label = label;
    this.now = () => state.facade.currentTime;
  }

  get value(): number {
    return this.current;
  }

  set value(next: number) {
    this.current = next;
    this.lines.push(`${this.label}.value=${formatNumber(next)}`);
  }

  setValueAtTime(value: number, time: number): void {
    this.current = value;
    this.lines.push(
      `${this.label}.setValueAtTime value=${formatNumber(value)} time=${formatRelative(time, this.now())}`,
    );
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.current = value;
    this.lines.push(
      `${this.label}.linearRampToValueAtTime value=${formatNumber(value)} time=${formatRelative(time, this.now())}`,
    );
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.current = value;
    this.lines.push(
      `${this.label}.exponentialRampToValueAtTime value=${formatNumber(value)} time=${formatRelative(time, this.now())}`,
    );
  }
}

class RecordedOscillator {
  readonly id: string;
  readonly frequency: RecordedParam;
  private oscType: OscillatorType = "sine";
  private readonly state: RecordingState;

  constructor(state: RecordingState, id: string) {
    this.state = state;
    this.id = id;
    this.frequency = new RecordedParam(state, `${id}.frequency`);
  }

  get type(): OscillatorType {
    return this.oscType;
  }

  set type(next: OscillatorType) {
    this.oscType = next;
    this.state.lines.push(`${this.id}.type=${next}`);
  }

  connect(target: object): object {
    this.state.connect(this.id, target);
    return target;
  }

  start(when?: number): void {
    this.state.lines.push(formatSchedule(this.id, "start", when, this.state.facade.currentTime));
  }

  stop(when?: number): void {
    this.state.lines.push(formatSchedule(this.id, "stop", when, this.state.facade.currentTime));
  }
}

class RecordedGain {
  readonly id: string;
  readonly gain: RecordedParam;
  private readonly state: RecordingState;

  constructor(state: RecordingState, id: string) {
    this.state = state;
    this.id = id;
    this.gain = new RecordedParam(state, `${id}.gain`);
  }

  connect(target: object): object {
    this.state.connect(this.id, target);
    return target;
  }
}

class RecordedFilter {
  readonly id: string;
  readonly frequency: RecordedParam;
  private filterType: BiquadFilterType = "lowpass";
  private readonly state: RecordingState;

  constructor(state: RecordingState, id: string) {
    this.state = state;
    this.id = id;
    this.frequency = new RecordedParam(state, `${id}.frequency`);
  }

  get type(): BiquadFilterType {
    return this.filterType;
  }

  set type(next: BiquadFilterType) {
    this.filterType = next;
    this.state.lines.push(`${this.id}.type=${next}`);
  }

  connect(target: object): object {
    this.state.connect(this.id, target);
    return target;
  }
}

class RecordedPanner {
  readonly id: string;
  readonly pan: RecordedParam;
  private readonly state: RecordingState;

  constructor(state: RecordingState, id: string) {
    this.state = state;
    this.id = id;
    this.pan = new RecordedParam(state, `${id}.pan`);
  }

  connect(target: object): object {
    this.state.connect(this.id, target);
    return target;
  }
}

class RecordedBuffer {
  readonly id: string;
  readonly data: Float32Array;
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;

  constructor(id: string, channels: number, length: number, sampleRate: number) {
    this.id = id;
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = new Float32Array(length);
  }

  getChannelData(channel: number): Float32Array {
    if (channel !== 0) {
      throw new Error(`Canal audio inattendu : ${channel}`);
    }
    return this.data;
  }
}

class RecordedBufferSource {
  readonly id: string;
  private stored: object | null = null;
  private readonly state: RecordingState;

  constructor(state: RecordingState, id: string) {
    this.state = state;
    this.id = id;
  }

  get buffer(): AudioBuffer | null {
    return this.stored as AudioBuffer | null;
  }

  set buffer(value: AudioBuffer | null) {
    this.stored = value;
    const recorded = value === null ? "null" : this.state.rememberBuffer(value);
    this.state.lines.push(`${this.id}.buffer=${recorded}`);
  }

  connect(target: object): object {
    this.state.connect(this.id, target);
    return target;
  }

  start(when?: number): void {
    this.state.lines.push(formatSchedule(this.id, "start", when, this.state.facade.currentTime));
  }

  stop(when?: number): void {
    this.state.lines.push(formatSchedule(this.id, "stop", when, this.state.facade.currentTime));
  }
}

function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function formatRelative(time: number, currentTime: number): string {
  return formatNumber(time - currentTime);
}

function formatSchedule(
  id: string,
  method: "start" | "stop",
  when: number | undefined,
  currentTime: number,
): string {
  if (when === undefined) return `${id}.${method}`;
  return `${id}.${method} when=${formatRelative(when, currentTime)}`;
}

function fingerprintChannel(data: Float32Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    const quantized = Math.round((data[index] ?? 0) * 1_000);
    hash ^= quantized;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= data.length;
  hash = Math.imul(hash, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
