import type { EnduranceSession } from "../../game/endurance/session";

export interface EnduranceTestBridge {
  readJournalPage(after?: number, limit?: number): ReturnType<EnduranceSession["journalPage"]>;
}
declare global {
  interface Window { __tankwarsEnduranceTest?: EnduranceTestBridge }
}

/** Browser/Playwright IPC only: no HTTP endpoint or third-party transport. */
export function installJournalBridge(session: EnduranceSession): () => void {
  if (import.meta.env.MODE !== "endurance") return () => {};
  const bridge: EnduranceTestBridge = { readJournalPage: (after = 0, limit = 256) => session.journalPage(after, limit) };
  window.__tankwarsEnduranceTest = bridge;
  return () => { if (window.__tankwarsEnduranceTest === bridge) delete window.__tankwarsEnduranceTest; };
}
