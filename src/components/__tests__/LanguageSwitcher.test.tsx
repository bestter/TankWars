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
      t: ((key: string) => key) as unknown as ReturnType<typeof reactI18next.useTranslation>["t"],
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);
  });

  it("renders both language buttons in a named group with lang and aria-pressed", () => {
    render(<LanguageSwitcher />);
    const group = screen.getByRole("group", { name: "language_switcher_label" });
    const enButton = screen.getByRole("button", { name: "EN" });
    const frButton = screen.getByRole("button", { name: "FR" });
    expect(group).toContainElement(enButton);
    expect(group).toContainElement(frButton);
    expect(frButton).toHaveAttribute("lang", "fr");
    expect(enButton).toHaveAttribute("lang", "en");
    expect(enButton).toHaveAttribute("aria-pressed", "true");
    expect(frButton).toHaveAttribute("aria-pressed", "false");
    expect(enButton).toHaveClass("active");
    expect(frButton).not.toHaveClass("active");
  });

  it("highlights the current language button (EN)", () => {
    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    const frButton = screen.getByRole("button", { name: "FR" });

    // In testing-library/jest-dom/vitest, hex codes may be converted to rgb.
    // The test framework may evaluate style matches in different formats.
    expect(enButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);
    expect(enButton).toHaveAttribute("aria-pressed", "true");
    expect(frButton).toHaveAttribute("aria-pressed", "false");

    // #111 might be converted to rgb(17, 17, 17) or remain as #111 depending on jsdom.
    expect(frButton.style.background).toContain("rgb(17, 17, 17)"); // or "#111"
  });

  it("highlights the current language button (FR)", () => {
    vi.mocked(reactI18next.useTranslation).mockReturnValue({
      i18n: {
        language: "fr",
        changeLanguage: changeLanguageMock,
      },
      t: ((key: string) => key) as unknown as ReturnType<typeof reactI18next.useTranslation>["t"],
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    const frButton = screen.getByRole("button", { name: "FR" });

    expect(frButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);
    expect(frButton).toHaveAttribute("aria-pressed", "true");
    expect(frButton).toHaveClass("active");
    expect(enButton).toHaveAttribute("aria-pressed", "false");
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
      t: ((key: string) => key) as unknown as ReturnType<typeof reactI18next.useTranslation>["t"],
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    await user.click(enButton);

    expect(changeLanguageMock).toHaveBeenCalledTimes(1);
    expect(changeLanguageMock).toHaveBeenCalledWith("en");
  });

  it("supports keyboard activation with Enter and Space", async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    const frButton = screen.getByRole("button", { name: "FR" });
    frButton.focus();
    await user.keyboard("{Enter}");
    expect(changeLanguageMock).toHaveBeenCalledWith("fr");
  });

  it("falls back to 'en' if i18n.language is undefined", () => {
    vi.mocked(reactI18next.useTranslation).mockReturnValue({
      i18n: {
        language: undefined,
        changeLanguage: changeLanguageMock,
      },
      t: ((key: string) => key) as unknown as ReturnType<typeof reactI18next.useTranslation>["t"],
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    expect(enButton).toHaveStyle(`background: ${VGA_PALETTE.GREEN}`);
  });

  it("handles uppercase language codes like FR-CA", () => {
    vi.mocked(reactI18next.useTranslation).mockReturnValue({
      i18n: {
        language: "FR-CA",
        changeLanguage: changeLanguageMock,
      },
      t: ((key: string) => key) as unknown as ReturnType<typeof reactI18next.useTranslation>["t"],
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);

    render(<LanguageSwitcher />);

    const frButton = screen.getByRole("button", { name: "FR" });
    const enButton = screen.getByRole("button", { name: "EN" });
    expect(frButton).toHaveAttribute("aria-pressed", "true");
    expect(frButton).toHaveClass("active");
    expect(enButton).toHaveAttribute("aria-pressed", "false");
  });

  it("prefers i18n.resolvedLanguage when browser language falls back from an unsupported locale", () => {
    vi.mocked(reactI18next.useTranslation).mockReturnValue({
      i18n: {
        language: "de-DE",
        resolvedLanguage: "en",
        changeLanguage: changeLanguageMock,
      },
      t: ((key: string) => key) as unknown as ReturnType<typeof reactI18next.useTranslation>["t"],
      ready: true,
    } as unknown as ReturnType<typeof reactI18next.useTranslation>);

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole("button", { name: "EN" });
    const frButton = screen.getByRole("button", { name: "FR" });
    expect(enButton).toHaveAttribute("aria-pressed", "true");
    expect(enButton).toHaveClass("active");
    expect(frButton).toHaveAttribute("aria-pressed", "false");
  });
});
