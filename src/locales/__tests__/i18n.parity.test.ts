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

  // react-i18next <Trans> copies HTML attributes onto React nodes.
  // A string `style="..."` on <strong> crashes React and freezes the shop → next-round flow.
  it("does not embed HTML style attributes that React rejects as string style props", () => {
    const htmlStyleAttr = /<[a-zA-Z]+[^>]*\sstyle\s*=/;
    const locales: Array<{ lang: string; catalog: Record<string, unknown> }> = [
      { lang: "en", catalog: en as Record<string, unknown> },
      { lang: "fr", catalog: fr as Record<string, unknown> },
    ];
    for (const { lang, catalog } of locales) {
      for (const [key, value] of Object.entries(catalog)) {
        if (typeof value === "string") {
          expect(value, `${lang}.${key}`).not.toMatch(htmlStyleAttr);
        }
      }
    }
  });
});
