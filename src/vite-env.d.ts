/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_ID?: string;
  /** Production Worker URL (option B), e.g. https://tankwars-api.account.workers.dev */
  readonly VITE_API_BASE?: string;
  /** Disable every online entry point and keep only local humans/AI. */
  readonly VITE_HOTSEAT_ONLY?: "true" | "false";
  /** In development only, submit contact messages to local Wrangler. */
  readonly VITE_CONTACT_USE_LOCAL_WORKER?: "true" | "false";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
