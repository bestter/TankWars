export const MAX_ACTION_ID_LENGTH = 64;

export function isValidActionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    value.length <= MAX_ACTION_ID_LENGTH
  );
}
