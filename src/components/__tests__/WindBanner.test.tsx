import { describe, it, expect, vi, beforeEach } from "vitest";
import { WindBanner } from "../WindBanner";
import { VGA_PALETTE } from "../../types/game";
import * as windModule from "../../game/wind";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.label !== undefined && options.strength !== undefined) {
        return `${key} ${options.label} ${options.strength}`;
      }
      return key;
    },
  }),
}));

describe("WindBanner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders correctly with CALM wind (0)", () => {
    const result = WindBanner({ windForce: 0 });

    expect(result.props.className).toBe("wind-banner");
    expect(result.props["aria-label"]).toBe("wind_aria_label wind_dir_calm 0");
    expect(result.props.children[1].props.children).toBe("—");
    expect(result.props.children[4].props.children).toBe("wind_no_drift");
  });

  it("renders a mid-strength EAST bar from formatWindDisplay", () => {
    const result = WindBanner({ windForce: 25 });
    const children = result.props.children;
    expect(children[1].props.children).toBe("→");
    expect(children[2].props.children).toBe("wind_dir_east");

    const innerBar = children[3].props.children[1].props.children;
    expect(innerBar.props.style.background).toBe(VGA_PALETTE.YELLOW);
    expect(innerBar.props.style.width).toBe(58);
  });

  it("caps extremely large values to bar width 120", () => {
    const result = WindBanner({ windForce: 1000 });
    const innerBar = result.props.children[3].props.children[1].props.children;
    expect(innerBar.props.style.width).toBe(120);
  });

  it("handles unknown label correctly using fallback", () => {
    vi.spyOn(windModule, "formatWindDisplay").mockReturnValueOnce({
      direction: "EAST",
      arrow: "→",
      strength: 10,
      label: "UNKNOWN_DIR",
    });

    const result = WindBanner({ windForce: 10 });
    expect(result.props["aria-label"]).toBe("wind_aria_label wind_dir_calm 10");
    expect(result.props.children[2].props.children).toBe("wind_dir_calm");
  });
});
