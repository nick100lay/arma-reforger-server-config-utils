# Skills

Five skills, each a self-contained `SKILL.md` in Agent Skills format: YAML frontmatter with
`name` (equal to the directory name) and `description` (80–1100 characters), then the
instructions. `npm run check:links` enforces that shape, and `npm run check:skills` fails when a
skill names a command or option its tool does not have.

| Skill | Use when |
|---|---|
| [arma-reforger-server-launch](arma-reforger-server-launch/SKILL.md) | Taking a server from "I have a machine" to "players can join": asking whether it runs locally or on a remote host over SSH, checking the target for the server and Node.js and installing what is missing (package manager, SteamCMD or Steam), copying `tools/` to the target, the interview (public address, RCON, profile and `ownerToken.bin`, admins, cross-platform, max players, scenario, folder location), writing and validating the config, the start scripts for Windows and Linux, launching outside any sandbox with the working directory set to the server directory, watching the log until `Server registered with address:`, checking the UDP ports and the A2S answer on the target and from outside, then the join code, the port-forwarding/security-group rules and the NAT-hairpin warning. Also the launch-side failures: `Missing Addon` / `58D0FB3206B6F859`, a server that never registers, a port that looks closed |
| [arma-reforger-server-config](arma-reforger-server-config/SKILL.md) | Writing, editing, reviewing or debugging a `server.json`: the top-level keys, `gameProperties`, `mods`, `operating`, the `missionHeader` block, and launching the server so it actually reads the config. Also: the server refuses to start, or logs `Server Config file is Invalid`; the `Missing Addon 58D0FB3206B6F859` dialog; setting up a Linux server with SteamCMD or systemd |
| [arma-reforger-rcon](arma-reforger-rcon/SKILL.md) | The remote console itself rather than the file around it: enabling it, `monitor` vs `admin`, which command exists only in chat, why a ban hangs in `PENDING`, and how it differs from BattlEye RCON while speaking the same packet format. Carries [`tools/rcon.mjs`](../tools/rcon.mjs), the client to use instead of writing one, and documents what that client prints — the tables and `--- done:` lines of `shell`, and the JSON described by [`schemas/rcon-result.schema.json`](../schemas/rcon-result.schema.json) |
| [arma-reforger-game-data](arma-reforger-game-data/SKILL.md) | Reading game data: `.pak` archives and their entry tree; EBIN worlds and world layers (`worlds/**.ent`, `*.layer`) with their entities, bases, references and BSP trees; resource GUIDs through `resourceDatabase.rdb`; an addons folder in dependency order, narrowed to the mods a server runs; the text resources `.et`/`.conf`/`.ct`/`.layout` (and a project's `.meta`/`.gproj`) through [`tools/etconf.mjs`](../tools/etconf.mjs); localization tables; and `.c` sources. Carries the readers — [pak](../tools/pak.mjs), [ebin](../tools/ebin.mjs), [rdb](../tools/rdb.mjs), [addons](../tools/addons.mjs), [etconf](../tools/etconf.mjs), [layer](../tools/layer.mjs), [loc](../tools/loc.mjs), [cscript](../tools/cscript.mjs) — and the formats they implement. Also when a pak read fails with `incorrect header check` or `Z_DATA_ERROR`, when an extracted file starts mid-word or ends with another file's bytes, or before writing new pak-, world- or string-table-parsing code |
| [arma-reforger-script-analysis](arma-reforger-script-analysis/SKILL.md) | Answering a question about script code rather than about data: what a class or method actually does, where it is declared in the installed build, why a `modded class` or an `override` changes nothing, whether two mods fight over one method (`SCR_CharacterCameraHandlerComponent`, `SCR_PlayerController`), what `super` reaches when more than one mod is loaded, and which questions the sources cannot answer at all — the callers of an `event` hook, the value a field has at runtime. Uses [`tools/cscript.mjs`](../tools/cscript.mjs); the command reference is the game-data skill's §5 |

Each skill links back into [`docs/`](../docs/README.md) rather than restating it, and into
[`tools/`](../tools/validate-server-config.mjs) for the scripts it refers to.

## Nothing discovers these automatically

They live in `skills/` inside this repository, which no agent runtime scans. Two ways to make
them usable:

1. **Point the agent at the file.** Cheapest and always correct: give it the path, or tell it
   to read `skills/<name>/SKILL.md` when the task matches the table above. `AGENTS.md` at the
   repository root does this for you if the agent reads that file.
2. **Install them into the agent's skill directory**, so they are discovered by description.
   For a Claude-style runtime that is `~/.claude/skills/`; copy or symlink, do not move,
   so the repository stays the single source of truth:

   ```bash
   # Windows (PowerShell), from the repository root
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\arma-reforger-server-config" -Target "$PWD\skills\arma-reforger-server-config"

   # Linux / macOS, from the repository root
   mkdir -p ~/.claude/skills
   ln -s "$PWD/skills/arma-reforger-server-config" ~/.claude/skills/
   ```

## Adding a skill

Create `skills/<kebab-case-name>/SKILL.md`. The frontmatter must contain **only** `name` and
`description` — one line each, no other keys, no nested YAML — because the checker parses it
line by line. Write the description as the trigger: it is the only part an agent sees before
deciding to load the skill, so name the symptoms and the exact error strings a user would
quote (`Server Config file is Invalid`, `incorrect header check`, `58D0FB3206B6F859`), not
the topic.

Then run `npm run check:links` and `npm run build:data` — the skill list in
[`data/manifest.json`](../data/manifest.json) is generated, and the skills are recorded there
with their description and hash.
