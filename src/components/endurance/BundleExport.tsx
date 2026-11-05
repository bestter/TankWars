import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrowserDisk } from "../../game/endurance/bundle/browserDisk";
import { buildBundle, type BundleSource } from "../../game/endurance/bundle/build";
import { exportOptions, type BundleManifest, type ExportOptions } from "../../game/endurance/bundle/format";
import { writeZip } from "../../game/endurance/bundle/zip";
import { randomUUID } from "../../utils/randomUUID";

interface BundleBridge {
  summary(): Promise<{ schemaVersion: 2; session: BundleSource["session"]; capturedAtSequence: number }>;
  prepare(options?: Partial<ExportOptions>, lease?: boolean): Promise<BundleManifest>;
  filePage(cursor?: { path: string; offset: number }): Promise<Array<{ path: string; offset: number; base64: string; bytes: number; eof: boolean }>>;
  unlock(): void;
  files(after?: string): Promise<string[]>;
  chunk(path: string, offset: number): Promise<{ base64: string; bytes: number }>;
  release(): Promise<void>;
  download(options?: Partial<ExportOptions>): Promise<void>;
}
declare global { interface Window { __tankwarsEnduranceBundle?: BundleBridge } }

export function BundleExport({ source, revision = 0 }: { source: () => Promise<BundleSource>; revision?: number }) {
  const french = useTranslation().i18n.language.startsWith("fr");
  const [partSizeMiB, setPartSize] = useState(20), [slowDecisionMs, setSlow] = useState(1000);
  const [progress, setProgress] = useState(""), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const currentSource = useRef(source);
  useEffect(() => { currentSource.current = source; }, [source]);
  const currentOptions = useRef({ partSizeMiB, slowDecisionMs });
  useEffect(() => { currentOptions.current = { partSizeMiB, slowDecisionMs }; }, [partSizeMiB, slowDecisionMs]);
  const bridgeRef = useRef<BundleBridge | null>(null);
  useEffect(() => {
    let disk: BrowserDisk | null = null;
    let effective: string | undefined;
    let pending: Promise<BundleManifest> | null = null;
    let refresh = false;
    let leased = false;
    let deferred = false;
    let downloading: Promise<void> | null = null;
    const lifetime = new AbortController();
    const bridge: BundleBridge = {
      async summary() { const value = await currentSource.current(); return { schemaVersion: 2, session: value.session, capturedAtSequence: value.status.persisted }; },
      async prepare(options, lease = false) {
        if (leased && !lease) {
          deferred = true;
          if (disk) return await disk.get("export-state", "manifest") as BundleManifest;
          if (pending) return await pending;
        }
        if (leased && lease) throw new Error("EXPORT_BUSY");
        if (lease) leased = true;
        try {
          const selectedOptions = exportOptions(options ?? (effective ? JSON.parse(effective) as ExportOptions : {}));
          const selected = JSON.stringify(selectedOptions);
          if (pending) {
            if (selected === effective) { refresh = true; return await pending; }
            await pending;
          }
          if (disk && selected !== effective) { await disk.dispose(); disk = null; }
          disk ??= await BrowserDisk.create(`endurance-export-${randomUUID()}`); effective = selected;
          const target = disk;
          pending = (async () => {
            let result: BundleManifest;
            do { refresh = false; result = await buildBundle(await currentSource.current(), target, selectedOptions, lifetime.signal); } while (refresh);
            return result;
          })();
          try { return await pending; }
          catch (error) { disk = null; await target.dispose(); throw error; }
          finally { pending = null; }
        } catch (error) {
          if (lease) leased = false;
          throw error;
        }
      },
      unlock() { leased = false; if (deferred) { deferred = false; void bridge.prepare().catch(e => console.warn("[Endurance] Deferred report failed", e)); } },
      async filePage(cursor = { path: "", offset: 0 }) {
        if (!disk || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error("INVALID_EXPORT_CURSOR");
        const result: Array<{ path: string; offset: number; base64: string; bytes: number; eof: boolean }> = [];
        let budget = 1048576;
        const manifest = await disk.get("export-state", "manifest") as BundleManifest;
        const activePrefix = manifest.index.slice(0, -"index/root.json".length);
        for await (const row of disk.scan("files")) {
          if (row.key < cursor.path || row.key === "bundle.zip" || (row.key.startsWith("derived/") && !row.key.startsWith(activePrefix))) continue;
          const offset = row.key === cursor.path ? cursor.offset : 0, size = await disk.size(row.key);
          if (offset >= size && row.key === cursor.path) continue;
          let binary = "";
          for await (const bytes of disk.read(row.key, offset, budget)) for (const b of bytes) binary += String.fromCharCode(b);
          result.push({ path: row.key, offset, base64: btoa(binary), bytes: binary.length, eof: offset + binary.length === size });
          budget -= binary.length;
          if (budget === 0 || result.length === 128) break;
        }
        return result;
      },
      async files(after = "") {
        if (!disk) throw new Error("EXPORT_NOT_PREPARED");
        const paths: string[] = [];
        for await (const row of disk.scan("files")) if (row.key > after && row.key !== "bundle.zip") { paths.push(row.key); if (paths.length === 128) break; }
        return paths;
      },
      async chunk(path, offset) {
        if (!disk || !Number.isSafeInteger(offset) || offset < 0) throw new Error("INVALID_EXPORT_CHUNK");
        let binary = "";
        for await (const bytes of disk.read(path, offset, 65536)) for (const b of bytes) binary += String.fromCharCode(b);
        return { base64: btoa(binary), bytes: binary.length };
      },
      async release() { lifetime.abort(); if (pending) await pending.catch(() => {}); if (disk) { const closing = disk; disk = null; await closing.dispose(); } },
      async download(options) {
        if (downloading) return downloading;
        downloading = (async () => {
          const manifest = await bridge.prepare(options ?? currentOptions.current, true);
          if (manifest.reportError) setError(manifest.reportError);
          try {
            if (!disk) throw new Error("EXPORT_NOT_PREPARED");
            await writeZip(disk, lifetime.signal);
            await disk.download("bundle.zip", `${manifest.session.id}-endurance.zip`);
          } finally {
            try {
              if (disk) await disk.remove("bundle.zip");
            } catch (cleanup) {
              console.warn("[Endurance] Temporary ZIP cleanup failed", cleanup);
            }
            bridge.unlock();
          }
        })();
        try { await downloading; } finally { downloading = null; }
      },
    };
    window.__tankwarsEnduranceBundle = bridge;
    bridgeRef.current = bridge;
    return () => {
      controller.current?.abort();
      if (window.__tankwarsEnduranceBundle === bridge) delete window.__tankwarsEnduranceBundle;
      void bridge.release().catch(e => console.error("[Endurance] Export cleanup failed", e));
    };
  }, []);
  useEffect(() => {
    if (!revision) return;
    let active = true;
    // One pending refresh; a new revision requests the latest confirmed boundary.
    void bridgeRef.current?.prepare().then(result => { if (active && result.reportError) setError(result.reportError); })
      .catch(e => { if (active) { setError(`rapport incomplet / report incomplete: ${String(e)}`); console.warn("[Endurance] Report refresh failed", e); } });
    return () => { active = false; };
  }, [revision]);
  const download = async () => {
    setError(null); let disk: BrowserDisk | undefined;
    try {
      const options = exportOptions({ partSizeMiB, slowDecisionMs });
      setBusy(true); controller.current = new AbortController();
      disk = await BrowserDisk.create(`endurance-export-${randomUUID()}`);
      const manifest = await buildBundle(await currentSource.current(), disk, options, controller.current.signal,
        value => setProgress(`${value.stage}: ${value.sequence}/${value.upper}`));
      controller.current.signal.throwIfAborted(); setProgress("ZIP");
      await writeZip(disk, controller.current.signal);
      await disk.download("bundle.zip", `${manifest.session.id}-endurance.zip`);
      setProgress(manifest.reportError ?? (french ? "Export terminé" : "Export complete"));
    } catch (e) { setError(String(e)); console.error("[Endurance] Bundle export failed", e); }
    finally {
      try { await disk?.dispose(); } catch (e) { setError(String(e)); console.error("[Endurance] Export cleanup failed", e); }
      setBusy(false); controller.current = null;
    }
  };
  return <div className="endurance-export">
    <label>{french ? "Taille des parties (Mio)" : "Part size (MiB)"}<input type="number" min="1" step="1" disabled={busy} value={partSizeMiB} onChange={e => setPartSize(e.target.valueAsNumber)} /></label>
    <label>{french ? "Décision lente (ms)" : "Slow decision (ms)"}<input type="number" min="1" step="1" disabled={busy} value={slowDecisionMs} onChange={e => setSlow(e.target.valueAsNumber)} /></label>
    <button type="button" disabled={busy} onClick={() => void download()}>{french ? "Exporter le rapport ZIP" : "Export ZIP report"}</button>
    {busy && <button type="button" onClick={() => controller.current?.abort()}>{french ? "Annuler l’export" : "Cancel export"}</button>}
    <p role="status">{progress}</p>{error && <p role="alert">{error}</p>}
  </div>;
}
