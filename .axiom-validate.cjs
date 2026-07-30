const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');

const checks = [
  {
    name: 'typecheck-node',
    command: process.execPath,
    args: [
      './node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      './apps/desktop/tsconfig.node.json',
      '--pretty',
      'false',
    ],
  },
  {
    name: 'typecheck-web',
    command: process.execPath,
    args: [
      './node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      './apps/desktop/tsconfig.web.json',
      '--pretty',
      'false',
    ],
  },
];

const results = checks.map((check) => {
  const result = spawnSync(check.command, check.args, {
    cwd: __dirname,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    name: check.name,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
});

writeFileSync(
  `${__dirname}/.axiom-validation-results.json`,
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  'utf8',
);
console.log('AXIOM_VALIDATION_CAPTURED');
