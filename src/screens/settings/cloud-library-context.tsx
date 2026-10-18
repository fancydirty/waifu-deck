import { createContext, useContext } from 'react';
import type { CloudLibraryData } from './use-cloud-library-data';

export const CloudLibraryContext = createContext<CloudLibraryData | null>(null);

/** Consumers share the runtime provider's snapshot; there is no fallback reader. */
export function useCloudLibraryModel(): CloudLibraryData {
  const data = useContext(CloudLibraryContext);
  if (data === null) throw new Error('useCloudLibraryModel requires ByosCloudLibraryProvider');
  return data;
}
