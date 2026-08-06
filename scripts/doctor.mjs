#!/usr/bin/env node
// node scripts/doctor.mjs          — is this clone ready to take a call?
// node scripts/doctor.mjs --live   — also enforce everything a real call needs
//
// The gateway's boot banner tells you what's configured, but only once you
// start it, and only for the voice path. This answers the earlier question:
// what still has to be true before dialling an ExoPhone works?
//
// Exit code is 0 unless something is actually broken (or, with --live, still
// missing), so it can gate a deploy.

import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../packages/env/load.mjs";
import { loadBusiness, listBusinesses } from "../packages/agent-core/index.mjs";
import { providersFromEnv } from "../packages/voice/providers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--live");

const env = loadEnv();

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

let failures = 0;
let warnings = 0;

/** @param {"ok"|"warn"|"fail"} status */
function line(status, label, detail = "") {
  const mark = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") }[status];
  if (status === "fail") failures++;
  if (status === "warn") warnings++;
  console.log(`  ${mark} ${label}${detail ? c.dim(`  ${detail}`) : ""}`);
}

/** Missing is a hard failure when --live, a warning otherwise. */
const need = (present, label, detail) =>
  line(present ? "ok" : LIVE ? "fail" : "warn", label, present ? "" : detail);

function section(title) {
  console.log(`\n${c.bold(title)}`);
}

// ---------------------------------------------------------------------------

console.log(`\n${c.bold("ReceptionFlow doctor")}${LIVE ? c.dim("  (--live: checking real-call readiness)") : ""}`);

section("Runtime");
const major = Number(process.versions.node.split(".")[0]);
line(major >= 18 ? "ok" : "fail", `Node ${process.versions.node}`, major >= 18 ? "" : "needs Node 18 or newer");
line(
  env.loaded ? "ok" : "warn",
  env.loaded ? `.env loaded` : ".env not found",
  env.loaded
    ? `${env.applied.length} applied${env.skipped.length ? `, ${env.skipped.length} already in the environment` : ""}`
    : "cp .env.example .env — placeholders are ignored, so this is safe to do now"
);

// ---------------------------------------------------------------------------

section("Businesses");
let slugs = [];
try {
  slugs = await listBusinesses();
} catch (err) {
  line("fail", "businesses/ could not be read", err.message);
}

if (slugs.length === 0) {
  line("fail", "no businesses configured", "cp businesses/_TEMPLATE.json businesses/your-business.json");
}

for (const slug of slugs) {
  try {
    const { config } = await loadBusiness(slug);
    const transfer = config.escalation?.transferNumber;
    const policy = config.escalation?.transferPolicy;
    const detail =
      policy === "never"
        ? "transfers disabled"
        : transfer
          ? `transfers to ${transfer}`
          : "no transferNumber set — callers asking for a human get a callback instead";
    line(policy !== "never" && !transfer ? "warn" : "ok", slug, detail);
  } catch (err) {
    line("fail", slug, err.message);
  }
}

// ---------------------------------------------------------------------------

section("Voice providers");
const providers = providersFromEnv();
if (providers.mock) {
  line(LIVE ? "fail" : "ok", "MOCK_PROVIDERS is on", LIVE ? "real calls need real keys — unset MOCK_PROVIDERS" : "fake speech and a scripted model; no spend");
} else {
  need(Boolean(providers.stt), `STT  ${providers.stt?.name ?? "not configured"}`, "set SARVAM_API_KEY (best for Indic), DEEPGRAM_API_KEY, or OPENAI_API_KEY");
  need(Boolean(providers.tts), `TTS  ${providers.tts?.name ?? "not configured"}`, "set SARVAM_API_KEY, ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, or OPENAI_API_KEY");
  need(Boolean(providers.llm), `LLM  ${providers.llm?.name ?? "not configured"}`, "set OPENAI_API_KEY or ANTHROPIC_API_KEY");
  if (!providers.mock && providers.ready && !process.env.SARVAM_API_KEY) {
    line("warn", "not using Sarvam", "fallbacks work, but Hindi/English code-switching and Indian names are noticeably worse");
  }
}

// ---------------------------------------------------------------------------

section("Telephony");
const encoding = (process.env.TELEPHONY_ENCODING || "pcm").toLowerCase();
line(
  ["pcm", "mulaw"].includes(encoding) ? "ok" : "fail",
  `audio ${encoding === "mulaw" ? "G.711 µ-law" : "linear PCM"} @ ${process.env.TELEPHONY_SAMPLE_RATE || 8000}Hz`,
  ["pcm", "mulaw"].includes(encoding) ? "must match what Exotel hands your trunk" : `TELEPHONY_ENCODING must be "pcm" or "mulaw"`
);

const secret = process.env.EXOTEL_WEBHOOK_SECRET;
need(
  Boolean(secret),
  secret ? "EXOTEL_WEBHOOK_SECRET set" : "EXOTEL_WEBHOOK_SECRET not set",
  "anyone who finds your gateway URL can drive your agent and run up your API bill"
);
if (secret && secret.length < 24) {
  line("warn", "EXOTEL_WEBHOOK_SECRET is short", `${secret.length} chars — use 32+ random characters`);
}

const restKeys = ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_ACCOUNT_SID"];
const restSet = restKeys.filter((k) => process.env[k]);
line(
  restSet.length === 0 || restSet.length === restKeys.length ? "ok" : "warn",
  restSet.length === restKeys.length ? "Exotel REST configured" : "Exotel REST not configured",
  restSet.length === 0
    ? "fine — the Connect applet handles transfers without it"
    : restSet.length === restKeys.length
      ? ""
      : `partially set (${restSet.join(", ")}) — all three or none`
);

// ---------------------------------------------------------------------------

section("Agent server");
line(
  process.env.AGENT_SERVER_SECRET ? "ok" : "warn",
  process.env.AGENT_SERVER_SECRET ? "AGENT_SERVER_SECRET set" : "AGENT_SERVER_SECRET not set",
  process.env.AGENT_SERVER_SECRET ? "" : "fine locally; required before you expose the console or its tool webhooks"
);

// ---------------------------------------------------------------------------

section("Dashboard (optional)");
const dashInstalled = existsSync(join(ROOT, "apps/dashboard/node_modules"));
line(dashInstalled ? "ok" : "warn", dashInstalled ? "dependencies installed" : "dependencies not installed", dashInstalled ? "" : "npm run dashboard:install");

const dashEnv = join(ROOT, "apps/dashboard/.env.local");
if (!existsSync(dashEnv)) {
  line("warn", ".env.local not found", "the dashboard is optional; the prototype stack does not need it");
} else {
  const vars = loadEnv({ path: dashEnv, env: {} });
  const has = (k) => vars.applied.includes(k);
  line(
    has("NEXT_PUBLIC_SUPABASE_URL") && has("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ? "ok" : "warn",
    "Supabase read credentials",
    has("NEXT_PUBLIC_SUPABASE_URL") ? "" : "still placeholders — pages will render their error state"
  );
}

// ---------------------------------------------------------------------------

section("Data");
try {
  const files = readdirSync(join(ROOT, "data"));
  line("ok", "data/ writable", files.length ? files.join(", ") : "empty");
} catch {
  line("ok", "data/ will be created on first write");
}

// ---------------------------------------------------------------------------

console.log("");
if (failures) {
  console.log(c.red(`  ${failures} blocking issue${failures === 1 ? "" : "s"}`) + (warnings ? c.dim(`, ${warnings} warning${warnings === 1 ? "" : "s"}`) : ""));
  console.log(c.dim("  See docs/exotel-setup.md.\n"));
  process.exit(1);
}
if (LIVE) {
  console.log(c.green("  Ready to take real calls.") + c.dim("  Remaining steps are on Exotel's side — docs/exotel-setup.md step 5.\n"));
} else {
  console.log(
    c.green("  Prototype stack is healthy.") +
      c.dim(`${warnings ? `  ${warnings} warning${warnings === 1 ? "" : "s"} above.` : ""}  Run with --live to check real-call readiness.\n`)
  );
}
