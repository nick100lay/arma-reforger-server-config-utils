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
// `out/` and `build/` are gitignored artefacts (extracted game data, a copied tree under test):
// their markdown is not this repository's documentation, and a scratch copy must not fail the check.
const SKIP_DIRS = new Set(["node_modules", "out", "build"]);
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
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

// ---------- 3. markdown tables ----------
// A GitHub-Flavored Markdown table exists only when the delimiter row has the same
// number of cells as the header row; otherwise the whole block silently renders as
// paragraph text. A mismatched body row is not fatal there (GFM pads short rows and
// ignores extra cells), but in these documents it means an unescaped '|' or dropped
// content, so it fails here too.
console.log("\n=== markdown tables ===");
const splitCells = (line) => {
  const cells = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (line[i] === "|") { cells.push(cur); cur = ""; continue; }
    cur += line[i];
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells;
};
const delimiterCells = (line) => {
  // A lone `---` is a horizontal rule / frontmatter fence, not a delimiter row.
  if (!line.includes("|")) return null;
  if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) return null;
  return splitCells(line).length;
};
let tables = 0;
for (const f of docFiles) {
  const rel = f.replace(root + "\\", "").replace(root + "/", "");
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  let fence = null;
  for (let i = 1; i < lines.length; i++) {
    const fenceMark = /^\s*(```|~~~)/.exec(lines[i]);
    if (fenceMark) { fence = fence === null ? fenceMark[1] : null; continue; }
    if (fence !== null) continue;
    const dcols = delimiterCells(lines[i]);
    if (dcols === null) continue;
    const header = lines[i - 1];
    if (!header.includes("|")) { fail(`${rel}:${i + 1}: table header above the delimiter row has no '|'`); continue; }
    tables++;
    const hcols = splitCells(header).length;
    if (hcols !== dcols) {
      fail(`${rel}:${i + 1}: delimiter row has ${dcols} column(s), header has ${hcols} - the table will not render`);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== "" && lines[end].includes("|")) end++;
    for (let j = i + 1; j < end; j++) {
      const rcols = splitCells(lines[j]).length;
      if (rcols !== hcols) fail(`${rel}:${j + 1}: table row has ${rcols} cell(s), header has ${hcols}`);
      // A pipe is a cell boundary even inside an inline code span, so `0x01|seq` in a
      // table silently ends the cell there and the rest of the text disappears. Escape it.
      for (const span of lines[j].matchAll(/`([^`]*)`/g)) {
        if (/(^|[^\\])\|/.test(span[1])) fail(`${rel}:${j + 1}: unescaped '|' inside ${span[0]} ends the cell early`);
      }
    }
    i = end - 1;
  }
}
if (errors === 0) console.log(`OK   ${tables} table(s) well formed`);

console.log(`\n${errors === 0 ? "ALL CHECKS PASSED" : errors + " PROBLEM(S)"}`);
process.exit(errors ? 1 : 0);
