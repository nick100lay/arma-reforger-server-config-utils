// Convert a saved MediaWiki HTML page to plain text with heading markers preserved.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
let html = readFileSync(input, "utf8");

// Drop everything that never carries article text.
html = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
html = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
html = html.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
html = html.replace(/<!--[\s\S]*?-->/g, " ");
// MediaWiki chrome: edit links, nav boxes, table of contents, references toolbar
html = html.replace(/<div[^>]*class="[^"]*mw-editsection[^"]*"[\s\S]*?<\/div>/gi, " ");
html = html.replace(/<div[^>]*id="toc"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, " ");
html = html.replace(/<table[^>]*class="[^"]*(navbox|vertical-navbox|metadata)[^"]*"[\s\S]*?<\/table>/gi, " ");

// Turn structural tags into markers so the outline survives.
html = html.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) =>
  "\n\n" + "#".repeat(Number(lvl)) + " " + strip(inner) + "\n");
html = html.replace(/<li[^>]*>/gi, "\n- ");
html = html.replace(/<\/(p|div|tr|ul|ol|table|blockquote|pre)>/gi, "\n");
html = html.replace(/<t[dh][^>]*>/gi, " | ");
html = html.replace(/<br\s*\/?>/gi, "\n");
html = html.replace(/<[^>]+>/g, ""); // remaining tags

function strip(s) { return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); }

// HTML entities
const ents = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&minus;": "-", "&ndash;": "-", "&mdash;": "-", "&rarr;": "->", "&hellip;": "..." };
html = html.replace(/&[a-zA-Z#0-9]+;/g, (m) => ents[m] ?? m);

// Collapse whitespace
let text = html
  .split("\n")
  .map(l => l.replace(/[ \t]+/g, " ").replace(/^\s*\|\s*$/, "").trimEnd())
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

writeFileSync(output, text, "utf8");
console.log(`wrote ${output}: ${text.length} chars, ${text.split("\n").length} lines`);
