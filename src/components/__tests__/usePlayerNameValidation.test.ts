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

  it("clears visible errors when player count is reduced and the removed player had the error", () => {
    const p1 = player("p1", "Patate");
    const p2 = player("p2", "Carotte");
    const p3 = player("p3", "Salade");
    const p4 = player("p4", "Patate");

    const { result, rerender } = renderHook(
      ({ configs }: { configs: readonly NamedPlayerConfig[] }) =>
        usePlayerNameValidation(configs),
      { initialProps: { configs: [p1, p2, p3, p4] } },
    );

    act(() => {
      result.current.validateNames("p4");
    });
    expect([...result.current.visibleErrorIds]).toEqual(["p4"]);
    expect([...result.current.conflictSourceIds]).toEqual(["p1"]);

    // Reduce to 2 players: [p1, p2]
    rerender({ configs: [p1, p2] });
    expect(result.current.visibleErrorIds.size).toBe(0);
    expect(result.current.conflictSourceIds.size).toBe(0);
  });

  it("marks empty names as invalid and populates emptyNameErrorIds", () => {
    const p1 = player("p1", "Patate");
    const p2 = player("p2", "   ");
    const { result } = renderHook(() => usePlayerNameValidation([p1, p2]));

    let isValid = true;
    act(() => {
      isValid = result.current.validateNames("p2");
    });

    expect(isValid).toBe(false);
    expect([...result.current.visibleErrorIds]).toEqual(["p2"]);
    expect([...result.current.emptyNameErrorIds]).toEqual(["p2"]);
    expect(result.current.conflictSourceIds.size).toBe(0);
  });

  it("supports immediate validation with overrideConfigs before state re-renders", () => {
    const p1 = player("p1", "Sniper");
    const p2 = player("p2", "Simple");
    const { result } = renderHook(() => usePlayerNameValidation([p1, p2]));

    const nextConfigs: NamedPlayerConfig[] = [p1, { ...p2, name: "Sniper" }];
    let isValid = true;
    act(() => {
      isValid = result.current.validateNames("p2", nextConfigs);
    });

    expect(isValid).toBe(false);
  });
});

