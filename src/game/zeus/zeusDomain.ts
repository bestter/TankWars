import type { Player, PlayerId } from "../../types/player";

export const ZEUS_ROTATIONS_WITHOUT_EARNINGS = 5;

export interface ZeusState {
  shotsWithoutEarnings: number;
  activeZeusId: PlayerId | null;
  appointedPlayerIds: PlayerId[];
  nextAppointmentId: number;
  nextStrikeId: number;
}

export interface ZeusAppointment {
  appointmentId: number;
  zeusId: PlayerId;
  rotationPlayerIds: PlayerId[];
}

export interface ZeusStrike {
  strikeId: number;
  zeusId: PlayerId;
  targetId: PlayerId;
}

export interface ZeusStrikeResult extends ZeusStrike {
  award: { playerId: PlayerId; amount: number };
  balances: Array<{ playerId: PlayerId; money: number }>;
  roundOutcome: {
    isRoundEnd: boolean;
    isDraw: boolean;
    roundWinnerId: PlayerId | null;
  };
}

export interface ZeusEvaluation {
  state: ZeusState;
  appointment: ZeusAppointment | null;
  zeusRevoked: boolean;
}

export function createZeusState(): ZeusState {
  return {
    shotsWithoutEarnings: 0,
    activeZeusId: null,
    appointedPlayerIds: [],
    nextAppointmentId: 1,
    nextStrikeId: 1,
  };
}

export function resetZeusRound(state: ZeusState): ZeusState {
  return {
    ...state,
    shotsWithoutEarnings: 0,
    activeZeusId: null,
  };
}

function livingPlayers(players: readonly Player[]): Player[] {
  return players.filter((player) => !player.tank.isDead && player.tank.health > 0);
}

function normalizedRandomIndex(randomValue: number, length: number): number {
  if (length <= 1) return 0;
  const normalized = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(0.9999999999999999, randomValue))
    : 0;
  return Math.floor(normalized * length);
}

function circularLivingOrder(players: readonly Player[], zeusId: PlayerId): PlayerId[] {
  const start = players.findIndex((player) => player.id === zeusId);
  if (start < 0) return [];
  const result: PlayerId[] = [];
  for (let offset = 0; offset < players.length; offset++) {
    const player = players[(start + offset) % players.length];
    if (!player.tank.isDead && player.tank.health > 0) result.push(player.id);
  }
  return result;
}

export function evaluateZeusDeadlock(
  state: ZeusState,
  players: readonly Player[],
  hasEarnings: boolean,
  random: () => number,
): ZeusEvaluation {
  const alive = livingPlayers(players);

  if (state.activeZeusId !== null) {
    const activeIsAlive = alive.some((player) => player.id === state.activeZeusId);
    if (activeIsAlive) {
      return {
        state: { ...state, shotsWithoutEarnings: 0 },
        appointment: null,
        zeusRevoked: false,
      };
    }
    return {
      state: { ...state, activeZeusId: null, shotsWithoutEarnings: 0 },
      appointment: null,
      zeusRevoked: true,
    };
  }

  if (alive.length < 2 || alive.some((player) => player.isHuman)) {
    return {
      state: { ...state, shotsWithoutEarnings: 0 },
      appointment: null,
      zeusRevoked: false,
    };
  }

  if (hasEarnings) {
    return {
      state: { ...state, shotsWithoutEarnings: 0 },
      appointment: null,
      zeusRevoked: false,
    };
  }

  const shotsWithoutEarnings = state.shotsWithoutEarnings + 1;
  const threshold = alive.length * ZEUS_ROTATIONS_WITHOUT_EARNINGS;
  if (shotsWithoutEarnings < threshold) {
    return {
      state: { ...state, shotsWithoutEarnings },
      appointment: null,
      zeusRevoked: false,
    };
  }

  let appointedPlayerIds = [...state.appointedPlayerIds];
  const appointedPlayerIdSet = new Set(appointedPlayerIds);
  let candidates = alive.filter((player) => !appointedPlayerIdSet.has(player.id));
  if (candidates.length === 0) {
    appointedPlayerIds = [];
    candidates = alive;
  }
  const zeus = candidates[normalizedRandomIndex(random(), candidates.length)];
  const appointment: ZeusAppointment = {
    appointmentId: state.nextAppointmentId,
    zeusId: zeus.id,
    rotationPlayerIds: circularLivingOrder(players, zeus.id),
  };

  return {
    state: {
      ...state,
      shotsWithoutEarnings: 0,
      activeZeusId: zeus.id,
      appointedPlayerIds: [...appointedPlayerIds, zeus.id],
      nextAppointmentId: state.nextAppointmentId + 1,
    },
    appointment,
    zeusRevoked: false,
  };
}

export function selectZeusTarget(
  players: readonly Player[],
  zeusId: PlayerId,
  random: () => number,
): { targetId: PlayerId; usedRevenge: boolean } | null {
  const zeus = players.find((player) => player.id === zeusId);
  if (!zeus || zeus.tank.isDead || zeus.tank.health <= 0) return null;
  const opponents = livingPlayers(players).filter((player) => player.id !== zeusId);
  if (opponents.length === 0) return null;

  const revengeId = zeus.tank.lastDirectAttackerId;
  const revengeTarget = revengeId
    ? opponents.find((player) => player.id === revengeId)
    : undefined;
  if (revengeTarget) return { targetId: revengeTarget.id, usedRevenge: true };

  return {
    targetId: opponents[normalizedRandomIndex(random(), opponents.length)].id,
    usedRevenge: false,
  };
}

export function allocateZeusStrike(
  state: ZeusState,
  zeusId: PlayerId,
  targetId: PlayerId,
): { state: ZeusState; strike: ZeusStrike } {
  return {
    state: { ...state, nextStrikeId: state.nextStrikeId + 1 },
    strike: { strikeId: state.nextStrikeId, zeusId, targetId },
  };
}
