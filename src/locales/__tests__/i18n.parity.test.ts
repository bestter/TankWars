import { describe, it, expect } from "vitest";
import en from "../en.json";
import fr from "../fr.json";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const keys: string[] = [];
  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(...flattenKeys(child, path));
  }
  return keys;
}

describe("i18n locale parity", () => {
  it("keeps the same translation keys in en.json and fr.json", () => {
    const enKeys = flattenKeys(en).toSorted();
    const frKeys = flattenKeys(fr).toSorted();
    expect(frKeys).toEqual(enKeys);
  });
});
