import { useEffect, useState } from 'react';
import { getOnlineApiBase } from '../utils/onlineApi';

function isContactPath() {
  return window.location.pathname === '/contact' || window.location.pathname === '/contact/';
}

function replaceBlockedContactPath() {
  if (!isContactPath()) return;
  const { search, hash } = window.location;
  window.history.replaceState(window.history.state, '', `/${search}${hash}`);
}

export function useContactRoute(isMenu: boolean, hotseatOnly: boolean) {
  const allowed = isMenu && !hotseatOnly && Boolean(getOnlineApiBase());
  const [requested, setRequested] = useState(() => allowed && isContactPath());

  useEffect(() => {
    if (!allowed) replaceBlockedContactPath();
    const onPopState = () => {
      if (!allowed) replaceBlockedContactPath();
      setRequested(allowed && isContactPath());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [allowed]);

  const navigate = (open: boolean) => {
    window.history.pushState(window.history.state, '', open ? '/contact' : '/');
    setRequested(open);
  };

  return {
    showContact: allowed && requested,
    openContact: allowed ? () => navigate(true) : undefined,
    closeContact: () => navigate(false),
  };
}
