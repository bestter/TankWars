import { describe, expect, it } from 'vitest';
import { onlineEntryMessagesReducer } from '../onlineEntryMessages';
import type { OnlineEntryMessage } from '../onlineParticipation';

describe('online persistence warnings', () => {
  it('preserves independent failures when a later error arrives', () => {
    expect(onlineEntryMessagesReducer(['online_url_cleanup_failed'], {
      type: 'add', messages: ['online_storage_clear_failed'],
    })).toEqual(['online_url_cleanup_failed', 'online_storage_clear_failed']);
  });
  it('does not change state when a repeated failure needs no new announcement', () => {
    const warnings: OnlineEntryMessage[] = ['online_storage_clear_failed'];
    expect(onlineEntryMessagesReducer(warnings, { type: 'add', messages: warnings })).toBe(warnings);
  });
  it('removes redundant general storage warnings in either arrival order', () => {
    for (const warnings of [
      ['online_restore_unavailable', 'online_private_url_warning'],
      ['online_private_url_warning', 'online_restore_unavailable'],
    ] satisfies OnlineEntryMessage[][]) {
      expect(onlineEntryMessagesReducer([], { type: 'replace', messages: warnings })).toEqual(['online_private_url_warning']);
    }
  });
  it('replaces previous warnings when leaving the online flow', () => {
    expect(onlineEntryMessagesReducer(['online_private_url_warning'], {
      type: 'replace', messages: [],
    })).toEqual([]);
  });
});
