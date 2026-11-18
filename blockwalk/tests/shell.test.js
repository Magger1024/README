import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the service worker shell lists real files, including every app script', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/'\.\/[^']*'/g)].map((m) => m[0].slice(1, -1));
  assert.ok(shell.includes('./'));
  assert.ok(shell.includes('./index.html'));
  for (const rel of shell) {
    if (rel === './') continue;
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is missing`);
  }
  for (const file of fs.readdirSync(path.join(root, 'js'))) {
    if (!file.endsWith('.js')) continue;
    assert.ok(shell.includes(`./js/${file}`), `${file} is not in the service worker shell`);
  }
  assert.match(sw, /blockwalk-v1/);
  assert.doesNotMatch(sw, /AIza|private_key|BEGIN PRIVATE/);
});

test('no secrets or real-looking key material are committed under blockwalk', () => {
  const skip = new Set(['node_modules', 'test-results', 'playwright-report']);
  const bad = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (stat.size > 1_000_000) continue;
      if (!/\.(js|md|html|css|json|toml|example|webmanifest)$/.test(name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const pem = `-----BEGIN ${'PRIVATE'} KEY-----[\\s\\S]{80,}-----END ${'PRIVATE'} KEY-----`;
      if (new RegExp(pem).test(text)) bad.push(`${full}:pem`);
      if (new RegExp(`AIza[0-9A-Za-z\\-_]{20,}`).test(text)) bad.push(`${full}:key`);
    }
  }
  walk(root);
  assert.deepEqual(bad, []);
});
