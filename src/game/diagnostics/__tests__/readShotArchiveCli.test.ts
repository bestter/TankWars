import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(result.stderr).toContain("[--max-input-mib <n>]");
  });

  it("lets the caller raise the input size limit for a large archive", () => {
    const directory = mkdtempSync(join(tmpdir(), "tankwars-archive-cli-"));
    const archive = join(directory, "archive.json");
    try {
      writeFileSync(archive, JSON.stringify({ schemaVersion: 1, session: {}, blocks: [] }) + " ".repeat(1024 * 1024));
      const rejected = run(archive, "--max-input-mib", "1");
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("ARCHIVE_TOO_LARGE");
      const accepted = run(archive, "--max-input-mib", "2");
      expect(accepted.status).toBe(2);
      expect(JSON.parse(accepted.stdout).capabilities.singleShotReplay).toBe(false);
    } finally {
      rmSync(archive, { force: true });
      rmdirSync(directory);
    }
  });

  it.each(["0", "1.5", "Infinity", "999999"])("rejects an invalid input size limit (%s)", limit => {
    const result = run("missing-archive.json", "--max-input-mib", limit);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("Error: INVALID_ARCHIVE_SIZE_LIMIT");
  });

  it.each(["--max-input-mib", "--shot", "--shot-hash", "--weapon", "--angle", "--power", "--output"])(
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

  it("rejects conflicting shot selectors before reading the input file", () => {
    const result = run("missing-archive.json", "--shot", "b:1:1", "--shot-hash", "a".repeat(64));
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("Error: SELECT_SHOT_BY_KEY_OR_HASH");
  });

  it("rejects incomplete alternative command flags before reading the input file", () => {
    const result = run("missing-archive.json", "--shot", "b:1:1", "--weapon", "MISSILE", "--angle", "45");
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("Error: INCOMPLETE_ALTERNATIVE_COMMAND");
  });

  it.each([
    ["abc", "50"],
    ["181", "50"],
    ["45", "0"],
    ["45", "50.5"],
    ["45", "100"],
  ])(
    "rejects invalid alternative command bounds (angle=%s, power=%s) before reading the input file",
    (angle, power) => {
      const result = run("missing-archive.json", "--shot", "b:1:1", "--weapon", "MISSILE", "--angle", angle, "--power", power);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("Error: INVALID_ALTERNATIVE_COMMAND");
    },
  );
});
