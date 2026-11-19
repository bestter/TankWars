interface CanvasRecorderState {
  fillStyle: string;
  globalAlpha: number;
  tx: number;
  ty: number;
  rot: number;
}

export interface RecordedCanvasContext {
  readonly ctx: CanvasRenderingContext2D;
  getLines(): string[];
  clearLines(): void;
  getGlobalAlpha(): number;
}

function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "0.000000";
  const rounded = Number(value.toFixed(6));
  const normalized = Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
  return normalized.toFixed(6);
}

export function createRecordingCanvasContext(): RecordedCanvasContext {
  let state: CanvasRecorderState = {
    fillStyle: "#000000",
    globalAlpha: 1,
    tx: 0,
    ty: 0,
    rot: 0,
  };
  const stack: CanvasRecorderState[] = [];
  const lines: string[] = [];

  const facade = {
    get fillStyle(): string | CanvasGradient | CanvasPattern {
      return state.fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      state.fillStyle = typeof value === "string" ? value : "[object]";
    },
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    get globalAlpha(): number {
      return state.globalAlpha;
    },
    set globalAlpha(value: number) {
      state.globalAlpha = value;
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      const transformSuffix =
        state.tx !== 0 || state.ty !== 0 || state.rot !== 0
          ? ` tx=${formatNumber(state.tx)} ty=${formatNumber(state.ty)} rot=${formatNumber(state.rot)}`
          : "";
      lines.push(
        `fillRect x=${formatNumber(x)} y=${formatNumber(y)} w=${formatNumber(w)} h=${formatNumber(h)} fill=${state.fillStyle} alpha=${formatNumber(state.globalAlpha)}${transformSuffix}`,
      );
    },
    strokeRect(): void {},
    clearRect(): void {},
    beginPath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    arc(): void {},
    closePath(): void {},
    fill(): void {},
    stroke(): void {},
    save(): void {
      stack.push({ ...state });
    },
    restore(): void {
      const prev = stack.pop();
      if (prev) {
        state = prev;
      }
    },
    translate(dx: number, dy: number): void {
      state.tx += dx;
      state.ty += dy;
    },
    rotate(rad: number): void {
      state.rot += rad;
    },
    scale(): void {},
    fillText(): void {},
    strokeText(): void {},
    drawImage(): void {},
    setLineDash(): void {},
    createLinearGradient(): CanvasGradient {
      return { addColorStop(): void {} } as unknown as CanvasGradient;
    },
  };

  return {
    ctx: facade as unknown as CanvasRenderingContext2D,
    getLines: () => [...lines],
    clearLines: () => {
      lines.length = 0;
    },
    getGlobalAlpha: () => state.globalAlpha,
  };
}
