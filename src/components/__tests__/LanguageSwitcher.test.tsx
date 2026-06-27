// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { VGA_PALETTE } from "../../types/game";
import * as reactI18next from "react-i18next";

vi.mock("react-i18next", () => ({
  useTranslation: vi.fn(),
}));

describe("LanguageSwitcher", () => {
  const changeLanguageMock = vi.fn();

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();

    // Default setup: English
    vi.mocked(reactI18next.useTranslation).mockReturnValue({
      i18n: {
        language: "en",
        changeLanguage: changeLanguageMock,
      },
      t: vi.fn(),
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);
  });

  it("renders both language buttons", () => {
    render(<LanguageSwitcher />);
    expect(screen.getByRole("button", { name: "EN" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "FR" })).toBeInTheDocument();
  });

  it("highlights the current language button (EN)", () => {
    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    const frButton = screen.getByRole("button", { name: "FR" });

    // In testing-library/jest-dom/vitest, hex codes may be converted to rgb.
    // The test framework may evaluate style matches in different formats.
    expect(enButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);

    // #111 might be converted to rgb(17, 17, 17) or remain as #111 depending on jsdom.
    expect(frButton.style.background).toContain("rgb(17, 17, 17)"); // or "#111"
  });

  it("highlights the current language button (FR)", () => {
    vi.mocked(reactI18next.useTranslation).mockReturnValue({
      i18n: {
        language: "fr",
        changeLanguage: changeLanguageMock,
      },
      t: vi.fn(),
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    const frButton = screen.getByRole("button", { name: "FR" });

    expect(frButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);
    expect(enButton.style.background).toContain("rgb(17, 17, 17)"); // "#111"
  });

  it("calls changeLanguage with 'fr' when FR button is clicked", async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    const frButton = screen.getByRole("button", { name: "FR" });
    await user.click(frButton);

    expect(changeLanguageMock).toHaveBeenCalledTimes(1);
    expect(changeLanguageMock).toHaveBeenCalledWith("fr");
  });

  it("calls changeLanguage with 'en' when EN button is clicked", async () => {
    const user = userEvent.setup();

    // Set current lang to fr so it makes sense to click en
    vi.mocked(reactI18next.useTranslation).mockReturnValue({
      i18n: {
        language: "fr-FR", // Testing startsWith
        changeLanguage: changeLanguageMock,
      },
      t: vi.fn(),
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    await user.click(enButton);

    expect(changeLanguageMock).toHaveBeenCalledTimes(1);
    expect(changeLanguageMock).toHaveBeenCalledWith("en");
  });

  it("falls back to 'en' if i18n.language is undefined", () => {
    vi.mocked(reactI18next.useTranslation).mockReturnValue({
      i18n: {
        language: undefined,
        changeLanguage: changeLanguageMock,
      },
      t: vi.fn(),
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    expect(enButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);
  });
});
