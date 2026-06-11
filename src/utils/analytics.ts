interface Zaraz {
  track: (name: string, properties?: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    zaraz?: Zaraz;
  }
}

/**
 * Envoie un événement personnalisé à Cloudflare Zaraz (si disponible).
 * Si Zaraz n'est pas disponible (ex: en local), l'événement est simulé dans la console.
 */
export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  if (window.zaraz && typeof window.zaraz.track === 'function') {
    try {
      window.zaraz.track(name, properties);
      console.log(`[Analytics] Tracked event: "${name}"`, properties);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Analytics] Failed to track event "${name}" via Zaraz:`, errorMessage);
    }
  } else {
    // Fallback log en local ou si Zaraz n'est pas actif
    console.log(`[Analytics] [Simulated] Tracked event: "${name}"`, properties);
  }
}
