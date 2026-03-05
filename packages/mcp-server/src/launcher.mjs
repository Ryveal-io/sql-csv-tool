#!/usr/bin/env node
/**
 * Launcher for the SQL CSV Chomper MCP server.
 * Ensures the native `duckdb` package is installed before starting the server.
 * This is needed because `duckdb` contains platform-specific native bindings
 * that can't be bundled into a single JS file.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

function isDuckDbAvailable() {
  // Check if node_modules/duckdb exists in our directory
  const nodeModules = join(__dirname, 'node_modules', 'duckdb');
  if (!existsSync(nodeModules)) return false;
  // Also verify it can actually be loaded
  try {
    const require = createRequire(join(__dirname, 'server.js'));
    require('duckdb');
    return true;
  } catch {
    return false;
  }
}

function ensureDuckDb() {
  if (isDuckDbAvailable()) return;

  const pkgJson = join(__dirname, 'package.json');
  if (!existsSync(pkgJson)) {
    process.stderr.write('[Chomper MCP] Error: package.json not found at ' + pkgJson + '\n');
    process.exit(1);
  }

  process.stderr.write('[Chomper MCP] Installing native duckdb module (first run only)...\n');
  process.stderr.write('[Chomper MCP] Directory: ' + __dirname + '\n');

  // On Windows, npm is actually npm.cmd — use shell: true to let the OS resolve it
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';

  try {
    const output = execSync(`${npmCmd} install --production --no-package-lock`, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      shell: isWindows, // Use cmd.exe on Windows to resolve npm.cmd
      env: { ...process.env, npm_config_loglevel: 'error' },
    });
    if (output && output.length) {
      process.stderr.write('[Chomper MCP] npm output: ' + output.toString().trim() + '\n');
    }
  } catch (err) {
    process.stderr.write('[Chomper MCP] npm install failed:\n');
    if (err.stderr) process.stderr.write(err.stderr.toString() + '\n');
    if (err.stdout) process.stderr.write(err.stdout.toString() + '\n');
    process.stderr.write('[Chomper MCP] Error: ' + err.message + '\n');
    process.stderr.write('\n[Chomper MCP] To fix manually, run:\n');
    process.stderr.write('  cd "' + __dirname + '"\n');
    process.stderr.write('  npm install\n\n');
    process.exit(1);
  }

  // Verify it actually worked
  if (!isDuckDbAvailable()) {
    process.stderr.write('[Chomper MCP] npm install completed but duckdb still not loadable.\n');
    process.stderr.write('[Chomper MCP] Try running manually: cd "' + __dirname + '" && npm install\n');
    process.exit(1);
  }

  process.stderr.write('[Chomper MCP] duckdb installed successfully.\n');
}

ensureDuckDb();

// Now import and run the actual server
await import('./server.js');
