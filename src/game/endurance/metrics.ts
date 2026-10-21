import type { EnduranceEvent, MetricGroups, Metrics } from "./types";
import type { Player } from "../../types/player";

export function metrics(): Metrics {
  return { decisions: 0, decisionMs: 0, commands: 0, shots: 0, resolved: 0, offensiveShots: 0,
    healthLostMilli: 0, shieldLostMilli: 0, healthDealtMilli: 0, shieldDealtMilli: 0,
    selfHealthMilli: 0, selfShieldMilli: 0, kills: 0, suicides: 0, unattributedDeaths: 0,
    displacement: 0, recoil: 0, zeusActions: 0, zeusResults: 0, failed: 0, recoveries: 0, skipped: 0,
    participations: 0, wins: 0, survivals: 0, draws: 0 };
}
export function groups(): MetricGroups { return { total: metrics(), players: {}, profiles: {}, weapons: {} }; }
export function addMetrics(target: MetricGroups, source: MetricGroups): void {
  const add = (to: Metrics, from: Metrics) => {
    for (const key of Object.keys(from) as Array<keyof Metrics>) to[key] += from[key];
  };
  add(target.total, source.total);
  for (const group of ["players", "profiles", "weapons"] as const) {
    for (const [key, value] of Object.entries(source[group])) add(target[group][key] ??= metrics(), value);
  }
}

/** Per-round sets are discarded at the round boundary; session memory stays bounded. */
export class RoundCollector {
  readonly data = groups();
  private shots = new Map<number, { playerId: string; weapon: string; offensive: boolean; resolved: boolean }>();
  private destructions = new Set<string>();
  private deaths = new Set<string>();
  private attributed = new Set<string>();
  private zeus = new Set<number>();
  private readonly players: readonly Player[];
  constructor(players: readonly Player[]) { this.players = players; }
  private update(playerId: string, weapon: string | null, apply: (m: Metrics) => void): void {
    const profile = this.players.find(p => p.id === playerId)?.aiProfile ?? "unknown";
    apply(this.data.total);
    apply(this.data.players[playerId] ??= metrics());
    apply(this.data.profiles[profile] ??= metrics());
    if (weapon) apply(this.data.weapons[weapon] ??= metrics());
  }
  observe(e: EnduranceEvent): void {
    switch (e.kind) {
      case "decision": this.update(e.playerId, null, m => { m.decisions++; m.decisionMs += e.durationMs; }); break;
      case "shot":
        if (this.shots.has(e.shotId)) throw new Error("DUPLICATE_SHOT");
        this.shots.set(e.shotId, { playerId: e.playerId, weapon: e.command.weaponId, offensive: false, resolved: false });
        this.update(e.playerId, e.command.weaponId, m => { m.shots++; m.commands++; });
        break;
      case "resolved": {
        const shot = this.shots.get(e.shotId);
        if (!shot || shot.resolved) throw new Error("INVALID_SHOT_RESOLUTION");
        shot.resolved = true;
        this.update(shot.playerId, shot.weapon, m => { m.resolved++; if (shot.offensive) m.offensiveShots++; });
        break;
      }
      case "damage": {
        const d = e.event;
        const shot = this.shots.get(d.shotId);
        if (!shot || shot.resolved || shot.playerId !== d.shooterId || shot.weapon !== d.weaponId) throw new Error("INVALID_DAMAGE_REFERENCE");
        if (![d.healthDamageMilli, d.shieldLostMilli].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("INVALID_DAMAGE");
        this.update(d.victimId, null, m => { m.healthLostMilli += d.healthDamageMilli; m.shieldLostMilli += d.shieldLostMilli; });
        if (d.shooterId === d.victimId) {
          this.update(d.shooterId, d.weaponId, m => { m.selfHealthMilli += d.healthDamageMilli; m.selfShieldMilli += d.shieldLostMilli; });
        } else {
          this.update(d.shooterId, d.weaponId, m => { m.healthDealtMilli += d.healthDamageMilli; m.shieldDealtMilli += d.shieldLostMilli; });
          if (d.healthDamageMilli + d.shieldLostMilli > 0) shot.offensive = true;
        }
        break;
      }
      case "destruction": {
        const d = e.event;
        if (this.destructions.has(d.victimId)) throw new Error("DUPLICATE_DESTRUCTION");
        const shot = this.shots.get(d.shotId);
        if (!shot || shot.resolved) throw new Error("INVALID_DESTRUCTION_REFERENCE");
        this.destructions.add(d.victimId); this.attributed.add(d.victimId);
        this.update(d.shooterId, d.weaponId, m => { if (d.shooterId === d.victimId) m.suicides++; else m.kills++; });
        if (d.shooterId !== d.victimId) shot.offensive = true;
        break;
      }
      case "death": this.deaths.add(e.playerId); break;
      case "displacement": this.update(e.playerId, "BULLDOZER", m => { if (e.recoil) m.recoil += e.distance; else m.displacement += e.distance; }); break;
      case "zeus":
        if (this.zeus.has(e.result.strikeId)) throw new Error("DUPLICATE_ZEUS");
        this.zeus.add(e.result.strikeId); this.attributed.add(e.result.targetId);
        this.update(e.result.zeusId, null, m => { m.zeusActions++; m.zeusResults++; });
        break;
      case "recovery": this.data.total.recoveries++; if (e.reason === "skipped") this.data.total.skipped++; break;
      case "failure": this.data.total.failed++; break;
    }
  }
  finish(survivors: string[] | null): void {
    for (const id of this.deaths) if (!this.attributed.has(id)) this.update(id, null, m => { m.unattributedDeaths++; });
    if (survivors === null) return;
    const survivingIds = new Set(survivors);
    for (const player of this.players) this.update(player.id, null, m => {
      m.participations++; if (survivingIds.has(player.id)) m.survivals++;
      if (survivors.length === 1 && survivors[0] === player.id) m.wins++;
      if (survivors.length === 0) m.draws++;
    });
  }
}
