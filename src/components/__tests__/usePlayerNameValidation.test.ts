// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NamedPlayerConfig } from "../playerNameUi";
import { usePlayerNameValidation } from "../usePlayerNameValidation";

const player = (id: string, name: string): NamedPlayerConfig => ({
  id,
  name,
  isHuman: true,
});

describe("usePlayerNameValidation", () => {
  it("marks the edited player as invalid and every other triple duplicate as a source", () => {
    const configs = [
      player("p1", "Patate"),
      player("p2", "PATATE"),
      player("p3", " patate "),
    ];
    const { result } = renderHook(() => usePlayerNameValidation(configs));
    let namesAreUnique = true;

    act(() => {
      result.current.focusName("p3");
      namesAreUnique = result.current.validateNames(
        result.current.pendingPlayerId(),
      );
    });

    expect(namesAreUnique).toBe(false);
    expect([...result.current.visibleErrorIds]).toEqual(["p3"]);
    expect([...result.current.conflictSourceIds]).toEqual(["p1", "p2"]);
    expect(result.current.pendingPlayerId()).toBeUndefined();
  });

  it("clears a stale error while editing and remains clear after correction", () => {
    const p1 = player("p1", "Patate");
    const p2 = player("p2", "PATATE");
    const { result, rerender } = renderHook(
      ({ configs }: { configs: readonly NamedPlayerConfig[] }) =>
        usePlayerNameValidation(configs),
      { initialProps: { configs: [p1, p2] } },
    );

    act(() => {
      result.current.validateNames("p2");
    });
    expect([...result.current.visibleErrorIds]).toEqual(["p2"]);

    act(() => {
      result.current.beginNameEdit(p2);
    });
    expect(result.current.visibleErrorIds.size).toBe(0);
    expect(result.current.pendingPlayerId()).toBe("p2");

    rerender({ configs: [p1, { ...p2, name: "Carotte" }] });
    let namesAreUnique = false;
    act(() => {
      namesAreUnique = result.current.validateNames("p2");
    });

    expect(namesAreUnique).toBe(true);
    expect(result.current.visibleErrorIds.size).toBe(0);
    expect(result.current.conflictSourceIds.size).toBe(0);
  });
});
