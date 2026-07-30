'use strict';
/**
 * Scratch check for the sign-in gate / profile panel styles.
 *
 * Two failure modes are invisible in a build: a class the TSX references but the CSS
 * never defines (the element renders unstyled), and a design token that does not
 * exist (the declaration is dropped silently). Both are checked here.
 */
const fs = require('fs');
const path = require('path');

const stylesDir = path.join('apps', 'desktop', 'src', 'renderer', 'src', 'styles');
const cssFiles = fs.readdirSync(stylesDir).filter((n) => n.endsWith('.css'));
const allCss = cssFiles.map((n) => fs.readFileSync(path.join(stylesDir, n), 'utf8')).join('\n');
const premium = fs.readFileSync(path.join(stylesDir, 'premium.css'), 'utf8');

const lines = [];

// 1. Every class the two new components use must be defined.
const workbench = path.join('apps', 'desktop', 'src', 'renderer', 'src', 'workbench');
const components = [
  path.join(workbench, 'SignInGate.tsx'),
  path.join(workbench, 'ProfileView.tsx'),
  path.join(workbench, 'ExtensionsView.tsx'),
  path.join(workbench, 'ExtensionDetailPanel.tsx'),
  path.join(workbench, 'ContributedAppearance.tsx'),
  path.join(workbench, 'ExtensionHostPanel.tsx'),
  path.join(workbench, 'ExtensionHostBridge.tsx'),
];
const used = new Set();
for (const file of components) {
  const source = fs.readFileSync(file, 'utf8');
  const pattern = /className=(?:"([^"]+)"|\{`([^`]+)`\})/g;
  let hit;
  while ((hit = pattern.exec(source)) !== null) {
    for (const token of (hit[1] ?? hit[2] ?? '').split(/[\s${}]+/)) {
      if (/^(signin|profile|ext|host)-/.test(token)) used.add(token);
    }
  }
  const named = /(?:overlayClassName|cardClassName)="([^"]+)"/g;
  while ((hit = named.exec(source)) !== null) {
    for (const token of hit[1].split(/\s+/)) if (token) used.add(token);
  }
}
const missingClasses = [...used].filter((name) => !allCss.includes(`.${name}`)).sort();
lines.push(
  missingClasses.length === 0
    ? `PASS  every referenced class is defined  ${used.size} classes`
    : `FAIL  undefined classes: ${missingClasses.join(', ')}`,
);

// 2. Every token the new blocks use must be declared somewhere.
const blockStart = premium.indexOf('.signin-gate');
const block = blockStart >= 0 ? premium.slice(blockStart) : '';
lines.push(blockStart >= 0 ? 'PASS  the new style blocks were found' : 'FAIL  the new style blocks are missing');
lines.push(
  premium.includes('.ext-view')
    ? 'PASS  the extensions manager block is present'
    : 'FAIL  the extensions manager block is missing',
);
const tokens = new Set((block.match(/var\((--[a-z0-9-]+)/g) ?? []).map((raw) => raw.slice(4)));
const missingTokens = [...tokens].filter((token) => !new RegExp(`${token}\\s*:`).test(allCss)).sort();
lines.push(
  missingTokens.length === 0
    ? `PASS  every design token exists  ${tokens.size} tokens`
    : `FAIL  undeclared tokens: ${missingTokens.join(', ')}`,
);

// 3. Braces balance, so nothing after the appended block is swallowed.
const opens = (block.match(/\{/g) ?? []).length;
const closes = (block.match(/\}/g) ?? []).length;
lines.push(
  opens === closes ? `PASS  braces balance  ${opens} rules` : `FAIL  braces unbalanced ${opens}/${closes}`,
);

const failed = lines.filter((line) => line.startsWith('FAIL')).length;
lines.push('', failed === 0 ? 'ALL PASS' : `FAILURES ${failed}`);
fs.writeFileSync('css-check.txt', `${lines.join('\n')}\n`, 'utf8');
