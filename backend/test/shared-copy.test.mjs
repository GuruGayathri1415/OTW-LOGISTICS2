import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
test('the browser copy of the Excel reader equals the server master (run node scripts/sync-shared.mjs if this fails)', () => {
  const a = fs.readFileSync(path.join(here, '..', 'shared', 'payment-excel.cjs'), 'utf8');
  const b = fs.readFileSync(path.join(here, '..', '..', 'frontend', 'dashboard', 'payment-excel.js'), 'utf8');
  assert.equal(a, b);
});
test('backend/ does not import anything from outside itself (it is deployed alone on Render)', () => {
  const src = fs.readFileSync(path.join(here, '..', 'server.js'), 'utf8');
  assert.ok(!/require[Cc]js\(\s*["']\.\.\//.test(src) && !/from\s+["']\.\.\//.test(src));
});
