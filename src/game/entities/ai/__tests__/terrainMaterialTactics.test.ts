import { describe, it, expect } from "vitest";
import { adjustWeaponForMaterial } from "../terrainMaterialTactics";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import type { WeaponId } from "../../../../types/weapon";

const has =
  (...ids: WeaponId[]) =>
  (id: WeaponId): boolean =>
    ids.includes(id);

describe("adjustWeaponForMaterial", () => {
  it("replaces DRILLER with MISSILE on ROCK (indestructible)", () => {
    expect(
      adjustWeaponForMaterial("DRILLER", TERRAIN_MATERIAL.ROCK, has("DRILLER")),
    ).toBe("MISSILE");
  });

  it("keeps explosives on ROCK so the +50% blast bonus still applies", () => {
    expect(
      adjustWeaponForMaterial("NUKE", TERRAIN_MATERIAL.ROCK, has("NUKE")),
    ).toBe("NUKE");
    expect(
      adjustWeaponForMaterial("CLUSTER", TERRAIN_MATERIAL.ROCK, has("CLUSTER")),
    ).toBe("CLUSTER");
  });

  it("upgrades MISSILE to DRILLER on SOFT when the inventory has one", () => {
    expect(
      adjustWeaponForMaterial("MISSILE", TERRAIN_MATERIAL.SOFT, has("DRILLER")),
    ).toBe("DRILLER");
  });

  it("does not override a stronger tactical pick on SOFT", () => {
    expect(
      adjustWeaponForMaterial("GRENADE", TERRAIN_MATERIAL.SOFT, has("DRILLER", "GRENADE")),
    ).toBe("GRENADE");
  });

  it("leaves DIRT picks unchanged", () => {
    expect(
      adjustWeaponForMaterial("MISSILE", TERRAIN_MATERIAL.DIRT, has("DRILLER")),
    ).toBe("MISSILE");
    expect(
      adjustWeaponForMaterial("DRILLER", TERRAIN_MATERIAL.DIRT, has("DRILLER")),
    ).toBe("DRILLER");
  });

  it("does not pick DRILLER on SOFT when the inventory is empty", () => {
    expect(
      adjustWeaponForMaterial("MISSILE", TERRAIN_MATERIAL.SOFT, has()),
    ).toBe("MISSILE");
  });
});
