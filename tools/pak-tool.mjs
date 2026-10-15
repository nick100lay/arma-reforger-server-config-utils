// Extract a file from an Arma Reforger .pak by virtual path, or scan a pak for a needle.
// Usage:
//   node pak-tool.mjs get <pak> <virtualPath> <outFile>
//   node pak-tool.mjs find <pak> <needle> [maxEntrySize]
//   node pak-tool.mjs list <pak> <regex> [limit]
import { openSync, readSync, closeSync, fstatSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const MAGIC_FORM = 0x464f524d, MAGIC_PAC1 = 0x50414331;
const MAGIC_HEAD = 0x48454144, MAGIC_DATA = 0x44415441, MAGIC_FILE = 0x46494c45;

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  if (n < length) throw new Error(`EOF at ${position} (want ${length}, got ${n})`);
  return buf;
}

function parsePakIndex(pakPath) {
  const fd = openSync(pakPath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const form = readAt(fd, 0, 12);
    if (form.readUInt32BE(0) !== MAGIC_FORM) throw new Error("not a pak (no FORM)");
    let pos = 12, dataStart = -1, fileChunkOffset = -1, fileChunkLen = 0;
    while (pos + 8 <= fileSize) {
      const hdr = readAt(fd, pos, 8);
      const magic = hdr.readUInt32BE(0), chunkLen = hdr.readUInt32BE(4);
      if (magic === MAGIC_HEAD) pos += 8 + chunkLen;
      else if (magic === MAGIC_DATA) { dataStart = pos + 8; pos += 8 + chunkLen; }
      else if (magic === MAGIC_FILE) { fileChunkOffset = pos + 8; fileChunkLen = chunkLen; break; }
      else pos += 8 + chunkLen;
    }
    if (dataStart < 0 || fileChunkOffset < 0) throw new Error("missing DATA/FILE chunk");
    const fileBuf = readAt(fd, fileChunkOffset, fileChunkLen);
    const state = { offset: 0 };
    const root = parseEntry(fileBuf, state);
    return { root, dataStart, pakPath, fd };
  } catch (e) { closeSync(fd); throw e; }
}

function parseEntry(buf, state) {
  const kind = buf.readUInt8(state.offset); state.offset += 1;
  const nameLen = buf.readUInt8(state.offset); state.offset += 1;
  const name = buf.toString("utf8", state.offset, state.offset + nameLen); state.offset += nameLen;
  if (kind === 0) {
    const childCount = buf.readUInt32LE(state.offset); state.offset += 4;
    const children = [];
    for (let i = 0; i < childCount; i++) children.push(parseEntry(buf, state));
    return { kind: "dir", name, children };
  }
  const offset = buf.readUInt32LE(state.offset); state.offset += 4;
  const compressedLen = buf.readUInt32LE(state.offset); state.offset += 4;
  const decompressedLen = buf.readUInt32LE(state.offset); state.offset += 4;
  state.offset += 6;
  const compressed = buf.readUInt8(state.offset) !== 0; state.offset += 1;
  state.offset += 5;
  return { kind: "file", name, offset, compressedLen, decompressedLen, compressed };
}

function walk(node, prefix, out) {
  if (node.kind === "file") { out.push({ path: prefix + node.name, ...node }); return; }
  for (const c of node.children) walk(c, node.name === "" ? prefix : prefix + node.name + "/", out);
}

function readEntry(idx, e) {
  const raw = readAt(idx.fd, idx.dataStart + e.offset, e.compressedLen);
  if (!e.compressed) return raw;
  return inflateSync(raw);
}

const [cmd, pakPath, a, b] = process.argv.slice(2);
const idx = parsePakIndex(pakPath);
const entries = [];
walk(idx.root, "", entries);

if (cmd === "get") {
  const want = a.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  const e = entries.find(x => x.path.replace(/\/+/g, "/") === want)
         || entries.find(x => x.path.replace(/\/+/g, "/").toLowerCase() === want.toLowerCase());
  if (!e) { closeSync(idx.fd); console.error(`NOT FOUND: ${want}`); process.exit(2); }
  const data = readEntry(idx, e);
  writeFileSync(b, data);
  console.log(`OK ${e.path}: ${e.compressed ? "deflated " : "raw "}${e.compressedLen} -> ${data.length} bytes -> ${b}`);
} else if (cmd === "find") {
  const needle = a, maxSize = parseInt(b || "60000", 10);
  let scanned = 0, hits = 0;
  for (const e of entries) {
    if (!e.decompressedLen || e.decompressedLen > maxSize) continue;
    let data; try { data = readEntry(idx, e); } catch { continue; }
    scanned++;
    const s = data.toString("latin1");
    const i = s.indexOf(needle);
    if (i >= 0) {
      console.log(`HIT ${e.path} (${e.decompressedLen}B)`);
      console.log("   ..." + s.substring(Math.max(0, i - 200), i + 250).replace(/[\x00-\x1f]/g, ".") + "...");
      if (++hits >= 15) break;
    }
  }
  console.log(`# scanned ${scanned}, hits ${hits}`);
} else if (cmd === "list") {
  const re = new RegExp(a, "i");
  const lim = parseInt(b || "100", 10);
  const hits = entries.filter(e => re.test(e.path));
  console.log(`${pakPath}: ${entries.length} entries, ${hits.length} match /${a}/i`);
  for (const h of hits.slice(0, lim)) console.log(`${h.path}\t${h.decompressedLen}\t${h.compressed ? "C" : "raw"}`);
}
closeSync(idx.fd);
