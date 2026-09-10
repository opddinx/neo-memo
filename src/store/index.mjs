// Stable Store boundary. Consumers should import this module, not item files.
export { Store, STORE_FILE, STORE_FORMAT, STORE_SCHEMA_VERSION, initStore, validateStore, migrateStore, migrateV1Store, encodeItem, decodeItem, memoText } from '../core/store.mjs';
export async function openStore(storePath) {
  const { Store } = await import('../core/store.mjs');
  return new Store(storePath).init();
}
