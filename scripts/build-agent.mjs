#!/usr/bin/env node
// Turn a business JSON into everything you need to stand up its agent.
//
//   node scripts/build-agent.mjs                    list all businesses
//   node scripts/build-agent.mjs sharma-dental      print prompt + tools
//   node scripts/build-agent.mjs sharma-dental -o   write to build/<slug>/
//   node scripts/build-agent.mjs --check            validate every business
//
// This is the whole onboarding step. Fill in a JSON, run this, paste the
// output into your voice provider's dashboard. No code, no deploy.

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  loadBusiness, listBusinesses, validateBusiness, normalize,
  buildSystemPrompt, buildGreeting, toolDefinitions, toVapiTools,
} from "../packages/agent-core/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("-")));
const slug = args.find((a) => !a.startsWith("-"));

const SERVER_URL_PLACEHOLDER = process.env.AGENT_SERVER_URL || "https://REPLACE_WITH_YOUR_PUBLIC_URL/api/tools";

try {
  if (flags.has("--check")) await checkAll();
  else if (!slug) await showList();
  else await build(slug);
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}

async function showList() {
  const slugs = await listBusinesses();
  console.log(`\nBusinesses in businesses/:\n`);
  for (const s of slugs) console.log(`  ${s}`);
  console.log(`\nUsage:`);
  console.log(`  node scripts/build-agent.mjs <slug>       print the agent config`);
  console.log(`  node scripts/build-agent.mjs <slug> -o    write it to build/<slug>/`);
  console.log(`  node scripts/build-agent.mjs --check      validate all of them`);
  console.log(`\nTo add a business: copy businesses/_TEMPLATE.json to businesses/<your-slug>.json\n`);
}

async function checkAll() {
  const slugs = await listBusinesses();
  let failed = 0;
  console.log(`\nValidating ${slugs.length} business config(s)...\n`);
  for (const s of slugs) {
    const raw = JSON.parse(await readFile(join(ROOT, "businesses", `${s}.json`), "utf8"));
    const { errors, warnings } = validateBusiness(raw);
    if (errors.length) {
      failed++;
      console.log(`✖ ${s}`);
      for (const e of errors) console.log(`    error:   ${e}`);
    } else {
      console.log(`✓ ${s}`);
    }
    for (const w of warnings) console.log(`    warning: ${w}`);
  }
  console.log("");
  if (failed) {
    console.error(`${failed} of ${slugs.length} failed.\n`);
    process.exit(1);
  }
  console.log(`All ${slugs.length} valid.\n`);
}

async function build(slugArg) {
  const { config, warnings } = await loadBusiness(slugArg);
  const prompt = buildSystemPrompt(config);
  const tools = toolDefinitions(config);
  const assistant = buildVapiAssistant(config, prompt);

  if (warnings.length) {
    console.log(`\n⚠  ${warnings.length} warning(s) for ${slugArg}:`);
    for (const w of warnings) console.log(`   - ${w}`);
  }

  if (flags.has("-o") || flags.has("--out")) {
    const outDir = join(ROOT, "build", slugArg);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "system-prompt.md"), prompt + "\n", "utf8");
    await writeFile(join(outDir, "tools.json"), JSON.stringify(tools, null, 2) + "\n", "utf8");
    await writeFile(join(outDir, "vapi-assistant.json"), JSON.stringify(assistant, null, 2) + "\n", "utf8");
    console.log(`\n✓ Wrote build/${slugArg}/`);
    console.log(`    system-prompt.md      paste into your assistant's system prompt`);
    console.log(`    tools.json            provider-neutral tool definitions`);
    console.log(`    vapi-assistant.json   full Vapi assistant, ready to POST or paste\n`);
    return;
  }

  const rule = "=".repeat(72);
  console.log(`\n${rule}\nSYSTEM PROMPT — ${config.profile.name}\n${rule}\n`);
  console.log(prompt);
  console.log(`\n${rule}\nFIRST MESSAGE\n${rule}\n`);
  console.log(buildGreeting(config));
  console.log(`\n${rule}\nTOOLS (${tools.length})\n${rule}\n`);
  console.log(JSON.stringify(tools, null, 2));
  console.log(`\n${rule}`);
  console.log(`Tip: add -o to write these to build/${slugArg}/ instead of printing.\n`);
}

/**
 * A complete Vapi assistant object. Model/voice choices here are sensible
 * starting points for Indian call traffic, not tuned settings:
 *   - multilingual transcription, because callers code-switch Hindi/English
 *     constantly and a monolingual model mangles it
 *   - a low `numWordsToInterruptAssistant`, because Indian callers tend to
 *     interrupt with "haan haan" style backchannel and the agent should
 *     yield quickly rather than talk over them
 * Verify all of these against current Vapi docs before going live — model
 * and voice IDs change, and this repo has no live Vapi account to test with.
 */
function buildVapiAssistant(cfg, prompt) {
  return {
    name: `${cfg.profile.name} — ${cfg.agent.name}`,
    firstMessage: buildGreeting(cfg),
    model: {
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.3,
      messages: [{ role: "system", content: prompt }],
      tools: toVapiTools(cfg, SERVER_URL_PLACEHOLDER),
    },
    voice: {
      provider: "vapi",
      voiceId: "REPLACE_WITH_A_VOICE_ID",
      _comment: "Pick a voice that handles Indian English. Audition options in the Vapi dashboard — this materially changes how the agent lands with callers.",
    },
    transcriber: {
      provider: "deepgram",
      model: "nova-2",
      language: "multi",
      _comment: "multi = code-switching Hindi/English in one utterance.",
    },
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: (cfg.agent.maxCallMinutes ?? 6) * 60,
    endCallMessage: "Thanks for calling. Have a good day!",
    endCallFunctionEnabled: true,
    backgroundSound: "off",
    numWordsToInterruptAssistant: 2,
    _setup_reminders: [
      "Set server.url on every tool to your real public URL (or set AGENT_SERVER_URL before running this script).",
      "Set a server secret in Vapi and the same value in the agent server's env, so tool webhooks are authenticated.",
      "Indian phone numbers cannot be attached to Vapi directly — see docs/india-telephony.md.",
    ],
  };
}
