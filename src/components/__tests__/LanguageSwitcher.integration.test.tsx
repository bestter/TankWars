// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import i18next from "i18next";
import { I18nextProvider, initReactI18next, useTranslation } from "react-i18next";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { VGA_PALETTE } from "../../types/game";
import en from "../../locales/en.json";
import fr from "../../locales/fr.json";

function TestApp() {
  const { t } = useTranslation();
  return (
    <div>
      <LanguageSwitcher />
      <span data-testid="translated-title">{t("battle_configuration")}</span>
    </div>
  );
}

describe("LanguageSwitcher (Real i18next integration)", () => {
  let realI18n: typeof i18next;

  beforeEach(async () => {
    cleanup();
    realI18n = i18next.createInstance();
    await realI18n.use(initReactI18next).init({
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

  it("updates real i18n language, active button styling, and translated content on click", async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={realI18n}>
        <TestApp />
      </I18nextProvider>,
    );

    const enButton = screen.getByRole("button", { name: "EN" });
    const frButton = screen.getByRole("button", { name: "FR" });
    const title = screen.getByTestId("translated-title");

    // Initial state: English
    expect(realI18n.language).toBe("en");
    expect(enButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);
    expect(title.textContent).toBe("BATTLE CONFIGURATION");

    // Switch to French
    await user.click(frButton);
    expect(realI18n.language).toBe("fr");
    expect(frButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);
    expect(title.textContent).toBe("CONFIGURATION DE LA BATAILLE");

    // Switch back to English
    await user.click(enButton);
    expect(realI18n.language).toBe("en");
    expect(enButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);
    expect(title.textContent).toBe("BATTLE CONFIGURATION");
  });
});
