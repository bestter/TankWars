/**
 * Logo du menu et du lobby. Le dessin est décoratif.
 * Le texte du h1 reste lisible par le lecteur d'écran et par les tests.
 */

import { useTranslation } from "react-i18next";
import { GAME_LOGO, GAME_LOGO_COMPACT } from "./gameLogoArt";

interface GameLogoProps {
  compact?: boolean;
}

export function GameLogo({ compact = false }: GameLogoProps) {
  const { t } = useTranslation();
  const frame = compact ? GAME_LOGO_COMPACT : GAME_LOGO;

  return (
    <h1 className="retro-title">
      <svg
        className="retro-logo"
        width={frame.width}
        height={frame.height}
        viewBox={`0 0 ${GAME_LOGO.width} ${GAME_LOGO.height}`}
        shapeRendering="crispEdges"
        aria-hidden="true"
        focusable="false"
      >
        {GAME_LOGO.paths.map((path) => (
          <path key={path.color} fill={path.color} d={path.d} />
        ))}
      </svg>
      <span className="retro-logo-text">{t("main_title")}</span>
    </h1>
  );
}
