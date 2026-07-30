#!/usr/bin/env node
/**
 * Scratch helper: print a numbered slice of a file.
 * Usage: node .axiom-cat.cjs <file> <from> <to>
 */
'use strict';
const fs = require('fs');
const file = process.argv[2];
const from = Math.max(1, Number(process.argv[3] || 1));
const to = Number(process.argv[4] || from + 80);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
for (let i = from - 1; i < Math.min(to, lines.length); i += 1) {
  process.stdout.write(`${i + 1}: ${lines[i]}\n`);
}
process.stdout.write(`TOTAL ${lines.length}\n`);
