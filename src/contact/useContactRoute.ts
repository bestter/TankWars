import { useEffect, useState, useSyncExternalStore } from 'react';
import { getOnlineApiBase } from '../utils/onlineApi';

const CONTACT_PATH_CHANGED = 'tankwars-contact-path-changed';

function isContactPath() {
  return window.location.pathname === '/contact' || window.location.pathname === '/contact/';
}

function subscribeToContactPath(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(CONTACT_PATH_CHANGED, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(CONTACT_PATH_CHANGED, onChange);
  };
}

function writeContactPath(path: '/' | '/contact', mode: 'pushState' | 'replaceState') {
  const { search, hash } = window.location;
  try {
    window.history[mode](window.history.state, '', `${path}${search}${hash}`);
  } catch {
    console.error('[TankWars] Contact history update failed', mode);
    return false;
  }
  window.dispatchEvent(new Event(CONTACT_PATH_CHANGED));
  return true;
}

export function useContactRoute(isMenu: boolean, hotseatOnly: boolean) {
  const allowed = isMenu && !hotseatOnly && Boolean(getOnlineApiBase());
  const requested = useSyncExternalStore(subscribeToContactPath, isContactPath);
  const [navigationFailed, setNavigationFailed] = useState(false);

  if (!allowed && navigationFailed) {
    setNavigationFailed(false);
  }

  useEffect(() => {
    if (!allowed && requested) writeContactPath('/', 'replaceState');
  }, [allowed, requested]);

  useEffect(() => {
    const clearNavigationError = () => setNavigationFailed(false);
    window.addEventListener('popstate', clearNavigationError);
    return () => window.removeEventListener('popstate', clearNavigationError);
  }, []);

  const navigate = (open: boolean) => {
    setNavigationFailed(!writeContactPath(open ? '/contact' : '/', 'pushState'));
  };

  return {
    showContact: allowed && requested,
    navigationFailed,
    openContact: allowed ? () => navigate(true) : undefined,
    closeContact: () => navigate(false),
  };
}
