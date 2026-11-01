export const DECISION_CONSOLE_MAX_LINE = 3000;
const FORMAT = "tankwars-decision-v1";
let sequence = 0;

/** Bound the encoded data, including quotes, control characters and surrogate pairs. */
function fragments(json: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < json.length;) {
    let end = Math.min(json.length, start + 1800);
    while (JSON.stringify(json.slice(start, end)).length > 2200) {
      end = start + Math.max(1, Math.floor((end - start) / 2));
    }
    parts.push(json.slice(start, end));
    start = end;
  }
  return parts;
}

/** One string per console call; long details remain recoverable as numbered JSON fragments. */
export function writeDecisionConsole(label: "[AI EXPERT] Décision" | "[Shot advisor] Décision", summary: Record<string, unknown>, details: unknown = summary): void {
  if (!import.meta.env.DEV) return;
  const traceId = `${performance.timeOrigin}:${++sequence}`;
  const detailParts = fragments(JSON.stringify(details) ?? "null");
  const header = { ...summary, format: FORMAT, traceId, detailParts: detailParts.length };
  const summaryLine = `${label} ${JSON.stringify(header)}`;
  const summaryParts = summaryLine.length <= DECISION_CONSOLE_MAX_LINE ? [] : fragments(JSON.stringify(summary));
  console.info(summaryParts.length === 0 ? summaryLine : `${label} ${JSON.stringify({
    format: FORMAT, traceId, detailParts: detailParts.length, summaryParts: summaryParts.length,
  })}`);
  for (const [kind, parts] of [["summary", summaryParts], ["detail", detailParts]] as const) {
    for (const [index, data] of parts.entries()) console.info(`${label} fragment ${JSON.stringify({
      format: FORMAT, traceId, kind, part: index + 1, total: parts.length, data,
    })}`);
  }
}
