import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { validateScenario, type EnduranceScenario } from "../../game/endurance/scenario";
import { VGA_PALETTE } from "../../types/game";
import type { TerrainMaterial } from "../../types/terrain";
import { drawTankSprite } from "../../game/rendering/tankSprite";

export interface ScenarioSelection { scenario: EnduranceScenario | null; error: string | null; loading: boolean }

const TERRAIN_PREVIEW_COLORS: Record<TerrainMaterial, string> = {
  DIRT: VGA_PALETTE.BROWN,
  SOFT: VGA_PALETTE.YELLOW,
  ROCK: VGA_PALETTE.GRAY,
};

const SPAWN_PREVIEW_COLORS = [
  VGA_PALETTE.BLUE,
  VGA_PALETTE.RED,
  VGA_PALETTE.ELECTRIC_CYAN,
  VGA_PALETTE.FLASH_GREEN,
] as const;

function ScenarioPreview({ scenario }: { scenario: EnduranceScenario }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.save(); ctx.scale(0.5, 0.5);
    ctx.fillStyle = VGA_PALETTE.DARK_BLUE; ctx.fillRect(0, 0, 800, 480);
    scenario.heights.forEach((y, x) => { ctx.fillStyle = TERRAIN_PREVIEW_COLORS[scenario.materials[x]]; ctx.fillRect(x, y, 1, 480 - y); });
    ctx.fillStyle = VGA_PALETTE.RED; ctx.fillRect(0, 474, 800, 6);
    scenario.spawnXs.forEach((x, i) => {
      const y = scenario.heights[Math.floor(x)];
      drawTankSprite(ctx, x, y - 6, 24, 15, 0, x < 400 ? 45 : 135, SPAWN_PREVIEW_COLORS[i]);
      ctx.fillStyle = VGA_PALETTE.WHITE; ctx.font = "12px monospace"; ctx.fillText(String(i + 1), x - 4, y - 20);
    });
    ctx.restore();
  }, [scenario]);
  return <canvas ref={canvas} width={400} height={240} data-testid="endurance-scenario-preview" role="img" aria-label={scenario.name}>{scenario.name}</canvas>;
}

export function ScenarioImport({ selection, onChange }: { selection: ScenarioSelection; onChange: (value: ScenarioSelection) => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const load = async (file: File) => {
    const id = ++request.current;
    onChange({ scenario: null, error: null, loading: true });
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("INVALID_SCENARIO: file exceeds 2 MiB");
      const scenario = validateScenario(JSON.parse(await file.text()) as unknown);
      if (id === request.current) onChange({ scenario, error: null, loading: false });
    } catch (error) {
      if (id === request.current) onChange({ scenario: null, error: String(error), loading: false });
    }
  };
  const s = selection.scenario;
  return <fieldset>
    <legend>{t(s ? "endurance_scenario_custom" : "endurance_scenario_generated")}</legend>
    <label>{t("endurance_scenario_import")}<input ref={input} type="file" accept=".json,application/json" data-testid="endurance-scenario-input"
      onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void load(file); }} /></label>
    <button type="button" disabled={!s && !selection.error && !selection.loading} onClick={() => { request.current++; if (input.current) input.current.value = ""; onChange({ scenario: null, error: null, loading: false }); }}>{t("endurance_scenario_remove")}</button>
    {selection.loading && <p role="status">{t("endurance_scenario_loading")}</p>}
    {selection.error && <p role="alert">{t("endurance_scenario_invalid")}: {selection.error}</p>}
    {s && <><p>{s.name} · {s.id} · {s.terrainId} · {s.width} × {s.height} · {t("endurance_scenario_wind")}: {s.wind}</p>
      <p>{t("endurance_scenario_spawns")}: {s.spawnXs.map(x => `(${x}, ${s.heights[Math.floor(x)]})`).join("; ")}</p>
      <ScenarioPreview scenario={s} /></>}
  </fieldset>;
}
