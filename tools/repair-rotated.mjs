// Repair a pak-extracted text file that has been cyclically shifted at an arbitrary
// byte offset (not necessarily at a line boundary). Finds the split by locating a
// trailing fragment that is the true head of the file: a partial line whose end, when
// prefixed to the buffer, forms a valid opening.
//
// Usage: node tools/repair-rotated.mjs <file> <headRegex>
//   headRegex - a regex that the FIRST LINE of the repaired file must match.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const [file, headRegex] = process.argv.slice(2);
if (!file || !headRegex) { console.error("usage: node tools/repair-rotated.mjs <file> <headRegex>"); process.exit(1); }

const buf = readFileSync(file);
const s = buf.toString("latin1");
const re = new RegExp(headRegex);

// Candidate split points: every newline + 1, scanning from the end backwards.
const candidates = [];
for (let i = s.length - 1; i >= 0; i--) if (s[i] === "\n") candidates.push(i + 1);

let chosen = -1, firstLine = null;
for (const cut of candidates) {
  const rotated = s.slice(cut) + s.slice(0, cut);
  const fl = rotated.split("\n")[0];
  if (re.test(fl)) { chosen = cut; firstLine = fl; break; }
}

if (chosen < 0) {
  console.error(`no split point produced a first line matching ${headRegex}`);
  console.error(`first 120 bytes of file: ${JSON.stringify(s.slice(0, 120))}`);
  process.exit(2);
}

copyFileSync(file, file + ".orig");
const rotated = Buffer.concat([buf.subarray(chosen), buf.subarray(0, chosen)]);
writeFileSync(file, rotated);
console.log(`repaired ${file}: split at ${chosen}/${buf.length}`);
console.log(`  first line: ${firstLine}`);
