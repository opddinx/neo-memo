import fs from 'node:fs/promises';
import path from 'node:path';
import { readJSON, writeJSON } from './util.mjs';

const EMPTY = { schema: 1, sources: {} };

export class ConnectorState {
  constructor(cacheRoot) { this.root = path.resolve(cacheRoot); this.file = path.join(this.root, 'connector-checkpoints.json'); }
  async read() { return readJSON(this.file, EMPTY); }
  async write(state) { await fs.mkdir(this.root, { recursive: true }); await writeJSON(this.file, state); }
}
