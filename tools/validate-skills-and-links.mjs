// Validate SKILL.md frontmatter and all relative markdown links in the workspace docs.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const root = process.cwd();
let errors = 0;
const fail = (m) => { console.log("FAIL " + m); errors++; };

// ---------- 1. SKILL.md frontmatter ----------
console.log("=== SKILL.md frontmatter ===");
const skillsDir = join(root, "skills");
if (!existsSync(skillsDir)) fail("no skills/ directory");
else {
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    // Only directories are skills; skills/README.md is documentation about them.
    if (!entry.isDirectory()) continue;
    const d = entry.name;
    const before = errors;
    const p = join(skillsDir, d, "SKILL.md");
    if (!existsSync(p)) { fail(`${d}/SKILL.md missing`); continue; }
    const text = readFileSync(p, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!m) { fail(`${d}: no YAML frontmatter block`); continue; }
    const fm = m[1];
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    if (!name) fail(`${d}: missing 'name'`);
    if (!desc) fail(`${d}: missing 'description'`);
    if (name && name !== d) fail(`${d}: frontmatter name '${name}' != directory name`);
    if (desc && (desc.length < 80 || desc.length > 1100)) fail(`${d}: description length ${desc.length} (want 80..1100)`);
    // frontmatter must be plain single-line scalars (no ':' unquoted issues that break YAML)
    for (const line of fm.split(/\r?\n/)) {
      if (!/^(name|description):\s*\S/.test(line)) fail(`${d}: unexpected frontmatter line: ${line.slice(0, 60)}`);
    }
    if (errors === before) console.log(`OK   ${d}  name=${name}  desc=${desc.length} chars`);
    const body = text.slice(m[0].length);
    console.log(`     body: ${body.split("\n").length} lines, ${body.length} chars`);
  }
}

// ---------- 2. relative markdown links ----------
console.log("\n=== relative markdown links ===");
const docFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith(".md")) docFiles.push(full);
  }
};
walk(root);

for (const f of docFiles) {
  const text = readFileSync(f, "utf8");
  const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const target = m[2];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = target.split("#")[0];
    if (!clean) continue;
    const abs = resolve(dirname(f), decodeURIComponent(clean));
    const ok = existsSync(abs);
    const rel = f.replace(root + "\\", "").replace(root + "/", "");
    if (!ok) fail(`${rel}: broken link -> ${target}`);
    else console.log(`OK   ${rel} -> ${target}`);
  }
}

console.log(`\n${errors === 0 ? "ALL CHECKS PASSED" : errors + " PROBLEM(S)"}`);
process.exit(errors ? 1 : 0);
