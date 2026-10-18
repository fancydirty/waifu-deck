import { openVaultWithPassword, parseVaultMeta, type VaultMeta } from '@/features/byos/byos-vault-meta';

type VaultReader = {
  getObject(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
};

const decoder = new TextDecoder();

/**
 * Integration-suite fixture: open a vault that a previous step created. This
 * is the production join path (`probeBucket` + `openVaultWithPassword`) in
 * three lines; production has no other "open" — K7 ㉟ removed the GET that
 * `initOrOpenVault` used to do before creating.
 */
export async function openExistingVault(
  transport: VaultReader,
  prefix: string,
  password: string | null,
): Promise<{ meta: VaultMeta; masterKey: Uint8Array | null }> {
  const stored = await transport.getObject(`${prefix}vault-meta.json`);
  if (stored === null) throw new Error(`no vault at ${prefix}`);
  const meta = parseVaultMeta(decoder.decode(stored.body));
  return { meta, masterKey: await openVaultWithPassword(meta, password) };
}
