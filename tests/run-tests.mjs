// Test suite for tools/validate-server-config.mjs.
//
//   node tests/run-tests.mjs
//
// Every case runs the validator as a real child process, so the CLI surface (argv,
// exit code, --lenient, --out) is covered and not just the internals. The report is
// read from a file written by --out rather than from a pipe, which keeps the suite
// working in sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(root, "tools", "validate-server-config.mjs");
const fixtures = join(root, "tests", "fixtures");
const tmp = join(root, "tests", ".tmp");

/**
 * errors / warnings are asserted EXACTLY — a duplicate or a missing finding is a
 * regression, not a cosmetic difference. `contains` pins the wording that matters.
 */
const CASES = [
  {
    fixture: "minimal.valid.json",
    why: "the config from the skill's minimal template must be clean",
    errors: 0,
    warnings: 0,
    contains: [[null, "/game/scenarioId", "resolves to \"Conflict — Everon\""]],
  },
  {
    fixture: "documented-accepted.json",
    why: "undocumented fields the schema still accepts must not be reported as errors — the server reached 'JSON is Valid' with both set, so reporting them would be a false positive on a valid config",
    errors: 0,
    warnings: 0,
  },
  {
    fixture: "legacy-keys.invalid.json",
    why: "pre-0.9.8.73 field names are reported with their replacement, once each",
    errors: 9,
    warnings: 0,
    contains: [
      ["error", "/gameHostBindAddress", "use bindAddress instead"],
      ["error", "/gameHostRegisterPort", "use publicPort instead"],
      ["error", "/passwordAdmin", "use game.passwordAdmin instead"],
      ["error", "/a2sQueryEnabled", "use the a2s object instead"],
      ["error", "/game/playerCountLimit", "use maxPlayers instead"],
    ],
  },
  {
    fixture: "bad-values.invalid.json",
    why: "schema ranges, patterns, required keys and the platform combination table; serverMinGrassDistance 25 is rejected because 1.8.0.13 enforces a minimum of 50 and the default 0 comes from omitting the key",
    errors: 7,
    warnings: 1,
    contains: [
      ["error", "/a2s/address", "required key is missing"],
      ["error", "/game/maxPlayers", "above the maximum 128"],
      ["error", "/game/gameProperties/serverMinGrassDistance", "minimum allowed is 50"],
      ["error", "/game/scenarioId", "must look like {16 hex}Missions/Name.conf"],
      ["error", "/game/supportedPlatforms", "valid only on a modded server"],
      ["error", "/rcon/password", "minimum is 3"],
      ["warning", "/game/gameProperties/fastValidation", "BI calls true mandatory"],
    ],
  },
  {
    fixture: "clamped.warning.json",
    why: "values the game clamps are warnings, not errors — the server still starts",
    errors: 0,
    warnings: 5,
    contains: [
      ["warning", "/a2s/port", "above the maximum 65535"],
      ["warning", "/rcon/port", "above the maximum 65535"],
      ["warning", "/rcon/address", "bind 127.0.0.1"],
      ["warning", "/publicAddress", "NAT hairpin"],
    ],
  },
  {
    fixture: "name-empty.invalid.json",
    why: "an empty game.name is rejected by the schema, not defaulted — verified by running 1.8.0.13, which wrote 'Param \"#/game/name\" is bellow the minimum limit of value/length. The minimum allowed is 1.'",
    errors: 1,
    warnings: 0,
    contains: [["error", "/game/name", "minimum is 1"]],
  },
  {
    fixture: "name-too-long.invalid.json",
    why: "a 101-character game.name is rejected, not cropped — verified by running 1.8.0.13, which wrote '... has surpassed the maximum limit of value/length. The maximum allowed is 100.' and never wrote the 'Session name exceed max value' crop line",
    errors: 1,
    warnings: 0,
    contains: [["error", "/game/name", "maximum is 100"]],
  },
  {
    fixture: "guid-mismatch.invalid.json",
    why: "a real GUID pasted onto the wrong scenario path is caught",
    errors: 1,
    warnings: 0,
    contains: [["error", "/game/scenarioId", 'belongs to "Missions/23_Campaign.conf"']],
  },
  {
    fixture: "mod-mission.warning.json",
    why: "an unknown GUID is legal for a mod mission, so it is only a warning",
    errors: 0,
    warnings: 1,
    contains: [["warning", "/game/scenarioId", "not one of the 38 vanilla scenarios"]],
  },
  {
    fixture: "missionheader-class.warning.json",
    why: "missionHeader keys are checked against the header class of the chosen scenario",
    errors: 0,
    warnings: 3,
    contains: [
      ["warning", "/m_iStartingHQSupplies", "belongs to SCR_MissionHeaderCampaign"],
      ["warning", "/m_sFactionKey", "nested field of SCR_FactionLimit"],
      ["warning", "/m_totallyMadeUpKey", "not a documented missionHeader key"],
    ],
  },
  {
    fixture: "unknown-keys.invalid.json",
    why: "a case-typo in a key name is an error with a suggestion",
    errors: 3,
    warnings: 0,
    contains: [
      ["error", "/game/maxplayers", 'did you mean "maxPlayers"? Key names are case-sensitive'],
      ["error", "/game/mods/0/modID", 'did you mean "modId"?'],
      ["error", "/game/mods/0/modId", "required key is missing"],
    ],
  },
  {
    fixture: "unknown-keys.invalid.json",
    args: ["--lenient"],
    why: "--lenient downgrades unknown keys to warnings, but a mod entry with no modId at all stays an error",
    errors: 1,
    warnings: 2,
    contains: [
      ["warning", "/game/maxplayers", 'did you mean "maxPlayers"?'],
      ["warning", "/game/mods/0/modID", 'did you mean "modId"?'],
      ["error", "/game/mods/0/modId", "required key is missing"],
    ],
  },
  {
    fixture: "launch-filled.valid.json",
    why: "the config the launch skill produces: RCON on localhost, all consoles, an admin id in the list, and serverMinGrassDistance omitted because build 1.8.0.13 rejects an explicit 0",
    errors: 0,
    warnings: 0,
  },
  {
    path: "skills/arma-reforger-server-launch/assets/config.template.json",
    why: "the file the launch skill hands out is a copy-and-edit starting point, so it must stay schema-valid on its own",
    errors: 0,
    warnings: 0,
  },
];

if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });

let failed = 0;
const fail = (label, message) => {
  failed++;
  console.log(`FAIL  ${label}\n      ${message}`);
};

for (const [i, c] of CASES.entries()) {
  const label = `${c.path ?? c.fixture}${c.args ? " " + c.args.join(" ") : ""}`;
  const reportPath = join(tmp, `report-${i}.json`);
  const expectedExit = c.errors > 0 ? 1 : 0;
  const file = c.path ? join(root, c.path) : join(fixtures, c.fixture);

  const proc = spawnSync(
    process.execPath,
    [validator, file, "--out", reportPath, "--quiet", ...(c.args ?? [])],
    { stdio: "ignore" }
  );

  if (proc.status !== expectedExit) {
    fail(label, `exit code ${proc.status}, expected ${expectedExit}`);
    continue;
  }
  if (!existsSync(reportPath)) {
    fail(label, "--out did not produce a report file");
    continue;
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const problems = [];
  if (report.counts.error !== c.errors) problems.push(`errors ${report.counts.error}, expected ${c.errors}`);
  if (report.counts.warning !== c.warnings) problems.push(`warnings ${report.counts.warning}, expected ${c.warnings}`);

  for (const [severity, pathContains, textContains] of c.contains ?? []) {
    const hit = report.findings.find(
      (f) =>
        (!severity || f.severity === severity) &&
        f.path.includes(pathContains) &&
        f.message.includes(textContains)
    );
    if (!hit) problems.push(`no ${severity ?? "finding"} at ~${pathContains} containing "${textContains}"`);
  }

  if (problems.length) {
    fail(label, problems.join("\n      ") + `\n      — ${c.why}`);
    for (const f of report.findings) console.log(`        [${f.severity}] ${f.path} :: ${f.message.slice(0, 100)}`);
  } else {
    console.log(`OK    ${label}  (${c.errors} error(s), ${c.warnings} warning(s))`);
  }
}

// The JSON Schema itself must stay parseable and must declare the enforced shape.
try {
  const schema = JSON.parse(readFileSync(join(root, "schemas", "server.schema.json"), "utf8"));
  const missing = ["a2s", "rcon", "game", "operating", "bindPort", "publicPort"].filter((k) => !schema.properties[k]);
  if (missing.length) fail("schemas/server.schema.json", `missing top-level properties: ${missing.join(", ")}`);
  else console.log("OK    schemas/server.schema.json parses and declares the expected top-level keys");
} catch (e) {
  fail("schemas/server.schema.json", e.message);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : failed + " TEST(S) FAILED"}`);
process.exit(failed ? 1 : 0);
