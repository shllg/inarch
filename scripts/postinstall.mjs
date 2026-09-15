// Prints a one-line nudge after install. Never fails the install.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

try {
  if (process.env.CI) process.exit(0);
  const dir = process.env.INIT_CWD || process.cwd();
  if (existsSync(join(dir, '.claude', 'helpers', 'graft-statusline.cjs'))) process.exit(0);
  console.log('\n  Graft installed. Run `npx graft init` to enable the Claude Code integration (statusline + hooks + auto-sync).\n');
} catch {
  /* never fail an install */
}
