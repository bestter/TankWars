/**
 * TankWars - Weapon definitions & registry (src/types/weapon.ts)
 *
 * WEAPON_REGISTRY is the single source of truth for all weapon stats.
 * Colors referenced from the shared VGA_PALETTE.
 *
 * Weapons drive both shop pricing and the simulation parameters in the engine.
 * MISSILE is special: unlimited (never in shop, never decrements on use, always selectable in HUD).
 * Other weapons have limited inventory that drops after each use (see TurnManager.consumeAmmo).
 */

import { VGA_PALETTE, type Color } from './game';

export type WeaponId =
  | 'MISSILE'
  | 'GRENADE'
  | 'CLUSTER'
  | 'NUKE'
  | 'THERMONUCLEAR'
  | 'DRILLER';

/** Static definition for a weapon type. */
export interface Weapon {
  id: WeaponId;
  name: string;
  /** Cost in the shop. */
  price: number;
  /** Hit-point damage at blast center. */
  damage: number;
  /** Radius of terrain destruction + splash damage (world units). */
  blastRadius: number;
  /** Selects the trajectory / secondary behavior in the physics engine. */
  physicsType: 'projectile' | 'grenade' | 'cluster_parent';
  /** Accent / tracer / explosion tint. Must come from VGA_PALETTE. */
  color: Color;
  /** How many rounds granted when purchased (or initial loadout). */
  defaultAmmo: number;
}

/** Master registry. All weapon behavior is derived from these values. */
export const WEAPON_REGISTRY: Record<WeaponId, Weapon> = {
  MISSILE: {
    id: 'MISSILE',
    name: 'Missile',
    price: 50,
    damage: 35,
    blastRadius: 28,
    physicsType: 'projectile',
    color: VGA_PALETTE.CYAN,
    defaultAmmo: 3,
  },
  GRENADE: {
    id: 'GRENADE',
    name: 'Grenade',
    price: 75,
    damage: 28,
    blastRadius: 24,
    physicsType: 'grenade',
    color: VGA_PALETTE.YELLOW,
    defaultAmmo: 2,
  },
  CLUSTER: {
    id: 'CLUSTER',
    name: 'Cluster Bomb',
    price: 135,
    damage: 16,
    blastRadius: 16,
    physicsType: 'cluster_parent',
    color: VGA_PALETTE.MAGENTA,
    defaultAmmo: 1,
  },
  NUKE: {
    id: 'NUKE',
    name: 'Baby Nuke',
    price: 210,
    damage: 75,
    blastRadius: 62,
    physicsType: 'projectile',
    color: VGA_PALETTE.RED,
    defaultAmmo: 1,
  },
  THERMONUCLEAR: {
    id: 'THERMONUCLEAR',
    name: 'Thermonuclear Bomb',
    price: 2500,
    damage: 120,
    blastRadius: 160,
    physicsType: 'projectile',
    color: VGA_PALETTE.RED,
    defaultAmmo: 1,
  },
  DRILLER: {
    id: 'DRILLER',
    name: 'Driller',
    price: 90,
    damage: 42,
    blastRadius: 14,
    physicsType: 'projectile',
    color: VGA_PALETTE.GREEN,
    defaultAmmo: 2,
  },
} as const;

/** Helper: concrete weapon type from registry. */
export type WeaponDef = (typeof WEAPON_REGISTRY)[WeaponId];

/**
 * Safe default starting inventory for new players (human or AI).
 * MISSILE is unlimited (always available, never decrements, removed from shop);
 * only limited weapons appear here and are decremented on use.
 */
export const DEFAULT_INVENTORY: Partial<Record<WeaponId, number>> = {
  GRENADE: 2,
} as const;

/** All weapon ids as a runtime array (useful for shop UI, validation). */
export const ALL_WEAPON_IDS: readonly WeaponId[] = Object.keys(
  WEAPON_REGISTRY,
) as WeaponId[];

/**
 * Weapon ids offered in the shop (and auto-bought by AI).
 * MISSILE is unlimited and not sold — it is always available to every tank.
 */
export const SHOP_WEAPON_IDS: readonly WeaponId[] = ALL_WEAPON_IDS.filter(
  (id) => id !== 'MISSILE',
);
