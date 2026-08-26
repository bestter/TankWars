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

  it.each([
    [true, undefined, "P"],
    [false, "v1-random", "CPU"],
    [false, undefined, "CPU"],
    [false, "v2-heuristic", "OK"],
    [false, "v3-sniper", "SNIP"],
    [false, "v4-smart", "EXPT"],
  ] as const)("controllerBadge(%s, %s) === %s", (isHuman, profile, badge) => {
    expect(controllerBadge(isHuman, profile)).toBe(badge);
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
