# Skills

Three skills, each a self-contained `SKILL.md` in Agent Skills format: YAML frontmatter with
`name` (equal to the directory name) and `description` (80–1100 characters), then the
instructions. `npm run check:links` enforces that shape.

| Skill | Use when |
|---|---|
| [arma-reforger-server-config](arma-reforger-server-config/SKILL.md) | Writing, editing, reviewing or debugging a `server.json`: the top-level keys, `gameProperties`, `mods`, `operating`, the `missionHeader` block, and launching the server so it actually reads the config. Also: the server refuses to start, or logs `Server Config file is Invalid`; the `Missing Addon 58D0FB3206B6F859` dialog; setting up a Linux server with SteamCMD or systemd |
| [arma-reforger-rcon](arma-reforger-rcon/SKILL.md) | The remote console itself rather than the file around it: enabling it, `monitor` vs `admin`, which command exists only in chat, why a ban hangs in `PENDING`, and how it differs from BattlEye RCON while speaking the same packet format. Carries [`tools/rcon.mjs`](../tools/rcon.mjs), the client to use instead of writing one, and documents what that client prints — the tables and `--- done:` lines of `shell`, and the JSON described by [`schemas/rcon-result.schema.json`](../schemas/rcon-result.schema.json) |
| [arma-reforger-game-data](arma-reforger-game-data/SKILL.md) | Reading what ordinary tools cannot: entries inside `.pak` archives, resource GUIDs, vanilla `.c` sources. Also when a pak read fails with `incorrect header check`, or an extracted file comes out cyclically shifted |

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
