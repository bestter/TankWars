// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, renderHook, act } from "@testing-library/react";
import { useOnlineLobby } from "../useOnlineLobby";
import { useGameSession } from "../useGameSession";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import { TERRAIN_MATERIAL, type TerrainMaterial } from "../../types/terrain";
import type { Player } from "../../types/player";
import type { ServerGameMessage } from "../../types/room";

// Mock react-i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: {
    type: "3rdParty",
    init: () => {},
  },
}));

function stubCanvas2d(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  ) as CanvasRenderingContext2D;
}

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 480;

describe("Online GAME_START with materials integration", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => stubCanvas2d(),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lobby receives GAME_START with materials and transfers them to onStartGame", async () => {
    const onStartGame = vi.fn();
    const heights = Array.from({ length: CANVAS_WIDTH }, (_, i) => 300 + (i % 20));
    const materials: TerrainMaterial[] = Array.from({ length: CANVAS_WIDTH }, (_, i) => {
      if (i < 150) return TERRAIN_MATERIAL.ROCK;
      if (i < 300) return TERRAIN_MATERIAL.SOFT;
      return TERRAIN_MATERIAL.DIRT;
    });

    const mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
      onopen: null as (() => void) | null,
      onmessage: null as ((ev: { data: string }) => void) | null,
      onerror: null as (() => void) | null,
      onclose: null as (() => void) | null,
    };

    class MockWebSocket {
      send = mockWs.send;
      close = mockWs.close;
      readyState = mockWs.readyState;
      get onopen() {
        return mockWs.onopen;
      }
      set onopen(cb: (() => void) | null) {
        mockWs.onopen = cb;
      }
      get onmessage() {
        return mockWs.onmessage;
      }
      set onmessage(cb: ((ev: { data: string }) => void) | null) {
        mockWs.onmessage = cb;
      }
      get onerror() {
        return mockWs.onerror;
      }
      set onerror(cb: (() => void) | null) {
        mockWs.onerror = cb;
      }
      get onclose() {
        return mockWs.onclose;
      }
      set onclose(cb: (() => void) | null) {
        mockWs.onclose = cb;
      }
    }

    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const { result } = renderHook(() =>
      useOnlineLobby({
        initialRoomId: "room-abc",
        initialSlot: 0,
        initialToken: "TOKEN-1",
        onStartGame,
      }),
    );

    act(() => {
      result.current.setMyName("Player 1");
    });

    await act(async () => {
      await result.current.handleJoin();
    });

    act(() => {
      // Simulate GAME_START message broadcast from server
      const gameStartMsg: ServerGameMessage = {
        type: "GAME_START",
        players: [
          makePlayer({ id: "player-1", name: "Player 1", isHuman: true }),
          makePlayer({ id: "player-2", name: "Player 2", isHuman: true }),
        ],
        heights,
        materials,
        wind: 8,
        currentPlayerIndex: 0,
      };

      if (mockWs.onmessage) {
        mockWs.onmessage({ data: JSON.stringify(gameStartMsg) });
      }
    });

    expect(onStartGame).toHaveBeenCalledTimes(1);
    const [startedPlayers, meta] = onStartGame.mock.calls[0];
    expect(startedPlayers.length).toBe(2);
    expect(meta.gameMode).toBe("online");
    expect(meta.roomId).toBe("room-abc");
    expect(meta.initialHeights).toEqual(heights);
    expect(meta.initialMaterials).toEqual(materials);
    expect(meta.initialWind).toBe(8);
    expect(meta.initialCurrentPlayerIndex).toBe(0);
  });

  it("useGameSession loads authoritative heights and materials into client game engine", () => {
    const fixedHeight = 320;
    const heights = Array.from({ length: CANVAS_WIDTH }, () => fixedHeight);
    const materials: TerrainMaterial[] = Array.from({ length: CANVAS_WIDTH }, (_, i) => {
      if (i >= 100 && i <= 200) return TERRAIN_MATERIAL.ROCK;
      if (i >= 300 && i <= 450) return TERRAIN_MATERIAL.SOFT;
      return TERRAIN_MATERIAL.DIRT;
    });

    const players: Player[] = [
      makePlayer({
        id: "player-1",
        name: "Joueur-1",
        isHuman: true,
        tank: makeTank("tank-1", 150, 200),
      }),
      makePlayer({
        id: "player-2",
        name: "Joueur-2",
        isHuman: true,
        tank: makeTank("tank-2", 600, 200),
      }),
    ];

    let sessionApi: ReturnType<typeof useGameSession> | null = null;

    function Harness() {
      const session = useGameSession({
        initialPlayers: players,
        gameMode: "online",
        roomId: "room-abc",
        localPlayerId: "player-1",
        initialHeights: heights,
        initialMaterials: materials,
        initialWind: 10,
        initialCurrentPlayerIndex: 0,
      });
      sessionApi = session;
      return <canvas ref={session.canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />;
    }

    render(<Harness />);

    expect(sessionApi).not.toBeNull();
    const state = sessionApi!.state;
    expect(state.gamePhase).toBe("COMBAT");
    expect(state.uiPlayers.length).toBe(2);

    // Tanks should be vertically anchored to the authoritative heightmap
    for (const p of state.uiPlayers) {
      expect(p.tank.position.y).toBe(fixedHeight);
    }
  });

  it("useGameSession safely handles GAME_START when materials array is omitted", () => {
    const fixedHeight = 280;
    const heights = Array.from({ length: CANVAS_WIDTH }, () => fixedHeight);
    const players: Player[] = [
      makePlayer({
        id: "player-1",
        name: "Joueur-1",
        isHuman: true,
        tank: makeTank("tank-1", 150, 200),
      }),
      makePlayer({
        id: "player-2",
        name: "Joueur-2",
        isHuman: true,
        tank: makeTank("tank-2", 600, 200),
      }),
    ];

    let sessionApi: ReturnType<typeof useGameSession> | null = null;

    function Harness() {
      const session = useGameSession({
        initialPlayers: players,
        gameMode: "online",
        roomId: "room-abc",
        localPlayerId: "player-1",
        initialHeights: heights,
        initialMaterials: undefined,
        initialWind: 5,
        initialCurrentPlayerIndex: 0,
      });
      sessionApi = session;
      return <canvas ref={session.canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />;
    }

    render(<Harness />);

    expect(sessionApi).not.toBeNull();
    expect(sessionApi!.state.gamePhase).toBe("COMBAT");
    for (const p of sessionApi!.state.uiPlayers) {
      expect(p.tank.position.y).toBe(fixedHeight);
    }
  });
});
