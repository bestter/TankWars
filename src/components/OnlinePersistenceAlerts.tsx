import { useTranslation } from 'react-i18next';
import type { OnlineEntryMessage } from '../utils/onlineParticipation';

export function OnlinePersistenceAlerts({ messages }: { readonly messages: OnlineEntryMessage[] }) {
  const { t } = useTranslation();
  // Keep the live region mounted before its content changes. role=alert already
  // implies assertive announcements; aria-atomic keeps each update understandable.
  return <div role="alert" aria-atomic="true">
    {messages.map(message => <p key={message}>{t(message)}</p>)}
  </div>;
}
