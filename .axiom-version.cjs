/**
 * Release version bump.
 *
 * The release validators assert CONSISTENCY across seven values, not a literal
 * pin, so all seven must move together or the gates fail:
 *   package.json .version
 *   apps/desktop/package.json .version
 *   packages/shared/package.json .version
 *   package-lock.json .version
 *   package-lock.json .packages[""].version
 *   package-lock.json .packages["apps/desktop"].version
 *   package-lock.json .packages["packages/shared"].version
 *
 * Usage: node .axiom-version.cjs 2.0.1
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(target ?? '')) {
  console.error('Expected a plain semver release, e.g. 2.0.1');
  process.exit(1);
}

const root = __dirname;
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const write = (rel, value) =>
  fs.writeFileSync(path.join(root, rel), `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const changed = [];

for (const rel of ['package.json', 'apps/desktop/package.json', 'packages/shared/package.json']) {
  const pkg = read(rel);
  changed.push(`${rel}: ${pkg.version} -> ${target}`);
  pkg.version = target;
  write(rel, pkg);
}

const lock = read('package-lock.json');
changed.push(`package-lock.json .version: ${lock.version} -> ${target}`);
lock.version = target;
for (const key of ['', 'apps/desktop', 'packages/shared']) {
  const entry = lock.packages?.[key];
  if (!entry) throw new Error(`package-lock.json is missing the "${key}" workspace entry.`);
  changed.push(`package-lock.json packages["${key}"]: ${entry.version} -> ${target}`);
  entry.version = target;
}
write('package-lock.json', lock);

// Read everything back and prove the invariant the validators check.
const rootVersion = read('package.json').version;
const values = [
  rootVersion,
  read('apps/desktop/package.json').version,
  read('packages/shared/package.json').version,
  read('package-lock.json').version,
  read('package-lock.json').packages[''].version,
  read('package-lock.json').packages['apps/desktop'].version,
  read('package-lock.json').packages['packages/shared'].version,
];
for (const line of changed) console.log(line);
const consistent = values.every((v) => v === target);
console.log(`\nVALUES ${values.join(', ')}`);
console.log(consistent ? `CONSISTENT at ${target}` : 'INCONSISTENT');
if (!consistent) process.exit(1);
