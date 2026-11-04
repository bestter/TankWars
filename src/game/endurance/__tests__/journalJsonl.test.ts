import { describe, expect, it } from "vitest";
import {
  exportJournalJsonl,
  formatJournalTextPage,
  validateJournalPageRequest,
} from "../journalJsonl";
import type { JournalEntry, JournalStatus } from "../journal";

function makeEntry(sequence: number, sessionId = "test-session", extra: Record<string, unknown> = {}): JournalEntry {
  return {
    schemaVersion: 1,
    sessionId,
    sequence,
    at: "2026-11-04T12:00:00.000Z",
    atMs: sequence * 100,
    blockId: "block-1",
    blockIndex: 1,
    seed: 12345,
    round: 1,
    turn: sequence,
    phase: "COMBAT",
    decisionId: `decision-${sequence}`,
    event: { kind: "session-start", metadata: { sequence, ...extra } },
    context: null,
    contextError: null,
  };
}

describe("validateJournalPageRequest", () => {
  it("uses defaults after=0 and limit=256", () => {
    expect(validateJournalPageRequest()).toEqual({ after: 0, limit: 256 });
    expect(validateJournalPageRequest(undefined, undefined)).toEqual({ after: 0, limit: 256 });
  });

  it("accepts valid safe integers within range", () => {
    expect(validateJournalPageRequest(0, 1)).toEqual({ after: 0, limit: 1 });
    expect(validateJournalPageRequest(100, 256)).toEqual({ after: 100, limit: 256 });
    expect(validateJournalPageRequest(Number.MAX_SAFE_INTEGER, 128)).toEqual({
      after: Number.MAX_SAFE_INTEGER,
      limit: 128,
    });
  });

  it("rejects invalid after or limit without coercion", () => {
    const invalidCases: Array<[unknown, unknown]> = [
      [-1, 256],
      [1.5, 256],
      [NaN, 256],
      [Infinity, 256],
      ["0", 256],
      [null, 256],
      [0, 0],
      [0, 257],
      [0, 1.5],
      [0, NaN],
      [0, -1],
      [0, "128"],
      [0, null],
    ];
    for (const [after, limit] of invalidCases) {
      expect(() => validateJournalPageRequest(after, limit)).toThrow("INVALID_JOURNAL_PAGE_REQUEST");
    }
  });
});

describe("formatJournalTextPage & pagination", () => {
  const sessionId = "sess-1";

  it("returns empty page when status is null", () => {
    const page = formatJournalTextPage([], sessionId, 0, 256, null);
    expect(page).toEqual({
      status: null,
      firstSequence: null,
      lastSequence: null,
      count: 0,
      bytes: 0,
      text: "",
    });
  });

  it("returns empty page when after >= status.persisted without reading rows", () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId,
      emitted: 50,
      persisted: 50,
      complete: true,
      error: null,
    };
    const page = formatJournalTextPage([], sessionId, 50, 256, status);
    expect(page).toEqual({
      status,
      firstSequence: null,
      lastSequence: null,
      count: 0,
      bytes: 0,
      text: "",
    });

    const pageMaxSafe = formatJournalTextPage([], sessionId, Number.MAX_SAFE_INTEGER, 256, status);
    expect(pageMaxSafe.count).toBe(0);
    expect(pageMaxSafe.text).toBe("");
  });

  it("paginates multiple pages up to exact limit and matches lastSequence", () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId,
      emitted: 500,
      persisted: 500,
      complete: true,
      error: null,
    };
    const allEntries = Array.from({ length: 500 }, (_, i) => makeEntry(i + 1, sessionId));

    // Page 1: limit 200
    const rawPage1 = allEntries.slice(0, 200);
    const page1 = formatJournalTextPage(rawPage1, sessionId, 0, 200, status);
    expect(page1.count).toBe(200);
    expect(page1.firstSequence).toBe(1);
    expect(page1.lastSequence).toBe(200);
    expect(page1.bytes).toBe(new TextEncoder().encode(page1.text).byteLength);

    // Page 2: limit 200
    const rawPage2 = allEntries.slice(200, 400);
    const page2 = formatJournalTextPage(rawPage2, sessionId, 200, 200, status);
    expect(page2.count).toBe(200);
    expect(page2.firstSequence).toBe(201);
    expect(page2.lastSequence).toBe(400);

    // Page 3: limit 200, but only 100 remain
    const rawPage3 = allEntries.slice(400, 500);
    const page3 = formatJournalTextPage(rawPage3, sessionId, 400, 200, status);
    expect(page3.count).toBe(100);
    expect(page3.firstSequence).toBe(401);
    expect(page3.lastSequence).toBe(500);

    // Page 4: after >= persisted -> empty
    const page4 = formatJournalTextPage([], sessionId, 500, 200, status);
    expect(page4.count).toBe(0);
    expect(page4.firstSequence).toBeNull();
    expect(page4.lastSequence).toBeNull();
    expect(page4.text).toBe("");
  });

  it("fails with JOURNAL_SEQUENCE_GAP when page is truncated under confirmed bound", () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId,
      emitted: 10,
      persisted: 10,
      complete: false,
      error: null,
    };
    // Expected 10 rows, but only 5 provided
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(i + 1, sessionId));
    expect(() => formatJournalTextPage(entries, sessionId, 0, 256, status)).toThrow("JOURNAL_SEQUENCE_GAP");
  });

  it("fails with JOURNAL_SEQUENCE_GAP on sequence gaps, duplicates, disorder, or sessionId mismatch", () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId,
      emitted: 3,
      persisted: 3,
      complete: true,
      error: null,
    };

    // Gap: sequence 1, then 3
    expect(() =>
      formatJournalTextPage([makeEntry(1, sessionId), makeEntry(3, sessionId)], sessionId, 0, 256, status),
    ).toThrow("JOURNAL_SEQUENCE_GAP");

    // Duplicate: 1, 1, 2
    expect(() =>
      formatJournalTextPage(
        [makeEntry(1, sessionId), makeEntry(1, sessionId), makeEntry(2, sessionId)],
        sessionId,
        0,
        256,
        status,
      ),
    ).toThrow("JOURNAL_SEQUENCE_GAP");

    // Disorder: 2, 1, 3
    expect(() =>
      formatJournalTextPage(
        [makeEntry(2, sessionId), makeEntry(1, sessionId), makeEntry(3, sessionId)],
        sessionId,
        0,
        256,
        status,
      ),
    ).toThrow("JOURNAL_SEQUENCE_GAP");

    // Wrong session ID
    expect(() =>
      formatJournalTextPage(
        [makeEntry(1, sessionId), makeEntry(2, "different-session"), makeEntry(3, sessionId)],
        sessionId,
        0,
        256,
        status,
      ),
    ).toThrow("JOURNAL_SEQUENCE_GAP");
  });
});

describe("Concurrency and exportJournalJsonl", () => {
  const sessionId = "concurrency-sess";

  it("freezes upper bound to status.persisted and ignores concurrent writes beyond it", async () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId,
      emitted: 5,
      persisted: 3,
      complete: false,
      error: null,
    };
    // Storage has 5 entries, but status.persisted is 3
    const allEntries = Array.from({ length: 5 }, (_, i) => makeEntry(i + 1, sessionId));
    const jsonl = await exportJournalJsonl({
      status,
      readPage: async (after, limit) => allEntries.filter(e => e.sequence > after).slice(0, limit),
    });

    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(4); // 1 header + 3 entries
    expect(JSON.parse(lines[0])).toMatchObject({ kind: "journal-status", status: { persisted: 3 } });
    expect(JSON.parse(lines[1])).toMatchObject({ sequence: 1 });
    expect(JSON.parse(lines[2])).toMatchObject({ sequence: 2 });
    expect(JSON.parse(lines[3])).toMatchObject({ sequence: 3 });
  });

  it("on clean state without error, concatenating text pages matches full export lines without header", async () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId,
      emitted: 20,
      persisted: 20,
      complete: true,
      error: null,
    };
    const allEntries = Array.from({ length: 20 }, (_, i) => makeEntry(i + 1, sessionId));

    // Collect pages of limit 7
    const pageTexts: string[] = [];
    let after = 0;
    while (after < status.persisted) {
      const limit = 7;
      const raw = allEntries.filter(e => e.sequence > after).slice(0, limit);
      const page = formatJournalTextPage(raw, sessionId, after, limit, status);
      pageTexts.push(page.text);
      after = page.lastSequence!;
    }
    const concatenatedPages = pageTexts.join("");

    const fullExport = await exportJournalJsonl({
      status,
      readPage: async (a, l) => allEntries.filter(e => e.sequence > a).slice(0, l),
    });
    const headerEnd = fullExport.indexOf("\n") + 1;
    const fullWithoutHeader = fullExport.slice(headerEnd);

    expect(concatenatedPages).toBe(fullWithoutHeader);
    expect(new TextEncoder().encode(concatenatedPages)).toEqual(new TextEncoder().encode(fullWithoutHeader));
  });

  it("appends pending rows as suffix only after confirmed prefix when status has error", async () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId,
      emitted: 5,
      persisted: 2,
      complete: false,
      error: "STORAGE_DISK_FULL",
    };
    const confirmed = [makeEntry(1, sessionId), makeEntry(2, sessionId)];
    // Pending includes sequence 2 (already confirmed), 3, 4, 5
    const pending = [makeEntry(2, sessionId), makeEntry(3, sessionId), makeEntry(4, sessionId), makeEntry(5, sessionId)];

    const jsonl = await exportJournalJsonl({
      status,
      readPage: async (after, limit) => confirmed.filter(e => e.sequence > after).slice(0, limit),
      pending: () => pending,
    });

    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(6); // 1 header + 2 confirmed + 3 pending
    expect(JSON.parse(lines[0])).toMatchObject({ kind: "journal-status", status: { error: "STORAGE_DISK_FULL" } });
    expect(JSON.parse(lines[1])).toMatchObject({ sequence: 1 });
    expect(JSON.parse(lines[2])).toMatchObject({ sequence: 2 });
    expect(JSON.parse(lines[3])).toMatchObject({ sequence: 3 });
    expect(JSON.parse(lines[4])).toMatchObject({ sequence: 4 });
    expect(JSON.parse(lines[5])).toMatchObject({ sequence: 5 });
  });

  it("recovery export ignores pending rows even if error is present (none passed)", async () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId,
      emitted: 5,
      persisted: 2,
      complete: false,
      error: "CRASH",
    };
    const confirmed = [makeEntry(1, sessionId), makeEntry(2, sessionId)];

    const jsonl = await exportJournalJsonl({
      status,
      readPage: async (after, limit) => confirmed.filter(e => e.sequence > after).slice(0, limit),
    });

    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(3); // 1 header + 2 confirmed
  });
});

describe("JSON serialization fidelity and byte comparisons", () => {
  it("preserves exact native JSON.stringify behavior for edge-case values", () => {
    const status: JournalStatus = {
      schemaVersion: 1,
      sessionId: "fidelity-sess",
      emitted: 1,
      persisted: 1,
      complete: true,
      error: null,
    };
    const edgeData = {
      absentField: undefined,
      explicitNull: null,
      arrayWithUndefined: [1, undefined, 3],
      emptyArray: [],
      emptyObject: {},
      emptyString: "",
      zero: 0,
      negativeZero: -0,
      smallFloat: 9.379815310239792e-6,
      largeFloat: 1e21,
      notANumber: NaN,
      posInfinity: Infinity,
      negInfinity: -Infinity,
      unicodeAccents: "Montréal, Québec, été & naïf",
      emojis: "🎮💥💣🚀",
      newlinesAndEscapes: "Line 1\nLine 2\r\n\tTab\"Quote\\Backslash",
      lineSeparators: "Paragraph\u2028Line\u2029End",
      isolatedSurrogate: "half\uD800surrogate",
      nested: { a: { b: { c: [false, true, null] } } },
    };

    const entry = makeEntry(1, "fidelity-sess", edgeData);
    const page = formatJournalTextPage([entry], "fidelity-sess", 0, 256, status);

    // Verify UTF-8 bytes count differs from string length due to multi-byte unicode
    expect(page.bytes).toBeGreaterThan(page.text.length);
    expect(page.bytes).toBe(new TextEncoder().encode(page.text).byteLength);

    const parsed = JSON.parse(page.text.trim()) as { event: { metadata: typeof edgeData } };
    const meta = parsed.event.metadata;

    // undefined properties omitted
    expect("absentField" in meta).toBe(false);
    expect(meta.explicitNull).toBeNull();
    // undefined in array becomes null
    expect(meta.arrayWithUndefined).toEqual([1, null, 3]);
    expect(meta.emptyArray).toEqual([]);
    expect(meta.emptyObject).toEqual({});
    expect(meta.emptyString).toBe("");
    expect(meta.zero).toBe(0);
    // -0 becomes 0
    expect(Object.is(meta.negativeZero, 0)).toBe(true);
    expect(meta.smallFloat).toBe(9.379815310239792e-6);
    expect(meta.largeFloat).toBe(1e21);
    // NaN and +-Infinity become null
    expect(meta.notANumber).toBeNull();
    expect(meta.posInfinity).toBeNull();
    expect(meta.negInfinity).toBeNull();
    expect(meta.unicodeAccents).toBe("Montréal, Québec, été & naïf");
    expect(meta.emojis).toBe("🎮💥💣🚀");
    expect(meta.newlinesAndEscapes).toBe("Line 1\nLine 2\r\n\tTab\"Quote\\Backslash");
    expect(meta.lineSeparators).toBe("Paragraph\u2028Line\u2029End");
    expect(meta.nested).toEqual({ a: { b: { c: [false, true, null] } } });
  });
});
