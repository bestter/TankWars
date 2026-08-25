import { describe, expect, it } from "vitest";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import {
  allocateZeusStrike,
  createZeusState,
  evaluateZeusDeadlock,
  resetZeusRound,
  selectZeusTarget,
} from "../zeusDomain";
import { calculateZeusStrikeReward } from "../zeusRewards";

function ai(id: string) {
  return makePlayer({
    id,
    name: id,
    isHuman: false,
    tank: makeTank(`tank-${id}`, 100, 200),
  });
}

describe("Zeus deadlock domain", () => {
  it.each([
    [2, 10],
    [3, 15],
    [4, 20],
  ])("appoints one Zeus after five rotations with %i AIs", (count, threshold) => {
    const players = Array.from({ length: count }, (_, index) => ai(`ai-${index + 1}`));
    let state = createZeusState();
    for (let shot = 1; shot <= threshold; shot++) {
      const evaluation = evaluateZeusDeadlock(state, players, false, () => 0);
      state = evaluation.state;
      if (shot < threshold) expect(evaluation.appointment).toBeNull();
      else expect(evaluation.appointment?.zeusId).toBe("ai-1");
    }
  });

  it("resets on earnings or a living human and allows dead human spectators", () => {
    const players = [ai("ai-1"), ai("ai-2")];
    let state = { ...createZeusState(), shotsWithoutEarnings: 8 };
    state = evaluateZeusDeadlock(state, players, true, () => 0).state;
    expect(state.shotsWithoutEarnings).toBe(0);

    const human = makePlayer({ id: "human", isHuman: true });
    state = { ...state, shotsWithoutEarnings: 8 };
    state = evaluateZeusDeadlock(state, [...players, human], false, () => 0).state;
    expect(state.shotsWithoutEarnings).toBe(0);

    human.tank.isDead = true;
    human.tank.health = 0;
    state = { ...state, shotsWithoutEarnings: 9 };
    const evaluation = evaluateZeusDeadlock(state, [...players, human], false, () => 0);
    expect(evaluation.appointment).not.toBeNull();
  });

  it("keeps accumulated shots when the survivor threshold shrinks", () => {
    const players = [ai("ai-1"), ai("ai-2"), ai("ai-3")];
    const state = { ...createZeusState(), shotsWithoutEarnings: 11 };
    players[2].tank.isDead = true;
    players[2].tank.health = 0;
    const evaluation = evaluateZeusDeadlock(state, players, false, () => 0.99);
    expect(evaluation.appointment?.zeusId).toBe("ai-2");
  });

  it("revokes a dead Zeus without counting the killing resolution", () => {
    const players = [ai("ai-1"), ai("ai-2")];
    players[0].tank.isDead = true;
    players[0].tank.health = 0;
    const state = {
      ...createZeusState(),
      activeZeusId: "ai-1",
      shotsWithoutEarnings: 7,
    };
    const evaluation = evaluateZeusDeadlock(state, players, false, () => 0);
    expect(evaluation.zeusRevoked).toBe(true);
    expect(evaluation.state.shotsWithoutEarnings).toBe(0);
    expect(evaluation.appointment).toBeNull();
  });

  it("rotates fairly across rounds and resets only the exhausted admissible pool", () => {
    const players = [ai("ai-1"), ai("ai-2")];
    let state = { ...createZeusState(), shotsWithoutEarnings: 9 };
    let evaluation = evaluateZeusDeadlock(state, players, false, () => 0);
    expect(evaluation.appointment?.zeusId).toBe("ai-1");
    state = { ...resetZeusRound(evaluation.state), shotsWithoutEarnings: 9 };
    evaluation = evaluateZeusDeadlock(state, players, false, () => 0);
    expect(evaluation.appointment?.zeusId).toBe("ai-2");
    state = { ...resetZeusRound(evaluation.state), shotsWithoutEarnings: 9 };
    evaluation = evaluateZeusDeadlock(state, players, false, () => 0.99);
    expect(evaluation.appointment?.zeusId).toBe("ai-2");
  });

  it("clears an exhausted admissible pool when appointing during the active round", () => {
    const players = [ai("ai-1"), ai("ai-2")];
    const state = {
      ...createZeusState(),
      shotsWithoutEarnings: 9,
      appointedPlayerIds: players.map((player) => player.id),
      nextAppointmentId: 3,
    };

    const evaluation = evaluateZeusDeadlock(state, players, false, () => 0);

    expect(evaluation.appointment).toMatchObject({ appointmentId: 3, zeusId: "ai-1" });
    expect(evaluation.state.appointedPlayerIds).toEqual(["ai-1"]);
    expect(evaluation.state.nextAppointmentId).toBe(4);
  });

  it("anchors rotation and allocates monotonic strike IDs", () => {
    const players = [ai("a"), ai("b"), ai("c")];
    const evaluation = evaluateZeusDeadlock(
      { ...createZeusState(), shotsWithoutEarnings: 14 },
      players,
      false,
      () => 0.5,
    );
    expect(evaluation.appointment?.rotationPlayerIds).toEqual(["b", "c", "a"]);
    const allocation = allocateZeusStrike(evaluation.state, "b", "a");
    expect(allocation.strike.strikeId).toBe(1);
    expect(allocation.state.nextStrikeId).toBe(2);
  });
});

describe("Zeus targeting and reward", () => {
  it("prioritizes and consumes revenge eligibility only when the attacker is alive", () => {
    const zeus = ai("zeus");
    const attacker = ai("attacker");
    const fallback = ai("fallback");
    zeus.tank.lastDirectAttackerId = attacker.id;
    expect(selectZeusTarget([zeus, attacker, fallback], zeus.id, () => 0.99)).toEqual({
      targetId: attacker.id,
      usedRevenge: true,
    });
    attacker.tank.isDead = true;
    attacker.tank.health = 0;
    expect(selectZeusTarget([zeus, attacker, fallback], zeus.id, () => 0)).toEqual({
      targetId: fallback.id,
      usedRevenge: false,
    });
  });

  it("pays only the standard 25X destruction reward", () => {
    expect(calculateZeusStrikeReward("zeus", 2, ["zeus"]).award.amount).toBe(75);
    expect(calculateZeusStrikeReward("zeus", 3, ["zeus"]).award.amount).toBe(88);
    expect(calculateZeusStrikeReward("zeus", 4, ["zeus"]).award.amount).toBe(100);
  });
});
