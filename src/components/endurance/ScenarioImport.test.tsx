// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ScenarioImport, type ScenarioSelection } from "./ScenarioImport";
import reference from "../../../Scripts/endurance/scenarios/issue-361-rock-cliff.json";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Importer() {
  const [selection, setSelection] = useState<ScenarioSelection>({ scenario: null, error: null, loading: false });
  return <ScenarioImport selection={selection} onChange={setSelection} />;
}

it("can import the same file again after its contents are corrected", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const user = userEvent.setup();
  render(<Importer />);
  const input = screen.getByTestId("endurance-scenario-input") as HTMLInputElement;
  const file = new File(["{"], "scenario.json", { type: "application/json" });
  const text = vi.fn().mockResolvedValueOnce("{").mockResolvedValueOnce(JSON.stringify(reference));
  Object.defineProperty(file, "text", { value: text });
  await user.upload(input, file);
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(input.value).toBe("");
  await user.upload(input, file);
  const preview = await screen.findByRole("img", { name: reference.name });
  expect(preview.textContent).toBe(reference.name);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(text).toHaveBeenCalledTimes(2);
});

it.each([2 * 1024 * 1024, 2 * 1024 * 1024 + 1])("checks the %i-byte boundary before reading", async size => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  render(<Importer />);
  const file = new File(["{}"], "scenario.json", { type: "application/json" });
  const text = vi.fn().mockResolvedValue(JSON.stringify(reference));
  Object.defineProperties(file, { size: { value: size }, text: { value: text } });
  await userEvent.setup().upload(screen.getByTestId("endurance-scenario-input"), file);
  if (size > 2 * 1024 * 1024) {
    expect((await screen.findByRole("alert")).textContent).toContain("file exceeds 2 MiB");
    expect(text).not.toHaveBeenCalled();
  } else {
    expect(await screen.findByRole("img", { name: reference.name })).toBeDefined();
    expect(text).toHaveBeenCalledOnce();
  }
});

it("disables the remove button when no scenario, error or loading is active", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  render(<Importer />);
  const removeBtn = screen.getByRole("button", { name: "endurance_scenario_remove" }) as HTMLButtonElement;
  expect(removeBtn.disabled).toBe(true);

  const user = userEvent.setup();
  const input = screen.getByTestId("endurance-scenario-input") as HTMLInputElement;
  const file = new File(["{"], "invalid.json", { type: "application/json" });
  await user.upload(input, file);
  await screen.findByRole("alert");
  expect(removeBtn.disabled).toBe(false);

  await user.click(removeBtn);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(removeBtn.disabled).toBe(true);
});
