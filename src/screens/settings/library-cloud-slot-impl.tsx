import { useEffect, useMemo, useState } from 'react';
import type { LibraryCloudSlotProps } from '@/screens/settings/library-cloud-slot-types';
import { LibraryCloudSection } from '@/screens/settings/library-cloud-section';

export function LibraryCloudSlot({ actions, byosStatus, message }: LibraryCloudSlotProps) {
  const generation = useMemo(() => ({ actions }), [actions]);
  const [result, setResult] = useState<{
    owner: typeof generation; scope: string | null | undefined;
  } | null>(null);
  useEffect(() => {
    if (actions === null) return;
    let cancelled = false;
    void Promise.resolve().then(() => actions.getAccountScope()).then((scope) => {
      if (!cancelled) setResult({ owner: generation, scope });
    }, () => {
      if (!cancelled) setResult({ owner: generation, scope: undefined });
    });
    return () => { cancelled = true; };
  }, [actions, generation]);
  // A replacement invalidates the previous answer before its effect runs.
  const scope = actions !== null && result?.owner === generation ? result.scope : undefined;
  return <LibraryCloudSection actions={actions} accountScope={scope} byosStatus={byosStatus} message={message} />;
}
