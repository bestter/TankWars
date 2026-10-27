import type { OnlineEntryMessage } from './onlineParticipation';

type MessageAction = { type: 'replace' | 'add'; messages: OnlineEntryMessage[] };

/** Preserve independent failures, without repeating the general storage warning
 * when the private-address warning already explains the same storage failure.
 */
export function onlineEntryMessagesReducer(previous: OnlineEntryMessage[], action: MessageAction): OnlineEntryMessage[] {
  const combined = action.type === 'add' ? [...previous, ...action.messages] : action.messages;
  const unique = new Set(combined);
  if (unique.has('online_private_url_warning')) unique.delete('online_restore_unavailable');
  const messages = [...unique];
  return previous.length === messages.length && previous.every((message, index) => message === messages[index])
    ? previous : messages;
}
