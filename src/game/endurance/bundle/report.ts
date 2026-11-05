import type { ArchiveRecord } from "../../diagnostics/types";
import type { JournalEntry } from "../journal";
import type { Player } from "../../../types/player";
import { object } from "../../diagnostics/validate";
import { encoder, identity, jsonBytes, one, sha256, type BundleDisk } from "./io";
import type { BundleManifest, Location } from "./format";

interface Row {
  sequence: number; blockId: string | null; round: number; turn: number; kind: string;
  location: Location; capture?: Location; archiveSequence?: number; shotKey?: string | null;
  decisionId: string | null; recorderDecisionId?: string | null; shotHash?: string;
  playerId?: string; name?: string; profile?: string; role: string;
  weapon?: string; durationMs?: number; detail: unknown; reasons: string[];
}
const pad = (n: number) => String(n).padStart(16, "0");
const escape = (value: unknown): string => String(value ?? "inconnu / unknown").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function page(title: string, body: string): Uint8Array {
  return encoder.encode(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:15px monospace;max-width:1100px;margin:2rem auto;padding:1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #888;padding:.5rem;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#1462a8}</style><h1>${escape(title)}</h1>${body}<footer>Signé / Signed : Codex — GPT-6</footer></html>`);
}
async function view(disk: BundleDisk, label: string, row: Row): Promise<void> {
  const id = await identity(label);
  await disk.put("views", id, { id, label });
  await disk.put(`view-${id}`, `${pad(row.sequence)}/${row.role}/${row.playerId ?? "session"}`, row);
}
export async function indexCollection(disk: BundleDisk, kind: "blocks" | "rounds" | "incidents", record: unknown,
  location: Location, capturedAtSequence: number | null): Promise<void> {
  if (!object(record)) throw new Error("INVALID_COLLECTION_RECORD");
  const label = kind === "blocks" ? `Bloc / Block ${String(record.id)}` : kind === "rounds" ? `Manche / Round ${String(record.blockId)}/${String(record.number)}` : "Examen / Review incident";
  const id = await identity(label);
  await disk.put("views", id, { id, label });
  // A block/round has one current immutable snapshot per export boundary. Incident
  // history remains in the paginated event view rather than an accumulating root.
  if (kind !== "incidents") await disk.put("view-metadata", id, { record, location, capturedAtSequence });
}
export async function indexEntry(disk: BundleDisk, entry: JournalEntry, location: Location,
  capture: { record: ArchiveRecord; location: Location } | undefined, slowMs: number): Promise<void> {
  if (entry.context) await Promise.all(entry.context.players.map(player => disk.put("players", `${entry.blockId}/${entry.round}/${player.id}`, player)));
  const event = entry.event, combat = event.kind === "combat" ? event.event : undefined;
  if (event.kind === "archive") {
    if (!capture) throw new Error("MISSING_CAPTURE_LOCATION");
    const record = capture.record;
    const context = `${record.blockId}/${record.round}/${record.turn}`;
    await disk.put("turn-captures", `${await identity(context)}/${pad(record.sequence)}`, { location: capture.location, sequence: record.sequence, journalSequence: entry.sequence,
      terrainId: "snapshot" in record.input ? record.input.snapshot.terrainId : null });
    if (record.shotKey) await disk.put("shot-contexts", record.shotKey, context);
    // Captured combat duplicates the direct journal observation; never count it twice.
    return;
  }
  const roles: Array<{ playerId?: string; role: string }> = [];
  if (combat && "playerId" in combat) roles.push({ playerId: combat.playerId, role: ["displacement", "death"].includes(combat.kind) ? "victime / victim" : "tireur / shooter" });
  if (combat?.kind === "ai-detail" && combat.observation.playerId) roles.push({ playerId: combat.observation.playerId, role: "tireur / shooter" });
  if (combat?.kind === "damage") roles.push({ playerId: combat.event.victimId, role: "victime / victim" });
  if (combat?.kind === "destruction") roles.push({ playerId: combat.event.victimId, role: "victime / victim" });
  if (combat?.kind === "ai-detail" && combat.observation.target) roles.push({ playerId: combat.observation.target.playerId, role: "cible / target" });
  if (combat?.kind === "credit") roles.push({ playerId: combat.credit.playerId, role: "bénéficiaire / beneficiary" });
  if (event.kind === "purchase") roles.push({ playerId: event.purchase.playerId, role: "acheteur / buyer" });
  if (event.kind === "shop-start" || event.kind === "shop-end") roles.push({ playerId: event.player.id, role: "acheteur / buyer" });
  if (roles.length === 0) roles.push({ role: "session" });
  let shotKey: string | undefined;
  const context = `${entry.blockId}/${entry.round}/${entry.turn}`;
  if (combat?.kind === "shot-launched") {
    shotKey = `${entry.blockId ?? entry.sessionId}:${entry.round}:${combat.shotId}`;
    await disk.put("launched", shotKey, { location, sequence: entry.sequence, context });
    await disk.put("active-shot", context, { shotKey, playerId: combat.playerId });
  }
  if (combat && "shotId" in combat) shotKey = `${entry.blockId ?? entry.sessionId}:${entry.round}:${combat.shotId}`;
  if (combat?.kind === "damage" || combat?.kind === "destruction") {
    shotKey = `${entry.blockId ?? entry.sessionId}:${entry.round}:${combat.event.shotId}`;
    if (combat.event.shooterId !== combat.event.victimId && (combat.kind === "destruction" || combat.event.healthDamageMilli + combat.event.shieldLostMilli > 0)) await disk.put("adverse-effect", shotKey, true);
  }
  const active = await disk.get("active-shot", context) as { shotKey: string; playerId: string } | undefined;
  if (combat?.kind === "displacement" && active && combat.playerId !== active.playerId && combat.distance > 0) await disk.put("adverse-effect", active.shotKey, true);
  const reasons: string[] = [];
  if (combat?.kind === "ai-detail" && combat.observation.steps.some(s => ["reaction", "gaffe", "direction-error", "power-error"].includes(s.kind))) reasons.push("commande perturbée / perturbed command");
  if (combat?.kind === "decision" && combat.durationMs >= slowMs) reasons.push("décision lente / slow decision");
  if (combat?.kind === "damage" && combat.event.shooterId === combat.event.victimId && combat.event.healthDamageMilli + combat.event.shieldLostMilli > 0) reasons.push("autodégâts / self damage");
  if (combat?.kind === "resolved" && shotKey && await disk.get("launched", shotKey) && !await disk.get("adverse-effect", shotKey)) reasons.push("aucun effet adverse observé / no observed opponent effect");
  if (combat?.kind === "ai-detail" && object(combat.observation.diagnostics)) {
    const diagnostics = combat.observation.diagnostics;
    if (combat.observation.profile === "v3-sniper" && diagnostics.certified === false) reasons.push("repli non certifié / uncertified fallback");
    if (combat.observation.profile === "v4-smart" && object(diagnostics.fallbackChoice) && object(diagnostics.fallbackChoice.forecast) && diagnostics.fallbackChoice.forecast.complete === false) reasons.push("prévision incomplète / incomplete forecast");
  }
  if (combat?.kind === "failure" || combat?.kind === "recovery" || event.kind === "incident") reasons.push("incident");
  const summary = await disk.get("turn-summary", context) as Record<string, unknown> | undefined ?? {};
  if (combat?.kind === "decision") summary.decision = { durationMs: combat.durationMs, command: combat.command, sequence: entry.sequence };
  if (combat?.kind === "ai-detail") summary.aim = { target: combat.observation.target, reason: combat.observation.reason,
    evaluated: combat.observation.evaluated, steps: combat.observation.steps, final: combat.observation.final,
    diagnostics: "Source complète / Complete source", sequence: entry.sequence };
  if (combat?.kind === "shot-launched") summary.launch = combat;
  if (combat?.kind === "shot-result") summary.result = combat;
  if (combat?.kind === "resolved") summary.resolved = true;
  if (combat?.kind === "ammo-consumed") summary.stock = combat;
  if (combat?.kind === "credit") {
    const credits = object(summary.credits) ? summary.credits : {};
    credits[combat.credit.playerId] = combat.credit; summary.credits = credits;
  }
  summary.replay = "non rejoué / not replayed";
  await disk.put("turn-summary", context, summary);
  for (const role of roles) {
    // Role iterations update shared per-player totals; one identity can have multiple roles.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const player = role.playerId ? await disk.get("players", `${entry.blockId}/${entry.round}/${role.playerId}`) as Player | undefined : undefined;
    const row: Row = { sequence: entry.sequence, blockId: entry.blockId, round: entry.round, turn: entry.turn,
      kind: combat?.kind ?? event.kind, location, decisionId: entry.decisionId, ...role, name: player?.name,
      profile: player?.aiProfile ?? (player?.isHuman ? "human" : "unknown"), shotKey, shotHash: shotKey ? await identity(shotKey) : undefined,
      durationMs: combat?.kind === "decision" ? combat.durationMs : undefined,
      weapon: combat && "command" in combat ? combat.command.weaponId : event.kind === "purchase" ? event.purchase.weaponId : undefined,
      detail: combat?.kind === "ai-detail" ? { target: combat.observation.target, evaluated: combat.observation.evaluated,
        final: combat.observation.final, reason: combat.observation.reason, steps: combat.observation.steps,
        diagnostics: "Consulter la source / See source", replay: "non rejoué / not replayed" } : combat ?? event,
      reasons };
    await view(disk, "Tous les événements / All events", row);
    await view(disk, `Bloc / Block ${entry.blockId ?? "session"}`, row);
    await view(disk, `Manche / Round ${entry.blockId}/${entry.round}`, row);
    if (role.playerId) await view(disk, `Joueur / Player ${role.playerId}`, row);
    await view(disk, `Profil / Profile ${row.profile}`, row);
    if (row.weapon) await view(disk, `Arme / Weapon ${row.weapon}`, row);
    await Promise.all(reasons.map(reason => view(disk, `Examen / Review ${reason}`, row)));
    if (role.playerId) {
      const totals = await disk.get("player-totals", role.playerId) as Record<string, number> | undefined ?? { decisions: 0, shots: 0, healthLostMilli: 0, shieldLostMilli: 0, gains: 0, purchases: 0 };
      if (combat?.kind === "decision" && role.role === "tireur / shooter") totals.decisions++;
      if (combat?.kind === "shot-launched" && role.role === "tireur / shooter") totals.shots++;
      if (combat?.kind === "damage" && role.role === "victime / victim") { totals.healthLostMilli += combat.event.healthDamageMilli; totals.shieldLostMilli += combat.event.shieldLostMilli; }
      if (combat?.kind === "credit" && role.role === "bénéficiaire / beneficiary") totals.gains += combat.credit.amount;
      if (event.kind === "purchase" && role.role === "acheteur / buyer") totals.purchases++;
      await disk.put("player-totals", role.playerId, totals);
    }
    if (combat?.kind === "decision-start" && role.role === "tireur / shooter") {
      const profile = await identity(row.profile!);
      await disk.put("profiles", profile, row.profile);
      await disk.put("decision-count", profile, Number(await disk.get("decision-count", profile) ?? 0) + 1);
    }
    if (row.durationMs !== undefined && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.role === "tireur / shooter") {
      const profile = await identity(row.profile!);
      await disk.put("profiles", profile, row.profile);
      const count = Number(await disk.get("duration-count", profile) ?? 0);
      await disk.put("duration-count", profile, count + 1);
      // IEEE754 positive doubles sort lexically by their big-endian bit representation.
      const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, row.durationMs);
      const sort = Array.from(bytes, b => (255 - b).toString(16).padStart(2, "0")).join("");
      await disk.put(`durations-${profile}`, `${sort}/${pad(row.sequence)}`, row);
      const label = `Durées décroissantes / Descending durations ${row.profile}`, id = await identity(label);
      await disk.put("views", id, { id, label }); await disk.put(`view-${id}`, `${sort}/${pad(row.sequence)}`, row);
    }
  }
}

export async function renderReport(disk: BundleDisk, manifest: BundleManifest, signal?: AbortSignal, prefix = ""): Promise<void> {
  const output = { async write(path: string, data: AsyncIterable<Uint8Array>): Promise<void> {
    async function* adjusted() {
      for await (const bytes of data) yield prefix && path.endsWith(".html") ? encoder.encode(new TextDecoder().decode(bytes).replace(/href="\.\.\/(journal|captures|terrains|session|unconfirmed)\//g, 'href="../../../$1/')) : bytes;
    }
    await disk.write(prefix + path, adjusted());
  } };
  const maxBytes = manifest.options.partSizeMiB * 1048576;
  let menu: string[] = [], menuRefs: unknown[] = [], menuBytes = 0, menuPage = 1;
  const flushMenu = async (next: boolean) => {
    const name = menuPage === 1 ? "index.html" : `report/menu-${menuPage}.html`;
    const root = menuPage === 1 ? "" : "../";
    const heading = `<p>${escape(manifest.session.id)} · ${escape(manifest.session.build)} · ${escape(manifest.session.gameVersion)}</p><p>Borne / Boundary: ${manifest.journal.persisted}. ${escape(manifest.createdAt)}. ${escape(manifest.session.status)} · ${escape(manifest.session.reason)}. ${manifest.complete ? "Complet jusqu’à la borne / Complete to boundary" : "Partiel / Partial"}.</p><p>Blocs / Blocks: ${manifest.session.attempted}; complétés / completed: ${manifest.session.completed}; abandonnés / abandoned: ${manifest.session.abandoned}; interrompus / interrupted: ${manifest.session.interrupted}. Manches terminées / Completed rounds: ${manifest.session.roundsCompleted}.</p><details><summary>Configuration</summary><pre>${escape(JSON.stringify(manifest.session.config, null, 2))}</pre></details><p>Seuil lent / Slow threshold: ${manifest.options.slowDecisionMs} ms. Filtres globaux via vues paginées / Global filters use paginated views.</p>`;
    await output.write(name, one(page("Endurance", heading + `<a href="${root}report/statistics.html">Statistiques / Statistics</a><ul>${menu.map(link => link.replaceAll('href="report/', `href="${root}report/`)).join("")}</ul>` +
      (next ? `<a href="${root}report/menu-${menuPage + 1}.html">Suite / Next</a>` : ""))));
    await output.write(`index/views/menu-${menuPage}.json`, one(jsonBytes({ views: menuRefs, next: next ? `index/views/menu-${menuPage + 1}.json` : null })));
    menuPage++; menu = []; menuRefs = []; menuBytes = 0;
  };
  for await (const entry of disk.scan("views")) {
    signal?.throwIfAborted();
    const info = entry.value as { id: string; label: string };
    const [metadataValue, totals] = await Promise.all([disk.get("view-metadata", info.id),
      info.label.startsWith("Joueur / Player ") ? disk.get("player-totals", info.label.slice("Joueur / Player ".length)) : Promise.resolve(null)]);
    const metadata = metadataValue as { record: unknown; location: Location; capturedAtSequence: number | null } | undefined;
    const link = `<li><a href="report/${info.id}-1.html">${escape(info.label)}</a></li>`;
    if (menu.length && (menu.length >= 200 || menuBytes + link.length * 6 + 4096 > maxBytes)) await flushMenu(true);
    menu.push(link); menuBytes += encoder.encode(link).length;
    menuRefs.push({ label: info.label, path: `index/views/${info.id}-1.json` });
    let rows: Row[] = [], bytes = 0, number = 1;
    const flush = async (next: boolean) => {
      const htmlPath = `report/${info.id}-${number}.html`, indexPath = `index/views/${info.id}-${number}.json`;
      const signature = await sha256(jsonBytes({ rows, metadata, totals })), cacheKey = `${info.id}/${number}`;
      const cached = await disk.get("closed-views", cacheKey) as { signature: string; html: string; index: string } | undefined;
      if (next && cached?.signature === signature) {
        // Relative links have the same depth in every generation. Copy immutable
        // closed pages as streams instead of rebuilding their HTML/JSON content.
        await disk.write(prefix + htmlPath, disk.read(cached.html));
        await disk.write(prefix + indexPath, disk.read(cached.index));
        await disk.put("closed-views", cacheKey, { signature, html: prefix + htmlPath, index: prefix + indexPath });
        number++; rows = []; bytes = 0; return;
      }
      const content = rows.map(row => `<tr><td>${row.sequence}</td><td>${escape(row.kind)}</td><td>${escape(row.name)} (${escape(row.playerId)})<br>${escape(row.role)}</td><td>${escape(row.profile)} ${escape(row.weapon)}</td><td>${escape(row.durationMs)}</td><td><a href="../${row.location.path}">Source ${row.location.offset}+${row.location.length} octets</a><pre>${escape(JSON.stringify(row.detail))}</pre>${row.shotHash ? `<a href="shot-${row.shotHash}.html">${escape(row.shotKey)}</a>` : ""}</td></tr>`).join("");
      await output.write(`report/${info.id}-${number}.html`, one(page(info.label,
        `<a href="../index.html">Index</a><p>Vue globale paginée / Paginated global view. Page ${number}.</p>${metadata ? `<details open><summary>État enregistré / Recorded state · ${escape(metadata.capturedAtSequence)}</summary><a href="../${metadata.location.path}">Preuve / Evidence ${metadata.location.offset}+${metadata.location.length}</a><pre>${escape(JSON.stringify(metadata.record, null, 2))}</pre></details>` : ""}${totals ? `<pre>${escape(JSON.stringify(totals))}</pre>` : ""}<table><tr><th>Séquence</th><th>Événement</th><th>Joueur / rôle</th><th>Profil / arme</th><th>ms</th><th>Preuves</th></tr>${content}</table>` +
        (number > 1 ? `<a href="${info.id}-${number - 1}.html">Précédente / Previous</a> ` : "") + (next ? `<a href="${info.id}-${number + 1}.html">Suite / Next</a>` : ""))));
      await output.write(`index/views/${info.id}-${number}.json`, one(jsonBytes({ label: info.label, page: number, next: next ? `index/views/${info.id}-${number + 1}.json` : null, metadata, rows })));
      if (next) await disk.put("closed-views", cacheKey, { signature, html: prefix + htmlPath, index: prefix + indexPath });
      number++; rows = []; bytes = 0;
    };
    for await (const row of disk.scan(`view-${info.id}`)) {
      const value = row.value as Row, size = jsonBytes(value).length * 6;
      if (rows.length && (rows.length >= 200 || bytes + size + 4096 > maxBytes)) await flush(true);
      // A long diagnostic is referenced, not copied wholesale into every HTML view.
      if (size + 4096 > maxBytes) value.detail = "Détails dans la source / Details in source";
      rows.push(value); bytes += jsonBytes(value).length * 6;
    }
    await flush(false);
  }
  await flushMenu(false);
  for await (const item of disk.scan("shot-contexts")) {
    signal?.throwIfAborted();
    const hash = await identity(item.key), context = String(item.value);
    let refs: unknown[] = [], number = 1;
    const flush = async (next: boolean) => {
      await output.write(`index/shots/${hash}${number === 1 ? "" : `-${number}`}.json`, one(jsonBytes({ shotKey: item.key,
        launched: await disk.get("launched", item.key) ?? null, refs, next: next ? `index/shots/${hash}-${number + 1}.json` : null })));
      refs = []; number++;
    };
    for await (const row of disk.scan("turn-captures", `${await identity(context)}/`)) {
      if (refs.length >= 256 || (refs.length && jsonBytes(refs).length + jsonBytes(row.value).length + 1024 > maxBytes)) await flush(true);
      refs.push(row.value);
    }
    await flush(false);
    const command = `node Scripts/read-shot-archive.mjs manifest.json --shot ${JSON.stringify(item.key)} --output shot.json --replay`;
    await output.write(`report/shot-${hash}.html`, one(page(item.key,
      `<a href="../index.html">Index</a><p>${await disk.get("launched", item.key) ? "Lancement confirmé / Launch confirmed" : "Lancement non confirmé / Launch unconfirmed"}</p><p>Rejeu : non exécuté / Replay: not executed. Champs absents : inconnus / Missing fields: unknown.</p><pre>${escape(JSON.stringify(await disk.get("turn-summary", context), null, 2))}</pre><a href="../index/shots/${hash}.json">Références exactes / Exact references</a><pre>${escape(command)}</pre>`)));
  }
  const stats: unknown[] = [];
  for await (const item of disk.scan("profiles")) {
    const n = Number(await disk.get("duration-count", item.key) ?? 0); let i = 0, middle = 0, p95: number | null = null, maximum: number | null = null;
    const middleFirst = Math.floor((n - 1) / 2), middleLast = Math.floor(n / 2), middleCount = n % 2 ? 1 : 2;
    for await (const row of disk.scan(`durations-${item.key}`)) {
      const duration = (row.value as Row).durationMs!;
      maximum ??= duration;
      if (i === middleFirst || i === middleLast) middle += duration / middleCount;
      if (i === n - Math.ceil(.95 * n)) p95 = duration;
      i++;
    }
    stats.push({ profile: item.value, count: n, missing: Math.max(0, Number(await disk.get("decision-count", item.key) ?? 0) - n), median: n ? middle : null, p95, maximum });
  }
  await output.write("index/root.json", one(jsonBytes({ schemaVersion: 1, boundary: manifest.journal.persisted,
    views: "index/views/menu-1.json", shots: "index/shots/<sha256-shotKey>.json", statistics: stats, replay: "not executed" })));
  await output.write("report/statistics.html", one(page("Durées / Durations", `<a href="../index.html">Index</a><pre>${escape(JSON.stringify(stats, null, 2))}</pre>`)));
}
