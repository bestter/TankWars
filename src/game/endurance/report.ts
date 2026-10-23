import type { EnduranceExport, MetricGroups, Metrics } from "./types";

export function markdownReport(data: EnduranceExport, french = true): string {
  const s = data.session;
  const label = (fr: string, en: string) => french ? fr : en;
  const rate = (n: number, d: number) => d === 0 ? label("non applicable (0)", "not applicable (0)") : `${(100 * n / d).toFixed(1)}% (${n}/${d})`;
  const metricTable = (g: MetricGroups): string[] => {
    const rows: Array<[string, Metrics]> = [[label("Total", "Total"), g.total],
      ...Object.entries(g.players).map(([k, v]): [string, Metrics] => [`player:${k}`, v]),
      ...Object.entries(g.profiles).map(([k, v]): [string, Metrics] => [`profile:${k}`, v]),
      ...Object.entries(g.weapons).map(([k, v]): [string, Metrics] => [`weapon:${k}`, v])];
    return [label("| Groupe | Décisions (ms) | Tirs lancés/résolus | Effet offensif | PV/bouclier adverses | Auto PV/bouclier | Destructions/suicides | Victoires | Survie | Nuls | Zeus |", "| Group | Decisions (ms) | Launched/resolved | Offensive effect | Opponent HP/shield | Self HP/shield | Kills/suicides | Wins | Survival | Draws | Zeus |"),
      "|---|---:|---:|---|---|---|---|---|---|---:|---:|",
      ...rows.map(([k, m]) => `| ${k} | ${m.decisions} (${m.decisionMs.toFixed(1)}) | ${m.shots}/${m.resolved} | ${rate(m.offensiveShots, m.resolved)} | ${m.healthDealtMilli / 1000}/${m.shieldDealtMilli / 1000} | ${m.selfHealthMilli / 1000}/${m.selfShieldMilli / 1000} | ${m.kills}/${m.suicides} | ${rate(m.wins, m.participations)} | ${rate(m.survivals, m.participations)} | ${m.draws} | ${m.zeusResults} |`)];
  };
  return [
    `# TankWars — ${label("Rapport d’endurance", "Endurance report")}`,
    "", `Session: ${s.id}`, `Version: ${s.gameVersion} · Build: ${s.build}`, `Schema: ${s.schemaVersion} · Physics: local`,
    `${label("Début", "Started")}: ${s.startedAt}`, `${label("Durée", "Duration")}: ${(s.durationMs / 3_600_000).toFixed(3)} h`,
    `${label("État / arrêt", "Status / stop")}: ${s.status} / ${s.reason ?? "—"}`,
    `${label("Collecte", "Collection")}: ${s.collection}${s.storageError ? ` — ${s.storageError}` : ""}`,
    "", label("## Exécution", "## Execution"), "",
    `${label("Blocs tentés / complétés / abandonnés / interrompus", "Blocks attempted / completed / abandoned / interrupted")}: ${s.attempted} / ${s.completed} / ${s.abandoned} / ${s.interrupted}`,
    `${label("Blocs suspects (compteur transversal)", "Suspect blocks (overlapping count)")}: ${s.suspect}`,
    `${label("Manches commencées / terminées", "Rounds started / completed")}: ${s.roundsStarted} / ${s.roundsCompleted}`,
    `${label("Tours commencés", "Turns started")}: ${data.rounds.reduce((sum, round) => sum + round.turns, 0)}`,
    `${label("Incidents", "Incidents")}: ${s.incidents}`,
    "", label("## Configuration", "## Configuration"), "", "```json", JSON.stringify(s.config, null, 2), "```",
    `Runtime: ${s.runtime.width}×${s.runtime.height} · gravity ${s.runtime.gravity} · baseShotSpeed ${s.runtime.baseShotSpeed} · localMatch ${s.runtime.localMatch}`,
    "", label("## Manches terminées", "## Completed rounds"), "", ...metricTable(s.completedMetrics),
    "", label("## Observations partielles", "## Partial observations"), "", ...metricTable(s.partialMetrics),
    "", label("## Blocs les plus longs", "## Longest blocks"), "",
    ...data.blocks.toSorted((a, b) => b.durationMs - a.durationMs).slice(0, 10).map(b => `- ${b.index} · ${b.id} · seed ${b.seed} · ${(b.durationMs / 1000).toFixed(1)} s · ${b.status} · ${b.reason ?? "—"}`),
    "", label("## Incidents", "## Incidents"), "",
    ...data.incidents.map(i => `- ${i.kind}: ${i.reason} · ${i.id} · block ${i.blockId} · seed ${i.seed} · round ${i.round} · turn ${i.turn} · ${i.phase} · ${i.observedMs} ms`),
    "", label("## Limites", "## Limits"), "",
    label("Onglet actif et appareil éveillé requis. Un onglet masqué interrompt la session. Aucun replay déterministe, redémarrage après gel complet ou reprise de combat garanti. Commandes évaluées, cibles et perturbations non exposées : indisponibles; elles ne sont pas déduites de la commande finale.",
      "An active tab and awake device are required. Hiding the tab interrupts the session. No deterministic replay, recovery after a full freeze, or combat resume is guaranteed. Unexposed evaluated commands, targets and perturbations are unavailable, never inferred from the final command."),
    label("Les gains ne mesurent pas les dégâts physiques. CLUSTER compte comme un tir; Zeus est séparé. Un abandon n’est pas une défaite. Le JSON contient les compteurs détaillés, manches et contextes d’incident.",
      "Earnings do not measure physical damage. CLUSTER counts as one shot; Zeus is separate. An abandoned block is not a defeat. JSON contains detailed counters, rounds and incident contexts."),
    label("Historique complet des événements non conservé; anneau des 256 derniers événements joint aux incidents. Sauvegarde toutes les 15 secondes et aux frontières. Une récupération après crash reste incomplète; les observations postérieures à la dernière sauvegarde sont perdues.",
      "Full event history is not retained; incidents include the last 256 events. Checkpoints occur every 15 seconds and at boundaries. Crash recovery is incomplete; observations after the last checkpoint are lost."),
    "", "Codex — GPT-6", "",
  ].join("\n");
}
