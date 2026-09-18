import { describe, expect, it } from "vitest";
import {
  AI_PROFILE_IDS,
  AI_PROFILE_UI,
  DEFAULT_AI_PROFILE,
  controllerBadge,
  isAiProfile,
} from "../playerControllerUi";

describe("playerControllerUi", () => {
  it("DEFAULT_AI_PROFILE is v1-random", () => {
    expect(DEFAULT_AI_PROFILE).toBe("v1-random");
  });

  it("AI_PROFILE_IDS lists every table key once", () => {
    expect(AI_PROFILE_IDS).toEqual(Object.keys(AI_PROFILE_UI).filter(isAiProfile));
  });

  describe("controllerBadge", () => {
    it("returns 'P' for human players regardless of AI profile", () => {
      expect(controllerBadge(true)).toBe("P");
      expect(controllerBadge(true, "v1-random")).toBe("P");
      expect(controllerBadge(true, "v4-smart")).toBe("P");
    });

    it("returns correct badge for each AI profile", () => {
      expect(controllerBadge(false, "v1-random")).toBe("CPU");
      expect(controllerBadge(false, "v2-heuristic")).toBe("OK");
      expect(controllerBadge(false, "v3-sniper")).toBe("SNIP");
      expect(controllerBadge(false, "v4-smart")).toBe("EXPT");
    });

    it("returns default badge (CPU) when AI profile is undefined", () => {
      expect(controllerBadge(false)).toBe("CPU");
      expect(controllerBadge(false, undefined)).toBe("CPU");
    });
  });

  it.each(["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"] as const)(
    "isAiProfile(%s) is true",
    (profile) => {
      expect(isAiProfile(profile)).toBe(true);
      expect(AI_PROFILE_UI[profile].badge).toBeTruthy();
      expect(AI_PROFILE_UI[profile].nameKey).toMatch(/^ai_name_/);
      expect(AI_PROFILE_UI[profile].optionKey).toMatch(/^controller_ai_/);
    },
  );

  it.each(["human", "v5-nope", ""])("isAiProfile(%s) is false", (value) => {
    expect(isAiProfile(value)).toBe(false);
  });
});
