// Minimal .env loader — zero dependencies, on purpose.
//
// docs/exotel-setup.md tells you to `cp .env.example .env` and then start the
// gateway. Nothing in the repo actually read that file, so every key you
// pasted in was ignored and the gateway booted with three red dots and no
// explanation. This closes that gap.
//
// Node 20.6+ has `--env-file`, but CLAUDE.md commits to bare Node 18+, and
// `--env-file` throws if the file is missing rather than shrugging. So: a
// ~40-line parser instead of a dependency or a version bump.
//
//   import { loadEnv } from "../../packages/env/load.mjs";
//   loadEnv();   // call once, before anything reads process.env
//
// Rules that matter:
//   - A variable already set in the real environment always wins. Docker,
//     systemd, and `FOO=1 node ...` must never be silently overridden by a
//     stale .env sitting in the repo.
//   - A missing .env is not an error. MOCK_PROVIDERS=1 on the command line
//     is a complete, valid way to run this.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Parses .env text into a plain object.
 *
 * Handles the subset of the format people actually write: comments, blank
 * lines, `export ` prefixes, quoted values (with \n escapes inside double
 * quotes), and trailing inline comments on unquoted values. Deliberately
 * does NOT do variable interpolation — a `$` in a secret should stay a `$`.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  const out = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      // Only double quotes get escape processing, same as every shell.
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      // Unquoted: strip a trailing ` # comment`, but not a `#` inside a value.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

/**
 * Loads .env into process.env without clobbering anything already set.
 *
 * @param {object} [o]
 * @param {string} [o.path]  defaults to <repo root>/.env
 * @param {NodeJS.ProcessEnv} [o.env]
 * @returns {{ loaded: boolean, path: string, applied: string[], skipped: string[] }}
 */
export function loadEnv({ path = resolve(REPO_ROOT, ".env"), env = process.env } = {}) {
  if (!existsSync(path)) return { loaded: false, path, applied: [], skipped: [] };

  const parsed = parseEnv(readFileSync(path, "utf8"));
  const applied = [];
  const skipped = [];

  for (const [key, value] of Object.entries(parsed)) {
    // The real environment is the source of truth. Never override it.
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      skipped.push(key);
      continue;
    }
    // A placeholder left in from .env.example is worse than nothing: it makes
    // `if (env.SARVAM_API_KEY)` true and sends garbage to the provider, which
    // fails mid-call instead of at boot. Treat these as unset.
    if (!value || /^(YOUR_|GENERATE_A_|REPLACE_WITH_)/.test(value)) continue;

    env[key] = value;
    applied.push(key);
  }

  return { loaded: true, path, applied, skipped };
}
