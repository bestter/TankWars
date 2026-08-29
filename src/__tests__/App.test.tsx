// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App from '../App';
import type { GameCanvasProps } from '../components/GameCanvas';

const sessionStorageData = new Map<string, string>();
const deploymentMode = vi.hoisted(() => ({ hotseatOnly: false }));
const sessionStorageMock: Storage = {
  get length() {
    return sessionStorageData.size;
  },
  clear: () => sessionStorageData.clear(),
  getItem: (key) => sessionStorageData.get(key) ?? null,
  key: (index) => [...sessionStorageData.keys()][index] ?? null,
  removeItem: (key) => sessionStorageData.delete(key),
  setItem: (key, value) => sessionStorageData.set(key, value),
};

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.num !== undefined) return `${key}_${options.num}`;
      return key;
    },
    i18n: {
      language: 'fr',
      changeLanguage: vi.fn(),
    },
  }),
}));

// Mock SEO
vi.mock('../components/SEO', () => ({
  SEO: () => <div data-testid="seo-mock" />,
}));

// Mock GameCanvas to test mounting/unmounting and props passed by App
vi.mock('../components/GameCanvas', () => ({
  GameCanvas: (props: GameCanvasProps) => (
    <div data-testid="game-canvas-mock">
      <span>Game Canvas Mounted</span>
      <span>Player Count: {props.initialPlayers?.length ?? 0}</span>
      <span>Mode: {props.gameMode}</span>
      {props.onReturnToMenu && (
        <button type="button" onClick={props.onReturnToMenu}>
          Mock Return To Menu
        </button>
      )}
    </div>
  ),
}));

vi.mock('../utils/deploymentMode', () => ({
  isHotseatOnlyBuild: () => deploymentMode.hotseatOnly,
}));

describe('App component (State and Lifecycle integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deploymentMode.hotseatOnly = false;
    cleanup();
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: sessionStorageMock,
    });
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('renders MainMenu, SEO, and LanguageSwitcher on initial load', () => {
    render(<App />);

    expect(screen.getByTestId('seo-mock')).toBeDefined();
    expect(screen.getByText('main_title')).toBeDefined();
    expect(screen.getByRole('button', { name: 'start_battle_button' })).toBeDefined();
    expect(screen.queryByTestId('game-canvas-mock')).toBeNull();
  });

  it('transitions from MainMenu to GameCanvas on start local battle, and unmounts MainMenu', () => {
    render(<App />);

    const startBtn = screen.getByRole('button', { name: 'start_battle_button' });
    fireEvent.click(startBtn);

    // MainMenu unmounted, GameCanvas mounted
    expect(screen.queryByText('main_title')).toBeNull();
    expect(screen.getByTestId('game-canvas-mock')).toBeDefined();
    expect(screen.getByText('Player Count: 2')).toBeDefined();
    expect(screen.getByText('Mode: local')).toBeDefined();
  });

  it('unmounts GameCanvas and returns to MainMenu when onReturnToMenu is triggered', () => {
    render(<App />);

    // Start game
    const startBtn = screen.getByRole('button', { name: 'start_battle_button' });
    fireEvent.click(startBtn);
    expect(screen.getByTestId('game-canvas-mock')).toBeDefined();

    // Trigger return to menu
    const returnBtn = screen.getByRole('button', { name: 'Mock Return To Menu' });
    fireEvent.click(returnBtn);

    // GameCanvas unmounted, MainMenu mounted again
    expect(screen.queryByTestId('game-canvas-mock')).toBeNull();
    expect(screen.getByText('main_title')).toBeDefined();
  });

  it('switches to OnlineLobby when clicking Play Online and returns when exiting', () => {
    render(<App />);

    const onlineBtn = screen.getByRole('button', { name: 'online_multiplayer_button' });
    fireEvent.click(onlineBtn);

    // OnlineLobby view active
    expect(screen.getByText('num_players_label')).toBeDefined();
    expect(screen.getByRole('button', { name: 'create_room_btn' })).toBeDefined();

    // Exit back to local menu
    const backBtn = screen.getByRole('button', { name: 'online_back_to_local' });
    fireEvent.click(backBtn);

    expect(screen.getByText('main_title')).toBeDefined();
  });

  it('automatically opens OnlineLobby in joining mode when URL has room, slot, and token query params', () => {
    window.history.replaceState({}, '', '/?room=ROOM77&slot=1&token=TOK77');

    render(<App />);

    // MainMenu start battle button is not rendered
    expect(screen.queryByRole('button', { name: 'start_battle_button' })).toBeNull();

    // OnlineLobby subtitle and joining view elements
    expect(screen.getByText('create_online_game')).toBeDefined();
    expect(screen.getByText('you_are_player_2')).toBeDefined();
    expect(screen.getByRole('button', { name: 'join_room_btn' })).toBeDefined();

    window.history.replaceState({}, '', '/');
  });

  it('keeps staging hotseat-only even with an invitation URL and a saved online session', () => {
    deploymentMode.hotseatOnly = true;
    window.sessionStorage.setItem('tankwars-online-session-v1', '{"saved":true}');
    window.history.replaceState({}, '', '/?room=ROOM77&slot=1&token=TOK77');

    render(<App />);

    expect(screen.getByText('main_title')).toBeDefined();
    expect(
      screen.queryByRole('button', { name: 'online_multiplayer_button' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'join_room_btn' })).toBeNull();
    expect(window.sessionStorage.getItem('tankwars-online-session-v1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'start_battle_button' }));
    expect(screen.getByText('Mode: local')).toBeDefined();
  });
});
