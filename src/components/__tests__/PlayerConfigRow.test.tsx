// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PlayerConfigRow, type PlayerConfigRowProps } from "../PlayerConfigRow";
import type { PlayerConfig } from "../MainMenu";
import { VGA_PALETTE } from "../../types/game";
import { AI_PROFILE_IDS, controllerBadge } from "../playerControllerUi";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      if (options.num !== undefined) return `${key}_${String(options.num)}`;
      if (typeof options.color === "string") return `${key}_${options.color}`;
      return key;
    },
  }),
}));

const sampleColorPool = [VGA_PALETTE.BLUE, VGA_PALETTE.RED, VGA_PALETTE.GREEN] as const;

const defaultCfg: PlayerConfig = {
  id: "p-1",
  name: "Player 1",
  isHuman: true,
  color: VGA_PALETTE.BLUE,
};

function renderRow(
  overrides: Partial<Omit<PlayerConfigRowProps, "cfg">> & { cfg?: PlayerConfig } = {},
) {
  const props: PlayerConfigRowProps = {
    index: 0,
    unavailableColors: new Set(),
    colorPool: sampleColorPool,
    nameInputRef: () => {},
    onNameChange: () => {},
    onColorSelect: () => {},
    onControllerChange: () => {},
    cfg: defaultCfg,
    ...overrides,
  };
  return render(<PlayerConfigRow {...props} />);
}

describe("PlayerConfigRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("renders human player row with name input and human controller select", () => {
    renderRow({
      unavailableColors: new Set([VGA_PALETTE.RED]),
    });

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Player 1");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("human");
  });

  it("triggers onNameChange when editing the name input", () => {
    const onNameChange = vi.fn();
    renderRow({ onNameChange });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Commander Z" } });
    expect(onNameChange).toHaveBeenCalledWith(0, "Commander Z");
  });

  it("triggers onControllerChange with the selected AI profile", () => {
    const onControllerChange = vi.fn();
    renderRow({ onControllerChange });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "v3-sniper" } });
    expect(onControllerChange).toHaveBeenCalledWith(0, "v3-sniper");
  });

  it("triggers onControllerChange when changing controller from AI back to human", () => {
    const onControllerChange = vi.fn();
    renderRow({
      index: 1,
      onControllerChange,
      cfg: {
        id: "p-2",
        name: "CPU Bot",
        isHuman: false,
        aiProfile: "v2-heuristic",
        color: VGA_PALETTE.RED,
      },
    });

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("v2-heuristic");

    fireEvent.change(select, { target: { value: "human" } });
    expect(onControllerChange).toHaveBeenCalledWith(1, "human");
  });

  it("triggers onColorSelect when a ColorPicker swatch is clicked", () => {
    const onColorSelect = vi.fn();
    renderRow({ index: 2, onColorSelect });

    fireEvent.click(
      screen.getByRole("button", { name: `color_select_label_${VGA_PALETTE.RED}` }),
    );
    expect(onColorSelect).toHaveBeenCalledWith(2, VGA_PALETTE.RED);
  });

  it.each([
    [{ isHuman: true } as const, "P"],
    [{ isHuman: false, aiProfile: "v1-random" } as const, "CPU"],
    [{ isHuman: false, aiProfile: "v2-heuristic" } as const, "OK"],
    [{ isHuman: false, aiProfile: "v3-sniper" } as const, "SNIP"],
    [{ isHuman: false, aiProfile: "v4-smart" } as const, "EXPT"],
  ])("wires controller badge %s → %s", (patch, badge) => {
    const cfg: PlayerConfig = {
      id: "p-1",
      name: "P1",
      color: VGA_PALETTE.BLUE,
      isHuman: patch.isHuman,
      ...("aiProfile" in patch ? { aiProfile: patch.aiProfile } : {}),
    };
    renderRow({ cfg });
    expect(screen.getByText(badge).textContent).toBe(
      controllerBadge(cfg.isHuman, cfg.aiProfile),
    );
  });

  it("falls back to v1-random select value and CPU badge when aiProfile is missing", () => {
    const cfg: PlayerConfig = {
      id: "p-1",
      name: "P1",
      isHuman: false,
      color: VGA_PALETTE.BLUE,
    };
    renderRow({ cfg });

    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("v1-random");
    expect(screen.getByText("CPU").textContent).toBe("CPU");
  });

  it("renders an option for every AI profile in the UI table", () => {
    renderRow();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("human");
    for (const profile of AI_PROFILE_IDS) {
      expect(values).toContain(profile);
    }
  });
});
