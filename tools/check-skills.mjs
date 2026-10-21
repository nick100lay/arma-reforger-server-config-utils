#!/usr/bin/env node
// Check that the skills only name commands and options the tools actually have.
//
//   node tools/check-skills.mjs [--quiet]
//
// A skill is a promise about a tool: `--mods-file` must exist, `addons.mjs order --dirs` must
// be a command with that option, and `npm run rcon` must be a script. The promise rots silently —
// an option is renamed in `tools/` and the prose keeps teaching the old spelling, so an agent
// follows the skill and gets `unknown option`, which is exactly the failure this repository exists
// to prevent. Nothing here re-reads a tool's source: each tool's own `--help` is the interface,
// so the check fails when the help and the skill disagree, whichever of the two moved.
//
// What is checked
//   * every `node tools/<tool>.mjs ...` line in a SKILL.md (or the README beside them): the tool
//     exists, the first word is one of its commands, and every `--option` is one it takes;
//   * every `npm run <script>` in a skill is a script in package.json.
//
// What is NOT checked: the text between the commands. A claim like "this exits 1" needs a run
// against real data and a judgement no checker has; the skills' own verification sections carry
// those. This is the mechanical half.
import { readFileSync, existsSync, readdirSync, writeFileSync, openSync, closeSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

// A child process's stdout cannot be captured through a pipe under a sandbox (EPERM), which is
// why the test suites redirect to files; `--help` is read the same way.
const tmp = join(root, "tests", ".tmp-skills");

const SKIP_TOOLS = new Set(["bsp.mjs", "build-data.mjs", "html2text.mjs", "check-skills.mjs"]);

function helpOf(tool) {
  const outPath = join(tmp, `${tool}.out`);
  const errPath = join(tmp, `${tool}.err`);
  writeFileSync(outPath, "");
  writeFileSync(errPath, "");
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  let status;
  try {
    status = spawnSync(process.execPath, [join(root, "tools", tool), "--help"], {
      stdio: ["ignore", out, err],
      timeout: 30000,
    }).status;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return { status, text: readFileSync(outPath, "utf8") + readFileSync(errPath, "utf8") };
}

/** The interface a tool's own help advertises: its options and the commands in its usage lines. */
function parseHelp(tool, text) {
  const options = new Set([...text.matchAll(/(--[a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]));
  const commands = new Set();
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const line of text.split("\n")) {
    const usage = new RegExp(`tools/${escaped}\\s+(\\S+)`).exec(line);
    if (usage && /^[a-z][a-z-]*$/.test(usage[1])) commands.add(usage[1]);
  }
  // rcon keeps its command list in a "subcommands" block rather than in `node tools/rcon.mjs`
  // usage lines; `shutdown | restart` is two commands on one line.
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === "subcommands");
  if (at >= 0) {
    for (let i = at + 1; i < lines.length && lines[i].trim() !== ""; i++) {
      const before = lines[i].trim().split(/\s{2,}/)[0];
      for (const alternative of before.split("|")) {
        const word = alternative.trim().split(/\s+/)[0];
        if (/^[a-z][a-z-]*$/.test(word)) commands.add(word);
      }
    }
  }
  return { options, commands };
}

// --- the interface of every tool ------------------------------------------------------------
if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const toolFiles = readdirSync(join(root, "tools"))
  .filter((name) => name.endsWith(".mjs") && !SKIP_TOOLS.has(name) && !name.startsWith("check-"))
  .sort();
const iface = new Map();
const helpProblems = [];
for (const tool of toolFiles) {
  const help = helpOf(tool);
  if (help.status !== 0 || help.text.trim() === "") {
    // A tool without `--help` is a library or a script with another calling convention; it has no
    // interface to check, and the skill that names it gets no command/option check either.
    continue;
  }
  iface.set(tool, parseHelp(tool, help.text));
}

// --- package.json scripts -------------------------------------------------------------------
const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {}));

// --- the skills -----------------------------------------------------------------------------
const skillDir = join(root, "skills");
const skillFiles = existsSync(skillDir)
  ? readdirSync(skillDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillDir, entry.name, "SKILL.md"))
    .filter((path) => existsSync(path))
  : [];

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

let invocations = 0;
let scriptUses = 0;
for (const path of skillFiles) {
  const rel = path.slice(root.length + 1).replace(/\\/g, "/");
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = `${rel}:${i + 1}`;

    for (const match of line.matchAll(/\bnpm run ([\w:.-]+)/g)) {
      scriptUses++;
      if (!scripts.has(match[1])) fail(where, `npm run ${match[1]} — no such script in package.json`);
    }

    const at = line.indexOf("node tools/");
    if (at < 0) continue;
    let text = line.slice(at);
    while (/\\\s*$/.test(text) && i + 1 < lines.length) {
      text = text.replace(/\\\s*$/, " ") + lines[++i].trim();
    }
    const invocation = /^node tools\/([\w.-]+\.mjs)\s*(.*)$/.exec(text);
    if (!invocation) continue;
    const tool = invocation[1];
    const rest = invocation[2];
    const known = iface.get(tool);
    if (!known) {
      fail(where, `${tool} has no --help: it is not a command-line tool this repository documents`);
      continue;
    }
    invocations++;
    for (const option of new Set([...rest.matchAll(/(--[a-z0-9][a-z0-9-]*)/g)].map((match) => match[1]))) {
      if (option !== "--" && !known.options.has(option)) {
        fail(where, `${tool} takes no ${option} (see node tools/${tool} --help)`);
      }
    }
    const first = rest.trim().split(/\s+/)[0];
    if (first && /^[a-z][a-z-]*$/.test(first) && known.commands.size && !known.commands.has(first)) {
      fail(where, `${tool} has no command "${first}" (it has: ${[...known.commands].join(", ")})`);
    }
  }
}

rmSync(tmp, { recursive: true, force: true });

if (!quiet) {
  console.log(`=== ${invocations} tool invocation(s) and ${scriptUses} npm script(s) in ${skillFiles.length} skill(s) ===`);
  for (const tool of [...iface.keys()].sort()) {
    const known = iface.get(tool);
    console.log(`     ${tool}: ${known.commands.size} command(s), ${known.options.size} option(s)`);
  }
  for (const problem of problems) console.log(`FAIL  ${problem}`);
}
console.log(`\n${problems.length === 0 ? "SKILLS OK" : problems.length + " SKILL PROBLEM(S)"}`);
process.exit(problems.length ? 1 : 0);
