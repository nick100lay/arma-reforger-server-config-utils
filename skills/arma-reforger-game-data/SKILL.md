---
name: arma-reforger-game-data
description: Read Arma Reforger game data out of the .pak archives and the EBIN worlds inside them - the entry tree, extracted .conf and .c sources, world .ent files with their entities and bases, resource GUIDs, the localization string tables behind `#AR-...` keys. And read Enforce Script sources: which file declares a class, what a class contains, a method's signature, an inheritance chain, a subclass tree, and every `modded class` that replaces something (tools/cscript.mjs). Use when a .pak read fails with "incorrect header check" or Z_DATA_ERROR, when an extracted file looks cyclically shifted, when a world .ent looks like binary, when you need the GUID for a scenario/world/prefab, when you need vanilla script or config text to override, when you need to know what a class declares or inherits before overriding it, or when a value like `#AR-Campaign_MapLocation_Cain_Kamensk` needs the text a player sees. Also use before writing new pak-, .ent-, .c- or string-table-parsing code - both formats and the one mistake that breaks pak reads are documented here.
---

# Reading Arma Reforger game data

Everything inside a `.pak` is readable with plain zlib and no key material. There is **no
encryption in the format** — no matter what an error message suggests. Three real obstacles
remain, and only one of them is about the archive at all:

| Symptom | Cause | What to do |
|---|---|---|
| `incorrect header check`, `unknown compression method`, `Z_DATA_ERROR` | entry payload read from the **wrong offset base** — by far the most common cause | §2. Fix the base; do not reach for a decryption tool |
| Text that starts mid-word, or ends with a fragment of an unrelated file | same wrong base: the window is shifted, so it begins late and the tail belongs to the neighbouring entry | §2 |
| `compressionType` other than `0` or `0x106` | a codec this toolkit does not know | `get --raw` the stored bytes, and report the type |
| Need a `{GUID}` for a config | GUIDs live in `resourceDatabase.rdb`, not in the pak | §4 |
| A world `.ent` starts with `EBIN` and looks like binary | it *is* binary — a different format from the pak around it | §3 |
| A value like `#AR-Campaign_MapLocation_Cain_Kamensk` where text is expected | it is a string-table id, not text — the player's language file holds the words | §6 |
| A string table that reports more texts than ids | a `\` after a closing quote continues the text in the next string; counting quoted strings misses it | §6 |
| Which file declares this class, what does it contain, what does it inherit, what replaces it | that is a script question, not an archive one: no namespaces, and a `modded class` is a second declaration of the same name | §5 |
| Need one file from a 2 GB archive | normal case | §1 |

**The rule that matters most:** in this engine a *failed* read and a *successful* read of the
wrong bytes look equally plausible. A shifted `.conf` still parses as text; a shifted
compressed entry just throws. Before reporting that something cannot be read, run
`verify` (§1) and confirm the base — a wrong base turns every compressed entry into
"encrypted" and every stored one into "rotated", and both conclusions are false.

## 1. The tool: `tools/pak.mjs`

```
node tools/pak.mjs info   <pak> [--json]                 # chunks, entry count, codec histogram, pack time, offset base
node tools/pak.mjs list   <pak|dir> [pathRegex] [--limit N|0] [--from N] [--json]   # entries by path
node tools/pak.mjs tree   <pak> [pathRegex] [--depth N] [--limit N|0] [--json]      # the entry tree
node tools/pak.mjs get    <pak> <virtualPath> <outFile> [--path-regex RE] [--dry-run] [--json]
node tools/pak.mjs cat    <pak> <virtualPath> [<lines>] [--lines A-B] [--numbers] [--json]
node tools/pak.mjs find   <pak|dir> <needle> [--regex] [--ignore-case] [--max-size N] [--path-regex RE]
                                            [--from N] [--limit N|0] [--json]
node tools/pak.mjs verify <pak|dir> [--sample N] [--limit N|0] [--json]              # every entry against the index
```

It is also a library — `import { openPak, findEntry, findTarget } from "./tools/pak.mjs"` — with
no dependencies, so a one-off script can use it instead of re-implementing the parser.
`listPaks`, `decodeEntry` and `splitLines` are exported too, because `loc`, `etconf`, `ebin` and
`layer` grew out of this reader and read the same archives.

Every command that answers a list has `--json`, and **no answer is silently partial**: `--limit N`
caps, `--limit 0` (or `--all`) lifts it, a cap that hid rows is reported in the text
(`# 51532 row(s), 100 shown — use --limit 0 for every one`) and counted in the JSON
(`total`, `from`, `returned`, `truncated`). The defaults are 100 rows for `list` and `tree` and
15 hits for `find`, all of which a bare run states. A value that is not a non-negative whole
number is refused, so is a misspelt option, and so is a backwards line range — each of those used
to change the answer instead: `--limit 0` printed no rows at all and answered `[]`, `--limit -1`
dropped the last row, `--limit abc` every row, and `--jsom` became the path regex. An option a
command does not use is refused by name (`tree --from 10`, `get --limit 5`), because an ignored
option reads exactly like an honoured one. `--` ends the options, which is how a needle that
begins with a hyphen is written (`find <pak> -- "--i"`), and a word the command has no place for
is refused with the shape it does take rather than dropped in silence.

**`<pak|dir>` takes a folder.** `list`, `find` and `verify` accept a directory and read every
`*.pak` under it, recursively, in path order; their `--json` answer wraps the per-archive objects
as `{ archives: [...], total, returned, truncated }`. An installed client is 23 archives and
~408 000 entries, so "which archive holds this file" is one call:
`node tools/pak.mjs find "<client>/addons" "GetFactionLimitMap" --path-regex "\.c$"`. `info`,
`tree`, `get` and `cat` need one archive and say so when given a folder.

`find` decodes each entry — UTF-8 when it is UTF-8, Latin-1 otherwise — so a needle in any script
matches, and reports `line L:C` with the matched line itself; `--json` carries `path`, `line`,
`column`, `offset` (bytes) and `text`, and the skips are split into `empty`, `oversized` and
`unreadable`, so "0 hits" can be told from "0 hits and 2 700 entries I could not read". It
decompresses entries **in place** (there is no need to extract a 2 GB archive), stops as soon as
`--limit` hits are found, and with no hits reads everything: 2.7 s for `data007.pak` (1.9 GiB
unpacked), 17.8 s for `worlds001.pak` (5.58 GiB). `--max-size N` caps that for speed and says how
many entries it skipped; the default is no cap, because a 60 000-byte default hid a 2.2 MB
localization table and turned a real match into a false "no hits".

`cat` prints the bytes unchanged, which is what makes `cat … > file` exact; with a line range
(`cat <pak> <path> 138-160`, or `--lines`, or `--numbers`) it prints a header and numbered lines
instead, the way `cscript cat` does. `tree` is bounded by `--limit` and `--depth` — it used to
print all 51 558 lines of `worlds001.pak` — and `--json` answers the tree itself, with `total`,
`returned` and `truncated`.

`get` takes a file **or a directory**. A directory extracts its whole subtree through the same
read path, so stored and zlib entries come out alike: on the installed server,
`get data002.pak Missions out/missions` writes 38 `.conf` files (23 stored, 15 zlib) and all 38
compare byte-identical to the archive. A virtual path of only separators — `/` — is the **archive
root**, so `get <pak> / out/dump` writes every entry of the archive at its own path (the installer's
`core/data.pak`: 939 entries / 18.8 MiB unpacked, all 939 byte-identical; the big ones are 5.58 GiB
unpacked for `worlds001.pak`, so a full dump is a deliberate act — `list`/`find` read in place
without it). `<outFile>` names the destination, and an existing directory — or a path written with
a trailing separator — means "inside it, under the entry's own name", the rule `cp -r` uses:
`get <pak> Missions out/` writes `out/Missions/…`, while `get <pak> Missions out/copy` roots the
tree at `copy/`; the root has no name of its own, so it is written straight into the destination.
Missing parents are created. A destination this platform cannot create is refused **by name**
before anything is written (a character Windows forbids in a name, a component longer than 255
characters, a reserved device name such as `CON`), because the file system answers exactly those
with `ENOENT: no such file or directory` — which reads as a missing directory, and creating one
does not help. `findTarget` and `entriesUnder` are exported for scripts that need the same
distinction.

`--path-regex` narrows a directory extraction to the entries that match — the difference between
dumping 5.58 GiB and the 40 `.conf` files you wanted — and `--dry-run` prints the same plan
without writing anything, naming each destination, so the size of a `get` is knowable before it
happens. A filter that matches nothing is an error naming the count, not an empty directory.

The archives live in the install, not in this repository:

- dedicated server: `<Dedicated Server>/addons/data/data*.pak`, `worlds*.pak`, `addons/core/data.pak`
- client (same format, more content — scenarios and scripts are here): `<Arma Reforger>/addons/data/data*.pak`

Typical session:

```bash
node tools/pak.mjs verify "<client>/addons/data"                       # every archive under it: always start here
node tools/pak.mjs list   "<client>/addons/data/data007.pak" "^Missions/.*\.conf$"
node tools/pak.mjs cat    "<client>/addons/data/data007.pak" Missions/23_Campaign_Western.conf
node tools/pak.mjs cat    "<client>/addons/data/data007.pak" scripts/Game/Ranks/SCR_RankInfo.c 1-40
node tools/pak.mjs find   "<client>/addons" "GetFactionLimitMap" --path-regex "\.c$"   # who calls it
node tools/pak.mjs get    "<client>/addons/data/data007.pak" Missions out/missions
node tools/pak.mjs get    "<client>/addons/data/data007.pak" "/" out/missions --path-regex "Missions/.*\.conf$" --dry-run
```

`find` is the tool for "which file references X" and for locating a method's callers — that is how
the `SCR_FactionManager.EOnInit()` caller of `GetFactionLimitMap()` was found when the documents
still said the scripts were encrypted. Ask it for `--json` when a program (or an agent) is what
reads the answer: the text form is for a person, and only the JSON carries line, column and the
matched text as data.

`verify` checks, mechanically: every entry's payload lies inside the DATA chunk, stored entries
agree with their own length, the reserved field is zero, and a sample of compressed entries
inflates to exactly the indexed length. On the installed 1.8.0.13 archives (23 files,
~408 000 entries) it reports the absolute base with 64/64 zlib headers where the index says
they are and 0/64 at the DATA-relative one, and no problems.

## 2. The format, and the one mistake

```
offset 0   "FORM" + u32BE size + "PAC1"                        (12 bytes)
then chunks, each u32BE magic + u32BE bodyLength + body:
  "HEAD"   28 bytes of pack metadata, skip
  "DATA"   every entry payload, back to back
  "FILE"   the entry tree, last in every archive observed
```

Entry tree, read sequentially (`u8 kind`, `u8 nameLength`, name, then):

```
kind 0 (directory): u32LE childCount, then childCount entries
kind 1 (file):      u32LE offset            <- ABSOLUTE file offset
                    u32LE storedLength
                    u32LE originalLength    (0 for a stub)
                    4 bytes                 always 0 in every archive observed
                    u32BE compressionType   0x0 = stored, 0x106 = zlib
                    u32LE timestamp         pack time, seconds since epoch
```

**`offset` is measured from the start of the `.pak` file.** Reading it from the start of the DATA
chunk body — the intuitive reading, and the one an earlier version of this repository's tool
used — is wrong by exactly 56 bytes in every archive here: 12 (FORM) + 8 + 28 (HEAD) + 8 (DATA
header). That single error produces all of these, at once:

- compressed entries throw `Z_DATA_ERROR` / `incorrect header check`, which reads exactly like
  encryption and is not;
- stored entries come back as a window into the middle of the concatenated DATA stream, so the
  text starts mid-word and the tail is the beginning of the **next** entry in the archive;
- a "repair" that rotates the buffer to the first class declaration it can find stitches the
  file together out of two different files, silently. This is how wrong `World` GUIDs were
  published for vanilla scenarios: the GUID belonged to the entry stored after the one being
  read, while the rest of the line came from the intended file.

`--data-relative` reproduces the broken behaviour on purpose, so an extract made with the old
tool can be recognised as such.

Compression: `0x106` is zlib, i.e. `inflateSync` on the stored bytes with no header stripping.
`0x0` is stored. Nothing else has ever been observed in ~408 000 entries; if a type appears,
`pak.mjs` refuses to guess and names it rather than emitting plausible garbage.

**Independent confirmation of the layout.** [rvost/PakInspector](https://github.com/rvost/PakInspector)
reaches the same structure from a Kaitai Struct description
([`formats/pak.ksy`](https://github.com/rvost/PakInspector/blob/main/formats/pak.ksy)) and reads
payloads at `io: _root._io, pos: offset` — the whole file, not the DATA body — with
`compression_type` as `u4be` and `0x106` handled as DEFLATE in its extractor. Two independent
parsers agreeing on both the offset base and the codec value is worth more than either alone;
it is also why the 56-byte defect above is a defect in the reader and not a change in the
container format between builds.

## 3. Reading a world (`worlds/**.ent`) — the EBIN format

**In the shipped game, only worlds are binary.** Every `.et` prefab in the archives is text
(`GenericEntity { ... }`) and needs nothing more than `pak.mjs get`; the 103 vanilla `worlds/**.ent`
start with the four bytes `EBIN`. **Six extensions are one format** — one object per file, only the
root object's meaning differs — and `tools/etconf.mjs` reads all six (`EXTENSIONS` is the list):
`.et` a prefab, `.conf` a config, `.ct` a component template, `.layout` a UI layout (1 238 in the
paks), and in a Workbench project `.meta` a resource's identity and `.gproj` the project itself.
The commands are `info`, `cat`, `tree`, `get`, `components`, `refs --rdb`, `chain`, `find`, `check`,
plus a library (`parseText`, `lookup`, `refsOf`):

```
node tools/etconf.mjs tree "<pak>:Prefabs/Props/Industrial/BarrelMetal_01_Base.et"
node tools/etconf.mjs get  "<pak>:Prefabs/…/BarrelMetal_01_Base.et" components/RigidBody/Static
node tools/etconf.mjs refs "<pak>:Prefabs/…/BarrelMetal_01_Base.et" --rdb <rdb>   # GUID vs path
node tools/etconf.mjs info "<pak>:Configs/System/PolicyRow.layout"                 # same reader
```

Two extensions are **not** in that list. `.layer` is a world layer, and it is a **sequence** of root
objects — it starts `GenericWorldEntity world {` (the root's name unquoted, unlike everything else),
then `GenericTerrainEntity Terrain { … }`, `SCR_MapEntity MapEntity : …`. `etconf.mjs` models one
object per file, so it reads a layer that holds one root and refuses the rest *by that rule*; the
reader for a whole layer is **`tools/layer.mjs`**, which is `etconf.mjs`'s own parser (`parseRoots`)
plus the one thing a layer adds — the roots, and the way a command line names one:

```
node tools/layer.mjs info   <source> [--limit N|0] [--json]        # every root: class, counts, BSP
node tools/layer.mjs tree   <source> [--root N] [--depth N] [--numbers]   # an outline per root
node tools/layer.mjs get    <source> <path>... [--root N] [--missing-ok]  # "@0/BSP", "@2/components/#1"
node tools/layer.mjs refs   <source> [--rdb <rdb>]... [--check]    # every reference, with its root
node tools/layer.mjs find   <source> <query> [--regex] [--in name|value|class|all]
node tools/layer.mjs check  <source> [--rdb <rdb>]... [--strict]   # duplicate members, a broken BSP, …
node tools/layer.mjs chain  <source> --root N [--rdb]... [--pak]... [--addon]... [--use-addons-rdbs]
node tools/layer.mjs cat    <source> [<lines>] [--numbers]
```

A root is addressed `@N/…` or with `--root N`; a bare path in a layer that holds several roots is
refused rather than guessed at, and the refusal lists the roots — the first root is a world entity,
so a typo that landed there would read as "the member is not here". `.ent` is `EBIN` in the shipped
paks (4 of 4) and belongs to `ebin.mjs`; a text stub in a project does parse, but the extension is
not this reader's.

**A layer has no resource GUID of its own**, so `--guid` takes the **world's**: `--rdb` answers
`worlds/<Name>.ent`, the layer is derived from that path (`worlds/<Name>_Layers/default.layer`, the
Workbench's rule, measured on the projects of this machine), and `--pak`/`--addon`/`--addons` say
where to look for it — a mod that ships its map in a `.pak` is read with `--pak` and its layer comes
out of the archive. `--use-addons-rdbs` adds the database beside each addon, so a Workbench project
needs only `--addon <dir> --guid <world guid>`. `chain` walks a root's `:` parents with the same
`inheritance` walk and the same `DocumentLoader` `etconf chain` uses — step 0 is the layer (and says
`(no GUID)`, honestly), the prefabs after it carry theirs. A GUID for anything that is not a world
or a `.layer` has no layers and is refused in those words.

The counts behind "reads without problems", measured on 1.8.0.13: **21 994 of 21 994**
`.et`/`.conf`/`.ct`, **1 233 of 1 238** `.layout`, and every `.meta` and `.gproj` of the Workbench
addons on the machine this was written on (133 and 7). The five `.layout` failures are malformed
*data*, not a reader gap: the markup string escapes the opening quote of the first attribute and not
the closing one — `Text "<image set=\\"{GUID}…imageset" name=\\"…\\"…` — so the string ends early and
the line is refused at that column. They are `QuickMenu.layout`, `ToolMenu.layout`,
`WarningWidgetDeploy.layout`, `PreviewRichText-Backup.layout`, `PreviewRichText_AsianFontTesting.layout`.

Two facts decide how to read one: a member is its **name plus the value tokens on the same line**
(an array element has no name), and the **path next to a GUID is decoration** — the engine resolves
the GUID, and 10 references in the vanilla data name a different file than their path says.

**Identity is not in the file.** The `ID` member repeats down a prefab family — of the 18 632
vanilla prefabs whose parent ships, 15 722 carry exactly their parent's value — so `chain` never
prints it: every step is named by its **resource GUID**, which comes from `--rdb`, or from the
`.meta` a Workbench project keeps beside each file (`X.et.meta` → `Name "{GUID}path"`).

```
node tools/etconf.mjs chain "<pak>:Prefabs/Weapons/Rifles/AK74/Rifle_AK74.et" --rdb <rdb>
node tools/etconf.mjs chain "<addon dir>/Prefabs/X.et" --addon "<addon dir>"      # a mod, no .pak
node tools/etconf.mjs chain "<addon dir>/Prefabs/X.et" --addon "<addon dir>" \
  --rdb "<install>/addons/data/resourceDatabase.rdb" --pak "<install>/addons/data"  # …and its vanilla parents
```

The second command finds the parents that live **inside the mod**. A parent in the base game is
not in the addon folder, so the walk stops unless the game's database and archives are named too
(third command); the error says where it searched (`searched 1 addon directory, 11 directories
above the source`) and which flags widen the search, so the fix is in the message rather than in
a re-read of this page.

- `--rdb` is repeatable and merged **in the order given**, the first database winning an override —
  the rule `rdb merge` states. With several databases, each step also prints `rdb 1,2`: the
  databases that declare it, first one first. A set that does not merge is refused, not answered
  from one of them.
- `--addon DIR` searches a mod project on disk, before the paks. A Workbench addon is a tree of
  files with no build, and this is what makes its parents resolvable.
- When two copies of one resource (two databases, or two containers) name **different parents**,
  `chain` stops with `Multiple parents detected at …` and exits 1: which parent applies would depend
  on the mount order.
- A parent whose **file extension** differs from the target's is a warning, not a stop — `In resource
  … parent … has different extension, it seems broken` — because a prefab derives from a prefab:
  none of the 21 994 shipped `.et`, `.conf` and `.ct` names a parent with another extension. `--json`
  lists these in `warnings` beside `problems`, and the exit code stays 0.

**One document, or a whole project.** A source is a file, a `<pak>:<entry>`, or a **directory** —
`info`, `check`, `refs` and `find` read every document under it, sorted; the commands that read one
document refuse a directory and name the ones that take it. Whatever way a source is named — a file, a
directory, `--addons`, `--guid` — those four read exactly it and nothing else, and that is asserted as
a table in the tests (each command against each way), because twice a command quietly answered a
clean, empty result after dropping one of them. `--ext .et` (comma list, dot optional)
narrows what a directory and `--addons` contribute: a mod audit reads `.et` **and** the `.meta`
identity file beside each one as two documents, and the prefab is the one you wanted. It is a filter
over a **scan**, so it never argues with a name: a file, or a `--guid`, is read whatever the filter
says (`--ext .et` still reads a `.meta` you pointed at, and `etconf` reads a `.layer` that holds a
single root — `tools/layer.mjs` is the reader for a whole layer). `--addons
<root>` treats every child directory as an addon (the rule `cscript` states): its documents are
sources for those four, its directories are searched for parents, and `--use-addons-rdbs` resolves
through the `resourceDatabase.rdb` it carries — a **fallback layer** after `--rdb`, because a mod
database and the game database genuinely do not merge (their `scripts/…` records differ), while a
mod's own GUIDs still have to resolve beside the vanilla ones; `shadowed` counts what `--rdb`
answered first. That is also why `--addons <install>/addons --use-addons-rdbs` is refused rather
than useful: the game's own `core` and `data` databases do not merge either (§4), so name the game's
database with `--rdb` and let the addon layer supply the mod's. The same rule makes `--use-addons-rdbs`
over a folder of **unrelated** Workbench projects fail, and rightly: each project carries its own copy
of the vanilla records, with different GUIDs, so their databases contradict each other by construction
— `verify-merge` on two of them reports two GUIDs for `Missions`. Audit such a folder without the
option, or one project at a time with `--addon <dir>`. `--guid <guid>` names the resource
instead of the path (`--rdb` answers the path, `--pak`/`--addon` supply the document). With more than
one source the JSON envelope names them in `sources` and each row carries the `source` index; a
one-source answer keeps `source`, and `refs`/`find` print a header even for a source that produced
nothing (`(no references)`, `(no matches)`), so "was it read?" is never a guess — while the corpus
fits `--limit`; a corpus larger than the cap gets one line counting those sources instead (naming
them all was 4 000 lines for `--limit 3` on 2 000 documents), and `--limit 0` lists them again.

**What a caller can branch on.** Exit 0 is success, 1 is the input at fault (a parse error, a
`check`/`refs --check` defect, a document `--lenient` had to skip), 2 is the command line (USAGE),
and 3 is a `get` path that is not in the document — a query that missed, not a broken file
(`--missing-ok` keeps it 0). `--strict` makes a warning fail in both `check` and `refs --check`; an
unresolved reference is a warning in both, because 32 ship in the vanilla data. `--lenient` belongs to
the four commands that read many documents — `info`, `check`, `refs`, `find` — and reports a document
it cannot read as a failure and goes on: a mod's layouts may carry `//~` annotations this format does
not have, and an audit that dies at the first of them cannot audit the mod. Each skipped document is a
`FAIL` line in the text, a `parseFailures` entry under `--json`, and the answer says how many were
skipped; the exit code is still 1. `cat`, `tree`, `get`, `components` and `chain` **refuse** the
option, because they read one document and skipping it would leave nothing to answer with. Under
`--json` a failure is an object —
`{ok:false, error:{code, message, source?, line?, column?}}` with `code` one of `USAGE`, `PARSE`,
`IO`, `MERGE`, `INPUT`, `ERROR` — never prose on stderr. `--compact` prints the JSON on one line and
drops `false`, empty arrays/objects and redundant value keys; `tree --json` obeys `--limit` like the
outline does. `cat <source> 20-30` reads a line range (`20`, `20-30`, `20-`), which is how a line a
`refs`/`find`/`check` row named is read in context; `--numbers` puts the file's line on the row
itself for `tree`, `get`, `components` and `cat`.

**Sources this reader refuses, and what to use instead.** `.ent` is EBIN (`ebin.mjs`), a bare `.pak`
is an archive (name an entry), `.c` is script (`cscript.mjs`), `.rdb` is an index (`rdb.mjs`); any
other extension is refused rather than parsed, so a `.txt` or a binary never comes back as
"unexpected character". `check` applies the 16-hex `ID` rule to `.et`/`.conf`/`.ct` only — a `.gproj`
writes its addon id there.

**What a mod ships:** `check "<addon dir>" --lenient --ext .et --strict` audits the prefabs and
survives a file this format cannot read, and one project with its own database resolves its GUIDs in
the same run: add `--addon "<addon dir>" --use-addons-rdbs`. Measured
here on seven Workbench projects: **257 documents in 289 ms, one parse failure** — a layout with
`//~` annotations — and with `--ext .et`, **107 documents in 153 ms, none**. On a generated corpus of
**2 000 documents in 20 directories** the same reader took 453 ms for `info`, 235 ms for `check` and
229 ms for `find` in one process under a 192 MB heap — well under a millisecond per document after
process start — and `--limit` caps the rows while `total` still counts the whole set; the `sources`
table of a `refs`/`find` answer is the full read set whatever the cap, because the rows index into
it (2 000 sources are 629 KB of JSON for `--limit 3`). The
corpus, the counts and a time bound far above those are written by the test suite, not committed —
`ETCONF_BULK_DOCS=2000` for the corpus above, 200 in a normal run so `npm test` stays quick, `0` to
skip it — so a read that turns quadratic fails there instead of in a user's afternoon.

**A mod's world is often text instead**: a `SubScene { Parent … }`
stub or a **0-byte** `.ent` beside `worlds/<Name>_Layers/*.layer`, as `Ruha` and `RuhaWinter` ship —
checking one of those with `ebin.mjs` is a "missing the EBIN magic" error, not a decode failure.
The map itself is then in the `.layer` files: read them with `tools/layer.mjs` (`info`, `get
@0/BSP`, `refs`), or `pak.mjs cat` when the bytes are what is wanted, and `ebin.mjs` has nothing to
read.
The EBIN format is a container the table above does not cover, and `tools/ebin.mjs` is the reader:

```
node tools/ebin.mjs info      <source> [--lenient] [--json]     # version, tables, decode coverage
node tools/ebin.mjs names     <source> [--json]                 # name table: classes, fields, syntax tokens
node tools/ebin.mjs guids     <source> [--rdb <rdb>]... [--json] # GUID table, optionally resolved to paths
node tools/ebin.mjs refs      <source> ... --rdb <rdb> [...] [--json]  # is any resource reference dangling?
node tools/ebin.mjs resources <source> ... --rdb <rdb> [...] [--lenient] [--json]
node tools/ebin.mjs worlds    <source> ... --rdb <rdb> [...] [--lenient] [--json]
node tools/ebin.mjs tokens    <source> [--from N] [--limit N|0] [--lenient] [--json]
node tools/ebin.mjs entities  <source> [--filter RE] [--limit N|0] [--rdb <rdb>]... [--instances N] [--lenient] [--json]
node tools/ebin.mjs find      <source> <needle> [--json]
node tools/ebin.mjs lengths   <source> ... [--lenient] [--json]  # blocks whose stored u16 is short, and where it lands
node tools/ebin.mjs verify    <source> ... [--lenient] [--json]
```

A **source** is a file on disk, or one entry inside a `.pak`, written `<pak>:<entry>` — the rule
`tools/pak.mjs` owns, the same one `loc.mjs` and `etconf.mjs` use. That is how a shipped world is
read: it lives in `worlds*.pak` (and four `.ent` files in `data010.pak`), so nothing has to be
extracted first, and every report names the source as written so a row can be passed back.

```bash
node tools/ebin.mjs entities "<install>/addons/data/worlds001.pak:worlds/MP/CTI_Campaign_Cain.ent" \
  --rdb "<install>/addons/data/resourceDatabase.rdb" --limit 3
# …/worlds001.pak:worlds/MP/CTI_Campaign_Cain.ent: 1059 nodes (421 entities, 83 groups,
#   555 expanded instances, 5 levels deep)
# SCR_AIWorld  @3616
#   prefab   {672531FAC0834C06} -> Prefabs/AI/SCR_AIWorld_Cain.et
```

The entry is inflated out of the archive and decoded in memory, so a world is never written to disk
to be read, and `readEbinSource(spec, { noPakPathSplit })` is the same thing from a script.
`--no-pak-path-split` turns the split off — every source is then a file on disk, even one whose own
name ends in `.pak` or carries a colon; it is accepted by every command, because it decides which
answer a source gives rather than how the answer is printed. The split happens at the **last**
colon and only when everything before it ends in `.pak`, so `D:\work\Cain.ent` stays a file path.
In PowerShell build the source as `${pak}:<entry>`: `"$pak:Prefabs/…"` is parsed as a scoped
variable named `Prefabs`, silently yields `/Prefabs/…`, and the tool then reports ENOENT for a path
the caller never wrote — the reader is right, the caller's string was not.

Read through the four archives rather than from copies on disk, the corpus is unchanged: **103/103
shipped worlds decode exactly, 168 530 192 stream bytes**, the same figures §3 quotes for the same
files unpacked — 2 483 872 of those bytes in `worlds001.pak` alone, in 2.1 s.

An unknown option, a missing value, or a value that is not a non-negative whole number is an
error naming the option (`--limit needs a non-negative whole number, not "abc"`), not silently
the default — `--filte X` used to read as no filter at all. `--help` exits 0; no arguments does
not.

**`--rdb` is repeatable, and the databases are merged under one rule: one GUID names one path,
case-insensitively — and one path names one GUID.** Workbench's *override resource* re-declares a
resource with the **same GUID and the same path**, so overrides merge by construction; a GUID that
changes path between databases, or a path two different GUIDs claim, is a **merge error** and
nothing is resolved. The check lives in `node tools/rdb.mjs verify-merge <rdb>...`:

```bash
node tools/rdb.mjs verify-merge test.rdb "<install>/addons/data/resourceDatabase.rdb"
# merge check: 2 database(s)
#   RDB #1  .../test/resourceDatabase.rdb  (version 7, 186 record(s), 136 GUID(s))
#   RDB #2  .../data/resourceDatabase.rdb  (version 7, 116390 record(s), 110576 GUID(s))
#   110594 GUID(s), 110594 path(s): one-to-one (case-insensitive)
#   ok
```

A valid merge resolves a GUID and says **which databases carry it, in command-line order** —
`{GUID} -> <path> rdb 1 2` in text, with the indices from 1 and the first database's fields
winning; a single database drops the suffix. JSON carries the same fact as `{ path, rdbs }`, with
indices **from 0** into the envelope's `rdbs` array.

The order is the **override order**, and it has to follow the **mods' dependencies**: a dependency is
mounted before the addon that depends on it, so the dependent — the one whose fields override — is
listed **first**, and the base game **last**. (`server.json`'s `mods` array is order-independent; the
engine sorts by dependency, and the tool cannot see those dependencies, so the caller supplies the
resulting order.)

A consequence worth knowing before passing two vanilla databases: **`data`+`core` do not merge.**
They share 151 GUIDs and 136 of those name different paths (core's `configs/…` against data's
`Configs/System/…`), which `verify-merge` reports as 136 `sameGuidDifferentPaths`. `data` alone names
every resource the shipped worlds reference (core resolves 0 of them), so the useful sets are one
database, or an addon plus the database it overrides — where the paths agree because Workbench's
override keeps them.

As a library, `readEbin(input, { strict, name })` takes a path **or the bytes** — a `Buffer` or
`Uint8Array`, which is what `pak.read(entry)` returns — so a world does not have to be written to
disk to be read; `name` labels a byte input in errors and in `file` (default `<buffer>`).
`readEbinSource(spec, { strict, noPakPathSplit })` is the command line's own form: it splits
`<pak>:<entry>`, opens the archive, and labels the result with the source **as written**. The
result carries `header`, `tokens`, `gaps`, `tokenCount`, `exact` and `lengths`, and
`entities(ebin, { instances })` turns it into the tree below.

**Strict is the default.** A file whose value stream does not tile is an error naming the byte
(`… at offset N (byte 0x..)`), not a 99 %-decoded result; `--lenient` brings back the old
resynchronising pass and its gap list, for a file that is already known to be damaged. The 103
shipped worlds are exact, so the default changes nothing on them.

### A world stores overrides, not entities

This single fact decides how to read everything else here. A record names the **prefab** the
entity was made from, then stores only the properties whose value differs from that prefab:

```cpp
GenericEntity "CP_Kamensk" : "{...}ConflictControlPoint.et" {     // class, id, prefab
 m_sBaseName "#AR-Campaign_MapLocation_Cain_Kamensk"              // only what differs
}
```

So a world file is a patch list, and the reader can only tell you what the file *changes*. It
cannot tell you the entity's full component list, because that lives in the `.et`. `CP_Kamensk`
has 22 components in Workbench and exactly **one** in `CTI_Campaign_Cain` — the one whose
`m_sBaseName` was edited. Print an entity from a world file and you have its overrides, not its
definition. `[practice]` 1.8.0.13, checked against Workbench's view of the same world.

That is why `--rdb` matters more than any other option. The prefab is stored as a **GUID**, and
only `resourceDatabase.rdb` can turn it into a path. Measured over all 103 binary worlds shipped
in `addons/data` — the three `worlds*.pak` archives and the four `.ent` files in `data010.pak`:
`entities(…, { instances: 0 })` reports **9 950** entity nodes and **10 409** group nodes that name
a prefab, the token stream holds **21 016** `:`+GUID+block constructs (20 338 `.et`, 653 `.conf`,
25 `.ct`), and **not one** of them fails to resolve through the client's data database — so a path
the tool prints is the real one. `[binary]` 1.8.0.13.

`--rdb` parses every database **before it prints a single path** and refuses one that contradicts
itself: the container header, the record count stored in it, and the record chain must all agree
with the bytes, and the records must end at the file's last byte. A truncated, padded or foreign
file cannot get through. The 8 GUIDs published on the BI wiki are compared when they are present —
a published path carrying another GUID is a contradiction and refuses the database — but a
**workshop database contains none of them and is read**: absence means "not vanilla", not
"broken".

A single database is a **subset**, and this is the trap of the option:
`addons/core/resourceDatabase.rdb` names core's resources only, and a mod's copy names that mod's.
Both pass every check, so a path they lack is reported as unresolved (`<- not in this database`,
`path: null`) — not as "this prefab is not a resource", which is what the tool used to print for
the whole of `Eden.ent` read with the core copy. That is what repeatable `--rdb` is for: pass
several databases and the unresolved label becomes `<- not in any of the N databases`, which is a
claim about all of them — provided they **merge**: one GUID -> one path, case-insensitively (see
`verify-merge` above).

Every resolved value names the databases that carry it, in command-line order:
`{GUID} -> <path> rdb 1 2` in text, `{ path, rdbs }` in JSON, with the preamble listing each file.
`node tools/rdb.mjs merge <rdb>...` prints the dictionary on its own. On the vanilla databases the
corpus resolves **11 912 of 12 045 distinct (file, GUID) references through `addons/data` and 0
through `addons/core`** — the worlds use the game's resources, and the core database exists for the
engine's (configs, imagesets, scripts), which a world can still reference. Note that `data`+`core`
cannot be passed together: they violate the one-GUID-one-path rule for 136 GUIDs, which
`verify-merge` lists.


A third state is not a database question at all: `0000000000000000` is the **null reference** the
engine writes when a resource-valued member is explicitly cleared (18 of the 22 resource references
inside sub-components point at it, and 11 of the 103 worlds hold at least one zero entry in their
table). It prints `<- zero GUID: names nothing` in text and `zeroGuid: true` in `--json` (a table
entry says `kind: "zero"`), so it cannot be read as an entry the database failed to name — that is
what `<- not in this database` is for.

A world's bases — the things a Conflict scenario fights over — are plain entities with a name:

```bash
node tools/pak.mjs get "<client>/addons/data/worlds001.pak" worlds/MP/CTI_Campaign_Cain.ent out/cain.ent
node tools/ebin.mjs entities out/cain.ent --filter "Kamensk" \
  --rdb "<install>/addons/data/resourceDatabase.rdb"
```

```
  instance of GenericEntity "CP_Kamensk"  @13870
    position 11866.496, 8.292, 10679.665   angle -2.121, -15.205, 2.43
    component SCR_CampaignMilitaryBaseComponent {621EB97024DABD3C}
        m_sBaseName = "#AR-Campaign_MapLocation_Cain_Kamensk"
        m_sBaseNameUpper = "#AR-Campaign_MapLocation_Cain_Kamensk-UC"
```

That transform and rotation are the ones Workbench reports for `CP_Kamensk`. `[practice]`

### Records, components, groups, nesting

The text form of the same graph is the authority, and the engine writes it to a `.layer` sidecar
(worlds built in Workbench can be text rather than EBIN) and to every prefab `.et`:

```cpp
GenericEntity "Area_A" : "{...}Area.et" {      // record: class, id, prefab
 components {                                   // the component list
  SCR_ScenarioFrameworkArea "{59E8CDC50969206E}" {   // component: a class WITH a GUID
   m_fAreaRadius 75
  }
 }
 coords 81.09 4.70 64.02                        // the transform: coords, angles, scale
 angles 0 173.65 0                              //   each written only when it is not the default
 scale 2.2
 {                                              // a child list: its own children
  $grp Building : "{...}win_brown.et" {          //   grouped by class and prefab
   { … } { … }
  }
  GenericEntity : "{...}Drain.et" { … }          //   a child that appears once
 }
}
```

The transform is three ordinary members — `coords`, `angles` and `scale` — and the World Editor's
Transformation panel shows exactly those three rows. **A value equal to the default is not written**:
`angles 0 0 0` and `scale 1` never appear, so an entity with no `scale` is at scale 1, not at an
unknown scale. `scale` is a single `f32`; 2 637 808 of them are stored across the shipped worlds (816
of `Arland.ent`'s 2 271 nodes are not at 1), and a value typed into the panel reaches the file only
when the world is **saved** — observed on a hand-made entity whose panel read 2.200 while the layer on
disk had no `scale` at all, until a save added `scale 2.2`.

**"The default" is not always the prefab's value.** A member is omitted when it equals the default,
and that default can be declared in three different places, which are not interchangeable:

- the **prefab's effective value** — the usual case, and itself possibly inherited from the prefab's
  own class or attribute default;
- the **attribute declared on the member in the class definition**: `[Attribute("5", …)]` carries
  `"5"` in `Attribute.m_DefValue` (`scripts/Core/generated/Attributes/Attribute.c`, where the
  constructor's first parameter is `defvalue`), so the class declaration itself is a source of the
  default — not just the prefab's text;
- the **engine's default** when the attribute declares none (`[Attribute()]` leaves
  `m_DefValue = ""`), or when the class or component is engine-implemented and its default exists
  only in the binary.

So an absent member means "the default", not "zero/empty": read the class (and its bases) and the
attribute before deciding what value is in effect, and do not present the prefab's value as the
default when the prefab itself omits the member.

`Flags` — the other row of the entity's General section — is **two `u32` words**, and the two words
mean opposite things. Both were measured box by box: one box changed in the panel, one save, one
reading of `worlds/arland_test_Layers/default.layer`, with a watcher recording every save.

The **first** word holds the boxes that are *ticked*, one bit each:

| ticked alone | stored as |
|---|---|
| `Static` | `0x400` |
| `Feature` | `0x40` |
| `No Link` | `0x20` |
| `Streamable` | `0x100` |
| `On Filtered Navmesh` | `0x10000` |
| `Relative Y` | `0x80000` |
| `Editor Only` | `0x100000` |
| `Disabled` | `0x200000` |
| `Proxy` | `0x400000` |

The **second** word holds the two that are *cleared*, a set bit meaning the box is **off** — the
opposite sense. All four states of those two boxes were measured: both ticked is `0x4`, both cleared
`0x7`, `Traceable` alone `0x5`, `Visible` alone `0x6`; so `Visible` is `0x1`, `Traceable` is `0x2`, and
`0x4` is constant in every state with no box behind it. A save made to test that prediction — untick
`Visible` only — came back `0x5`, which is what `Visible = 0x1` predicts.

A value equal to the class default is **not stored at all**: an entity with no `Flags` line is at its
defaults, not at zeros.

**Do not read the numbering off `EntityFlags.c`.** The generated script
(`scripts/Core/generated/Entities/EntityFlags.c`, 1.8.0.13, `addons/core/data.pak`) lists the same
names, but it puts `STATIC` at bit 7 (`0x80`) where the file writes `0x400`, and it has no bit that
explains the second word's constant. The stored numbering is the engine's own. Read with the table
above, the shipped values decode as `0x80403 0` = `Static` + `Relative Y` + two unmeasured bits,
`0x100003 0` = `Editor Only` + the same two, and every vegetation instance `0 0x80000` = an empty first
word and a second word with no panel box behind it.

In the binary, each of those is a length-delimited scope (`0x0e`), and the grammar is
unambiguous:

- an **entity** is `[class] [id] ":" <guidRef> <block>`. The `:`+GUID+block triple is present in
  every record measured, so it is the anchor — not a guess about capitalisation or prefixes. The
  **id is optional**: a child that keeps the prefab's name stores none, and that is most of a
  world's entities. An entity that stores no prefab at all is `[class] [id] <block>` — the world
  entity and the sun carry an id, a road child of a road generator carries neither
  (`RoadEntity { … }`, 434 in `Arland.ent`).
- **consecutive entities of one class and prefab are compacted**: only the first names them, and
  `[id] <block>` entries after it inherit both. `MP/Coop_CombatOps_Cain.ent` has 205 of those after
  a record; a group is the same compaction at scale.
- the entity's **own members** are the `name value` pairs directly in its block, before and after
  the `components` section alike. A child list lives inside its own block, so it can never leak
  members onto its parent.
- a **component** is `[class] [GUID] <block>` inside the `components` block. The GUID belongs to
  the component *slot*, not to the class: an entity that overrides a property of a component it
  inherited carries the **prefab's** GUID for it, which is what makes a world's override readable
  as "this component of the prefab". `SCR_ScenarioFrameworkArea` carries `59E8CDC50969206E` in
  `Area.et` and in all 246 occurrences across the shipped worlds — but do not generalise: 135 of the
  395 component classes seen appear with more than one GUID, because several prefabs can declare the
  same class and each keeps its own slot id — and a class a prefab instantiates per instance
  (`MeshObject`, 26 distinct) gets a fresh id each time. A **derived prefab can re-declare a slot with
  a related class**: `ConflictSourceBase_T3Harbor.et` declares `{621EB97024DABD3C}` as
  `SCR_CampaignSourceBaseComponent`, where its base `ConflictBase_Base.et` declares the same GUID as
  `SCR_CampaignMilitaryBaseComponent`. So the class in a world record is the one the *prefab chain*
  gave that slot — read the chain, not the nearest base's text.
- a component can carry **sub-components** of its own: its block holds a `components { … }` list,
  exactly as an entity does, and that list can nest one level further. Same keyword, one level down —
  the shape Workbench writes when a component is built out of components, read from a project's own
  text layer:

  ```cpp
  SCR_RespawnSystemComponent "{6AA37B0DFEF7C77E}" {
   components {
    SCR_FreeSpawnHandlerComponent "{6AA37B0DC66AC72F}" {
     m_bDestroyPreviousControlledEntity 1
    }
   }
   m_bEnablePauseMenuRespawn 0        // the parent's own field, written after the list
  }
  ```

  57 components in the shipped worlds carry such a list, 140 sub-components in total
  (`BaseVehicleNodeComponent` → `ControllersManagerComponent`, `SCR_BaseHUDComponent`,
  `SCR_CarControllerComponent`). Nothing else in a component's block is one: a class-and-GUID
  *without* a `components` wrapper is a member's object value (`LinkType NavmeshDoorLink {…}`).
  Their members are read like any other, one level down: `entities --rdb` annotates and prints a
  sub-component's resource-valued member in place, `--json` keeps its `subComponents` tree, and
  `--filter` searches the class, the members and the resolved paths. 22 resource references sit
  inside sub-components in 1.8.0.13: 18 are a direct `0x05` member — 17
  `MuzzleComponent.MagazineTemplate` and one `SCR_MuzzleInMagComponent.AmmoTemplate`, all
  `{0000000000000000}` — and 4 are nested deeper,
  `BaseHUDComponent.InfoDisplays → SCR_WeaponInfo_MultiWeaponTurret.m_LayoutPath`, which name a
  real layout (`WeaponInfo_MultiWeaponTurret.layout`). The zero ones resolve to nothing; the
  nested four are a shipped path that `--rdb` reproduces.
- two shapes are *not* components: a nested sub-object without a GUID (`EventHandlers`), and a
  member whose *value* is a class name (`m_BaseLayout` → `SCR_DebriefingScreenUnevenFourTiles`).
- **the graph is a tree of child lists**, and the file is one of them: the top is the world's own
  children, an entity's children sit in a child list inside its body, theirs inside a child list in
  theirs. `depth` is that distance from the root — up to 8 in the shipped worlds
  (`MP/Coop_CombatOps_Cain.ent`; 7 in `SP/Tutorial`). A group is not a scene node of its own: it
  belongs to the child list it sits in, and that is what `parent` names.
- `$grp <class> [":" <prefab>] <block>` is a **group**: one header and N member blocks that carry
  only transforms and overrides. That is where a terrain world hides its trees — 1 542 groups and
  1 419 984 members in `Cain.ent` alone — so a group is one node with `instances: N`, and
  `--instances 0` / `--instances N` decides whether the members are listed or only counted. An
  `id` inside a group belongs to the member block that follows it, which is how `$grp
  GenericEntity : <prefab>` keeps `CP_Kamensk` attached to the first of its instances.
- **the member list is not bounded by that block.** When it does not fit, the rest of the members
  follow *outside* it as sibling blocks — `[id] <block>` pairs with no second header — and the
  parent's recorded length stops short of them, which is the stored-length rule seen from the other
  side (below). A group is therefore the body's blocks **plus every block that follows**, and that is
  measured, not assumed: `Arland.ent` holds 63 644 members inside bodies and 108 078 outside, and
  with them the world has **173 206** entity-and-member nodes against the **173 226 the World
  Editor reports for the same file** (20 off, 0.01 %); without them it is 64 822, a third of the
  world. 253 groups in the corpus overflow this way.
- a **member's block is never a child list**, however much it looks like one: `Data { … }` is a
  member of a `ShapePoint` whose value is a struct (285 in `Eden.ent`), while `RoadEntity { … }` is
  a child. Both are a name followed by a block; only the token in front says which — a value, or
  the list's boundary (padding, or the previous entry's block). Reading the first as the second
  invented 339 nodes in `Eden.ent`.

### What a member's value is

A value that is not a scalar is almost always a block, and what is inside it is readable, so it is
read rather than summarised. Four shapes cover every member in the shipped worlds:

| in the file | what it is | printed as |
|---|---|---|
| `name { <padding> <array> }` | an array, always wrapped this way | `[36, 37]`, `["Slot3", "Slot4"]` |
| `name { <Class> <GUID> {…} … }` | an array of objects | one line per object, members under it |
| `name <Class> <GUID> {…}` | a nested object | the class and GUID, members under it |
| `name { <member> <value> … }` | a plain struct | braces with the members inside |

```
m_aIncludedEditableEntityLabels = [46]
m_aExcludedEditableEntityLabels = [52, 51, 21, 35, 23]
m_aActivationActions =
  SCR_ScenarioFrameworkActionKillEntity {5EBEEB2CAE8F801C}
    m_Getter = SCR_ScenarioFrameworkGetSpawnedEntity {5EBEEB2CAD2066C2}
      m_sLayerName = "SlotAI8"
m_aBlacklistZones =
  SCR_SpawnPointBlacklistZone {691E6E23D83D1172}
    m_vCenter = 11392.4, 35, 2089
    m_fRadius = 2000
```

Two details that change what the value *means*:

- **`+` is the append operator**, not a field. The text form writes `m_aWheels + { 4 5 6 7 }`
  meaning "append to the array the prefab already has", and the binary stores the same `+` as a name
  token between the member name and its value. The tool prints `+=` so an append cannot be read as
  a replacement. `+` and `:` are the only two non-identifier names in any world's name table.
- **Arrays print their first 256 elements**, and say so (`… 40 more`); the `count` in `--json` is
  always exact. Element types are whatever the array's tag fixed: `0x81` i32, `0x85` GUID reference,
  `0x86` f32, `0x88` vec3, `0x8c` string, `0x8d` name, `0x80` empty (which has zero width, and
  getting that wrong shifts the rest of the file by one byte per element). An array of GUID
  references is a list of resources: `--rdb` prints each resolved path in place and adds `paths`
  (one per value, `null` where the entry names nothing) to the member in `--json`. `--filter` looks
  inside an array too — at its string values (`m_aLayerName ["SlotAI8"]`) and at those resolved
  paths — so a prefab referenced only from an array is findable. It reaches a component's
  sub-components the same way: class name, member names, values and resolved paths.

Only a block that did **not** tile stays a size — `<block, N bytes, opaque>` — because it is data
and not a value (see the `BSP` member of the world entity, below).

### The container and the tag table

```
"EBIN" | u32 version (1) | u16 nameCount | u16 guidCount
       | nameCount x (u16 length + UTF-8 name)     <- class names, field names, even ":" and "$grp"
       | guidCount x 8 bytes, little-endian        <- resources AND component instance GUIDs
       | the value stream
```

The value stream is a sequence of `<u8 tag> <payload>`. Every tag below is established the same
way: it makes whole files tile to their exact last byte, and the value it yields agrees with the
text form of the same object.

| tag | payload | what it is |
|---|---|---|
| `0x00` | none | padding between fields; carries nothing |
| `0x01` | `i32` | `m_iRandomPercent` reads `100` |
| `0x02` | **two `u32` words** | a bit mask, and the text form prints it as a pair: `Flags 0x100003 0`, `LightType 0x40 0`, `Rendering 0x1d 0x20`. Every field that carries it is a mask — `Flags` is 2 107 724 of the 2 107 782 occurrences |
| `0x05` | `u16` index into the GUID table | **a resource reference**: the prefab of a record, the `Parent` of a sub-scene, a resource-valued member |
| `0x06` | `f32` | `m_fAreaRadius` reads `75` |
| `0x07` | `vec2` (2 × f32) | found in the last undecoded blocks: `-45 45` |
| `0x08` | `vec3` (3 × f32) | `coords`, `angles` |
| `0x09` | `vec4` (4 × f32) | colours, quaternions |
| `0x0b` | `u8` | boolean-ish fields read 0/1 |
| `0x0c` | `u16` length + bytes | field strings ("Terrain", "PoseID") |
| `0x0d` | `u16` index into the name table | every class name, member name, `:` and `$grp` |
| `0x0e` | `u16` length | **a scope**: `blockEnd = at + 1 + length`, so the content is `length - 2` bytes after the field. Tokens, a text payload, or a list behind two bytes |
| `0x43` | `u16` length + bytes | **entity ids** ("CP_Kamensk") — a different tag from `0x0c` |
| `0x44` | 8 bytes inline | a GUID carried in the stream, not in the table |
| `0x45` | `u16` index into the GUID table | a **component instance GUID**, not a resource |
| `0x8X` | `u32` count + `count` untagged elements of type `0xX` | arrays: `0x81` i32, `0x85` guid reference, `0x86` f32, `0x87` vec2, `0x88` vec3, `0x8c` string, `0x8d` name, `0x80` empty (zero width) |

Tags `0x03`, `0x04` and `0x0a` are still unidentified, and they now appear only inside payloads that
do not decode at all — never in a scope that otherwise tiles. Inventing a width for one would corrupt
everything after it, so they stay unknown on purpose.

### Payloads that are not token streams

Three shapes are established by tiling, and none of them is "undecoded":

| shape | what it is | how it is reported |
|---|---|---|
| printable ASCII | `BSP`, the world's tree: `<u32 nodeCount>` then `nodeCount` × 4 integers — true for all 19 in the shipped worlds (20 721 nodes) | `BSP 1136 nodes`, or `BSP invalid: <reason>` |
| two bytes, then `0x0e` sub-blocks that tile exactly | a group's instances. The second byte is `0`, and the first is a value of the **prefab in that world** — see below — never interpreted | `<N entries behind 2 unknown bytes>` |
| neither | not seen in the shipped worlds any more (1.8.0.13) | `opaque`/gap, bytes counted |

**The two-byte prefix is a property of the prefab, per world.** Measured over the 117 instance lists
in the shipped worlds:

- it is **constant for a given (world, prefab) pair** — 108 of 108 pairs;
- it **differs between worlds for the same prefab** — all 14 prefabs that appear in more than one
  world: `b_juniperus_communis_0.et` is 4 in Arland and 13 in Cain, `b_corylus_avellana_1l.et` is 5
  in Arland and 48 in Eden;
- it **groups prefabs together** inside a world: Arland has 10 prefabs and 5 values, Cain 46 and 22,
  Eden 47 and 19;
- a group of *records* rather than instances starts `00 00`, i.e. the value is `0`.

That is the shape of an index into a per-world table that several prefabs share — most consistent
with the terrain's surface/vegetation material bucket, whose order differs per terrain and would
explain both the sharing and the cross-world difference. **That interpretation is not proven**, so
the reader carries the byte as `headerBytes: 2` / `header: [N, 0]` in `--json` and prints it as
unknown, which is also what makes it checkable: open the same world in Workbench and compare the
number with what the editor shows for that group.

What it is *not*, each tested against all 117 lists and matching only by chance: the unit count
(2/117), the unit count mod 256 (4), the number of members in a member (14 at best), the number of
distinct unit shapes or lengths (3 each), the length of the initial run of equal units (7), the
first unit's own length field (4), the run of padding bytes at the start of a unit (11), a count of
distinct `Flags`/`scale`/`coords` values (≤ 9), a world cell index across 17 cell sizes × 5
formulas (≤ 13), and an index into the world's GUID table (`guids[N]` are world entities, not
materials).

Four writer quirks are compensated rather than reported as corruption, each with its evidence:

- **a stored length that is short of its block's content** — 256 blocks in 11 files. The `0x0e`
  u16 is a **lower bound, not a delimiter**, and the reader never ends a scope at it when the tokens
  disagree:
  - a block of more than 64 KiB **cannot be expressed in a u16 at all**; twelve are that big, and
    seven of them store exactly `trueLength mod 65536`, so only the tokens say where they end;
  - 189 of the short ends fall **inside a value** (`vec3`, `u64`, `f32`, `string`, `guid`, or a
    block's own header) — a place no block can end;
  - the other 67 fall on a token boundary, but on one that cannot continue the enclosing record
    list: 53 before a member name (`coords` 14, `angles` 15, `scale` 16, `Flags` 7, `Position` 1),
    10 on padding before one of those, 3 on a bare value and 1 on a bare block;
  - **248 are the last child block's own doing**: its stored length is exactly its content and
    reaches past the parent's end. The other 8 are enclosing blocks whose last child is itself short.

  The child's number is corroborated by its bytes, the parent's is contradicted by them. That is why
  the scope is extended to the child and never cut at the stored end — a measurement, not a
  preference. `node tools/ebin.mjs lengths <worlds>` prints every case with the token its stored end
  lands in; `info` and `verify` report the counts.
- **the two-byte offset** in the instance lists above.
- **a scope that stops two bytes into its last child's header**: the parent's bytes run out inside
  `0e` + one length byte, and the block continuing there is that child, written without its tail in
  the parent's length. Re-parsing the scope to the child's own end is what the last 92 612 bytes of
  `Eden.ent` were — before that, two blocks came back `opaque`.
- **a member list that ends inside its last member**: while the bytes after a list are a named member
  (`[id] [block]`), they are part of the list, and the block — and every scope above it — is extended
  to them. `Ugoldar_Randomization_Arena` in `MP/Coop_CombatOps_Cain.ent` needs it for four of its seven
  layer members, which otherwise land outside the arena the World Editor shows them in.

Over the 103 shipped worlds that is **100.00 % of 168 530 192 value-stream bytes decoded, and all 103
files tile to their exact last byte**. `[binary]` 1.8.0.13, `node tools/ebin.mjs verify <worlds>`.

Report the coverage next to any conclusion drawn from a file with gaps — but after this pass a gap no
longer means "the reader gave up early", it means those particular bytes contradict themselves.

### The `BSP` tree: a node count by default, the nodes on request

`BSP` is the one payload that is **decoded** instead of described, and one decoder serves both forms
of a world — `tools/bsp.mjs` (`decodeBsp`, `describeBsp`), used by `ebin.mjs` for the binary resource
and by `etconf.mjs`/`layer.mjs` for the text layer. A node is four integers:

| integer | meaning | how it was established |
|---|---|---|
| 1 | split axis: `0` = X, `1` = Y (up), `2` = Z | axis-`1` values are heights — Cain's maximum is `731`, against the world's own `boundMaxs.y` of `731.6` |
| 2 | the plane's position along that axis | **not interpreted**: along X and Z it lies on a quantized per-world lattice (±29750 in 4250 steps on Cain *and* Eden) that does not match `boundMins`/`boundMaxs`, which are metres, so its unit stays unknown rather than guessed |
| 3, 4 | the two child nodes, `-1` where there is none | in all 19 trees, every index `1..N-1` is the child of exactly one node — and **764 nodes have one child**, so it is a tree, not a full binary tree (`N` nodes ⇒ `N+1` leaves holds only in `EmptyCain`/`EmptyEden`) |

The text form is the count, never the integers: `BSP = 1136 nodes`, and `BSP = invalid: <reason>` when
the list does not hold together. In `--json` the **default is the count too** —
`bsp: { count, error }` — because a terrain world's tree is 17 277 integers (4 319 nodes, ~70 KB once
shaped as arrays) and a reader that has to scroll it pays for context it did not ask for. `--bsp nodes`
adds the tree: `bsp: { count, nodes: [[axis, plane, child, child], …], error: null }`. **An AI agent
should leave `--bsp` at its default**: the count answers "is the tree there, is it whole", and the
arrays are for a caller that will compute with them.

Invalid means one of: the list length is not `1 + 4 × count`, an axis is outside `0..2`, a child index
is outside `-1` and `1..N-1`, the same child is named twice, or a node is named by nobody. It is
reported as an **error**, never as a truncated tree: `ebin.mjs verify` exits 1 and names the byte
offset, `etconf.mjs check` and `layer.mjs check` name the line. That is a data defect, not a reader
gap — the bytes decode exactly and the record they hold is still wrong.

### What a world is based on: `worlds`

A sub-scene holds only the layers added on top of a base scene, so its own records cannot tell you
what it is based on. The base scene is named in the **GUID table** and referenced by the
sub-scene's `Parent` member:

```bash
node tools/ebin.mjs worlds out/cain.ent --rdb "<install>/addons/data/resourceDatabase.rdb"
#   [0] {1EA95DAE3230BEB0} -> worlds/Cain/Cain.ent
```

Across the four `CTI_Campaign_*` worlds, entry 0 is that map's terrain world
(`CTI_Campaign_Cain` → `worlds/Cain/Cain.ent`, `CTI_Campaign_Arland` → `worlds/Arland/Arland.ent`,
`CTI_Campaign_Montignac` → `worlds/Eden/Eden.ent`). `--rdb` is required, because only the resource
database can say which GUIDs are world resources. Each row carries `used`, which is what the
`Parent` reference sets.

### What a world references: `refs`, `resources` and `entities --rdb`

The GUID table holds two kinds of entry, and the tags tell them apart:

| tokens | resolves to a resource |
|---|---|
| tag `0x05` scalar, and `0x85` array elements — 39 327 refs of 5 766 distinct GUIDs | **39 128 refs, 5 654 GUIDs** |
| tag `0x45`, 33 982 refs (1 209 distinct) | 0 |
| tag `0x44`, 8 bytes inline (83 605 refs) | 0 — not in the table at all |
| `ID` field values (16 hex chars) | 0 |

`0x45` values are **editor-generated object ids, not resources**. Each names a component *slot*, and
the value is written in the prefab that declares it: `ConflictControlPoint.et` holds
`SCR_CampaignMilitaryBaseComponent "{621EB97024DABD3C}"`, which is exactly the GUID the world's table
carries for `CP_Kamensk`. The value therefore travels with the prefab — **657 of the 1 209 distinct
`0x45` GUIDs appear in two or more of the 103 worlds** (one in 33; a single `MeshObject` slot is
referenced 298 times across 9) — while every instance of the slot carries the same GUID
(`SCR_AmbientVehicleSpawnPointComponent` is `5D5E85F932F777FA` all 62 times). What is local to the
file is the *table index*, not the value. A component the world creates itself, or one the prefab
instantiates per instance (`MeshObject`, 26 distinct), gets an id that appears in that file only.

The bytes identify them. The **high 32 bits behave like a Unix timestamp**: 98.1% of the 1 209 fall in
2012–2025, clustered on development dates (2019: 236, 2021: 161, 2013: 117), and a prefab's own
`ID "621EB97024DABAFE"` sits in the same second as its components' ids — where the high halves of the
110 177 resource GUIDs are uniform over 1970–2106, which is a path hash. The **low 32 bits behave
like a per-session counter**: 15.4% of adjacent values inside one second are consecutive, which a
uniform value would never give. No class-name hash (FNV-1a, CRC32, djb2) reproduces them, and none of
the four installed databases — client and server, data and core — names a single one of the 1 209.
`ID` values are a name-like id that appears nowhere else in the file. Neither is a resource
reference — the trap is to read them as one.

`guids` names that classification per row, because the file already carries it in the tags: `kind` is
`resource` (referenced by `0x05`, directly or through an `0x85` array), `componentSlot` (referenced by
`0x45`), `zero`, or `unused` (no token points at it), and the text form says `<- component slot (see
the prefab)` instead of leaving a slot to be read as a resource the database lacks. The summary
counts the rows, so a listing reads `116 of 148 table entries resolve through this database; the
rest: 32 component slots (see the prefab)` — and the same classification is printed without `--rdb`,
since it needs no database. Across the 103 worlds the two sets never overlap: 11 882 entries are
referenced by `0x05` only, 2 576 by `0x45` only, 0 by both, 163 by nothing, 11 are the zero GUID.

`0x05` values **are** resource references, and that is the tag the reader follows:

```bash
node tools/ebin.mjs resources out/cain.ent --rdb "<install>/addons/data/resourceDatabase.rdb"
#   [   0] used   {086E46E08A3675AE} -> Prefabs/World/Game/Cain/GenericWorld_Cain.et
#   [   1] used   {17857A588EC4C3C0} -> Prefabs/World/Game/Cain/GenericTerrain_Cain.et
#   ...
#   1728 resource name(s) in a table of 1793; 65 component slot(s) (see the prefab);
#   1728 of the 1728 resource(s) referenced
```

`resources` lists every GUID-table entry that resolves to a path, marks the ones a token — or an
element of a `guidRef` array — references (`used`), and separates the entries that name nothing by
what the tags prove they are: `componentSlots`, `unreferenced`, and `unresolved` (a resource
reference that no given database names — the only one of the three that is a defect). It takes
several files and carries the same envelope as `worlds`.

### Is any reference dangling? `refs`

`refs` is the completeness check, and the reason the answer can be a number rather than an
impression. It walks the token stream, takes **every `0x05` scalar and every element of an `0x85`
array** (the null reference excluded — it names nothing by design), resolves each distinct GUID
through all the `--rdb` databases, and exits 1 if one resolves nowhere, printing the file, the GUID,
the entity and member that carry it, and the offset:

```bash
node tools/ebin.mjs refs <worlds>/*.ent \
  --rdb "<install>/addons/data/resourceDatabase.rdb"
# 39327 resource reference(s) to 12045 distinct GUID(s) in 103 file(s)
#   11912 of 12045 distinct GUID(s) resolve; 133 do not
#   ! …/Showcase/PBR_Props.ent: {267CFA7B91DDFA14}  GenericEntity, Object  @2488
#   ...
```

(`data` alone, because `data`+`core` do not merge — 136 GUIDs name two paths; see above.)

**The 133 are real and they are not the reader's fault.** They are 112 distinct GUIDs, and every
one of them is absent from all **229** resource databases installed on this machine (the client's
and server's data and core, and 224 workshop addons'), absent from the 267 339 `{GUID}path`
references written in the game's text resources across the installed paks (63 382 distinct GUIDs),
and no `.meta` sidecar ships in a pak (0 of 222 572 entries), so there is nowhere else a name could
come from. They sit in **14 worlds**, 11 of them `worlds/Showcase/*` (the PBR/showcase scenes —
`PBR_Props.ent` alone has 25), plus `Showcase/Terrain/ENF_TECH.ent`,
`CaptureAndHold/CAH_TestWorld.ent` (its `Parent` base scene),
`ScenarioFramework/SF-Tutorial-Empty.ent` (a `Satellite background image`) and
`SP/Story/Scenario05_Hill` (one element of a `Filenames` array). Every member that carries one is a
mesh or material value — `MeshObject.Object`, `AssignedMaterial`, `Mat` — not a prefab, a `.conf`
or a world. The only explanation the files support is content removed from the build while the
scenes that referenced it were left in place; the 89 other worlds, including every multiplayer and
campaign one, resolve **completely**. `[binary]` 1.8.0.13.

`entities --rdb` resolves the prefab of every record and every resource-valued member in place, so
the answer is visible where the question arises:

```
GenericEntity "Area_A"  @349
  prefab   {C72F956E4AC6A6E7} -> Prefabs/Systems/ScenarioFramework/Components/Area.et
  position 81.093, 4.706, 64.021
  component SCR_ScenarioFrameworkArea {59E8CDC50969206E}
      m_iRandomPercent = 100
      m_bShowDebugShapesDuringRuntime = true
      m_fAreaRadius = 75
```

Each resource-valued member keeps `guid` and `index` (its GUID-table entry) plus `path` and `rdbs`:
the resource path and the **0-based** databases that carry it, in override order, or `null`/`[]`
when no given database names it — a component slot (the `kind` of its `guids` row), or a resource
none of them carries. An array of references carries `paths` (one path per element) and `pathRdbs`
(one index list per element). The null reference `0000000000000000` is a third case and carries
`zeroGuid: true` with `path: null`; in an array the distinction is in `value` (the zero element is
right there) and `paths` is `null` for it. `null` alone is not a statement that the member is not a
resource — see §3 on how narrow one database can be, and on the zero GUID.

### `--json`, and the 200-row limit

`entities` and `tokens` stop at **200 rows** unless told otherwise: `--limit N` sets the count and
`--limit 0` (or `--all`) lifts it. Their `--json` output is an **envelope, not a bare array**, so a
truncated read cannot be mistaken for a complete one:

```json
{
  "file": "out/cain.ent",
  "total": 1059,
  "returned": 200,
  "truncated": true,
  "filter": null,
  "coverage": {
    "tokens": 15594,
    "bodyBytes": 55136,
    "decodedBytes": 55136,
    "undecodedBytes": 0,
    "opaqueBlocks": 0,
    "opaqueBytes": 0,
    "gaps": 0,
    "exact": true
  },
  "entities": []
}
```

`total` is every **node** the reader found (after `--filter`) — entity, group or expanded member —
`returned` is how many are in `entities`, and `truncated` is `returned < total` — when it is true,
`entities` is the first `--limit` rows and nothing more. `tokens --json` carries `from` and `tokens`
instead of `filter` and `entities`. Read `total` and `truncated` before concluding anything from
the row list, and `coverage` before concluding anything from the entities.

The other commands answer `--json` with the same idea — an object that names the file, never a bare
list whose completeness you cannot check:

| command | `--json` |
|---|---|
| `names` | `{ file, total, names: ["…"] }`, in table order |
| `guids` | `{ file, rdbs?, total, resolved?, guids: [{ index, guid, kind, path?, rdbs? }] }` — `kind` is `resource`/`componentSlot`/`zero`/`unused`; `path`, `rdbs` and `resolved` only with `--rdb`; `rdbs` lists the 0-based databases that name the GUID, in override order (empty when none does) |
| `find` | `{ file, needle, total, hits: [{ at, depth, kind, value }] }` |
| `refs` | `{ rdbs, files, references, distinct, resolved, byRdb, unresolved: [{ file, guid, at, member, class?, id?, prefab? }], failed }` — `byRdb` is keyed by the 0-based index |
| `verify`, `lengths` | an array of per-file rows, **always an array**, even for one file |
| `worlds`, `resources` | `{ rdbs, files: [{ file, scenes }] }` / `{ rdbs, files: [{ file, resources, tableEntries, componentSlots, unreferenced, unresolved }] }` — an envelope, because the rows alone cannot say which database a path came from |
| `merge` | `{ rdbs, resources: { "<GUID>": { path, rdbs } } }` — the dictionary, 0-based; an invalid set answers with the `verify-merge` report and `resources: null` |
| `verify-merge` | `{ ok, rdbs, guids, paths, sameGuidDifferentPaths, samePathDifferentGuids }` — every offender with 0-based `rdb` |

`rdbs` is the head array `[{ file, bytes, version, records, guids }, …]` and is absent without
`--rdb`; a value's `rdbs` indexes it **from 0**, so the same list is carried once and referred to by
position. The text form uses the same indices **from 1** (`RDB #1`, `rdb 1 2`), because that is how
the preamble names them.

Every node carries `depth` and `parent` (its index in the same array, `null` at the root), so the
tree in the file is recovered from `--json` without guessing from the indentation: an entity's
children are the following rows whose `parent` chain leads back to it.

### Limits worth knowing before you trust a number

- **Overrides only.** A record lists what the world changed; the prefab holds everything else.
  Follow the prefab path with `pak.mjs cat` if you need the full component list.
- **A group is counted, not expanded, past `--instances`.** `Cain.ent` has 1 542 groups and
  1 419 984 members; listing every tree is possible but rarely what you want, so the default caps
  expansion at 2 000 members. The count is exact whether or not the members are listed.
- **`0x02` is two `u32` words**, and the text form of the same object prints the same pair — compare
  with it directly. What each bit *means* belongs to the class that declares the field, not to the
  file; `Flags` alone has 46 distinct values across the shipped worlds.
- **Nothing is undecoded in the shipped worlds.** All 103 tile to their last byte; a file that does
  not is an **error naming the byte** (strict is the default), and `--lenient` reports the gap list
  instead — so a gap means those particular bytes contradict themselves rather than "the reader gave
  up early".
- **A stored block length can be short — the tokens are the delimiter.** 256 blocks across the 103
  worlds carry a u16 short of their content (11 files); 7 are a u16 wrap of a block over 64 KiB.
  Never cut a scope at the stored end when a token disagrees: `lengths` lists every case and
  `info`/`verify` count them.
- **Deep structure is printed to three levels**, then as a size (`<block, N bytes, not expanded>`);
  `--json` carries the structure itself, so use it when the printed tree stops early. Arrays above
  256 elements and object lists above 8 entries are abbreviated on screen, never in `--json`.
- **Block nesting is capped at 512 levels.** No shipped world goes past 8, so the cap is a guard
  against a hand-made or hostile file overflowing the stack; past it the deepest block is reported
  as an opaque payload whose gap names the cap (and `--lenient` keeps everything above it).
- **A terrain world costs seconds and gigabytes.** `Cain.ent` is 19 803 563 tokens: reading it takes
  ~3 s and about 3 GB of RSS, and expanding its 1 419 984 members doubles that — measured on
  1.8.0.13. Use `--instances 0` (or `--filter`) when the members are not the question, and give the
  process room (`node --max-old-space-size=8192 …`) if it is.
- **Counts here are for the installed 1.8.0.13 archives.** The number of files, records and
  coverage percentages move with the build; re-run `verify` rather than quoting them.

## 4. Getting a GUID

`{2B4183DF23E88249}Missions/CAH_Morton.conf` — the GUID is a resource identity. It is stored in
Workbench `<file>.meta` sidecars, which are **not shipped inside the pak**, but it *is* in
`resourceDatabase.rdb` (in the install under `addons/data/`, ~11 MB) as raw little-endian bytes.
[`tools/rdb.mjs`](../../tools/rdb.mjs) reads it in both directions:

```bash
node tools/rdb.mjs get          <rdb> <guid>      # GUID -> path
node tools/rdb.mjs guid         <rdb> <path>      # path -> GUID, the direction a scenarioId needs
node tools/rdb.mjs list         <rdb> [regex]     # browse with kinds; --limit N|0, --json
node tools/rdb.mjs info         <rdb>             # container, header, kinds, metadata, extensions
node tools/rdb.mjs verify       <rdb>             # structure, mapping, and the 8 published GUIDs
node tools/rdb.mjs merge        <rdb>...          # several databases as one dictionary (one GUID -> one path)
node tools/rdb.mjs verify-merge <rdb>...          # would they merge? every offender, with both paths/GUIDs
```

### More than one database: one GUID, one path

A build ships two databases and every installed addon brings its own: `addons/data` names the
game's resources, `addons/core` the engine's (configs, imagesets, scripts), and a mod's copy names
that mod's. A world can reference several of them at once, so `ebin --rdb` is repeatable and
`merge` does the same for the databases alone:

```bash
node tools/rdb.mjs merge \
  "<workbench>/addons/test/resourceDatabase.rdb" \
  "<install>/addons/data/resourceDatabase.rdb"
# resource databases: 2
#   RDB #1  …/test/resourceDatabase.rdb  (version 7, 186 record(s), 136 GUID(s))
#   RDB #2  …/data/resourceDatabase.rdb  (version 7, 116390 record(s), 110576 GUID(s))
#   110594 GUID(s), 110594 path(s): one-to-one (case-insensitive)
#   {FA5C25BF66A53DCF} -> Prefabs/Weapons/Rifles/AK74/Rifle_AK74.et  rdb 1 2
#   ...
```

The rule is a **bijection, case-insensitively**:

- **one GUID -> one path.** An override re-declares a GUID, so every record of that GUID — in every
  database — must use the same path. The addon's AK-74 is `{FA5C25BF66A53DCF}` with the vanilla
  path, so it merges and the text says `rdb 1 2`; its fields win because it is first.
- **one path -> one GUID.** Two different GUIDs must not share a path.

A case difference (`Prefabs/X.et` / `prefabs/x.et`) is not an error; the first spelling is the one
reported. Anything else is a **merge error**: `merge` prints `FAIL`, `ebin --rdb` refuses before a
path is printed, and `verify-merge` lists every offender, in both directions, with the databases
from 1 and `--json` from 0:

```bash
node tools/rdb.mjs verify-merge a.rdb b.rdb
# merge check: 2 database(s)
#   RDB #1  …  RDB #2  …
#   110594 GUID(s), 110595 path(s): NOT one-to-one (case-insensitive)
#   FAIL  {BBBBBBBBBBBBBBBB} names 2 path(s)
#           RDB #1  Configs/System/ResourceTypes/Sound.conf
#           RDB #2  Configs/ResourceTypes/Sound.conf
#   FAIL  "Prefabs/X/Thing.et" is named by 2 GUID(s)
#           RDB #1  {AAAAAAAAAAAAAAAA}
#           RDB #2  {EEEEEEEEEEEEEEEE}
```

**The order is the override order**, and it has to follow the **mods' dependencies**: a dependency
is mounted before the addon that depends on it, so the dependent — the one whose fields override —
is listed first and the base game last. `server.json`'s `mods` array is order-independent (the
engine sorts by dependency); the tool cannot see those dependencies, so the caller supplies the
order that results from them.

The text form is `<GUID> -> <path> rdb <indices from 1>`; with a single database the suffix is
dropped (`<GUID> -> <path>`). JSON is `{ "<GUID>": { path, rdbs: [0-based indices] } }`, the indices
into the `rdbs` array at the head of the same object. `merge` shows the GUIDs more than one database
names; `--json` carries the whole dictionary.

A consequence worth knowing before passing two vanilla databases: **`data`+`core` do not merge.**
They share 151 GUIDs, and **136** of those name different paths (core's `configs/…` against data's
`Configs/System/…`), so `verify-merge` reports 136 `sameGuidDifferentPaths` and `ebin --rdb` refuses
the pair. `data` alone names every resource the shipped worlds reference; the useful sets are one
database, or an addon plus the database it overrides (the paths agree there, because Workbench's
override keeps them).

Passing the same database twice is refused rather than deduplicated: a second index would claim
paths it does not own. The library form is `verifyMerge([scanned…])` → the check object,
`mergeRdb([scanned…])` → `MergedRdb` (`resolve` with `{ path, rdbs }`, `resources()`, `json()`) and
`openRdbFiles(paths)` → `{ merged, check }`, which is the whole scan-verify-merge path.


### The one kind of reference that cannot resolve

`ebin refs` over the 103 shipped worlds with `data`+`core` reports **39 327 references to 12 045
distinct (file, GUID) pairs; 11 912 resolve and 133 do not** — 112 distinct GUIDs, every one
absent from all 229 installed databases and from the game's own 267 339 text references. They are
in 14 worlds (11 `Showcase/*`, plus `Showcase/Terrain/ENF_TECH`, `CAH_TestWorld`'s `Parent`,
`SF-Tutorial-Empty`'s satellite image and one `Filenames` element in `Scenario05_Hill`), and every
member carrying one is a mesh or material value. They are content removed from the build while the
scenes remained, not a database the caller failed to pass — the 89 other worlds, including every
multiplayer and campaign one, resolve completely. There is no fifth database on this machine that
names one: 229 `.rdb` files, 0 hits. `[binary]` 1.8.0.13.

The file is a `FORM` container with a header, a root record and then the records:

```
"FORM" | u32BE size-8 | "RDBC" | u32LE version | u32LE size
u32 flags | u32 nameCount | names (u32 length incl. NUL, bytes, 0x00) | u32 recordCount
root record: empty path, kind 5 (directory), zero GUID
records, back to back, to the last byte of the file
```

Every copy checked — the client's and the dedicated server's data and core databases and 224
workshop addons' — parses to its exact last byte, and the parsed record count equals
`recordCount - 1`; `scanRdb` refuses a file where either is untrue. That is what makes the read a
parse rather than a carve: a 2 MB prefix of a database is refused at the header instead of yielding
19 837 "valid" records and "not found" for everything after it. The name list names the build: the
data database lists `spruce`, the core database `license`, workshop databases none.

Three versions occur, and the reader handles all of them: **7** is the installed build's, **6** is
current Workshop content, **5** is old Workshop content. Version 5 has no name table (flags are
followed directly by the count) and its root record carries a GUID; the record layout is otherwise
the same. The version is reported, not gated — the structure is what is validated.

A record is

```
[u32LE pathLen + 1][path][0x00][u32LE kind][u16 flags][GUID 8][metadata 0..16]
```

and the GUID starts **7 bytes after the path's NUL terminator**. The u32 counts the path **and its
NUL**; the path is printable ASCII — 244 paths contain a space, a dozen contain `@ ! # ( ) +`, so
the whole printable range is accepted.

- **kind**: the low 4 bits are the base type — 4 script, 5 directory, 6 file, 7 group — and the
  higher bits are flags. On the server's copy 35 461 records carry `0x10` and every one names a
  resource whose file is in none of its paks (the client has the same paths as plain 5/6/7), so
  `0x10` marks what this build knows but does not ship; 9 Cain vegetation prefabs carry `0x10000`.
- **metadata** is a whole number of 4-byte words: 8 bytes `[mtime, type]` on version 7's files and
  groups and version 6's directories, 16 bytes (two such pairs) on version 6's files, 4 bytes on
  version 5's directories and root, 12 bytes on version 5's files. Which length applies is decided
  by the bytes — a timestamp is not a small length followed by a printable path — and then
  validated by the record that follows. The mtime is identical in both copies for all 98 751
  shared records that carry it, and equal to the matching pak entry's timestamp for two thirds.
  `type` is a 16-bit resource type id — 3 471 distinct, shared by similar resources — exposed and
  not mapped to names, because the file does not hold the mapping.
- a **script** record has a zero GUID: it is in `entries`, not in the GUID map.

`verify` keeps three answers apart:

- **`ok`** — the structural check: the container and header parsed, the count matches, the records
  end at the file's last byte, it is non-empty, and no published pair contradicts it. It holds for
  any database, including a workshop one.
- **`vanilla`** — the 8 pairs the BI wiki publishes for the vanilla scenarios. They are the only
  external evidence for where in a record the GUID sits (a reader shifted by a byte cannot match
  them), but they are 8 records of ~116 000 and a workshop database has none. A *contradiction*
  (a published path with another GUID) is reported as such; absence is not a defect.
- **`unique`** — one GUID to one path. The installed databases are one-to-one; **14 of the 228
  copies checked reuse a GUID** (a mod packaging fault), which `verify` reports as
  `duplicateGuids`/`duplicatePaths`; the map keeps the first record, deterministically, and the
  file is still read. `ebin --rdb` reads it too and prints the same note on stderr before resolving
  anything, because the path it yields for that GUID may belong to the later record.

On 1.8.0.13 the client's copy is 116 389 records (110 576 with a GUID, 5 813 scripts) and the
server's 116 541 (110 728), both 8/8. The library form is `readRdb` (GUID -> `Map`), `scanRdb` (the
same read plus the header, kinds and metadata), `reverseRdb` and `verifyRdb`. The parsing does not
rest on the 8 pairs: `tests/rdb-tests.mjs` repeats the stronger check when the game is installed —
every `{GUID}path` pair written in the game's own text resources (132 843 in `data007.pak`, of
which 132 781 resolve exactly) — and the client's and server's copies agree on all 116 375 records
they share.

`extract-guid-table.ps1` still prints `{GUID}path` lines and takes `-Filter` / `-Validate`; it
does not parse the container, so prefer `rdb.mjs` when the answer has to be right.

The RDB is a second opinion for anything read out of the pak: a `.conf` that names a world or a
prefab can be cross-checked by looking the same path up in the RDB and comparing GUIDs. Doing
that is what proved the corrected `World` values in
[the MissionHeader document](../../docs/en/ArmaReforger_MissionHeader_EN.md) §2.1.

Session scenario table for build 1.8.0.13:
[ArmaReforger_Scenarios_EN.md](../../docs/en/ArmaReforger_Scenarios_EN.md).

## 5. Vanilla `.c` and `.conf` sources

Both read straight out of the pak now, compressed or not. Use the pak — it is the build you
actually run.

Arma Reforger Explorer (`https://arexplorer.zeroy.com/`) remains useful as an independent
**second source** for a `.c` or `.h` file: a different build, a different extraction path. Its
pages truncate when fetched directly, so two steps are needed:

1. Build the page URL:

   ```
   https://arexplorer.zeroy.com/_<filename_lowercased_with_underscores>_8c_source.html
   ```

   `SCR_NotificationsComponent.c` → `_s_c_r___notifications_component_8c_source.html`
   (`SCR` → `s_c_r`, then `_` between words, `.c` → `_8c`).
   For names that exist in several modules, use the path form:
   `_game_2game_8c_source.html` for `scripts/Game/game.c`.

2. Wrap it in the W3C HTML→text service, urlencoded, with `nonums=on`:

   ```
   https://www.w3.org/services/html2txt?url=<URLENCODED>&nonums=on
   ```

   Encode `:` → `%3A` and `/` → `%2F`.

Why the wrapper is mandatory: `web_fetch` on an arexplorer source page hits the output budget and
stops mid-file **and does not create a spill file**. The result is a text render with tokens and
line numbers exact.

**Limits.** The explorer has `.c` and `.h` and **no `.conf` or `.layout` files at all** — for those
the pak is the only source. It is also pinned to an older build than the installed game, so a
class added recently may be absent (HTTP 403/404) while still existing in the game; check the
installed build before concluding a class does not exist.

If a wiki page was saved locally as `.htm`, [`tools/html2text.mjs`](../../tools/html2text.mjs)
converts it to clean text with no network access at all.

### The reader: `tools/cscript.mjs`

Getting the text out of the pak is the easy half. The questions that actually come up are *which* file
declares a class, what that class contains, what a method's signature is, what a class inherits from,
who inherits from it, and which copies a mod replaces. `cscript` answers those, from a file, a
directory, an addon or a `<pak>:<entry>`, with `--json` on every command and a library API beside the
CLI. `--json --compact` (or just `--compact`, which implies it) keeps the envelope but makes the rows
smaller: each row's `source` becomes an integer id into one shared `sourceTable`, the keys that only
repeated it are dropped, and fields that are `false`, `[]` or `{}` are left out — an absent field means
false or empty. Sizes are part of the design, not a detail: measured on `schema --inherited` of
`CharacterControllerComponent`, the default answer is **9.5 KB of text** or **57 KB of `--json`** —
a page of 25 rows, with `counts` and `truncated` saying what the page hid — **10 KB as
`--json --compact`**, and **517 KB / 292 KB with `--limit 0`**, which is the whole class. Read the
text, compact the JSON when a program parses it, and pass `--limit 0` only when you mean every
member.

```
node tools/cscript.mjs outline            <source> [--limit N|0] [--json]
node tools/cscript.mjs cat                <source> [<lines>] [--plain] [--json]
node tools/cscript.mjs check              <source>... [--pak ...] [--addons <root>] [--addon ...] [--json]
node tools/cscript.mjs stats              <source> [--pak ...] [--addon ...] [--addons ...] [--json]
node tools/cscript.mjs refs               <needle> [--pak ...] [--addons ...] [--code-only] [--json]
node tools/cscript.mjs find-defs          <needle> --pak ... [--addons <root>] [--addon ...] [--kind K]
                                          [--regex] [--original | --only-modded] [--files-only] [--json]
node tools/cscript.mjs schema             <source> <needle> [--members all|fields|methods]
                                          [--inherited] [--limit N|0] [--json]
node tools/cscript.mjs signature          <source> <needle> [--json]
node tools/cscript.mjs inheritance-chain  <source> [<class>] [--pak ...] [--addon ...] [--depth N] [--json]
node tools/cscript.mjs subclass-tree      <source> [<class>] [--pak ...] [--addon ...]
                                          [--depth N] [--no-modded] [--limit N|0] [--json]
```

`<needle>` is `Class`, `Enum`, `Class.Method` or `Enum.MEMBER`; `find-defs` also accepts a bare member
name, and looks for **types first** and members second, so `find-defs GetUIInfo` still finds the
methods. `<source>` follows the same rule as every other reader
([`parseSourceSpec`](../../tools/pak.mjs)): a file on disk, or `<pak>:<entry>`.

```
# where is the class, in vanilla and in any mod that replaces it?
node tools/cscript.mjs find-defs BaseWeaponComponent --pak "<install>/addons/data"

# what does it contain, with the base classes' members too?
node tools/cscript.mjs schema "<install>/addons/data/data007.pak:scripts/Game/Weapon/BaseWeaponComponent.c" \
  BaseWeaponComponent --inherited

# only the signature and the docstring
node tools/cscript.mjs signature "<install>/addons/data/data007.pak:scripts/Game/Character/SCR_CharacterControllerComponent.c" \
  SCR_CharacterControllerComponent.CanInteract

# what does a mod replace, and what does the replacement inherit?
node tools/cscript.mjs inheritance-chain "<mod>/Scripts/Game/ACE_Core/Character/SCR_CharacterControllerComponent.c" \
  --pak "<install>/addons/data" --addon "<mod>" --depth 4

# which classes extend this one (with the modded copies of each node)?
node tools/cscript.mjs subclass-tree "<install>/addons/data/data007.pak:scripts/Game/generated/GameMode/BaseGameMode.c" \
  BaseGameMode --pak "<install>/addons/data" --addon "<mod>" --depth 2

# the text behind a range a command just reported -- lines 138 to 160, both ends included
node tools/cscript.mjs cat "<install>/addons/data/data007.pak:scripts/Game/GameMode/SCR_BaseGameMode.c" 138-160
```

`cat` takes one line (`400`), an inclusive range (`400-500`) or an open one (`400-`), prints each
line with its number, and `--plain` drops the number column for a copy-paste. Without `<lines>` it
prints the whole file. A range that starts past the end of the file is an error (an empty answer
would look like an empty file); one that ends past it is clamped and says so. This is the command
that closes the loop with `find-defs` and `schema`: they report ranges, and `cat` reads them out of
an archive without extracting 2 GB.

**What counts as a source.** `--file` is one script (or one `<pak>:<entry>`); `--pak` is an archive or
a directory searched for `*.pak` (recursively); `--addon` is one addon directory, and it accepts both
shapes a modder has: a Workbench project (a tree of `.c` on disk) and a **downloaded** addon
(`addon.gproj` + `data.pak`, with the scripts only inside the archive). `--addons` is a whole folder of
them: every directory directly under it is one addon, its unpacked tree and its `*.pak` files — what a
dedicated server's `addons` folder looks like. Measured on this machine: 133 addons, 4 241 `.c`, and
`find-defs` across all of them takes 0.7 s, so a forty-mod server is one option rather than forty.
Options are searched in the order given. `find-defs` has nothing to search without one of them;
`inheritance-chain` and `subclass-tree` fall back to the addon that contains `<source>` (the nearest
parent with a `.gproj`), or to `<source>`'s own directory. The combination that audits a real
collection is `--addons` **plus** the two vanilla paks: `check` over the folder alone reports 978
warnings, nearly all `modded class … replaces a class that is not in the searched sources`, and 20 once
`--pak` supplies the originals — 10 809 files in 17 s either way.

**`modded` is the point of the tool, and it is reported three ways.** A `modded class X` and the
original `class X` are two declarations of one name, so `find-defs` reports **both** by default (`--original`
keeps the original, `--only-modded` keeps the modifications). A method declared inside a `modded class`
counts as modded as well — that is what "overridden in a modded class" means. `check` uses the
searched sources to settle what a mod claims: a `modded class`/`modded enum` whose original is not in
them is a **warning** (the search was too narrow — add `--pak`), and a modded class whose base clause
differs from the original's is a warning too.

**Traps this reader exists to absorb**, each one measured on the installed build:

| Shape | Why it matters |
|---|---|
| `modded class X : Base` | a modded class **can** carry a base clause, though the wiki never shows one: `modded class ArmaReforgerScripted : ChimeraGame`. Most do not — 35 of the 179 modded classes in the analysed addons write one — so never read a missing clause as "inherits nothing" |
| `enum X : Y` | an enum may extend another enum (`enum ECharacterHitZoneGroup : EHitZoneGroup`), which the wiki does not mention; `schema` reports the base and, when the base is in the searched sources, resolves it |
| `modded enum X { ... }` | it adds constants to an enum declared elsewhere, so its auto-numbering continues the **original's** — `schema` resolves that original when `--pak`/`--addon` supply it and prints `?` when they do not. Never guess the number |
| `#ifdef` around declarations | every row carries its `conditions` (`#ifdef AI_DEBUG`); two declarations with one name are only a duplicate under the same condition, and the flags the game was built with are not knowable here |
| a class name is global | there are no namespaces and no per-file scope: two mods may both ship `modded class SCR_X`, which is why every copy is reported instead of one |
| `[Attribute("0")];` | a stray `;` after a decorator ships in vanilla, and the attribute still belongs to the next declaration |
| `};` after a method body, `#include` inside a class body, `>>` closing nested generics, a string continued with a trailing `\`, a field with no `;` at all | all present in the shipped scripts; all tolerated, and the missing `;` is reported as a note |

**`check` is not a compiler, and says so.** It proves what the text can prove: an unterminated string
or comment, a bracket that never closes, an unbalanced `#ifdef`, a type or method declared twice under
the same condition, an enum constant declared twice, a class inheriting from itself, a method header
with neither a body nor a `;`, and — with sources — the modded-target warnings above. It does **not**
report a missing or mismatched `override` target: a method can exist only under an `#ifdef` the game may
or may not define, so that verdict would be a guess. Nothing here is a type check.

**Measured**, so a count can be trusted: the 6 568 vanilla scripts of `data007.pak` + `core/data.pak`
(28.7 MB, 94 568 declarations) parse with **0 errors and 0 warnings**; `check` over them reports 7
notes and nothing else (an enum whose constants are all inside `#ifdef`, and one field vanilla really
declares without its semicolon). The 971 scripts of ten downloaded addons parse with 6 errors, each a
genuine defect in the mod: two method headers whose bodies have no braces, three block comments never
closed, and one `modded class SCR_PlayerController : SCR_PlayerController`. `find-defs` over the whole
vanilla corpus takes ~0.35 s (one regex pass builds a name index, then only the candidates are
parsed); `check` over all of it takes ~7 s.

**`refs` is a text search, not a call graph — and it says so.** It reports every place the needle
appears as `file:line:column`, the line, and whether that place is code, a `[comment]` or a
`[string]`, so "who calls this" gets an answer that can be trusted instead of a hit list that cannot:
`refs CameraSelector` over the vanilla corpus returns 3 hits in 3 files and **none is a call** — the
declaration, a comment about it, and the `event int CameraSelector();` it overrides — which is the
correct answer for a hook the engine calls. The same search over the addons folder finds the 13
overrides and the `super.CameraSelector()` calls inside them. 0.9 s over 6 568 files; `--code-only`
drops the mentions; the default pattern is a whole word, so `Target` does not match `SCR_Target`, and
`--regex`/`--case-sensitive` change that.

**`stats` is where the counts come from**, and the reason it exists is that three numbers in this
repository were wrong until it did: a corpus was described as 14 addons when the folder had ten with
scripts, a byte count had been carried over from another extraction, and a flag count mixed
declarations with directives. It prints files, bytes, declarations by kind, the class and method flags,
the `modded` count and the conditional declarations with the flags they name — 6 568 files, 28.7 MB,
94 568 declarations, 9 modded for vanilla; 4 241 files, 27.9 MB, 93 522 declarations, 1 068 modded for
the downloaded addons folder — and `--json` carries the same numbers. A count nobody can re-run is a
rumour; this one is one command, so quote it and let the reader check it.

**Limits.** A body is skipped by bracket matching, so what is known about it is where it starts and
where it ends — no types, no calls, no control flow. Members that only a compiler could place (an
`#include`d fragment, a macro-generated declaration) are invisible. And the searched sources are
whatever was passed: "not in the searched sources" is the honest wording `check` uses, not "does not
exist".

## 6. Localization: the text behind a `#AR-…` key

A world, a prefab or a config names its display text by a **string-table id**, not by the text
itself:

```text
component SCR_CampaignMilitaryBaseComponent {621EB97024DABD3C}
    m_sBaseName = "#AR-Campaign_MapLocation_Cain_Kamensk"
```

The `#` marks the value as an id, and every place the game shows that base — the map, the capture
notifications, the editor — shows the text the player's language file gives for
`AR-Campaign_MapLocation_Cain_Kamensk`, with the `#` dropped. [`tools/loc.mjs`](../../tools/loc.mjs)
reads those files, out of a `.pak` or off disk:

```bash
node tools/loc.mjs info  <source>... [--json]
node tools/loc.mjs get   <source> <id|#id>... [--raw] [--missing-ok] [--json]
node tools/loc.mjs list  <source>... [--limit N|0] [--all] [--raw] [--json]
node tools/loc.mjs find  <source>... <query> [--in id|text|both] [--regex] [--limit N|0] [--json]
node tools/loc.mjs diff  <sourceA> <sourceB> [--limit N|0] [--json]
node tools/loc.mjs check <source>... [--json]
```

Every command also takes `--json` and `--no-pak-path-split`.

A **source** is a `.conf` file or one entry inside a `.pak`, written `<pak>:<entry>`. The vanilla
tables are one file per language under `Language/` in `data007.pak`, and an addon brings its own
there too (`Language/ACE_Core_localization.ru_ru.conf`):

```bash
node tools/loc.mjs get \
  "<install>/addons/data/data007.pak:Language/localization.ru_ru.conf" \
  "#AR-Campaign_MapLocation_Cain_Kamensk" "#AR-MapLocation_BARSRelayTower"
# AR-Campaign_MapLocation_Cain_Kamensk -> Каменск
# AR-MapLocation_BARSRelayTower -> Башня связи БАРС
```

A `get` for an id that is not in the table **exits 1** and names the key: a miss is what a wrong
spelling looks like, and silence would hide it. `--missing-ok` turns that off when a batch is
expected to be partial.

### The shape, and the three ways a naive reader gets it wrong

```text
StringTableRuntime {
 Ids {
  "AR-Account_Authenticating"
  …
 }
 Texts {
  "Authenticating"
  …
 }
}
```

`Ids` and `Texts` are **parallel arrays** — entry *k* of one is entry *k* of the other, and nothing
else links them. That is the whole format, and the three traps are all about counting:

- **A text may be split into several physical strings**, each but the last followed by a lone `\`
  *outside* the quotes. Joining them is what makes the two arrays the same length: across the
  installed corpus 265 529 ids are written as **291 119** physical strings, and the vanilla `en_us`
  table alone holds 18 097 strings for its 16 217 ids (196 of its texts are split, one of them into
  640 pieces). A reader that counts quoted strings reports a mismatch the file does not have; one
  that stops at the first `\` loses text.
- **An escaped quote is written double-escaped**, `\\"`, not `\"` — in 15 of the 584 files. The
  vanilla `en_us` entry is `… <color rgba=\\"226,168,79,255\\">Player List</color> …`, so reading it
  classically ends the string inside the BBCode tag it belongs to.
- **Escapes are not JSON**: `\n`, `\t`, `\r`, `\"` and `\\` are decoded, and any other `\X` is kept
  verbatim — which is what keeps the literal `\u1f600` in a `<ucs codepoints=…/>` tag intact instead
  of inventing a code point the engine never wrote.

Nothing else occurs in the corpus: of the **584** localization files in the client's 240 `.pak`
files, 573 are the `Ids`+`Texts` pair and **11 are an empty `StringTableRuntime { }`** (a table with
no entries is a table, not a defect). No file has a `Languages { … }` block, so a table in that
shape is refused **by name** rather than misread, as is a missing block, a count mismatch (with both
counts quoted) and a dangling continuation. **583 of the 584 parse**: the exception is a workshop
addon's `uk_ua` file that ends a string with an unterminated `\"` at line 667, and the error names
that line and what it means.

### Which file wins: the override order

`<source>` is repeatable and the tables are merged in **command-line order**, which is the override
order — a mod is mounted after the base game, so its file goes **first** and its text wins. The same
rule `--rdb` uses for GUIDs, for the same reason. Every id keeps its variants, so an override is
visible instead of silent: `info` counts the ids named by more than one source, and `check` lists
the ones they disagree about (a warning — overriding vanilla is what a mod is *for*):

```bash
node tools/loc.mjs check \
  "<mod>/data.pak!Language/My_mod.ru_ru.conf" \
  "<install>/addons/data/data007.pak!Language/localization.ru_ru.conf"
# OK    …/My_mod.ru_ru.conf: 412 entries, no problems
# OK    …/localization.ru_ru.conf: 16217 entries, 3 problem(s)
#         [warning] id "AR-Tutorial_Hint_Driving_Right" has an empty text (line 13879)
#       37 id(s) the sources give different text (the first source wins):
```

`check` exits 1 on an **error** — a duplicate id, an empty id, a dangling continuation — and 0 with
the **warnings** the game tolerates: an empty text (83 in the installed corpus), an id with
surrounding whitespace, or a text whose bytes were not valid UTF-8. Use `diff` when the question is
what one language has and another lacks; it separates ids only in A, only in B, and ids whose texts
differ, which is the translator's list:

```bash
node tools/loc.mjs diff \
  "<install>/addons/data/data007.pak!Language/localization.en_us.conf" \
  "<install>/addons/data/data007.pak!Language/localization.de_de.conf" --limit 3
# only in A (0): … only in B (0):
# differing (14598):
#   AR-Account_Authenticating
#     A: Authenticating
#     B: Authentifizierung ...
# 1619 id(s) identical in both
```

`--json` on every command answers with an **envelope**, never a bare array: it names the sources
(`{ index, kind, display, pak, entry, path, language, entries, bytes, problems }`, indices from 0),
then `total`/`returned`/`truncated` for the rows, so a truncated list cannot be mistaken for a
complete one.

The library form is the same read: `parseStringTable(bytesOrText, { name, language })` →
`StringTable` (`get`, `raw`, `entry`, `resolve` for a `#`-prefixed key, `find`, `ids`, `size`,
`problems`), `readStringTable(path)`, `openStringTables(specs, { noPakPathSplit })` → `[{ source, table }]`,
`new MergedStringTable(parts)` (`get`, `lookup` with its variants, `overrides`, `conflicts`,
`problems`), `compareStringTables(a, b)`, `languageOfName(name)` and `parseSourceSpec(spec, { noPakPathSplit })`,
which is the one place the `<pak>:<entry>` rule lives.

**Limits worth knowing.** The split is at the **last** colon and only when everything before it ends
in `.pak`, so a Windows path stays a path (`D:\work\localization.ru_ru.conf` has one colon, the
drive's) and `D:\work\data007.pak:Language/…` becomes an entry; `--no-pak-path-split` turns the split
off entirely, which is the way in for a file whose own name carries a colon or ends in `.pak`. A table is
per language and per file — there is no "ask for a language" option, because the language *is* the
file; `language` is read off the name (`localization.ru_ru.conf` → `ru_ru`) and is `null` for a name
that does not say. `--raw` prints a text as the file spells it, escapes undecoded, which is what you
want when re-emitting a file rather than reading one. `find` is case-insensitive, substring by
default and a regular expression with `--regex`. A text that the game formats at run time (`%1`,
`<br/>`, `<color …>`) is stored with its markup and comes back with it — this tool does not
interpret it.

## 7. What is genuinely out of reach

- **`-listScenarios` expecting stdout** — the wiki confirms it prints scenario `.conf` paths
  **to the game log**, and Workshop scenarios appear only when no scenario is loaded
  (e.g. through a config). Read the log, not the console.
- **GUIDs from the pak itself.** They are not in entry payloads; a full content scan of
  `data007.pak` for one known GUID returns zero hits. Use §4.
- **A `.pak` written by a different tool with a different offset convention.** `pak.mjs`
  detects this (`info`/`verify` print the base) but the archives it has been tested against are
  all the game's own. If `verify` reports a data-relative base, read with `--data-relative`
  and say so.

## 8. Verification checklist

Before reporting a result from this skill:

- [ ] Did you confirm the read actually succeeded, rather than that the file is absent?
- [ ] Did `verify` (or `info`) show the offset base the archive really uses?
- [ ] If a GUID: did `npm run rdb -- verify <rdb>` reproduce the 8 published GUIDs, and for a
      value taken from a `.conf`, does the RDB agree?
- [ ] If you say a GUID resolves (or does not): did you pass every database that could carry it
      (`--rdb` is repeatable), and did you run `ebin refs` rather than reasoning from one file?
- [ ] If you extracted a `.conf`: is the first line a class declaration, not mid-value?
- [ ] If a world: did `info` show the decode coverage, and did you say which build the record
      counts belong to?
- [ ] If a world's entity: did you report what the file *overrides*, and not present a prefab's
      defaults as this entity's values?
- [ ] If a `#AR-…` key: did you say which language file answered, and did `loc check` report
      nothing? A `#`-stripped id is the key, and a miss exits 1 rather than printing nothing.
- [ ] If a world carries a `BSP`: did you report its **node count** — or the error, when the integers
      do not form a tree — rather than a payload size? `--json` carries the nodes.
- [ ] If you gave up on an entry: did you say *why* (unknown `compressionType`, truncated
      archive), not just "unreadable"?
