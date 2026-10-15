// Validate ```json fenced blocks in markdown.
//
// Handles three cases that all occur in this workspace's documents:
//   1. a full JSON document            -> parsed as is
//   2. a member fragment, e.g.         -> re-wrapped as { ... } and parsed
//        "mods": [ ... ]
//   3. a block nested inside a         -> leading "> " markers stripped first,
//      blockquote ("> ```json")           otherwise JSON.parse sees ">" and fails
//
// Any ```json block that is deliberately NOT valid JSON should be fenced as ```text
// instead, so that a failure here always means a real mistake.
//
// Usage:  node tools/validate-doc-json.mjs [file.md ...]
//         With no arguments every markdown file in the repository is checked, which is
//         what `npm run check:json` does — the explicit form exists for a quick check of
//         one document while editing it.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every markdown file below `dir`, skipping dotted directories and node_modules. */
function collectMarkdown(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collectMarkdown(full, out);
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.length > 2 ? process.argv.slice(2) : collectMarkdown(repoRoot).sort();
console.log(`=== json blocks in ${files.length} markdown document(s) ===`);
let total = 0, bad = 0, frag = 0, quoted = 0;

/** Remove blockquote markers and their single following space. */
function unquote(s) {
  return s.split(/\r?\n/).map(l => l.replace(/^[ \t]*>[ \t]?/, "")).join("\n");
}

for (const f of files) {
  const text = readFileSync(f, "utf8");
  const re = /```json\r?\n([\s\S]*?)```/g;
  let m, i = 0;
  while ((m = re.exec(text)) !== null) {
    i++; total++;
    const rawBody = m[1];
    const line = text.slice(0, m.index).split("\n").length;

    // Detect blockquote nesting before stripping, for reporting only.
    const inQuote = /^[ \t]*>/.test(rawBody.split(/\r?\n/)[0] ?? "");
    const body = inQuote ? unquote(rawBody) : rawBody;
    if (inQuote) quoted++;

    const trimmed = body.trim();
    let kind = "doc", obj = null, err = null;
    try {
      obj = JSON.parse(trimmed);
    } catch (e1) {
      try { obj = JSON.parse("{" + trimmed + "}"); kind = "fragment"; frag++; }
      catch (e2) { err = e2; }
    }

    const where = `${f} block#${i} (line ${line})${inQuote ? " [in blockquote]" : ""}`;
    if (err) {
      bad++;
      console.log(`FAIL ${where}: ${err.message}`);
      const mm = /position (\d+)/.exec(err.message);
      if (mm) {
        const pos = parseInt(mm[1], 10);
        const ln = trimmed.slice(0, pos).split("\n").length;
        console.log(`     near line ${ln}: ${trimmed.split("\n")[ln - 1]}`);
      }
    } else {
      console.log(`OK   [${kind}] ${where}  keys: ${Object.keys(obj).join(", ")}`);
    }
  }
}

console.log(`\nTOTAL ${total} json blocks (${frag} fragments, ${quoted} in blockquotes), ${bad} invalid`);
process.exit(bad ? 1 : 0);
