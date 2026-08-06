// node packages/env/env.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Not url.pathname — that percent-encodes spaces, and this repo gets cloned
// into paths with spaces in them.
import { fileURLToPath } from "node:url";

import { parseEnv, loadEnv } from "./load.mjs";

const tmpEnv = (contents) => {
  const path = join(mkdtempSync(join(tmpdir(), "rf-env-")), ".env");
  writeFileSync(path, contents);
  return path;
};

test("parseEnv: basic key/value pairs", () => {
  assert.deepEqual(parseEnv("A=1\nB=two"), { A: "1", B: "two" });
});

test("parseEnv: ignores comments and blank lines", () => {
  assert.deepEqual(parseEnv("# a comment\n\nA=1\n   # indented\nB=2\n"), { A: "1", B: "2" });
});

test("parseEnv: tolerates `export ` prefixes", () => {
  assert.deepEqual(parseEnv("export A=1"), { A: "1" });
});

test("parseEnv: strips trailing inline comments from unquoted values", () => {
  assert.equal(parseEnv("A=value # why").A, "value");
});

test("parseEnv: a # inside a value is not a comment", () => {
  // Real secrets contain # far more often than people expect.
  assert.equal(parseEnv("A=pa#ssword").A, "pa#ssword");
});

test("parseEnv: quoted values keep spaces and #", () => {
  assert.equal(parseEnv('A="hello world # not a comment"').A, "hello world # not a comment");
  assert.equal(parseEnv("A='single quoted'").A, "single quoted");
});

test("parseEnv: \\n unescapes in double quotes only", () => {
  assert.equal(parseEnv('A="one\\ntwo"').A, "one\ntwo");
  assert.equal(parseEnv("A='one\\ntwo'").A, "one\\ntwo");
});

test("parseEnv: no variable interpolation — $ stays literal", () => {
  // A generated secret with a $ in it must survive verbatim.
  assert.equal(parseEnv("A=abc$HOME/def").A, "abc$HOME/def");
});

test("parseEnv: values containing = are kept whole", () => {
  assert.equal(parseEnv("A=base64==").A, "base64==");
});

test("parseEnv: skips malformed keys and lines with no =", () => {
  assert.deepEqual(parseEnv("not a line\n1BAD=x\nOK=y"), { OK: "y" });
});

test("loadEnv: a missing .env is not an error", () => {
  const result = loadEnv({ path: join(tmpdir(), "definitely-not-here", ".env"), env: {} });
  assert.equal(result.loaded, false);
  assert.deepEqual(result.applied, []);
});

test("loadEnv: applies values into the target env", () => {
  const env = {};
  loadEnv({ path: tmpEnv("SARVAM_API_KEY=real-key\n"), env });
  assert.equal(env.SARVAM_API_KEY, "real-key");
});

test("loadEnv: never overrides an already-set variable", () => {
  // Docker/systemd/CI set the real thing; a stale repo .env must not win.
  const env = { OPENAI_API_KEY: "from-the-environment" };
  const result = loadEnv({ path: tmpEnv("OPENAI_API_KEY=from-the-file\n"), env });
  assert.equal(env.OPENAI_API_KEY, "from-the-environment");
  assert.deepEqual(result.skipped, ["OPENAI_API_KEY"]);
});

test("loadEnv: leftover .env.example placeholders are treated as unset", () => {
  // Otherwise `if (env.SARVAM_API_KEY)` is true and the call fails mid-call
  // against the provider, instead of showing a red dot at boot.
  const env = {};
  loadEnv({
    path: tmpEnv(
      "SARVAM_API_KEY=YOUR_SARVAM_API_KEY\n" +
        "EXOTEL_WEBHOOK_SECRET=GENERATE_A_LONG_RANDOM_VALUE\n" +
        "N8N_BASE_URL=REPLACE_WITH_YOUR_PUBLIC_URL\n" +
        "OPENAI_API_KEY=sk-actually-real\n"
    ),
    env,
  });
  assert.equal(env.SARVAM_API_KEY, undefined);
  assert.equal(env.EXOTEL_WEBHOOK_SECRET, undefined);
  assert.equal(env.N8N_BASE_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, "sk-actually-real");
});

test("loadEnv: empty values are treated as unset", () => {
  const env = {};
  loadEnv({ path: tmpEnv("SARVAM_API_KEY=\n"), env });
  assert.equal(env.SARVAM_API_KEY, undefined);
});

test("loadEnv: the shipped .env.example parses and is all placeholders", () => {
  // If a real value ever lands in .env.example, this fails — which is the
  // point. Placeholders are also what loadEnv refuses to apply, so a fresh
  // `cp .env.example .env` must produce an env with nothing configured
  // rather than a gateway that boots green and fails on the first call.
  const env = {};
  const path = fileURLToPath(new URL("../../.env.example", import.meta.url));
  const result = loadEnv({ path, env });
  assert.equal(result.loaded, true, ".env.example should exist at the repo root");
  assert.deepEqual(
    result.applied,
    [],
    `.env.example contains non-placeholder value(s): ${result.applied.join(", ")}`
  );
});
