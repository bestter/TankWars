import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GameCanvas } from "../GameCanvas";
import { createLocalPlayers } from "../localPlayers";
import { defaultConfig } from "../../game/endurance/config";
import { EnduranceSession } from "../../game/endurance/session";
import { IndexedEnduranceStorage } from "../../game/endurance/storage";
import { markdownReport } from "../../game/endurance/report";
import type { EnduranceConfig, EnduranceExport, SessionRecord } from "../../game/endurance/types";
import type { AiProfile } from "../../types/player";
import { VGA_PALETTE } from "../../types/game";
import { installJournalBridge } from "./journalBridge";

const PROFILES: AiProfile[] = ["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"];
const COLORS = [VGA_PALETTE.BLUE, VGA_PALETTE.RED, VGA_PALETTE.ELECTRIC_CYAN, VGA_PALETTE.FLASH_GREEN];
const SLOTS = ["first", "second", "third", "fourth"];

class EnduranceBoundary extends Component<{ session: EnduranceSession; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.session.incident("exception", "REACT_ERROR", 0, error.stack); }
  render() { return this.state.failed ? null : this.props.children; }
}

function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SessionView({ session, onExit }: { session: EnduranceSession; onExit: () => void }) {
  const { t, i18n } = useTranslation();
  useSyncExternalStore(session.subscribe, session.snapshot);
  const [report, setReport] = useState<EnduranceExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const removeBridge = installJournalBridge(session);
    const tick = setInterval(() => session.tick(), 1000);
    const hidden = () => { if (document.hidden) void session.stop("environment-hidden"); };
    const pagehide = () => { void session.stop("environment-pagehide"); };
    const failed = (event: ErrorEvent) => session.incident("exception", "BROWSER_ERROR", 0, event.error instanceof Error ? event.error.stack : event.message);
    const rejected = (event: PromiseRejectionEvent) => session.incident("exception", "UNHANDLED_REJECTION", 0, String(event.reason));
    document.addEventListener("visibilitychange", hidden); window.addEventListener("pagehide", pagehide);
    window.addEventListener("error", failed); window.addEventListener("unhandledrejection", rejected);
    hidden();
    return () => {
      removeBridge();
      clearInterval(tick); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("error", failed); window.removeEventListener("unhandledrejection", rejected);
    };
  }, [session]);
  const exportResult = async (format: "json" | "md" | "view" | "jsonl") => {
    try {
      if (format === "jsonl") { download(`${session.session.id}.jsonl`, await session.journalJSONL(), "application/x-ndjson"); return; }
      const data = await session.export(); setReport(data);
      if (format === "json") download(`${data.session.id}.json`, JSON.stringify(data, null, 2), "application/json");
      if (format === "md") download(`${data.session.id}.md`, markdownReport(data, i18n.language.startsWith("fr")), "text/markdown");
    } catch (e) { setError(String(e)); }
  };
  const s = session.session;
  return <section className="endurance-screen">
    <h1>{t("endurance_title")}</h1>
    <p>{t("endurance_progress", { attempted: s.attempted, completed: s.completed, abandoned: s.abandoned, interrupted: s.interrupted, rounds: s.roundsCompleted })}</p>
    <p>{s.id} · {(s.durationMs / 60000).toFixed(1)} min · {session.phase} · {s.status} {s.reason}</p>
    <p role="status">{t("endurance_storage")}: {s.storageError ?? (session.busy ? t("endurance_saving") : t("endurance_saved"))}</p>
    {session.journalStatus && <p role="status">{t("endurance_journal_status", { ...session.journalStatus,
      state: t(session.journalStatus.complete ? "endurance_journal_complete" : session.journalStatus.error || !session.running ? "endurance_journal_incomplete" : "endurance_journal_active") })}</p>}
    {(error || s.storageError) && <p role="alert">{error ?? s.storageError}</p>}
    {session.latestIncident && <p role="alert">{session.latestIncident.kind}: {session.latestIncident.reason} · seed {session.latestIncident.seed}</p>}
    <div className="endurance-actions">
      <button type="button" disabled={!session.running} onClick={() => void session.stop()}>{t("endurance_stop")}</button>
      <button type="button" onClick={() => void exportResult("view")}>{t("endurance_report")}</button>
      <button type="button" onClick={() => void exportResult("json")}>JSON</button>
      <button type="button" onClick={() => void exportResult("md")}>Markdown</button>
      <button type="button" disabled={!session.journalStatus} onClick={() => void exportResult("jsonl")}>JSONL</button>
      <button type="button" disabled={session.running || session.busy} onClick={() => { session.close(); onExit(); }}>{t("btn_menu")}</button>
    </div>
    <p>{t("endurance_limits_help")}</p>
    {session.ready && session.block && <EnduranceBoundary key={session.block.id} session={session}>
      <GameCanvas endurance={session} initialPlayers={structuredClone(session.block.config.players)} gameMode="local" />
    </EnduranceBoundary>}
    {report && <pre className="endurance-report">{markdownReport(report, i18n.language.startsWith("fr"))}</pre>}
  </section>;
}

function Configuration({ onStart, onExit }: { onStart: (config: EnduranceConfig) => void; onExit: () => void }) {
  const { t, i18n } = useTranslation();
  const [profiles, setProfiles] = useState(PROFILES);
  const [count, setCount] = useState(4);
  const [rounds, setRounds] = useState(2);
  const [blocks, setBlocks] = useState(0);
  const [minutes, setMinutes] = useState(240);
  const [stopOnIncident, setStopOnIncident] = useState(false);
  const [limits, setLimits] = useState({ turns: 1000, roundMs: 1800000, actionMs: 120000, transitionMs: 30000 });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SessionRecord | null>(null);
  const [storage] = useState(() => new IndexedEnduranceStorage());
  useEffect(() => {
    let active = true;
    void storage.latest().then(value => { if (active) setSaved(value); }, e => { if (active) setError(String(e)); });
    return () => { active = false; storage.close(); };
  }, [storage]);
  const start = () => {
    try {
      const players = createLocalPlayers(profiles.slice(0, count).map((profile, index) => ({ name: `${profile}-${index + 1}`, isHuman: false, aiProfile: profile, color: COLORS[index] })));
      onStart({ ...defaultConfig(players), roundsPerBlock: rounds, maxBlocks: blocks === 0 ? null : blocks,
        maxDurationMs: minutes === 0 ? null : minutes * 60000, stopOnIncident, limits });
    } catch (e) { setError(`${t("endurance_invalid")}: ${String(e)}`); }
  };
  const recovered = async (format: "json" | "md" | "jsonl") => {
    if (!saved) return;
    try {
      if (format === "jsonl") {
        const status = await storage.journalStatus(saved.id);
        if (!status) throw new Error(t("endurance_journal_unavailable"));
        const chunks = [JSON.stringify({ schemaVersion: 1, kind: "journal-status", status: { ...status, complete: saved.status === "stopped" && status.complete } }) + "\n"];
        let after = 0;
        while (after < status.persisted) {
          // The next bounded page starts at the sequence validated in the preceding page.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const entries = await storage.readJournal(saved.id, after, 256);
          if (!entries.length) throw new Error("JOURNAL_SEQUENCE_GAP");
          for (const entry of entries) { if (entry.sequence !== ++after) throw new Error("JOURNAL_SEQUENCE_GAP"); chunks.push(JSON.stringify(entry) + "\n"); }
        }
        download(`${saved.id}.jsonl`, chunks.join(""), "application/x-ndjson"); return;
      }
      const record = structuredClone(saved);
      if (record.status === "running") { record.collection = "incomplete"; record.reason = "crash-checkpoint"; }
      const data = await storage.exportSession(record);
      download(`${record.id}.${format}`, format === "json" ? JSON.stringify(data, null, 2) : markdownReport(data, i18n.language.startsWith("fr")), format === "json" ? "application/json" : "text/markdown");
    } catch (e) { setError(String(e)); }
  };
  return <section className="endurance-screen">
    <h1>{t("endurance_title")}</h1><p>{t("endurance_limits_help")}</p>
    <form onSubmit={e => { e.preventDefault(); start(); }} className="endurance-config">
      <label>{t("num_players")}<select value={count} onChange={e => setCount(Number(e.target.value))}>{[2, 3, 4].map(n => <option key={n}>{n}</option>)}</select></label>
      {SLOTS.slice(0, count).map((slot, index) => <label key={slot}>{t("endurance_profile", { number: index + 1 })}<select value={profiles[index]} onChange={e => setProfiles(profiles.map((p, i) => i === index ? e.target.value as AiProfile : p))}>{PROFILES.map(p => <option key={p}>{p}</option>)}</select></label>)}
      <label>{t("endurance_rounds")}<input type="number" min="1" required value={rounds} onChange={e => setRounds(e.target.valueAsNumber)} /></label>
      <label>{t("endurance_blocks")}<input type="number" min="0" required value={blocks} onChange={e => setBlocks(e.target.valueAsNumber)} /></label>
      <label>{t("endurance_minutes")}<input type="number" min="0" required value={minutes} onChange={e => setMinutes(e.target.valueAsNumber)} /></label>
      {(Object.keys(limits) as Array<keyof typeof limits>).map(key => <label key={key}>{t(`endurance_limit_${key}`)}<input type="number" min="1" required value={limits[key]} onChange={e => setLimits({ ...limits, [key]: e.target.valueAsNumber })} /></label>)}
      <label><input type="checkbox" checked={stopOnIncident} onChange={e => setStopOnIncident(e.target.checked)} />{t("endurance_stop_incident")}</label>
      <button type="submit">{t("endurance_start")}</button><button type="button" onClick={onExit}>{t("btn_menu")}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {saved && <p>{t("endurance_recover")} ({saved.id}) <button type="button" onClick={() => void recovered("json")}>JSON</button> <button type="button" onClick={() => void recovered("md")}>Markdown</button> <button type="button" onClick={() => void recovered("jsonl")}>JSONL</button></p>}
  </section>;
}

export function EnduranceScreen({ onExit }: { onExit: () => void }) {
  const [session, setSession] = useState<EnduranceSession | null>(null);
  const start = (config: EnduranceConfig) => {
    const run = new EnduranceSession(config, new IndexedEnduranceStorage());
    setSession(run); void run.start();
  };
  return session ? <SessionView session={session} onExit={onExit} /> : <Configuration onStart={start} onExit={onExit} />;
}
