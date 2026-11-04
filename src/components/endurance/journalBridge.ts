import type { EnduranceSession } from "../../game/endurance/session";
import type { JournalTextPage } from "../../game/endurance/journalJsonl";

export type { JournalTextPage };

export interface EnduranceTestBridge {
  readJournalText(after?: number, limit?: number): Promise<JournalTextPage>;
  readArchiveMetrics(): EnduranceSession["archiveMetrics"];
}
declare global {
  interface Window { __tankwarsEnduranceTest?: EnduranceTestBridge }
}

/** Browser/Playwright IPC only: no HTTP endpoint or third-party transport. */
export function installJournalBridge(session: EnduranceSession): () => void {
  if (import.meta.env.MODE !== "endurance") return () => {};
  const bridge: EnduranceTestBridge = {
    readJournalText: (after?: number, limit?: number) => session.readJournalText(after, limit),
    readArchiveMetrics: () => session.archiveMetrics,
  };
  window.__tankwarsEnduranceTest = bridge;
  return () => { if (window.__tankwarsEnduranceTest === bridge) delete window.__tankwarsEnduranceTest; };
}
