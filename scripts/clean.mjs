#!/usr/bin/env node
/**
 * Removes build artefacts and the local SQLite database (never the source).
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const targets = [
  'apps/server/dist',
  'apps/web/dist',
  'packages/shared-types/dist',
  'packages/capabilities/dist',
  'packages/core/dist',
  'packages/rules/dist',
  'packages/storage/dist',
  'packages/queue/dist',
  'packages/onebot/dist',
  'packages/adapters-discord/dist',
  'packages/adapters-qq/dist',
];

for (const target of targets) {
  rmSync(join(root, target), { recursive: true, force: true });
  process.stdout.write(`removed ${target}\n`);
}
