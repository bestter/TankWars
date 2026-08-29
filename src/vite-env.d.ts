/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production Worker URL (option B), e.g. https://tankwars-api.account.workers.dev */
  readonly VITE_API_BASE?: string;
  /** Disable every online entry point and keep only local humans/AI. */
  readonly VITE_HOTSEAT_ONLY?: "true" | "false";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
