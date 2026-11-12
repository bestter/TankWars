// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MobileControls } from '../MobileControls';
import type { CurrentTurnInfo } from '../../game/engine/TurnManager';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// JSDOM n'expose pas PointerEvent : double minimal portant pointerId/pointerType.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventDouble extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventDouble, configurable: true });
}

describe('MobileControls', () => {
  let originalMatchMedia: typeof window.matchMedia;
  let originalMaxTouchPoints: number;

  const defaultTurnInfo: CurrentTurnInfo = {
    playerName: 'Player 1',
    playerId: 'p1',
    isHuman: true,
    playerColor: '#FF5555', // RED
    angle: 0,
    power: 50,
    currentWeapon: 'MISSILE',
    inventory: {},
    turn: 1,
    isInputLocked: false,
    tanksAreFalling: false,
  };

  const defaultProps = {
    turnInfo: defaultTurnInfo,
    onAdjustAngle: vi.fn(),
    onAdjustPower: vi.fn(),
    onCycleWeapon: vi.fn(),
    onFire: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();

    originalMatchMedia = window.matchMedia;
    originalMaxTouchPoints = navigator.maxTouchPoints;

    // Default to touch device
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 1,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: originalMaxTouchPoints,
      writable: true,
      configurable: true,
    });
  });

  it('renders correctly on touch devices', () => {
    render(<MobileControls {...defaultProps} />);
    expect(screen.getByText('ANGLE')).toBeDefined();
    expect(screen.getByText('POWER')).toBeDefined();
    expect(screen.getByText('mobile_weapon_btn')).toBeDefined();
    expect(screen.getByText('mobile_fire_btn')).toBeDefined();
  });

  it('does not render on non-touch devices', () => {
    // Override default mock to simulate non-touch
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 0,
      writable: true,
      configurable: true,
    });

    // In JSDOM, ontouchstart exists by default, we need to hide it for this test
    const originalOntouchstart = (window as unknown as Record<string, unknown>).ontouchstart;
    delete (window as unknown as Record<string, unknown>).ontouchstart;

    const { container } = render(<MobileControls {...defaultProps} />);
    expect(container.firstChild).toBeNull();

    // Restore
    (window as unknown as Record<string, unknown>).ontouchstart = originalOntouchstart;
  });

  describe('Interaction based on game state', () => {
    it('disables buttons when not human turn', () => {
      render(
        <MobileControls
          {...defaultProps}
          turnInfo={{ ...defaultTurnInfo, isHuman: false }}
        />
      );

      const angleButtons = screen.getAllByText(/◀|▶/);
      angleButtons.forEach((btn) => expect((btn as HTMLButtonElement).disabled).toBe(true));

      const powerButtons = screen.getAllByText(/▼|▲/);
      powerButtons.forEach((btn) => expect((btn as HTMLButtonElement).disabled).toBe(true));

      expect((screen.getByText('mobile_weapon_btn') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText('mobile_fire_btn') as HTMLButtonElement).disabled).toBe(true);
    });

    it('disables buttons when input is locked', () => {
      render(
        <MobileControls
          {...defaultProps}
          turnInfo={{ ...defaultTurnInfo, isInputLocked: true }}
        />
      );

      const angleButtons = screen.getAllByText(/◀|▶/);
      angleButtons.forEach((btn) => expect((btn as HTMLButtonElement).disabled).toBe(true));

      const powerButtons = screen.getAllByText(/▼|▲/);
      powerButtons.forEach((btn) => expect((btn as HTMLButtonElement).disabled).toBe(true));

      expect((screen.getByText('mobile_weapon_btn') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText('mobile_fire_btn') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables buttons when human turn and input not locked', () => {
      render(<MobileControls {...defaultProps} />);

      const angleButtons = screen.getAllByText(/◀|▶/);
      angleButtons.forEach((btn) => expect((btn as HTMLButtonElement).disabled).toBe(false));

      const powerButtons = screen.getAllByText(/▼|▲/);
      powerButtons.forEach((btn) => expect((btn as HTMLButtonElement).disabled).toBe(false));

      expect((screen.getByText('mobile_weapon_btn') as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByText('mobile_fire_btn') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('Interactions', () => {
    it('calls onCycleWeapon correctly', () => {
      render(<MobileControls {...defaultProps} />);
      fireEvent.click(screen.getByText('mobile_weapon_btn'));
      expect(defaultProps.onCycleWeapon).toHaveBeenCalledWith(1);
    });

    it('calls onFire correctly', () => {
      render(<MobileControls {...defaultProps} />);
      fireEvent.click(screen.getByText('mobile_fire_btn'));
      expect(defaultProps.onFire).toHaveBeenCalled();
    });

  });

  describe('Réglages par Pointer Events', () => {
    const ADJUST_BUTTONS: Array<[string, 'onAdjustAngle' | 'onAdjustPower', number]> = [
      ['◀', 'onAdjustAngle', -1],
      ['▶', 'onAdjustAngle', 1],
      ['▼', 'onAdjustPower', -1],
      ['▲', 'onAdjustPower', 1],
    ];

    const down = (el: Element, pointerId = 1, init: PointerEventInit = {}) =>
      fireEvent.pointerDown(el, { pointerId, button: 0, buttons: 1, ...init });

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(ADJUST_BUTTONS)('%s : un pas immédiat puis répétitions à 330/410 ms', (label, cb, delta) => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText(label);
      down(btn);
      expect(defaultProps[cb]).toHaveBeenCalledTimes(1);
      expect(defaultProps[cb]).toHaveBeenCalledWith(delta);
      act(() => { vi.advanceTimersByTime(250); });
      expect(defaultProps[cb]).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(80); });
      expect(defaultProps[cb]).toHaveBeenCalledTimes(2);
      act(() => { vi.advanceTimersByTime(80); });
      expect(defaultProps[cb]).toHaveBeenCalledTimes(3);
      fireEvent.pointerUp(btn, { pointerId: 1 });
      act(() => { vi.advanceTimersByTime(500); });
      expect(defaultProps[cb]).toHaveBeenCalledTimes(3);
    });

    it.each(['mouse', 'touch', 'pen'])('un appui court (%s) produit exactement un pas, sans pas au clic', (pointerType) => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('▲');
      down(btn, 1, { pointerType });
      fireEvent.pointerUp(btn, { pointerId: 1, pointerType });
      fireEvent.click(btn);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(1);
    });

    it('ignore clic droit, bouton central et boutons auxiliaires', () => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('▲');
      down(btn, 1, { button: 2, buttons: 2 });
      down(btn, 2, { button: 1, buttons: 4 });
      down(btn, 3, { pointerType: 'pen', button: 0, buttons: 3 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustPower).not.toHaveBeenCalled();
    });

    it.each(['mouse', 'touch', 'pen'])('arrête à la sortie du bouton (%s), avant le délai et sans reprise au retour', (pointerType) => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('◀');
      down(btn, 1, { pointerType });
      fireEvent.pointerLeave(btn, { pointerId: 1, pointerType });
      act(() => { vi.advanceTimersByTime(1000); });
      fireEvent.pointerEnter(btn, { pointerId: 1, pointerType });
      fireEvent.pointerMove(btn, { pointerId: 1, pointerType });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustAngle).toHaveBeenCalledTimes(1);
    });

    it('arrête à la sortie pendant la répétition', () => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('◀');
      down(btn);
      act(() => { vi.advanceTimersByTime(250 + 80); });
      expect(defaultProps.onAdjustAngle).toHaveBeenCalledTimes(2);
      fireEvent.pointerLeave(btn, { pointerId: 1 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustAngle).toHaveBeenCalledTimes(2);
    });

    it('arrête quand un pointeur capturé sort du rectangle du bouton (pointermove)', () => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('◀');
      vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, right: 48, bottom: 44, width: 48, height: 44, x: 0, y: 0, toJSON: () => ({}),
      });
      down(btn);
      fireEvent.pointerMove(btn, { pointerId: 1, buttons: 1, clientX: 20, clientY: 20 });
      act(() => { vi.advanceTimersByTime(330); });
      expect(defaultProps.onAdjustAngle).toHaveBeenCalledTimes(2);
      fireEvent.pointerMove(btn, { pointerId: 1, buttons: 1, clientX: 200, clientY: 20 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustAngle).toHaveBeenCalledTimes(2);
    });

    it.each(['◀', '▲'])('%s : arrête au relâchement du bouton principal malgré un bouton central encore enfoncé', (label) => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText(label);
      const cb = label === '◀' ? defaultProps.onAdjustAngle : defaultProps.onAdjustPower;
      vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, right: 48, bottom: 44, width: 48, height: 44, x: 0, y: 0, toJSON: () => ({}),
      });
      down(btn, 1, { pointerType: 'mouse' });
      // Bouton central ajouté : le maintien continue (gauche + central = 5).
      fireEvent.pointerMove(btn, { pointerId: 1, pointerType: 'mouse', buttons: 5, clientX: 20, clientY: 20 });
      act(() => { vi.advanceTimersByTime(330); });
      expect(cb).toHaveBeenCalledTimes(2);
      // Gauche relâché, central toujours enfoncé : pas de pointerup.
      fireEvent.pointerMove(btn, { pointerId: 1, pointerType: 'mouse', buttons: 4, clientX: 20, clientY: 20 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(cb).toHaveBeenCalledTimes(2);
      // Aucun redémarrage automatique.
      fireEvent.pointerMove(btn, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 20, clientY: 20 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it.each(['pointerCancel', 'lostPointerCapture'] as const)('%s arrête le maintien avant le délai et pendant la répétition', (evt) => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('▶');
      down(btn);
      fireEvent[evt](btn, { pointerId: 1 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustAngle).toHaveBeenCalledTimes(1);

      down(btn);
      act(() => { vi.advanceTimersByTime(330); });
      expect(defaultProps.onAdjustAngle).toHaveBeenCalledTimes(3);
      fireEvent[evt](btn, { pointerId: 1 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustAngle).toHaveBeenCalledTimes(3);
    });

    it('libère la capture implicite sans arrêter le maintien', () => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('▲');
      btn.hasPointerCapture = vi.fn(() => true);
      btn.releasePointerCapture = vi.fn();
      down(btn, 1, { pointerType: 'touch' });
      expect(btn.releasePointerCapture).toHaveBeenCalledWith(1);
      fireEvent.lostPointerCapture(btn, { pointerId: 1 });
      act(() => { vi.advanceTimersByTime(330); });
      expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(2);
      // Une perte de capture inattendue ultérieure arrête le maintien.
      fireEvent.lostPointerCapture(btn, { pointerId: 1 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(2);
    });

    it('démarre le maintien sans planter si releasePointerCapture lève une exception', () => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('▲');
      btn.hasPointerCapture = vi.fn(() => true);
      btn.releasePointerCapture = vi.fn(() => {
        throw new DOMException('NotFoundError', 'NotFoundError');
      });
      down(btn, 1, { pointerType: 'touch' });
      expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(1);
    });

    it('premier appui prioritaire : le second pointeur est sans effet, même sur un autre bouton', () => {
      render(<MobileControls {...defaultProps} />);
      const first = screen.getByText('▲');
      const other = screen.getByText('◀');
      down(first, 1);
      down(first, 2);
      down(other, 2);
      expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(1);
      expect(defaultProps.onAdjustAngle).not.toHaveBeenCalled();
      fireEvent.pointerMove(other, { pointerId: 2, clientX: 999, clientY: 999 });
      fireEvent.pointerLeave(first, { pointerId: 2 });
      fireEvent.pointerCancel(first, { pointerId: 2 });
      fireEvent.pointerUp(other, { pointerId: 2 });
      fireEvent.lostPointerCapture(first, { pointerId: 2 });
      act(() => { vi.advanceTimersByTime(330); });
      expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(2);
      expect(defaultProps.onAdjustAngle).not.toHaveBeenCalled();
      fireEvent.pointerUp(first, { pointerId: 1 });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(2);
      // Le second pointeur, toujours posé, n'est pas devenu actif.
      expect(defaultProps.onAdjustAngle).not.toHaveBeenCalled();
    });

    describe('arrêts externes', () => {
      const startHold = (props = defaultProps) => {
        const utils = render(<MobileControls {...props} />);
        down(screen.getByText('▲'));
        act(() => { vi.advanceTimersByTime(330); });
        expect(props.onAdjustPower).toHaveBeenCalledTimes(2);
        return utils;
      };
      const expectStopped = () => {
        act(() => { vi.advanceTimersByTime(1000); });
        expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(2);
      };

      it.each([
        ['verrouillage', { ...defaultTurnInfo, isInputLocked: true }],
        ['tour IA', { ...defaultTurnInfo, isHuman: false }],
        ['turnInfo null', null],
      ])('arrête au %s', (_name, turnInfo) => {
        const { rerender } = startHold();
        rerender(<MobileControls {...defaultProps} turnInfo={turnInfo} />);
        expectStopped();
      });

      it('arrête au changement de joueur sans transfert au suivant', () => {
        const { rerender } = startHold();
        rerender(<MobileControls {...defaultProps} turnInfo={{ ...defaultTurnInfo, playerId: 'p2' }} />);
        expectStopped();
      });

      it('arrête au démontage', () => {
        const { unmount } = startHold();
        unmount();
        expectStopped();
      });

      it('arrête à la perte de focus de la fenêtre', () => {
        startHold();
        act(() => { window.dispatchEvent(new Event('blur')); });
        expectStopped();
      });

      it('arrête quand le document devient masqué', () => {
        startHold();
        const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        expectStopped();
        spy.mockRestore();
      });

      it('ne reprend pas automatiquement après réactivation', () => {
        const { rerender } = startHold();
        rerender(<MobileControls {...defaultProps} turnInfo={{ ...defaultTurnInfo, isInputLocked: true }} />);
        rerender(<MobileControls {...defaultProps} />);
        expectStopped();
      });

      it('un rafraîchissement du HUD conserve la cadence', () => {
        const { rerender } = startHold();
        rerender(<MobileControls {...defaultProps} turnInfo={{ ...defaultTurnInfo, angle: 5, power: 60 }} />);
        act(() => { vi.advanceTimersByTime(160); });
        expect(defaultProps.onAdjustPower).toHaveBeenCalledTimes(4);
      });
    });

    it('ne démarre pas lorsque les commandes sont désactivées', () => {
      render(<MobileControls {...defaultProps} turnInfo={{ ...defaultTurnInfo, isInputLocked: true }} />);
      down(screen.getByText('▲'));
      act(() => { vi.advanceTimersByTime(1000); });
      expect(defaultProps.onAdjustPower).not.toHaveBeenCalled();
    });

    it('les réglages ne portent plus de gestionnaires Mouse/Touch et Arme/Tir restent des clics', () => {
      render(<MobileControls {...defaultProps} />);
      const btn = screen.getByText('▲');
      fireEvent.mouseDown(btn);
      fireEvent.touchStart(btn);
      expect(defaultProps.onAdjustPower).not.toHaveBeenCalled();

      fireEvent.pointerDown(screen.getByText('mobile_fire_btn'), { pointerId: 1, button: 0, buttons: 1 });
      expect(defaultProps.onFire).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('mobile_fire_btn'));
      fireEvent.click(screen.getByText('mobile_weapon_btn'));
      expect(defaultProps.onFire).toHaveBeenCalledTimes(1);
      expect(defaultProps.onCycleWeapon).toHaveBeenCalledTimes(1);
    });

    it('applique la classe de touch-action: none aux quatre réglages seulement', () => {
      render(<MobileControls {...defaultProps} />);
      for (const [label] of ADJUST_BUTTONS) {
        expect(screen.getByText(label).classList.contains('retro-mobile-adjust-btn')).toBe(true);
      }
      expect(screen.getByText('mobile_fire_btn').classList.contains('retro-mobile-adjust-btn')).toBe(false);
      expect(screen.getByText('mobile_weapon_btn').classList.contains('retro-mobile-adjust-btn')).toBe(false);
    });
  });

  describe('Touch configuration changes', () => {
    it('updates isTouch when media query changes', async () => {
      let changeListener: (() => void) | undefined;
      let isCoarse = false;

      // Override default mock to intercept addEventListener
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query === '(pointer: coarse)' ? isCoarse : false;
        },
        media: query,
        onchange: null,
        addEventListener: vi.fn((event, listener) => {
          if (event === 'change') changeListener = listener;
        }),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        writable: true,
        configurable: true,
      });
      const originalOntouchstart = (window as unknown as Record<string, unknown>).ontouchstart;
      delete (window as unknown as Record<string, unknown>).ontouchstart;

      const { container } = render(<MobileControls {...defaultProps} />);
      expect(container.firstChild).toBeNull();

      // Trigger change event saying it IS a touch device now
      if (changeListener) {
        isCoarse = true;
        const { act } = await import('@testing-library/react');
        await act(async () => {
          changeListener?.();
        });
      }

      expect(container.firstChild).not.toBeNull();

      // Restore
      (window as unknown as Record<string, unknown>).ontouchstart = originalOntouchstart;
    });
  });
});
