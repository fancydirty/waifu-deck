import { describeCloudObjectStoreContract } from './cloud-object-store-contract-test-support';
import { createMemoryCloudObjectStore } from './memory-cloud-object-store';

// The memory store ignores the per-run token — every run gets a fresh instance,
// so nothing survives to collide with — and has nothing to dispose. A real
// backend uses both.
describeCloudObjectStoreContract('memory store', async () => ({
  store: createMemoryCloudObjectStore(),
  dispose: async () => {},
}));
