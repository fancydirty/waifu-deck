/**
 * K4: the two lifecycle calls app-services makes at bundle-ready. Pure type,
 * safe in both variants; the Direct implementation lives in
 * `library-background-sync.ts` and is reached only through the integration.
 */
export type LibraryBackgroundSyncPort = Readonly<{
  ensureRegistered(): Promise<void>;
  ensureUnregistered(): Promise<void>;
}>;
