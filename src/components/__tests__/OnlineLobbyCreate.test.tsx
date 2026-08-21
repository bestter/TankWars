// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OnlineLobbyCreate } from '../OnlineLobbyCreate';
import type { RoomSlotConfig } from '../../types/room';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.num !== undefined) {
        return `${key}_${options.num}`;
      }
      return key;
    },
  }),
}));

describe('OnlineLobbyCreate component', () => {
  const defaultSlotConfigs: RoomSlotConfig[] = [
    { id: 's0', type: 'human' },
    { id: 's1', type: 'ai', aiProfile: 'v1-random' },
  ];

  let mockOnChangeNumPlayers: Mock<(n: 2 | 3 | 4) => void>;
  let mockOnUpdateSlot: Mock<(idx: number, patch: Partial<RoomSlotConfig>) => void>;
  let mockOnCreateRoom: Mock<() => void>;
  let mockOnExitToLocalMenu: Mock<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();

    mockOnChangeNumPlayers = vi.fn();
    mockOnUpdateSlot = vi.fn();
    mockOnCreateRoom = vi.fn();
    mockOnExitToLocalMenu = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders player count buttons and applies active class to selected count', () => {
    render(
      <OnlineLobbyCreate
        numPlayers={2}
        slotConfigs={defaultSlotConfigs}
        canCreate={true}
        isCreating={false}
        onChangeNumPlayers={mockOnChangeNumPlayers}
        onUpdateSlot={mockOnUpdateSlot}
        onCreateRoom={mockOnCreateRoom}
        onExitToLocalMenu={mockOnExitToLocalMenu}
      />
    );

    const btn2 = screen.getByRole('button', { name: '2' });
    const btn3 = screen.getByRole('button', { name: '3' });
    const btn4 = screen.getByRole('button', { name: '4' });

    expect(btn2.className).toContain('active');
    expect(btn3.className).not.toContain('active');
    expect(btn4.className).not.toContain('active');

    fireEvent.click(btn3);
    expect(mockOnChangeNumPlayers).toHaveBeenCalledWith(3);

    fireEvent.click(btn4);
    expect(mockOnChangeNumPlayers).toHaveBeenCalledWith(4);
  });

  it('renders slot rows and updates controller type on select change', () => {
    render(
      <OnlineLobbyCreate
        numPlayers={2}
        slotConfigs={defaultSlotConfigs}
        canCreate={true}
        isCreating={false}
        onChangeNumPlayers={mockOnChangeNumPlayers}
        onUpdateSlot={mockOnUpdateSlot}
        onCreateRoom={mockOnCreateRoom}
        onExitToLocalMenu={mockOnExitToLocalMenu}
      />
    );

    expect(screen.getByText('slot_label_1')).toBeDefined();
    expect(screen.getByText('slot_label_2')).toBeDefined();

    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBe(2);

    // Change slot 1 from AI to human
    fireEvent.change(selects[1], { target: { value: 'human' } });
    expect(mockOnUpdateSlot).toHaveBeenCalledWith(1, { type: 'human', aiProfile: undefined });

    // Change slot 0 from human to AI sniper
    fireEvent.change(selects[0], { target: { value: 'ai:v3-sniper' } });
    expect(mockOnUpdateSlot).toHaveBeenCalledWith(0, { type: 'ai', aiProfile: 'v3-sniper' });
  });

  it('displays link instructions for human slot with index > 0', () => {
    const slotsWithTwoHumans: RoomSlotConfig[] = [
      { id: 's0', type: 'human' },
      { id: 's1', type: 'human' },
    ];

    render(
      <OnlineLobbyCreate
        numPlayers={2}
        slotConfigs={slotsWithTwoHumans}
        canCreate={true}
        isCreating={false}
        onChangeNumPlayers={mockOnChangeNumPlayers}
        onUpdateSlot={mockOnUpdateSlot}
        onCreateRoom={mockOnCreateRoom}
        onExitToLocalMenu={mockOnExitToLocalMenu}
      />
    );

    expect(screen.getByText('link_instructions')).toBeDefined();
  });

  it('handles create room button states and triggers onCreateRoom callback', () => {
    const { rerender } = render(
      <OnlineLobbyCreate
        numPlayers={2}
        slotConfigs={defaultSlotConfigs}
        canCreate={true}
        isCreating={false}
        onChangeNumPlayers={mockOnChangeNumPlayers}
        onUpdateSlot={mockOnUpdateSlot}
        onCreateRoom={mockOnCreateRoom}
        onExitToLocalMenu={mockOnExitToLocalMenu}
      />
    );

    const createBtn = screen.getByRole('button', { name: 'create_room_btn' });
    expect(createBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(createBtn);
    expect(mockOnCreateRoom).toHaveBeenCalledTimes(1);

    // When isCreating is true
    rerender(
      <OnlineLobbyCreate
        numPlayers={2}
        slotConfigs={defaultSlotConfigs}
        canCreate={true}
        isCreating={true}
        onChangeNumPlayers={mockOnChangeNumPlayers}
        onUpdateSlot={mockOnUpdateSlot}
        onCreateRoom={mockOnCreateRoom}
        onExitToLocalMenu={mockOnExitToLocalMenu}
      />
    );

    const creatingBtn = screen.getByRole('button', { name: 'creating_room' });
    expect(creatingBtn.hasAttribute('disabled')).toBe(true);

    // When canCreate is false
    rerender(
      <OnlineLobbyCreate
        numPlayers={2}
        slotConfigs={defaultSlotConfigs}
        canCreate={false}
        isCreating={false}
        onChangeNumPlayers={mockOnChangeNumPlayers}
        onUpdateSlot={mockOnUpdateSlot}
        onCreateRoom={mockOnCreateRoom}
        onExitToLocalMenu={mockOnExitToLocalMenu}
      />
    );

    const disabledBtn = screen.getByRole('button', { name: 'create_room_btn' });
    expect(disabledBtn.hasAttribute('disabled')).toBe(true);
  });

  it('triggers onExitToLocalMenu callback when clicking back to local menu button', () => {
    render(
      <OnlineLobbyCreate
        numPlayers={2}
        slotConfigs={defaultSlotConfigs}
        canCreate={true}
        isCreating={false}
        onChangeNumPlayers={mockOnChangeNumPlayers}
        onUpdateSlot={mockOnUpdateSlot}
        onCreateRoom={mockOnCreateRoom}
        onExitToLocalMenu={mockOnExitToLocalMenu}
      />
    );

    const backBtn = screen.getByRole('button', { name: 'online_back_to_local' });
    fireEvent.click(backBtn);
    expect(mockOnExitToLocalMenu).toHaveBeenCalledTimes(1);
  });
});
