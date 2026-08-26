import { describe, expect, it, vi } from "vitest";
import {
  getDuplicateNameGroups,
  getEmptyNamePlayerIds,
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

  it("identifies player configs with empty or whitespace-only names", () => {
    const configs: NamedPlayerConfig[] = [
      human("p1", "Patate"),
      human("p2", ""),
      human("p3", "   "),
      human("p4", "Carotte"),
    ];

    expect(getEmptyNamePlayerIds(configs)).toEqual(["p2", "p3"]);
  });

  it("normalizes accented and non-ASCII Unicode names case-insensitively", () => {
    expect(normalizePlayerName("  Élise  ")).toBe("élise");
    expect(normalizePlayerName("ÉLÈVE")).toBe("élève");
    expect(normalizePlayerName("ÑANDU")).toBe("ñandu");
    expect(normalizePlayerName("MÜLLER")).toBe("müller");
    expect(normalizePlayerName("  ČESKÝ  ")).toBe("český");
  });

  it("normalizes ASCII casing independently of the host locale", () => {
    const localeLowerCaseSpy = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockReturnValue("sımple");

    try {
      expect(normalizePlayerName("  SIMPLE  ")).toBe("simple");
      expect(localeLowerCaseSpy).not.toHaveBeenCalled();
    } finally {
      localeLowerCaseSpy.mockRestore();
    }
  });

  it("groups duplicate names with accented characters", () => {
    const configs: NamedPlayerConfig[] = [
      human("p1", "  Élise  "),
      human("p2", "ÉLISE"),
      human("p3", "élise"),
      human("p4", "Élise-1"),
    ];

    const groups = getDuplicateNameGroups(configs);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it.each([
    {
      label: "human name collision and suffix gap",
      configs: [human("p1", " simple "), human("p2", "Simple-2")],
      expected: "Simple-1",
    },
    {
      label: "accented base name collision",
      configs: [human("p1", " élite "), human("p2", "Élite-1")],
      expected: "Élite-2",
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
    const baseName = expected.startsWith("Élite") ? "Élite" : "Simple";
    expect(
      getUniqueAiName(baseName, "v1-random", configs, configs.length),
    ).toBe(expected);
  });
});
