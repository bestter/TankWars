import { useTranslation } from "react-i18next";
import type { AdvisorView } from "./AdvisorController";
import type { AdvisorObjective } from "../../game/entities/ai/expertPolicy";

export interface ShotAdvisorPanelProps {
  view: AdvisorView;
  request(): void;
  apply(): void;
  setObjective(objective: AdvisorObjective): void;
}

export function ShotAdvisorPanel({ view, request, apply, setObjective }: ShotAdvisorPanelProps) {
  const { t } = useTranslation();
  if (!view.playerId) return null;
  const result = view.result;
  const name = (id: string) => view.names?.[id] ?? id;
  return (
    <section className="shot-advisor" aria-label={t("advisor_title")} onKeyDown={(event) => event.stopPropagation()}>
      <div className="shot-advisor-actions">
        <label>
          {t("advisor_objective")}{" "}
          <select value={view.objective} onChange={(event) => setObjective(event.target.value === "SURVIE" ? "SURVIE" : "OPTIMISER_PROFIT")}>
            <option value="SURVIE">{t("advisor_survival")}</option>
            <option value="OPTIMISER_PROFIT">{t("advisor_profit")}</option>
          </select>
        </label>
        <button type="button" onClick={request} disabled={view.status === "calculating"}>{t("advisor_title")}</button>
        <button type="button" onClick={apply} disabled={!result}>{t("advisor_apply")}</button>
      </div>
      <div role="status" aria-live="polite">
        {view.status === "calculating" && t("advisor_calculating")}
        {view.status === "empty" && t("advisor_empty")}
        {view.status === "expired" && t("advisor_expired")}
        {result && <>
          <p>{t("advisor_command", { weapon: t(`weapons.${result.command.weaponId}`),
            angle: result.command.angle, power: result.command.power,
            targets: result.targetIds.map(name).join(", "),
            objective: t(result.objective === "SURVIE" ? "advisor_survival" : "advisor_profit") })}</p>
          <p>{t("advisor_economy", { gain: result.gain, cost: result.cost, profit: result.profit })}</p>
          {result.shooterDestroyed && <p className="shot-advisor-danger">{t("advisor_shooter_destroyed")}</p>}
          <ul>{result.consequences.map((row) => <li key={row.playerId}>
            {t("advisor_losses", { name: name(row.playerId), health: row.health, shield: row.shield })}
            {row.destroyed && ` — ${t("advisor_destroyed")}`}
          </li>)}</ul>
          <p>{t("advisor_prediction")}</p>
        </>}
      </div>
      {view.status === "error" && <p role="alert">{t("advisor_error")}</p>}
    </section>
  );
}
