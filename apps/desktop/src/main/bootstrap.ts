import { app } from 'electron';

// Keep release probes ahead of the application module graph. Some optional
// dependencies emit import-time warnings, so loading them before this branch
// would violate the exact, side-effect-free packaged version contract.
if (app.isPackaged && process.argv.slice(1).includes('--version')) {
  process.stdout.write(`${app.getVersion()}\n`);
  app.exit(0);
} else {
  void import('./index').catch(() => {
    process.stderr.write('AXIOM failed to initialize.\n');
    app.exit(1);
  });
}
