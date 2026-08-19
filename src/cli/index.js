#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8'));

const HELP = `claude-for-poor-folks v${pkg.version} — know what your agent is spending, before the bill does.

Usage
  npx claude-for-poor-folks init [--yes] [--global]   set the budget gate for this repo
  npx claude-for-poor-folks install [--global]        wire the status line + hooks into settings.json
  npx claude-for-poor-folks uninstall [--global]      remove every trace from settings.json
  npx claude-for-poor-folks report [--days N] [--json] where the money actually went
  npx claude-for-poor-folks status                    current config and live sessions
  npx claude-for-poor-folks doctor                    check the wiring

Internal (called by Claude Code, not by you)
  claude-for-poor-folks statusline
  claude-for-poor-folks hook <EventName>

Everything stays on this machine. No network calls, no telemetry, no dependencies.
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'statusline': {
      const { main: run } = await import('./statusline.js');
      return run();
    }
    case 'hook': {
      const { main: run } = await import('./hook.js');
      return run(rest);
    }
    case 'init': {
      const { runInit } = await import('./init.js');
      return runInit(rest);
    }
    case 'install': {
      const { runInstall } = await import('./install.js');
      return runInstall(rest);
    }
    case 'uninstall': {
      const { runUninstall } = await import('./install.js');
      return runUninstall(rest);
    }
    case 'report': {
      const { runReport } = await import('./report.js');
      return runReport(rest);
    }
    case 'status': {
      const { runStatus } = await import('./report.js');
      return runStatus(rest);
    }
    case 'doctor': {
      const { runDoctor } = await import('./install.js');
      return runDoctor(rest);
    }
    case '--version':
    case '-v':
      process.stdout.write(pkg.version + '\n');
      return;
    default:
      process.stdout.write(HELP);
      return;
  }
}

// The "hooks always exit 0" guarantee has to live at the real entry point.
// If a module fails to load, run() is never reached and its own try/catch never
// runs, so without this the user would get exit 1 and an error printed on every
// single hook firing.
const INTERNAL = new Set(['hook', 'statusline']);
main().catch((/** @type {any} */ err) => {
  const cmd = process.argv[2];
  if (INTERNAL.has(cmd)) process.exit(0);
  process.stderr.write(`claude-for-poor-folks: ${err?.message || err}\n`);
  process.exit(1);
});
