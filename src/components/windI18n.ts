import type { WindDisplay } from "../game/wind";

export type WindDirectionKey =
  | "wind_dir_calm"
  | "wind_dir_west"
  | "wind_dir_east";

const WIND_LABEL_KEYS: Record<string, WindDirectionKey> = {
  calm: "wind_dir_calm",
  west: "wind_dir_west",
  east: "wind_dir_east",
};

export function getWindDirectionKey(info: WindDisplay): WindDirectionKey {
  const key = info.label.toLowerCase();
  return Object.hasOwn(WIND_LABEL_KEYS, key)
    ? WIND_LABEL_KEYS[key]
    : "wind_dir_calm";
}
