import { describe, expect, it } from "vitest";
import {
  getDuplicateNameGroups,
  getNameConflictIds,
  getUniqueAiName,
  normalizePlayerName,
  type NamedPlayerConfig,
} from "../playerNameUi";

const human = (id: string, name: string): NamedPlayerConfig => ({
  id,
  name,
  isHuman: true,
});

describe("playerNameUi", () => {
  it("normalizes names case-insensitively after trimming outer whitespace", () => {
    expect(normalizePlayerName("  Simple  ")).toBe("simple");
    expect(normalizePlayerName("SIMPLE-1")).toBe("simple-1");
  });

  it("finds conflicts regardless of controller type or AI profile", () => {
    const configs: NamedPlayerConfig[] = [
      human("p1", " Simple "),
      {
        id: "p2",
        name: "simple",
        isHuman: false,
        aiProfile: "v4-smart",
      },
      human("p3", "Simple-1"),
    ];

    expect(getNameConflictIds(configs, "p1")).toEqual(["p2"]);
    expect(getNameConflictIds(configs, "p2")).toEqual(["p1"]);
    expect(getNameConflictIds(configs, "p3")).toEqual([]);
    expect(getNameConflictIds(configs, "missing")).toEqual([]);
  });

  it("groups triple duplicates while ignoring empty names", () => {
    const configs: NamedPlayerConfig[] = [
      human("p1", "Patate"),
      human("p2", "PATATE"),
      human("p3", " patate "),
      human("p4", "   "),
    ];

    const groups = getDuplicateNameGroups(configs);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((player) => player.id)).toEqual(["p1", "p2", "p3"]);
  });

  it.each([
    {
      label: "human name collision and suffix gap",
      configs: [human("p1", " simple "), human("p2", "Simple-2")],
      expected: "Simple-1",
    },
    {
      label: "matching profile count and occupied suffix",
      configs: [
        {
          id: "p1",
          name: "Ace Bot",
          isHuman: false,
          aiProfile: "v1-random" as const,
        },
        human("p2", "SIMPLE-1"),
      ],
      expected: "Simple-2",
    },
    {
      label: "different AI profile using the base name",
      configs: [
        {
          id: "p1",
          name: "simple",
          isHuman: false,
          aiProfile: "v4-smart" as const,
        },
      ],
      expected: "Simple-1",
    },
  ])("generates a unique AI name for $label", ({ configs, expected }) => {
    expect(
      getUniqueAiName("Simple", "v1-random", configs, configs.length),
    ).toBe(expected);
  });
});
