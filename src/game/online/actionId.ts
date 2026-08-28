export const MAX_ACTION_ID_LENGTH = 64;

export function isValidActionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_ACTION_ID_LENGTH
  );
}
