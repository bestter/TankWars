import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(...args: string[]) {
  const result = spawnSync(process.execPath, ["Scripts/read-shot-archive.mjs", ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

describe("read-shot-archive CLI", () => {
  it("documents the output option in its usage", () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[--output <file>]");
  });

  it.each(["--shot", "--shot-hash", "--weapon", "--angle", "--power", "--output"])(
    "rejects an empty value for %s before reading the input file",
    flag => {
      const result = run("missing-archive.json", flag, "");
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("Error: MISSING_CLI_VALUE");
    },
  );

  it.each(["abc", "F".repeat(64), "a".repeat(64) + "\n"])(
    "rejects a malformed hash before reading the input file",
    hash => {
      const result = run("missing-archive.json", "--shot-hash", hash);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("Error: INVALID_SHOT_HASH");
    },
  );
});
