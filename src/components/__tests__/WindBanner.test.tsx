import { describe, it, expect, vi, beforeEach } from "vitest";
import { WindBanner } from "../WindBanner";
import { VGA_PALETTE } from "../../types/game";
import * as windModule from "../../game/wind";

// Mock react-i18next
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

    expect(result.type).toBe("div");
    expect(result.props.className).toBe("wind-banner");
    expect(result.props["aria-label"]).toBe("wind_aria_label wind_dir_calm 0");

    const children = result.props.children;
    expect(children.length).toBe(5);

    // Check title
    expect(children[0].props.children).toBe("wind_title");

    // Check arrow
    expect(children[1].props.children).toBe("—");
    expect(children[1].props.style.color).toBe(VGA_PALETTE.GRAY);

    // Check direction label
    expect(children[2].props.children).toBe("wind_dir_calm");

    // Check calm message
    expect(children[3]).toBe(false); // fragment for non-calm
    expect(children[4].props.children).toBe("wind_no_drift");
  });

  it("renders correctly with weak EAST wind (15) - green bar", () => {
    const result = WindBanner({ windForce: 15 });

    expect(result.props["aria-label"]).toBe("wind_aria_label wind_dir_east 15");

    const children = result.props.children;

    // Check arrow
    expect(children[1].props.children).toBe("→");
    expect(children[1].props.style.color).toBe(VGA_PALETTE.YELLOW);

    // Check direction label
    expect(children[2].props.children).toBe("wind_dir_east");

    // Check bar fragment
    const barFragment = children[3];
    expect(barFragment).toBeTruthy();

    const strengthSpan = barFragment.props.children[0];
    const barContainer = barFragment.props.children[1];

    expect(strengthSpan.props.children).toBe(15);
    expect(strengthSpan.props.style.color).toBe(VGA_PALETTE.GREEN);

    const innerBar = barContainer.props.children;
    expect(innerBar.props.style.background).toBe(VGA_PALETTE.GREEN);

    // bar width calculation: Math.round(15 / 52 * 120) = Math.round(34.615...) = 35
    expect(innerBar.props.style.width).toBe(35);
  });

  it("renders correctly with medium EAST wind (25) - yellow bar", () => {
    const result = WindBanner({ windForce: 25 });

    const children = result.props.children;
    const barFragment = children[3];
    const barContainer = barFragment.props.children[1];
    const innerBar = barContainer.props.children;

    expect(innerBar.props.style.background).toBe(VGA_PALETTE.YELLOW);
    // Math.round(25 / 52 * 120) = 58
    expect(innerBar.props.style.width).toBe(58);
  });

  it("renders correctly with strong EAST wind (40) - red bar", () => {
    const result = WindBanner({ windForce: 40 });

    const children = result.props.children;
    const barFragment = children[3];
    const barContainer = barFragment.props.children[1];
    const innerBar = barContainer.props.children;

    expect(innerBar.props.style.background).toBe(VGA_PALETTE.RED);
    // Math.round(40 / 52 * 120) = 92
    expect(innerBar.props.style.width).toBe(92);
  });

  it("renders correctly with max WEST wind (-52)", () => {
    const result = WindBanner({ windForce: -52 });

    expect(result.props["aria-label"]).toBe("wind_aria_label wind_dir_west 52");

    const children = result.props.children;
    expect(children[1].props.children).toBe("←");
    expect(children[2].props.children).toBe("wind_dir_west");

    const barFragment = children[3];
    const innerBar = barFragment.props.children[1].props.children;

    expect(innerBar.props.style.background).toBe(VGA_PALETTE.RED);
    // Math.round(52 / 52 * 120) = 120
    expect(innerBar.props.style.width).toBe(120);
  });

  it("handles extremely large values by capping bar width to 120", () => {
    const result = WindBanner({ windForce: 1000 });
    const innerBar = result.props.children[3].props.children[1].props.children;
    expect(innerBar.props.style.width).toBe(120);
  });

  it("handles NaN windforce by formatting it gracefully", () => {
    // formatWindDisplay(NaN) returns { direction: 'WEST', arrow: '←', strength: NaN, label: 'WEST' }
    const result = WindBanner({ windForce: NaN });
    const children = result.props.children;
    expect(children[1].props.children).toBe("←");
    expect(children[2].props.children).toBe("wind_dir_west");
  });

  it("handles unknown label correctly using fallback", () => {
    vi.spyOn(windModule, "formatWindDisplay").mockReturnValueOnce({
      direction: "EAST",
      arrow: "→",
      strength: 10,
      label: "UNKNOWN_DIR",
    });

    const result = WindBanner({ windForce: 10 });

    // Check fallback in aria-label
    expect(result.props["aria-label"]).toBe("wind_aria_label wind_dir_calm 10");

    // Check fallback in span content
    const children = result.props.children;
    expect(children[2].props.children).toBe("wind_dir_calm");
  });
});
