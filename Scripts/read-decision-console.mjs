import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read text as data only. Missing/truncated parts produce an explicitly incomplete entry. */
export function readDecisionConsole(text) {
  const entries = new Map();
  const malformed = [];
  const unsupported = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/(\[AI EXPERT\] Décision|\[Shot advisor\] Décision)( fragment)?(?: (.*))?$/);
    if (!match) continue;
    let value;
    try { value = JSON.parse(match[3]); }
    catch { malformed.push(index + 1); continue; }
    if (value?.format !== "tankwars-decision-v1" || typeof value.traceId !== "string") { unsupported.push(index + 1); continue; }
    let entry = entries.get(value.traceId);
    if (!entry) {
      entry = { traceId: value.traceId, label: match[1], header: null, summary: new Map(), detail: new Map(), problems: [] };
      entries.set(value.traceId, entry);
    }
    if (!match[2]) { entry.header = value; continue; }
    if (!["summary", "detail"].includes(value.kind) || !Number.isSafeInteger(value.part) ||
      !Number.isSafeInteger(value.total) || value.part < 1 || value.part > value.total || typeof value.data !== "string") {
      entry.problems.push(`invalid-fragment:${index + 1}`); continue;
    }
    const previous = entry[value.kind].get(value.part);
    if (previous && (previous.data !== value.data || previous.total !== value.total)) entry.problems.push("conflicting-fragment");
    entry[value.kind].set(value.part, value);
  }
  const decisions = [...entries.values()].map(entry => {
    const errors = [...entry.problems];
    if (!entry.header) errors.push("missing-header");
    const assemble = (kind, count) => {
      if (!Number.isSafeInteger(count) || count < 0) { errors.push(`invalid-${kind}-count`); return null; }
      const parts = entry[kind];
      if (parts.size !== count) { errors.push(`missing-${kind}-fragments`); return null; }
      let json = "";
      for (let part = 1; part <= count; part++) {
        const value = parts.get(part);
        if (!value || value.total !== count) { errors.push(`invalid-${kind}-sequence`); return null; }
        json += value.data;
      }
      try { return JSON.parse(json); } catch { errors.push(`invalid-${kind}-json`); return null; }
    };
    const summary = entry.header?.summaryParts ? assemble("summary", entry.header.summaryParts) : entry.header;
    const details = entry.header ? assemble("detail", entry.header.detailParts) : null;
    return { traceId: entry.traceId, label: entry.label, complete: errors.length === 0, errors, summary, details };
  });
  return { complete: malformed.length === 0 && unsupported.length === 0 && decisions.every(value => value.complete),
    malformedLines: malformed, unsupportedLines: unsupported, decisions };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) { console.error("Usage: node Scripts/read-decision-console.mjs <console.txt>"); process.exitCode = 1; }
  else {
    const result = readDecisionConsole(readFileSync(path, "utf8"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
  }
}
