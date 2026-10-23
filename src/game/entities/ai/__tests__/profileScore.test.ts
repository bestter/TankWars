import { describe, it, expect } from "vitest";
import { playerProfileScore } from "../profileScore";
import { makePlayer } from "../../../__tests__/helpers";

describe("playerProfileScore", () => {
  it("should return 0.9 for human players", () => {
    const humanPlayer = makePlayer({ isHuman: true });
    expect(playerProfileScore(humanPlayer)).toBe(0.9);
  });

  it("should return 1 for v4-smart AI profile", () => {
    const aiPlayer = makePlayer({ isHuman: false, aiProfile: "v4-smart" });
    expect(playerProfileScore(aiPlayer)).toBe(1);
  });

  it("should return 0.8 for v3-sniper AI profile", () => {
    const aiPlayer = makePlayer({ isHuman: false, aiProfile: "v3-sniper" });
    expect(playerProfileScore(aiPlayer)).toBe(0.8);
  });

  it("should return 0.1 for v1-random AI profile", () => {
    const aiPlayer = makePlayer({ isHuman: false, aiProfile: "v1-random" });
    expect(playerProfileScore(aiPlayer)).toBe(0.1);
  });

  it("should return 0.5 for default/other AI profiles", () => {
    const aiPlayer = makePlayer({ isHuman: false, aiProfile: "v2-heuristic" });
    expect(playerProfileScore(aiPlayer)).toBe(0.5);
  });

  it("should return 0.5 for AI with no specific profile set", () => {
    const aiPlayer = makePlayer({ isHuman: false });
    // Simulate no profile
    delete aiPlayer.aiProfile;
    expect(playerProfileScore(aiPlayer)).toBe(0.5);
  });
});
