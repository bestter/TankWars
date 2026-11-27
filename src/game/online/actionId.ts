export const MAX_ACTION_ID_LENGTH = 64;
const FORBIDDEN_ACTION_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function isValidActionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    value.length <= MAX_ACTION_ID_LENGTH &&
    !FORBIDDEN_ACTION_IDS.has(value) &&
    !Object.prototype.hasOwnProperty.call(Object.prototype, value)
  );
}
