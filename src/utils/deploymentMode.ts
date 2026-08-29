export function isHotseatOnlyBuild(): boolean {
  return import.meta.env.VITE_HOTSEAT_ONLY === "true";
}
