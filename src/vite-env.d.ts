/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Production Worker URL (option B), e.g. https://tankwars-api.account.workers.dev */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}