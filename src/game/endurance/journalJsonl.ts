import type { JournalEntry, JournalStatus } from "./journal";

export interface JournalTextPage {
  status: JournalStatus | null;
  firstSequence: number | null;
  lastSequence: number | null;
  count: number;
  bytes: number;
  text: string;
}

export function validateJournalPageRequest(after?: unknown, limit?: unknown): { after: number; limit: number } {
  const a = after === undefined ? 0 : after;
  const l = limit === undefined ? 256 : limit;
  if (typeof a !== "number" || !Number.isSafeInteger(a) || a < 0 || typeof l !== "number" || !Number.isSafeInteger(l) || l < 1 || l > 256) {
    throw new Error("INVALID_JOURNAL_PAGE_REQUEST");
  }
  return { after: a, limit: l };
}

export function formatJournalTextPage(
  rawEntries: readonly JournalEntry[],
  sessionId: string,
  after: number,
  limit: number,
  status: JournalStatus | null,
): JournalTextPage {
  if (!status) {
    return { status: null, firstSequence: null, lastSequence: null, count: 0, bytes: 0, text: "" };
  }
  const upper = status.persisted;
  if (after >= upper) {
    return { status: { ...status }, firstSequence: null, lastSequence: null, count: 0, bytes: 0, text: "" };
  }
  const rows = rawEntries.filter(e => e.sequence <= upper);
  const expectedCount = Math.min(limit, upper - after);
  if (rows.length !== expectedCount) {
    throw new Error("JOURNAL_SEQUENCE_GAP");
  }
  const chunks: string[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const row = rows[i];
    if (row.sequence !== after + 1 + i || row.sessionId !== sessionId) {
      throw new Error("JOURNAL_SEQUENCE_GAP");
    }
    chunks.push(JSON.stringify(row) + "\n");
  }
  const text = chunks.join("");
  const bytes = new TextEncoder().encode(text).byteLength;
  return {
    status: { ...status },
    firstSequence: rows[0].sequence,
    lastSequence: rows[rows.length - 1].sequence,
    count: rows.length,
    bytes,
    text,
  };
}

export async function exportJournalJsonl(options: {
  status: JournalStatus;
  readPage: (after: number, limit: number) => Promise<JournalEntry[]>;
  pending?: () => JournalEntry[];
}): Promise<string> {
  const { status, readPage, pending } = options;
  const chunks: string[] = [];
  chunks.push(JSON.stringify({ schemaVersion: 1, kind: "journal-status", status }) + "\n");
  const upper = status.persisted;
  let after = 0;
  while (after < upper) {
    const limit = 256;
    // Each bounded page depends on the last sequence read; do not load the full history in parallel.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const entries = await readPage(after, limit);
    const page = formatJournalTextPage(entries, status.sessionId, after, limit, status);
    if (page.count === 0) throw new Error("JOURNAL_SEQUENCE_GAP");
    chunks.push(page.text);
    after = page.lastSequence!;
  }
  if (status.error && pending) {
    for (const row of pending()) {
      if (row.sequence <= upper) continue;
      if (row.sequence !== ++after || row.sessionId !== status.sessionId) throw new Error("JOURNAL_SEQUENCE_GAP");
      chunks.push(JSON.stringify(row) + "\n");
    }
  }
  return chunks.join("");
}
