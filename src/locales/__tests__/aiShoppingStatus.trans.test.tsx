// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next, Trans } from "react-i18next";
import en from "../en.json";
import fr from "../fr.json";

const testI18n = i18next.createInstance();

beforeAll(async () => {
  await testI18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: { translation: en },
      fr: { translation: fr },
    },
    interpolation: { escapeValue: false },
  });
});

afterEach(() => {
  cleanup();
});

function renderAiShoppingStatus(lang: "en" | "fr", color: string, name: string) {
  void testI18n.changeLanguage(lang);
  return render(
    <I18nextProvider i18n={testI18n}>
      <Trans
        i18nKey="ai_shopping_status"
        values={{ name }}
        components={{
          strong: <strong style={{ color }} />,
        }}
      />
    </I18nextProvider>,
  );
}

describe("ai_shopping_status Trans overlay", () => {
  it("renders the AI name with a React style object instead of a string style prop", () => {
    expect(() => renderAiShoppingStatus("en", "#ff5555", "CPU-1")).not.toThrow();

    const nameEl = screen.getByText("CPU-1");
    expect(nameEl.tagName).toBe("STRONG");
    expect(nameEl.style.color).toBe("rgb(255, 85, 85)");
    expect(screen.getByText(/is shopping/i)).toBeTruthy();
  });
});
