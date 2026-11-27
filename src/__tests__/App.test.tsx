import { makeRoundMap } from "../game/__tests__/helpers";
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import App from '../App';
import type { GameCanvasProps } from '../components/GameCanvas';
import { makePlayer, makeTank } from '../game/__tests__/helpers';
import { createEmptyShopSession } from '../components/gameCanvasReducer';
import type { PersistedOnlineSession } from '../utils/onlineSession';
import { StrictMode } from 'react';
import { persistParticipation, readParticipation } from '../utils/onlineParticipation';

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
  SEO: ({ titleKey }: { titleKey: string }) => <div data-testid="seo-mock" data-title={titleKey} />,
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
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('renders MainMenu, SEO, and LanguageSwitcher on initial load', () => {
    render(<App />);

    expect(screen.getByTestId('seo-mock')).toBeDefined();
    expect(screen.getByText('main_title')).toBeDefined();
    expect(screen.getByRole('button', { name: 'start_battle_button' })).toBeDefined();
    expect(screen.queryByTestId('game-canvas-mock')).toBeNull();
    expect(screen.queryByRole('button', { name: 'endurance_title' })).toBeNull();
  });

  it('keeps the menu setup through contact navigation and keeps the Canvas unmounted', async () => {
    const suffix = '?lang=fr#anchor';
    window.history.replaceState({ keep: true }, '', `/${suffix}`);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Capitaine' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'menu_free_weapons' }));
    const colors = within(screen.getByRole('group', { name: 'color_picker_player_group_label_1' }));
    const [customColor] = colors.getAllByRole('button', { name: 'color_select_label', pressed: false });
    fireEvent.click(customColor);
    const expectMenuSetup = () => {
      expect(screen.getByRole('button', { name: '4', pressed: true })).toBeDefined();
      expect(screen.getByDisplayValue('Capitaine')).toBeDefined();
      expect(screen.getByRole('checkbox', { name: 'menu_free_weapons', checked: true })).toBeDefined();
      expect(colors.getByRole('button', { name: 'color_select_label', pressed: true })).toBe(customColor);
    };

    fireEvent.click(screen.getByRole('button', { name: 'contact_title' }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(`/contact${suffix}`);
    expect(window.history.state).toEqual({ keep: true });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'contact_title' }));
    expect(screen.queryByRole('button', { name: 'start_battle_button' })).toBeNull();
    expect(screen.queryByTestId('game-canvas-mock')).toBeNull();
    expect(screen.getByTestId('seo-mock').dataset.title).toBe('contact_seo_title');

    window.history.back();
    await screen.findByRole('button', { name: 'start_battle_button' });
    expectMenuSetup();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(`/${suffix}`);
    window.history.forward();
    await screen.findByRole('heading', { name: 'contact_title' });
    fireEvent.click(screen.getByRole('button', { name: 'contact_back' }));
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(`/${suffix}`);
    expect(window.history.state).toEqual({ keep: true });
    expect(document.activeElement).toBe(screen.getByRole('main'));
    expectMenuSetup();
  });

  it.each(['/contact', '/contact/'])('accepts the direct URL %s', (path) => {
    window.history.replaceState({}, '', path);
    render(<App />);
    expect(screen.getByRole('heading', { name: 'contact_title' })).toBeDefined();
  });

  it('keeps the menu after a previously open contact path is blocked and contact becomes available again', () => {
    window.history.replaceState({}, '', '/contact');
    const { rerender } = render(<App />);
    expect(screen.getByRole('heading', { name: 'contact_title' })).toBeDefined();

    deploymentMode.hotseatOnly = true;
    rerender(<App />);
    expect(window.location.pathname).toBe('/');
    deploymentMode.hotseatOnly = false;
    rerender(<App />);
    expect(screen.getByRole('button', { name: 'contact_title' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'contact_title' })).toBeNull();
  });

  it('keeps the contact form and its draft if history rejects navigation', () => {
    window.history.replaceState({}, '', '/contact?lang=fr#anchor');
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementationOnce(() => {
      throw new DOMException('History is unavailable', 'SecurityError');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    const message = screen.getByLabelText<HTMLTextAreaElement>('contact_message');
    fireEvent.change(message, { target: { value: 'Unsaved contact message' } });
    fireEvent.click(screen.getByRole('button', { name: 'contact_back' }));
    expect(screen.getByText('contact_navigation_error')).toBeDefined();
    expect(log).toHaveBeenCalledWith('[TankWars] Contact history update failed', 'pushState');
    expect(message.value).toBe('Unsaved contact message');
    expect(window.location.pathname).toBe('/contact');

    fireEvent.click(screen.getByRole('button', { name: 'contact_back' }));
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('contact_navigation_error')).toBeNull();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?lang=fr#anchor');
  });

  it('clears the contact navigation error when leaving the menu and returning later', () => {
    vi.spyOn(window.history, 'pushState').mockImplementationOnce(() => {
      throw new DOMException('History is unavailable', 'SecurityError');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'contact_title' }));
    expect(screen.getByText('contact_navigation_error')).toBeDefined();
    expect(window.location.pathname).toBe('/');

    fireEvent.click(screen.getByRole('button', { name: 'start_battle_button' }));
    expect(screen.getByTestId('game-canvas-mock')).toBeDefined();
    expect(screen.queryByText('contact_navigation_error')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mock Return To Menu' }));
    expect(screen.getByRole('button', { name: 'start_battle_button' })).toBeDefined();
    expect(screen.queryByText('contact_navigation_error')).toBeNull();
  });

  it.each(['hotseat', 'no API base'])('hides contact and normalizes the URL in %s builds', (mode) => {
    deploymentMode.hotseatOnly = mode === 'hotseat';
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_BASE', mode === 'hotseat' ? 'https://api.example.com' : '');
    window.history.replaceState({ keep: true }, '', '/contact/?lang=fr#anchor');
    render(<App />);
    expect(screen.queryByRole('button', { name: 'contact_title' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'contact_title' })).toBeNull();
    expect(location.pathname + location.search + location.hash).toBe('/?lang=fr#anchor');
    expect(history.state).toEqual({ keep: true });
  });

  it('gives an online invitation priority over the contact path', () => {
    window.history.replaceState({}, '', '/contact/?room=ROOM77&slot=1&token=TOK77');
    render(<App />);
    expect(screen.getByRole('button', { name: 'join_room_btn' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'contact_title' })).toBeNull();
    expect(readParticipation()?.token).toBe('TOK77');
    expect(location.pathname + location.search).toBe('/');
  });

  it('does not open contact through browser history during a battle', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'start_battle_button' }));
    window.history.pushState({}, '', '/contact');
    fireEvent.popState(window);
    expect(screen.getByTestId('game-canvas-mock')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'contact_title' })).toBeNull();
    expect(location.pathname).toBe('/');
  });
  it('mounts one atomic live region inside main landmark before any warning occurs', () => {
    render(<App />);
    const main = screen.getByRole('main');
    const alert = screen.getByRole('alert');
    expect(main.contains(alert)).toBe(true);
    expect(alert.getAttribute('aria-atomic')).toBe('true');
    expect(alert.textContent).toBe('');
  });

  it('aggregates independent failures without duplicating lobby alerts or reannouncing repeated errors', () => {
    window.history.replaceState({}, '', '/?room=ROOM77&slot=1&token=TOK77');
    vi.spyOn(sessionStorageMock, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<App />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('online_private_url_warning');
    fireEvent.change(screen.getByPlaceholderText('enter_name_placeholder'), { target: { value: 'Guest' } });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(alert.textContent).toBe('online_private_url_warning');

    const warn = () => fireEvent(window, new CustomEvent('online-persistence-warning', { detail: 'online_storage_clear_failed' }));
    warn();
    expect(alert.textContent).toBe('online_private_url_warningonline_storage_clear_failed');
    const mutations = new MutationObserver(() => {});
    mutations.observe(alert, { childList: true, subtree: true, characterData: true });
    warn();
    fireEvent.change(screen.getByPlaceholderText('enter_name_placeholder'), { target: { value: 'Guest 2' } });
    expect(mutations.takeRecords()).toHaveLength(0);
    mutations.disconnect();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toBe(alert);
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
    expect(window.location.search).toBe('');
    expect(readParticipation()?.token).toBe('TOK77');

    window.history.replaceState({}, '', '/');
  });

  it('restores the unjoined form and edited name after refresh under Strict Mode', () => {
    const ws = vi.spyOn(window, 'WebSocket');
    window.history.replaceState({ keep: 1 }, '', '/?room=ROOM77&slot=1&token=TOK77&lang=fr#test');
    const first = render(<StrictMode><App /></StrictMode>);
    fireEvent.change(screen.getByPlaceholderText('enter_name_placeholder'), { target: { value: 'Guest' } });
    first.unmount();
    render(<StrictMode><App /></StrictMode>);
    expect((screen.getByPlaceholderText('enter_name_placeholder') as HTMLInputElement).value).toBe('Guest');
    expect(ws).not.toHaveBeenCalled();
    expect(window.location.search + window.location.hash).toBe('?lang=fr#test');
    expect(history.state).toEqual({ keep: 1 });
    ws.mockRestore();
  });

  it('keeps the menu open after leaving a direct invitation and refreshing', () => {
    window.history.replaceState({}, '', '/?room=ROOM77&slot=1&token=TOK77');
    const first = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'leave_room' }));
    expect(screen.getByText('main_title')).toBeDefined();
    expect(readParticipation()).toBeNull();
    first.unmount();
    render(<App />);
    expect(screen.getByText('main_title')).toBeDefined();
  });

  it('displays an invalid invitation error instead of restoring an old lobby', () => {
    persistParticipation({ version: 1, room: 'old', slot: 0, token: 'synthetic',
      name: 'Host', engaged: false, mode: 'guest', slots: [] });
    window.history.replaceState({}, '', '/?room=new&slot=9&token=synthetic');
    render(<App />);
    expect(screen.getByRole('alert').textContent).toBe('online_invitation_invalid');
    expect(screen.getByText('main_title')).toBeDefined();
    expect(readParticipation()).toBeNull();
    expect(location.search).toBe('');
  });

  it.each([
    '/?room=ROOM77&slot=invalid&token=TOK77',
    '/?room=ROOM77&slot=1',
    '/?slot=1&token=TOK77',
  ])('keeps the local menu for an incomplete invitation URL: %s', (url) => {
    window.history.replaceState({}, '', url);
    render(<App />);

    expect(screen.getByRole('button', { name: 'start_battle_button' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'join_room_btn' })).toBeNull();
  });

  it('confirms via a native dialog focusing Cancel before returning from a restored online game, without window.confirm', () => {
    const players = [
      makePlayer({ id: 'player-1', name: 'Host' }),
      makePlayer({ id: 'player-2', name: 'Guest', tank: makeTank('tank-2', 620, 300) }),
    ];
    const session: PersistedOnlineSession = {
      meta: {
        initialMap: makeRoundMap(),
        roomId: 'room-abc',
        localPlayerId: 'player-1',
        slot: 0,
        token: 'TOKEN1',
      },
      players,
      canvas: {
        map: makeRoundMap(),
      gamePhase: 'COMBAT',
        currentManche: 1,
        uiPlayers: players,
        shopPlayers: players,
        currentShopIndex: 0,
        roundResult: null,
        lastRoundOutcome: null,
        wind: 0,
        authoritySlot: 0,
        authorityEpoch: 1,
        lastAppliedShotId: 0,
        lastAppliedZeusStrikeId: 0,
        shopSession: createEmptyShopSession(),
        lastAppliedShopEpoch: 0,
        lastCompletedRoundNumber: 0,
        lastSeenShotId: 0,
        pendingFireIntent: null,
        fireRejection: null,
        roundEarningsByPlayer: {},
        earningsOverlay: null,
      },
    };
    window.sessionStorage.setItem(
      'tankwars-online-session-v2',
      JSON.stringify(session),
    );
    persistParticipation({
      version: 1,
      room: 'room-abc',
      slot: 0,
      token: 'TOKEN1',
      name: 'Host',
      engaged: true,
      mode: 'host',
      slots: [],
    });
    const confirmSpy = vi.spyOn(window, 'confirm');

    render(<App />);
    const returnButton = screen.getByRole('button', { name: 'Mock Return To Menu' });
    fireEvent.click(returnButton);
    expect(confirmSpy).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'online_quit_confirm' }) as HTMLDialogElement;
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.getAttribute('role')).toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    const cancelBtn = screen.getByRole('button', { name: 'online_quit_cancel' });
    expect(document.activeElement).toBe(cancelBtn);

    // Canceling by button keeps match open
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('game-canvas-mock')).toBeDefined();

    // Canceling by Esc keeps match open
    fireEvent.click(returnButton);
    const dialogForEsc = screen.getByRole('dialog', { name: 'online_quit_confirm' });
    fireEvent(dialogForEsc, new Event('cancel', { cancelable: true }));
    expect(dialogForEsc).toHaveProperty('returnValue', 'cancel');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('game-canvas-mock')).toBeDefined();

    // Confirming clears online storage + participation and returns to menu
    fireEvent.click(returnButton);
    fireEvent.click(screen.getByRole('button', { name: 'online_quit_confirm_btn' }));
    expect(screen.getByText('main_title')).toBeDefined();
    expect(window.sessionStorage.getItem('tankwars-online-session-v2')).toBeNull();
    expect(readParticipation()).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('closes the connected native dialog before unmounting so focus returns to the invoker on Cancel, Esc, and native close', () => {
    const players = [
      makePlayer({ id: 'player-1', name: 'Host' }),
      makePlayer({ id: 'player-2', name: 'Guest', tank: makeTank('tank-2', 620, 300) }),
    ];
    const session: PersistedOnlineSession = {
      meta: {
        initialMap: makeRoundMap(),
        roomId: 'room-focus',
        localPlayerId: 'player-1',
        slot: 0,
        token: 'TOKEN_FOCUS',
      },
      players,
      canvas: {
        map: makeRoundMap(),
        gamePhase: 'COMBAT',
        currentManche: 1,
        uiPlayers: players,
        shopPlayers: players,
        currentShopIndex: 0,
        roundResult: null,
        lastRoundOutcome: null,
        wind: 0,
        authoritySlot: 0,
        authorityEpoch: 1,
        lastAppliedShotId: 0,
        lastAppliedZeusStrikeId: 0,
        shopSession: createEmptyShopSession(),
        lastAppliedShopEpoch: 0,
        lastCompletedRoundNumber: 0,
        lastSeenShotId: 0,
        pendingFireIntent: null,
        fireRejection: null,
        roundEarningsByPlayer: {},
        earningsOverlay: null,
      },
    };
    window.sessionStorage.setItem('tankwars-online-session-v2', JSON.stringify(session));

    const previousFocusMap = new WeakMap<HTMLDialogElement, HTMLElement>();
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
      showModal?: () => void;
      close?: (returnValue?: string) => void;
    };
    const originalShowModal = proto.showModal;
    const originalClose = proto.close;

    proto.showModal = function (this: HTMLDialogElement) {
      if (document.activeElement instanceof HTMLElement) {
        previousFocusMap.set(this, document.activeElement);
      }
      this.setAttribute('open', '');
      Object.defineProperty(this, 'open', { configurable: true, get: () => true });
    };
    proto.close = function (this: HTMLDialogElement, returnValue?: string) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      Object.defineProperty(this, 'open', { configurable: true, get: () => false });
      if (returnValue !== undefined) {
        this.returnValue = returnValue;
      }
      // Chromium only restores focus when the dialog is still connected to the DOM.
      if (this.isConnected) {
        const invoker = previousFocusMap.get(this);
        invoker?.focus();
      }
      this.dispatchEvent(new Event('close'));
    };

    try {
      render(<StrictMode><App /></StrictMode>);
      const returnButton = screen.getByRole('button', { name: 'Mock Return To Menu' });

      // 1) Cancel button
      returnButton.focus();
      fireEvent.click(returnButton);
      const cancelBtn = screen.getByRole('button', { name: 'online_quit_cancel' });
      expect(document.activeElement).toBe(cancelBtn);
      fireEvent.click(cancelBtn);
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.activeElement).toBe(returnButton);

      // 2) Esc (cancel event)
      fireEvent.click(returnButton);
      const dialogForEsc = screen.getByRole('dialog', { name: 'online_quit_confirm' });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'online_quit_cancel' }));
      fireEvent(dialogForEsc, new Event('cancel', { cancelable: true }));
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.activeElement).toBe(returnButton);

      // 3) Native close without prior cancel (e.g. CloseWatcher / repeated Esc)
      fireEvent.click(returnButton);
      const dialogForClose = screen.getByRole('dialog', { name: 'online_quit_confirm' }) as HTMLDialogElement;
      act(() => {
        dialogForClose.close();
      });
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.activeElement).toBe(returnButton);

      // 4) Confirm still quits and cleans up
      fireEvent.click(returnButton);
      fireEvent.click(screen.getByRole('button', { name: 'online_quit_confirm_btn' }));
      expect(screen.getByText('main_title')).toBeDefined();
      expect(window.sessionStorage.getItem('tankwars-online-session-v2')).toBeNull();
    } finally {
      if (originalShowModal) proto.showModal = originalShowModal;
      else Reflect.deleteProperty(proto, 'showModal');
      if (originalClose) proto.close = originalClose;
      else Reflect.deleteProperty(proto, 'close');
    }
  });

  it('keeps staging hotseat-only even with an invitation URL and a saved online session', () => {
    deploymentMode.hotseatOnly = true;
    window.sessionStorage.setItem('tankwars-online-session-v2', '{"saved":true}');
    window.history.replaceState({}, '', '/?room=ROOM77&slot=1&token=TOK77');

    render(<App />);

    expect(screen.getByText('main_title')).toBeDefined();
    expect(
      screen.queryByRole('button', { name: 'online_multiplayer_button' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'join_room_btn' })).toBeNull();
    expect(window.sessionStorage.getItem('tankwars-online-session-v2')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'start_battle_button' }));
    expect(screen.getByText('Mode: local')).toBeDefined();
  });

  it('provides semantic landmarks, skip link before language switcher, and targets main content with focus', () => {
    render(<App />);

    // Unique header and main landmarks
    const banner = screen.getByRole('banner');
    const main = screen.getByRole('main');
    expect(banner).toBeDefined();
    expect(main).toBeDefined();
    expect(main.id).toBe('main-content');
    expect(main.getAttribute('tabindex')).toBe('-1');

    // Skip link inside header, preceding language switcher
    const skipLink = screen.getByRole('link', { name: 'skip_to_content' });
    expect(skipLink).toBeDefined();
    expect(skipLink.getAttribute('href')).toBe('#main-content');
    expect(banner.contains(skipLink)).toBe(true);

    const langSwitcher = banner.querySelector('.language-switcher, [aria-label], select, button') ?? banner;
    expect(skipLink.compareDocumentPosition(langSwitcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Activating skip link focuses main content
    fireEvent.click(skipLink);
    expect(document.activeElement).toBe(main);

    // Landmarks persist on view transitions
    const startBtn = screen.getByRole('button', { name: 'start_battle_button' });
    fireEvent.click(startBtn);

    expect(screen.getByRole('banner')).toBe(banner);
    expect(screen.getByRole('main')).toBe(main);
    expect(main.contains(screen.getByTestId('game-canvas-mock'))).toBe(true);

    const returnBtn = screen.getByRole('button', { name: 'Mock Return To Menu' });
    fireEvent.click(returnBtn);

    expect(screen.getByRole('banner')).toBe(banner);
    expect(screen.getByRole('main')).toBe(main);
    expect(main.contains(screen.getByText('main_title'))).toBe(true);
  });

  it('resets scroll to top only when transitioning between top-level screens', () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(scrollToSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'start_battle_button' }));
    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    expect(scrollToSpy).toHaveBeenLastCalledWith(0, 0);

    // Un re-rendu interne pendant le combat ne doit pas forcer le défilement vers le haut
    fireEvent(window, new CustomEvent('online-persistence-warning', { detail: 'online_restore_unavailable' }));
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Mock Return To Menu' }));
    expect(scrollToSpy).toHaveBeenCalledTimes(2);
    expect(scrollToSpy).toHaveBeenLastCalledWith(0, 0);

    fireEvent.click(screen.getByRole('button', { name: 'online_multiplayer_button' }));
    expect(scrollToSpy).toHaveBeenCalledTimes(3);
    expect(scrollToSpy).toHaveBeenLastCalledWith(0, 0);
  });
});
