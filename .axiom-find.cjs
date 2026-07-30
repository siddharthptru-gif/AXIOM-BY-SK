#!/usr/bin/env node
/**
 * Scratch helper: grep with line numbers over the AXIOM source tree.
 * Usage: node .axiom-find.cjs <regex> [globSubstring] [contextLines]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const pattern = process.argv[2];
const filter = process.argv[3] || '';
const ctx = Number(process.argv[4] || 0);
if (!pattern) {
  process.stdout.write('usage: node .axiom-find.cjs <regex> [pathSubstring] [context]\n');
  process.exit(2);
}
const re = new RegExp(pattern);
const roots = ['apps/desktop/src'];
const files = [];
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue;
      walk(full);
    } else if (/\.(ts|tsx|cjs|json|css)$/.test(entry.name)) {
      files.push(full);
    }
  }
}
for (const root of roots) walk(root);

let hits = 0;
for (const file of files) {
  const rel = file.replace(/\\/g, '/');
  if (filter && !rel.includes(filter)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!re.test(lines[i])) continue;
    hits += 1;
    const from = Math.max(0, i - ctx);
    const to = Math.min(lines.length - 1, i + ctx);
    for (let j = from; j <= to; j += 1) {
      process.stdout.write(`${rel}:${j + 1}: ${lines[j]}\n`);
    }
    if (ctx > 0) process.stdout.write('--\n');
  }
}
process.stdout.write(`HITS ${hits}\n`);
