import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArchiveFilter } from "../../game/diagnostics/export";
import type { ShotArchive, ShotListPage } from "../../game/diagnostics/types";

export interface DiagnosticSource { read(filter?: ArchiveFilter): Promise<ShotArchive | null>; list?(query: string, page: number): Promise<ShotListPage>; capture(): void; mark?(): void }
function download(archive: ShotArchive): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `${archive.sessionId}-shots-${archive.lastSequence}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function DiagnosticPanel({ source }: { source: DiagnosticSource }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Array<{ key: string; label: string; status: string }>>([]);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const read = async (nextPage = page) => {
    setBusy(true); setError(null);
    try {
      if (source.list) {
        const result = await source.list(query, nextPage);
        setRows(result.rows); setPage(nextPage);
        setSummary(`${result.firstSequence}–${result.lastSequence} · ${t("diagnostics_evicted")}: ${result.evicted} · ${result.total}`);
        return;
      }
      const archive = await source.read(); if (!archive) return;
      const terminal = new Map<string, string>();
      for (const r of archive.records) if (r.shotKey && ["settled", "interrupted"].includes(r.input.kind)) terminal.set(r.shotKey, r.input.kind);
      const shots = archive.records.flatMap(r => {
        const input = r.input;
        if (input.kind !== "pre-shot" || !r.shotKey) return [];
        const player = input.snapshot.state.players.find(p => p.id === input.shot.playerId);
        return [{ key: r.shotKey, label: `${player?.name ?? input.shot.playerId} · ${r.blockId ?? "DEV"}/${r.round}/${r.turn} · #${r.sequence} · ${r.shotKey}`, status: terminal.get(r.shotKey) ?? "in-progress" }];
      }).filter(row => `${row.label} ${row.status}`.toLowerCase().includes(query.toLowerCase()));
      setRows(shots.slice(nextPage * 20, (nextPage + 1) * 20)); setPage(nextPage);
      setSummary(`${archive.firstSequence}–${archive.lastSequence} · ${t("diagnostics_evicted")}: ${archive.evicted} · ${shots.length} · ${archive.error ?? ""}`);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const save = async (filter?: ArchiveFilter) => {
    setBusy(true); setError(null);
    try { const archive = await source.read(filter); if (archive) download(archive); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <details className="diagnostic-panel">
    <summary>{t("diagnostics_title")}</summary><p>{summary}</p>
    <label>{t("diagnostics_filter")} <input value={query} onChange={e => setQuery(e.target.value)} /></label>
    <button type="button" disabled={busy} onClick={() => void read(0)}>{t("diagnostics_refresh")}</button>
    <button type="button" disabled={busy} onClick={() => { source.capture(); void read(0); }}>{t("diagnostics_capture")}</button>
    {source.mark && <button type="button" disabled={busy} onClick={() => { source.mark?.(); void read(0); }}>{t("diagnostics_mark")}</button>}
    <button type="button" disabled={busy} onClick={() => void save()}>{t("diagnostics_export")}</button>
    <button type="button" disabled={busy} onClick={() => void save({ incidents: true })}>{t("diagnostics_incidents")}</button>
    <div><label>{t("diagnostics_from")} <input type="number" min="1" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>{t("diagnostics_to")} <input type="number" min="1" value={to} onChange={e => setTo(e.target.value)} /></label>
      <button type="button" disabled={busy || (!from && !to)} onClick={() => void save({ from: from ? Number(from) : undefined, to: to ? Number(to) : undefined })}>{t("diagnostics_range")}</button></div>
    <ul>{rows.map(row => <li key={row.key}>{row.label} · {row.status} <button type="button" disabled={busy} onClick={() => void save({ shotKey: row.key })}>{t("diagnostics_export_shot")}</button></li>)}</ul>
    <button type="button" aria-label={t("diagnostics_previous")} disabled={busy || page === 0} onClick={() => void read(page - 1)}>←</button>
    <span> {page + 1} </span><button type="button" aria-label={t("diagnostics_next")} disabled={busy || rows.length < 20} onClick={() => void read(page + 1)}>→</button>
    {error && <p role="alert">{error}</p>}
  </details>;
}
