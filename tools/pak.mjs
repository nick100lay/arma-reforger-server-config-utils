// Read Arma Reforger PAC1 archives (.pak): list, inspect, extract, search, verify.
//
//   node tools/pak.mjs info   <pak> [--json]
//   node tools/pak.mjs list   <pak> [pathRegex] [--limit N] [--json]
//   node tools/pak.mjs tree   <pak> [pathRegex]
//   node tools/pak.mjs get    <pak> <virtualPath> <outFile> [--raw] [--verbose]
//   node tools/pak.mjs cat    <pak> <virtualPath> [--raw]
//   node tools/pak.mjs find   <pak> <needle> [--max-size N] [--limit N] [--path-regex RE]
//   node tools/pak.mjs verify <pak> [--sample N]
//
// `get` takes a file *or* a directory and extracts the whole subtree of the
// latter; "/" is the archive root, so `get <pak> / <dir>` dumps every entry.
// <outFile> names the destination, and an existing directory (or a path ending
// in a separator) means "inside it, under the entry's own name" -- the rule
// `cp -r` uses. Destination paths this platform cannot create are refused by
// name before anything is written; see "Output paths" below.
//
// Also usable as a library:
//   import { openPak, findEntry, findTarget } from "./pak.mjs";
//   const pak = openPak(path); pak.entries; pak.dirs; pak.read(entry);
//
// ---------------------------------------------------------------------------
// The container, as measured on the installed 1.8.0.13 client and server
// archives (all 24 .pak files under addons/, 190 000+ entries):
//
//   offset 0   "FORM" + u32BE size + "PAC1"                    (12 bytes)
//   then chunks, each `u32BE magic + u32BE bodyLength + body`:
//     "HEAD" -> 28 bytes of pack metadata, skip
//     "DATA" -> all entry payloads, back to back, in index order
//     "FILE" -> the entry tree, and the last chunk in every observed pak
//
// Entry tree, read sequentially (u8 kind, u8 nameLength, name, then):
//     kind 0 (directory): u32LE childCount, childCount entries
//     kind 1 (file):      u32LE offset          <-- ABSOLUTE file offset, see below
//                         u32LE storedLength
//                         u32LE originalLength  (0 for a directory-like stub)
//                         4 bytes, always zero in every archive observed
//                         u32BE compressionType: 0 = stored, 0x106 = zlib
//                         u32LE timestamp       (pack time, seconds since epoch)
//
// `offset` is measured from the start of the .pak file, NOT from the start of
// the DATA chunk body. The two differ by 56 bytes in every archive here -- the
// 12-byte FORM header, the 8+28-byte HEAD chunk and the 8-byte DATA chunk
// header -- and reading from the wrong base is exactly the defect that made
// earlier tools report `incorrect header check` on compressed files and hand
// back cyclically shifted text for stored ones. `verify` checks the choice on
// the archive in front of it; `--data-relative` reproduces the old behaviour
// so an extract made with the broken tool can be recognised.
//
// Compression types other than 0 and 0x106 have never been observed; if one
// appears, `read()` refuses to guess and `--raw` writes the stored bytes.
// ---------------------------------------------------------------------------

import { openSync, readSync, closeSync, fstatSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAGIC_FORM = 0x464f524d; // "FORM"
export const MAGIC_PAC1 = 0x50414331; // "PAC1"
export const CHUNK_HEAD = 0x48454144; // "HEAD"
export const CHUNK_DATA = 0x44415441; // "DATA"
export const CHUNK_FILE = 0x46494c45; // "FILE"

export const COMPRESSION_STORED = 0x0;
export const COMPRESSION_ZLIB = 0x106;

const COMPRESSION_NAMES = {
  [COMPRESSION_STORED]: "stored",
  [COMPRESSION_ZLIB]: "zlib",
};

export function compressionName(type) {
  return COMPRESSION_NAMES[type] ?? `unknown(0x${type.toString(16)})`;
}

/** Read exactly `length` bytes at `position`, or throw with the position in the message. */
function readAt(fd, position, length, what) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  if (n < length) {
    throw new Error(
      `truncated archive: wanted ${length} bytes of ${what} at offset ${position}, got ${n}`,
    );
  }
  return buf;
}

export class PakEntry {
  constructor({ path, kind, offset, storedLength, originalLength, zeroField, compressionType, timestamp }) {
    this.path = path;
    this.kind = kind; // "file" | "dir"
    this.offset = offset;
    this.storedLength = storedLength;
    this.originalLength = originalLength;
    this.zeroField = zeroField;
    this.compressionType = compressionType;
    this.timestamp = timestamp; // Date, or null for a directory
    this.children = kind === "dir" ? [] : null;
  }
  get name() {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
}

export class Pak {
  constructor(fd, path, { chunks, dataStart, dataLength, fileChunkOffset, fileChunkLength, root, entries, dirs }) {
    this.fd = fd;
    this.path = path;
    this.chunks = chunks;
    this.dataStart = dataStart;
    this.dataLength = dataLength;
    this.fileChunkOffset = fileChunkOffset;
    this.fileChunkLength = fileChunkLength;
    this.root = root;
    this.entries = entries;
    /** Every directory in the index except the unnamed root, in tree order. */
    this.dirs = dirs;
    this.closed = false;
  }

  close() {
    if (!this.closed) {
      closeSync(this.fd);
      this.closed = true;
    }
  }

  /** Read the payload bytes of one entry. Returns raw stored bytes when `raw` is true. */
  read(entry, { raw = false, dataRelative = false } = {}) {
    const at = dataRelative ? this.dataStart + entry.offset : entry.offset;
    if (entry.storedLength === 0) return Buffer.alloc(0);
    const bytes = readAt(this.fd, at, entry.storedLength, `entry ${entry.path}`);
    if (raw || entry.compressionType === COMPRESSION_STORED) return bytes;
    if (entry.compressionType !== COMPRESSION_ZLIB) {
      throw new Error(
        `entry ${entry.path} uses compression type ${compressionName(entry.compressionType)}, ` +
          `which this tool does not know how to decompress; re-run with --raw to get the stored bytes`,
      );
    }
    try {
      const out = inflateSync(bytes);
      return out;
    } catch (err) {
      throw new Error(
        `entry ${entry.path} did not inflate (${err.code ?? err.message}) from offset ${at}; ` +
          `this is the signature of a wrong offset base -- run \`node tools/pak.mjs verify ${this.path}\``,
      );
    }
  }
}

/** Walk the FILE chunk tree. Returns the root entry plus the flat file and directory lists. */
function parseTree(buf) {
  let pos = 0;
  const files = [];
  const dirs = [];

  function parseOne(prefix) {
    const kind = buf.readUInt8(pos); pos += 1;
    const nameLength = buf.readUInt8(pos); pos += 1;
    const name = buf.toString("utf8", pos, pos + nameLength); pos += nameLength;
    // The root entry has an empty name; skip it so paths never start with "/".
    const childPrefix = name ? prefix + name + "/" : prefix;
    if (kind === 0) {
      const entry = new PakEntry({ path: prefix + name, kind: "dir" });
      // The unnamed root is not an addressable path, so it stays out of `dirs`.
      if (name) dirs.push(entry);
      const childCount = buf.readUInt32LE(pos); pos += 4;
      for (let i = 0; i < childCount; i++) entry.children.push(parseOne(childPrefix));
      return entry;
    }
    if (kind !== 1) {
      throw new Error(`unexpected entry kind ${kind} in the FILE chunk at byte ${pos - 2 - nameLength}`);
    }
    const offset = buf.readUInt32LE(pos); pos += 4;
    const storedLength = buf.readUInt32LE(pos); pos += 4;
    const originalLength = buf.readUInt32LE(pos); pos += 4;
    const zeroField = buf.readUInt32LE(pos); pos += 4;
    const compressionType = buf.readUInt32BE(pos); pos += 4;
    const timestamp = buf.readUInt32LE(pos); pos += 4;
    const entry = new PakEntry({
      path: prefix + name,
      kind: "file",
      offset,
      storedLength,
      originalLength,
      zeroField,
      compressionType,
      timestamp: timestamp > 0 ? new Date(timestamp * 1000) : null,
    });
    files.push(entry);
    return entry;
  }

  const root = parseOne("");
  return { root, files, dirs, consumed: pos, leftover: buf.length - pos };
}

/** Open an archive and parse its index. The caller owns the returned Pak and must close() it. */
export function openPak(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 16) throw new Error(`${path} is too small to be a PAC1 archive`);
    const form = readAt(fd, 0, 12, "the FORM header");
    if (form.readUInt32BE(0) !== MAGIC_FORM) {
      throw new Error(`${path} does not start with "FORM" -- not a PAC1 archive`);
    }
    if (form.readUInt32BE(8) !== MAGIC_PAC1) {
      throw new Error(`${path} has FORM but not PAC1 at offset 8 -- not a PAC1 archive`);
    }
    const formLength = form.readUInt32BE(4);

    const chunks = [];
    let dataStart = -1, dataLength = 0, fileChunkOffset = -1, fileChunkLength = 0;
    let pos = 12;
    while (pos + 8 <= size) {
      const header = readAt(fd, pos, 8, "a chunk header");
      const magic = header.readUInt32BE(0);
      const length = header.readUInt32BE(4);
      const name = magic === CHUNK_HEAD ? "HEAD"
        : magic === CHUNK_DATA ? "DATA"
        : magic === CHUNK_FILE ? "FILE"
        : `0x${magic.toString(16)}`;
      chunks.push({ name, offset: pos, bodyOffset: pos + 8, length });
      if (magic === CHUNK_DATA && dataStart < 0) {
        dataStart = pos + 8;
        dataLength = length;
      }
      if (magic === CHUNK_FILE) {
        fileChunkOffset = pos + 8;
        fileChunkLength = length;
        break;
      }
      pos += 8 + length;
    }
    if (fileChunkOffset < 0) throw new Error(`${path} has no FILE chunk -- the index cannot be read`);
    if (dataStart < 0) throw new Error(`${path} has no DATA chunk`);
    if (fileChunkOffset + fileChunkLength > size) {
      throw new Error(
        `${path} is truncated: the FILE chunk claims ${fileChunkLength} bytes at ${fileChunkOffset}, ` +
          `but the file is ${size} bytes`,
      );
    }

    const fileBuf = readAt(fd, fileChunkOffset, fileChunkLength, "the FILE chunk");
    const { root, files, dirs, consumed, leftover } = parseTree(fileBuf);
    if (leftover > 0) {
      throw new Error(
        `the FILE chunk of ${path} has ${leftover} bytes left after ${files.length} entries ` +
          `(parsed ${consumed} of ${fileBuf.length}); the index is not a plain entry tree`,
      );
    }
    return new Pak(fd, path, { chunks, dataStart, dataLength, fileChunkOffset, fileChunkLength, root, entries: files,
      dirs, formLength, size });
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** Normalise a virtual path for comparison: leading slash optional, backslashes allowed. */
export function normalisePath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Find one *file* entry by virtual path (with or without a leading slash). Throws
 * when absent. Directories are not entries; use findTarget to resolve either.
 */
export function findEntry(pak, virtualPath) {
  const want = normalisePath(virtualPath);
  const lowered = want.toLowerCase();
  let hit = pak.entries.find((e) => normalisePath(e.path) === want);
  if (!hit) hit = pak.entries.find((e) => normalisePath(e.path).toLowerCase() === lowered);
  if (!hit) {
    const near = pak.entries
      .filter((e) => normalisePath(e.path).toLowerCase().endsWith(lowered.split("/").pop()))
      .slice(0, 5)
      .map((e) => `    ${normalisePath(e.path)}`);
    throw new Error(
      `no entry "${want}" in ${pak.path}` + (near.length ? `\n  similarly named entries:\n${near.join("\n")}` : ""),
    );
  }
  return hit;
}

/**
 * Resolve a virtual path to either one file entry or one directory.
 *
 * A path of only separators (or an empty one) is the archive **root**: it has no
 * name of its own, and extracting it means every entry in the archive. Files win
 * over directories of the same name, exact case wins over a case-insensitive hit,
 * and a miss reports the near-matching names of both kinds -- a path that names a
 * directory is the common mistake, and `get` accepts it.
 * Returns { kind: "file"|"dir", entry, path, name }.
 */
export function findTarget(pak, virtualPath) {
  const want = normalisePath(virtualPath);
  if (want === "") return { kind: "dir", entry: pak.root, path: "", name: "" };
  const lowered = want.toLowerCase();
  const byPath = (list) =>
    list.find((e) => normalisePath(e.path) === want) ??
    list.find((e) => normalisePath(e.path).toLowerCase() === lowered);

  const file = byPath(pak.entries);
  if (file) return { kind: "file", entry: file, path: normalisePath(file.path), name: file.name };
  const dir = byPath(pak.dirs);
  if (dir) return { kind: "dir", entry: dir, path: normalisePath(dir.path), name: dir.name };

  const tail = lowered.split("/").pop();
  const all = [
    ...pak.entries.map((e) => normalisePath(e.path)),
    ...pak.dirs.map((d) => `${normalisePath(d.path)}/`),
  ];
  // The exact tail first, then anywhere in the path, then tolerating one wrong
  // last character -- the typos that actually happen when a path is copied.
  const attempts = [
    (p) => p.toLowerCase().endsWith(tail),
    (p) => tail.length > 2 && p.toLowerCase().includes(tail),
    (p) => tail.length > 3 && p.toLowerCase().includes(tail.slice(0, -1)),
  ];
  let near = [];
  for (const test of attempts) {
    near = all.filter(test);
    if (near.length) break;
  }
  near = near.slice(0, 5).map((p) => `    ${p}`);
  throw new Error(
    `no entry or directory "${want}" in ${pak.path}` +
      (near.length ? `\n  similarly named paths:\n${near.join("\n")}` : ""),
  );
}

/**
 * Decide whether this archive's offsets are absolute or relative to the DATA body.
 * Compressed entries start with a zlib header (0x78, then a byte that makes the
 * 16-bit value a multiple of 31), so a handful of them is enough to tell the two
 * bases apart. Returns { base, absoluteHits, relativeHits, tested }.
 */
export function detectOffsetBase(pak) {
  const candidates = pak.entries.filter((e) => e.compressionType === COMPRESSION_ZLIB && e.storedLength >= 2).slice(0, 64);
  let absoluteHits = 0, relativeHits = 0;
  for (const e of candidates) {
    const probe = (at) => {
      if (at < 0 || at + 2 > pak.fileChunkOffset) return false;
      const b = readAt(pak.fd, at, 2, `probe for ${e.path}`);
      return b[0] === 0x78 && ((b[0] << 8) | b[1]) % 31 === 0;
    };
    if (probe(e.offset)) absoluteHits++;
    if (probe(pak.dataStart + e.offset)) relativeHits++;
  }
  const base = absoluteHits >= relativeHits ? "absolute" : "data-relative";
  return { base, absoluteHits, relativeHits, tested: candidates.length };
}

/** Structural checks over the whole index. Returns { checked, problems[] }. */
export function verifyPak(pak, { sample = 50, dataRelative = false } = {}) {
  const problems = [];
  const dataEnd = pak.dataStart + pak.dataLength;
  const base = dataRelative ? pak.dataStart : 0;
  let storedMismatch = 0;
  for (const e of pak.entries) {
    if (e.offset + base < pak.dataStart || e.offset + base + e.storedLength > dataEnd) {
      problems.push(
        `${e.path}: payload at ${e.offset}..${e.offset + e.storedLength} falls outside the DATA body ` +
          `(${pak.dataStart}..${dataEnd})`,
      );
      continue;
    }
    if (e.compressionType === COMPRESSION_STORED && e.storedLength !== e.originalLength) {
      storedMismatch++;
      problems.push(
        `${e.path}: stored entry with storedLength ${e.storedLength} != originalLength ${e.originalLength}`,
      );
    }
    if (e.zeroField !== 0) problems.push(`${e.path}: the reserved field is ${e.zeroField}, not 0`);
  }
  if (storedMismatch) problems.push(`${storedMismatch} stored entries disagree about their own length`);

  const compressed = pak.entries.filter((e) => e.compressionType === COMPRESSION_ZLIB);
  const step = Math.max(1, Math.floor(compressed.length / Math.max(1, sample)));
  let inflated = 0, sampled = 0;
  for (let i = 0; i < compressed.length; i += step) {
    const e = compressed[i];
    sampled++;
    try {
      const out = pak.read(e, { dataRelative });
      if (out.length !== e.originalLength) {
        problems.push(`${e.path}: inflated to ${out.length} bytes, index says ${e.originalLength}`);
      } else inflated++;
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { checked: pak.entries.length, compressed: compressed.length, inflated, sampled, problems };
}

// ---------------------------------------------------------------------------
// Output paths
//
// `get` writes real files, so a destination it cannot create has to fail with a
// sentence about the path instead of a bare `ENOENT: no such file or directory`.
// That is not a cosmetic difference: on Windows a component containing one of
// `<>:"|?*`, a reserved device name (`CON`, `NUL`, `COM1`..), or a name longer
// than 255 characters makes `mkdirSync` AND `writeFileSync` fail with exactly
// the ENOENT a genuinely missing parent produces -- so "no such file or
// directory" points at the wrong cause, and creating the parent does not help.
// The check runs before anything is written, and `platform` is a parameter so
// the Windows rules can be tested from a host that is not Windows.
// ---------------------------------------------------------------------------

const WINDOWS_ILLEGAL_CHARS = '<>:"|?*';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** The components of an absolute path, without its root or drive prefix. */
function pathComponents(absPath, platform = process.platform) {
  if (platform === "win32") {
    const { root } = parse(absPath);
    return absPath.slice(root.length).split(/[\\/]+/).filter(Boolean);
  }
  return absPath.split("/").filter(Boolean);
}

/**
 * Why `absPath` cannot be created on this platform, as a phrase, or null when
 * nothing about the path is obviously impossible.
 */
export function describeUnusablePath(absPath, { platform = process.platform } = {}) {
  const win = platform === "win32";
  const control = CONTROL_CHARS.exec(absPath);
  if (control) {
    const code = control[0].charCodeAt(0).toString(16).padStart(2, "0");
    return `it contains the control character 0x${code}, which no file name may contain`;
  }
  for (const part of pathComponents(absPath, platform)) {
    if (part.length > 255) {
      return `the component "${part.slice(0, 32)}..." is ${part.length} characters long, ` +
        `and no file system here allows a single name longer than 255`;
    }
    if (!win) continue;
    const illegal = [...part].find((ch) => WINDOWS_ILLEGAL_CHARS.includes(ch));
    if (illegal) {
      return `the component "${part}" contains "${illegal}", which Windows does not allow in a file name`;
    }
    const stem = part.split(".")[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      return `the component "${part}" starts with "${stem}", a reserved device name on Windows ` +
        `(CON, PRN, AUX, NUL, COM1-9, LPT1-9)`;
    }
  }
  return null;
}

const FS_ERROR_HINTS = {
  ENOENT: "the parents are created before this call, so what remains is a dangling symlink or " +
    "junction in the path, an unavailable drive or network share, or a name this file system refuses",
  EISDIR: "the destination is an existing directory",
  ENOTDIR: "a component of the path is an existing file",
  EEXIST: "something already exists where a directory has to be",
  EPERM: "the file system refused the write (a controlled-folder or antivirus policy does this)",
  EACCES: "this process may not write here",
};

function fsFailure(operation, absPath, err) {
  const hint = FS_ERROR_HINTS[err.code];
  return new Error(
    `cannot ${operation} "${absPath}": ${err.code ?? err.message}` + (hint ? ` -- ${hint}` : ""),
  );
}

/** Throw unless `absPath` is a path this platform can actually create. */
function requireUsablePath(absPath) {
  const why = describeUnusablePath(absPath);
  if (why) throw new Error(`cannot use "${absPath}" as an output path: ${why}`);
}

/** Create `absPath` as a directory, parents included, with a diagnosable failure. */
function makeDirectory(absPath) {
  requireUsablePath(absPath);
  try {
    mkdirSync(absPath, { recursive: true });
  } catch (err) {
    throw fsFailure("create the directory", absPath, err);
  }
}

/** Write `data` to `absPath`, with a diagnosable failure. */
function writeOutputFile(absPath, data) {
  requireUsablePath(absPath);
  try {
    writeFileSync(absPath, data);
  } catch (err) {
    throw fsFailure("write", absPath, err);
  }
}

/** True when `p` exists and is a directory. */
function isExistingDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the requested entry actually lands.
 *
 * A path that already is a directory, or one written with a trailing separator,
 * means "put it inside, under the name it has in the archive" -- the rule `cp -r`
 * uses, and the reason `get <pak> <path> out/` does what it looks like it does.
 * Anything else is the destination itself, its parents created as needed.
 */
function planDestination(outFile, name) {
  const inside = /[\\/]$/.test(outFile) || isExistingDirectory(outFile);
  const abs = resolve(outFile);
  return inside ? join(abs, name) : abs;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Read Arma Reforger PAC1 archives (.pak)

  node tools/pak.mjs info   <pak> [--json]
  node tools/pak.mjs list   <pak> [pathRegex] [--limit N] [--json]
  node tools/pak.mjs tree   <pak> [pathRegex]
  node tools/pak.mjs get    <pak> <virtualPath> <outFile> [--raw] [--verbose]
  node tools/pak.mjs cat    <pak> <virtualPath> [--raw]
  node tools/pak.mjs find   <pak> <needle> [--max-size N] [--limit N] [--path-regex RE]
  node tools/pak.mjs verify <pak> [--sample N]

Options
  --raw                 write/print the stored bytes without decompressing
  --verbose             get: print every file of a directory as it is written
  --data-relative       read offsets relative to the DATA body (the pre-2026
                        mis-reading; only for recognising an old broken extract)
  --json                machine-readable output (info, list)
  --limit N             cap the number of results (default 100)
  --max-size N          skip entries whose original length exceeds N (find, default 60000)
  --sample N            compressed entries to decompress during verify (default 50)

get writes one entry, or a whole directory and everything under it. A virtual
path of only separators ("/") is the archive root, i.e. every entry in it.
<outFile> is the destination; an existing directory, or a path ending in a
separator, means "write inside it under the entry's own name" (the rule cp -r
uses) -- the root has no name of its own, so it is written straight into the
destination. Missing parents are created. A path this platform cannot create is
refused by name before anything is written, rather than as a bare ENOENT.
`;

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--raw") flags.raw = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--verbose") flags.verbose = true;
    else if (a === "--data-relative") flags.dataRelative = true;
    else if (a === "--limit") flags.limit = parseInt(argv[++i], 10);
    else if (a === "--max-size") flags.maxSize = parseInt(argv[++i], 10);
    else if (a === "--sample") flags.sample = parseInt(argv[++i], 10);
    else if (a === "--path-regex") flags.pathRegex = argv[++i];
    else if (a === "-h" || a === "--help") flags.help = true;
    else flags._.push(a);
  }
  return flags;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function histogram(entries) {
  const byType = new Map();
  let storedBytes = 0, originalBytes = 0;
  const timestamps = [];
  for (const e of entries) {
    byType.set(e.compressionType, (byType.get(e.compressionType) ?? 0) + 1);
    storedBytes += e.storedLength;
    originalBytes += e.originalLength;
    if (e.timestamp) timestamps.push(e.timestamp);
  }
  timestamps.sort((a, b) => a - b);
  return { byType, storedBytes, originalBytes, timestamps };
}

function printInfo(pak, flags) {
  const { byType, storedBytes, originalBytes, timestamps } = histogram(pak.entries);
  const base = detectOffsetBase(pak);
  const info = {
    path: pak.path,
    chunks: pak.chunks.map((c) => ({ name: c.name, offset: c.offset, length: c.length })),
    dataStart: pak.dataStart,
    dataLength: pak.dataLength,
    fileChunkOffset: pak.fileChunkOffset,
    fileChunkLength: pak.fileChunkLength,
    entries: pak.entries.length,
    compression: Object.fromEntries(
      [...byType].map(([type, count]) => [compressionName(type), count]),
    ),
    storedBytes,
    originalBytes,
    compressedBytesSaved: originalBytes - storedBytes,
    timestamps: timestamps.length
      ? { from: timestamps[0].toISOString(), to: timestamps[timestamps.length - 1].toISOString() }
      : null,
    offsetBase: base,
  };
  if (flags.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(`${pak.path}`);
  console.log(`  chunks`);
  for (const c of pak.chunks) console.log(`    ${c.name.padEnd(6)} at ${String(c.offset).padStart(12)}  ${humanBytes(c.length)}`);
  console.log(`  entries        ${pak.entries.length}`);
  for (const [type, count] of byType) {
    console.log(`    ${compressionName(type).padEnd(16)} ${count}`);
  }
  console.log(`  payload        ${humanBytes(storedBytes)} stored, ${humanBytes(originalBytes)} unpacked`);
  if (info.timestamps) {
    console.log(`  pack time      ${info.timestamps.from.slice(0, 10)} .. ${info.timestamps.to.slice(0, 10)}`);
  }
  console.log(
    `  offset base    ${base.base} (zlib headers found: ${base.absoluteHits} absolute, ` +
      `${base.relativeHits} data-relative, of ${base.tested} compressed entries)`,
  );
}

function printList(pak, flags) {
  const re = flags._[2] ? new RegExp(flags._[2], "i") : null;
  const limit = flags.limit ?? 100;
  const hits = pak.entries.filter((e) => !re || re.test(normalisePath(e.path)));
  if (flags.json) {
    console.log(JSON.stringify(
      hits.slice(0, limit === Infinity ? undefined : limit).map((e) => ({
        path: normalisePath(e.path),
        offset: e.offset,
        storedLength: e.storedLength,
        originalLength: e.originalLength,
        compression: compressionName(e.compressionType),
        timestamp: e.timestamp ? e.timestamp.toISOString() : null,
      })),
      null,
      2,
    ));
    return;
  }
  console.log(`${pak.path}: ${pak.entries.length} entries, ${hits.length} match${re ? ` /${flags._[2]}/i` : ""}`);
  for (const e of hits.slice(0, limit)) {
    console.log(
      `${normalisePath(e.path)}\t${e.originalLength}\t${compressionName(e.compressionType)}`,
    );
  }
}

function printTree(pak, flags) {
  const re = flags._[2] ? new RegExp(flags._[2], "i") : null;
  const walk = (node, prefix) => {
    for (const child of node.children) {
      const line = prefix + (child.kind === "dir" ? child.name + "/" : child.name);
      if (child.kind === "file") {
        if (!re || re.test(normalisePath(child.path))) {
          console.log(`${line}  ${child.originalLength}  ${compressionName(child.compressionType)}`);
        }
      } else if (walk(child, line + " ")) {
        console.log(line);
      }
    }
    return node.children.length > 0;
  };
  walk(pak.root, "");
}

/** Every file entry inside a directory, i.e. every path under `<dir>/`. */
export function entriesUnder(pak, dirPath) {
  const prefix = normalisePath(dirPath);
  const under = prefix ? `${prefix}/` : "";
  return pak.entries.filter((e) => normalisePath(e.path).startsWith(under));
}

function doGet(pak, flags) {
  const [, , virtualPath, outFile] = flags._;
  if (!virtualPath || !outFile) throw new Error("get needs a virtual path and an output file");
  const target = findTarget(pak, virtualPath);
  const dest = planDestination(outFile, target.name);
  if (target.kind === "dir") doGetDirectory(pak, target, dest, flags);
  else doGetFile(pak, target.entry, dest, flags);
}

/** How a directory is named in messages: the root is "/", not "". */
function dirLabel(dir) {
  return dir.path ? `${normalisePath(dir.path)}/` : "/";
}

function doGetFile(pak, entry, dest, flags) {
  const data = pak.read(entry, { raw: flags.raw, dataRelative: flags.dataRelative });
  makeDirectory(dirname(dest));
  writeOutputFile(dest, data);
  console.log(
    `${normalisePath(entry.path)}: ${compressionName(entry.compressionType)} ` +
      `${entry.storedLength} -> ${data.length} bytes (index says ${entry.originalLength}) -> ${dest}`,
  );
}

function doGetDirectory(pak, dir, dest, flags) {
  const under = dir.path ? `${dir.path}/` : "";
  const files = entriesUnder(pak, dir.path);
  const label = dirLabel(dir);
  if (existsSync(dest) && !isExistingDirectory(dest)) {
    throw new Error(
      `"${label}" is a directory in this archive (${files.length} file${files.length === 1 ? "" : "s"}), ` +
        `but "${dest}" is an existing file; give a directory, or a path that does not exist yet`,
    );
  }
  makeDirectory(dest);
  let bytes = 0;
  const byCodec = new Map();
  for (const e of files) {
    const rel = normalisePath(e.path).slice(under.length);
    const parts = rel.split("/");
    if (parts.some((p) => !p || p === "." || p === "..")) {
      throw new Error(
        `entry "${normalisePath(e.path)}" has no usable path inside "${label}": ` +
          `"${rel}" does not stay under the directory being extracted`,
      );
    }
    const at = join(dest, ...parts);
    let data;
    try {
      data = pak.read(e, { raw: flags.raw, dataRelative: flags.dataRelative });
      makeDirectory(dirname(at));
      writeOutputFile(at, data);
    } catch (err) {
      throw new Error(`${normalisePath(e.path)}: ${err.message}`);
    }
    bytes += data.length;
    byCodec.set(e.compressionType, (byCodec.get(e.compressionType) ?? 0) + 1);
    if (flags.verbose) console.log(`  ${rel}\t${compressionName(e.compressionType)}\t${data.length}`);
  }
  const codecs = [...byCodec].map(([type, n]) => `${n} ${compressionName(type)}`).join(", ");
  console.log(
    `${label}: directory, ${files.length} file${files.length === 1 ? "" : "s"}, ` +
      `${humanBytes(bytes)} written (${codecs || "empty"}) -> ${dest}`,
  );
}

function doCat(pak, flags) {
  const [, , virtualPath] = flags._;
  if (!virtualPath) throw new Error("cat needs a virtual path");
  const target = findTarget(pak, virtualPath);
  if (target.kind === "dir") {
    const files = entriesUnder(pak, target.path);
    throw new Error(
      `"${dirLabel(target)}" is a directory in this archive (${files.length} file${files.length === 1 ? "" : "s"}), ` +
        `not a file; use list to see what is in it, or get to extract it`,
    );
  }
  const data = pak.read(target.entry, { raw: flags.raw, dataRelative: flags.dataRelative });
  process.stdout.write(data);
}

function doFind(pak, flags) {
  const [, , needle] = flags._;
  if (!needle) throw new Error("find needs a needle");
  const maxSize = flags.maxSize ?? 60000;
  const limit = flags.limit ?? 15;
  const pathRe = flags.pathRegex ? new RegExp(flags.pathRegex, "i") : null;
  const needleBuf = Buffer.from(needle, "latin1");
  let scanned = 0, skipped = 0, hits = 0;
  for (const e of pak.entries) {
    if (pathRe && !pathRe.test(normalisePath(e.path))) continue;
    if (!e.originalLength || e.originalLength > maxSize) { skipped++; continue; }
    let data;
    try { data = pak.read(e); } catch { skipped++; continue; }
    scanned++;
    const i = data.indexOf(needleBuf);
    if (i < 0) continue;
    const from = Math.max(0, i - 200), to = Math.min(data.length, i + needle.length + 250);
    console.log(`HIT ${normalisePath(e.path)} (${e.originalLength} B) at byte ${i}`);
    console.log("    " + data.subarray(from, to).toString("latin1").replace(/[^\x20-\x7e\n\t]/g, "."));
    if (++hits >= limit) break;
  }
  console.log(`# scanned ${scanned}, skipped ${skipped}, hits ${hits}`);
}

function doVerify(pak, flags) {
  const base = detectOffsetBase(pak);
  console.log(`${pak.path}: ${pak.entries.length} entries`);
  console.log(
    `  offset base: zlib headers at absolute offsets ${base.absoluteHits}/${base.tested}, ` +
      `at DATA-relative offsets ${base.relativeHits}/${base.tested} -> ${base.base}`,
  );
  const { compressed, inflated, sampled, problems } = verifyPak(pak, {
    sample: flags.sample ?? 50,
    dataRelative: flags.dataRelative,
  });
  console.log(`  decompressed ${inflated}/${sampled} sampled compressed entries to the indexed length (of ${compressed} compressed)`);
  if (!problems.length) {
    console.log("  no problems found");
    return 0;
  }
  console.log(`  ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 20)) console.log(`    ${p}`);
  if (problems.length > 20) console.log(`    ... and ${problems.length - 20} more`);
  return 1;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags._.length === 0) {
    process.stdout.write(USAGE);
    process.exit(flags._.length === 0 && !flags.help ? 1 : 0);
  }
  const [command, pakPath] = flags._;
  if (!pakPath) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const pak = openPak(pakPath);
  try {
    switch (command) {
      case "info": printInfo(pak, flags); break;
      case "list": printList(pak, flags); break;
      case "tree": printTree(pak, flags); break;
      case "get": doGet(pak, flags); break;
      case "cat": doCat(pak, flags); break;
      case "find": doFind(pak, flags); break;
      case "verify": process.exitCode = doVerify(pak, flags); break;
      default:
        process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
        process.exitCode = 1;
    }
  } finally {
    pak.close();
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  }
}
