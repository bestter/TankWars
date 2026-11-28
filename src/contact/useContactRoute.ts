import { useEffect, useState, useSyncExternalStore } from 'react';
import { getOnlineApiBase } from '../utils/onlineApi';

const CONTACT_PATH_CHANGED = 'tankwars-contact-path-changed';

function contactPath() {
  return `${import.meta.env.BASE_URL}contact`;
}

function isContactPath() {
  const path = contactPath();
  return window.location.pathname === path || window.location.pathname === `${path}/`;
}

function subscribeToContactPath(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(CONTACT_PATH_CHANGED, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(CONTACT_PATH_CHANGED, onChange);
  };
}

function writeContactPath(path: string, mode: 'pushState' | 'replaceState') {
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
  const contactAvailable = !hotseatOnly && Boolean(getOnlineApiBase());
  const allowed = isMenu && contactAvailable;
  const requested = useSyncExternalStore(subscribeToContactPath, isContactPath);
  const [navigationFailed, setNavigationFailed] = useState(false);

  if (!allowed && navigationFailed) {
    setNavigationFailed(false);
  }

  useEffect(() => {
    if (!allowed && requested) writeContactPath(import.meta.env.BASE_URL, 'replaceState');
  }, [allowed, requested]);

  useEffect(() => {
    const clearNavigationError = () => setNavigationFailed(false);
    window.addEventListener('popstate', clearNavigationError);
    return () => window.removeEventListener('popstate', clearNavigationError);
  }, []);

  const navigate = (open: boolean) => {
    if (isContactPath() === open) {
      setNavigationFailed(false);
      return;
    }
    setNavigationFailed(!writeContactPath(open ? contactPath() : import.meta.env.BASE_URL, 'pushState'));
  };

  return {
    contactAvailable,
    showContact: allowed && requested,
    navigationFailed,
    openContact: allowed ? () => navigate(true) : undefined,
    closeContact: () => navigate(false),
  };
}
