---
name: maintain
description: Full maintenance pass for claude-progress-panel — bump the mise toolchain and the CI pins to the newest day-old releases, reconcile README / CLAUDE.md / the bundled skill / docs with the code, run every gate, report, commit. Use when the user runs /maintain or asks for a maintenance/housekeeping pass.
---

# Maintenance pass

Run the phases in order. Work from ground truth (code, registries, real command output), never from
memory of what was recently built. Finish with a report and logically scoped commits. Never push.
Work on a branch, not on `main`, unless the user says otherwise.

## Phase 1 — Toolchain (bump, lock, verify)

`mise.toml` holds exact pins: `biome`, `claude`, `node`, `age`. Quarantine rule: **only releases at
least 1 day old.**

1. `mise outdated --bump` to see candidates. For each tool take the newest release at least one day
   old: `mise ls-remote <tool> --json` (the `created_at` per version), pick the newest old enough.
   Bump `mise.toml`; **node: LTS line only, never Current**, bump patch/minor within it.
2. `mise lock` (set `MISE_GITHUB_TOKEN` if the anonymous API limit bites), then `mise install`.
   Commit `mise.toml` + `mise.lock` together; CI installs only what the lock names.
3. Keep versions that appear twice in step:
   - **Biome**: `biome.json` `$schema` URL (`.../schemas/<version>/schema.json`) = the pinned Biome.
     `mise exec -- biome migrate --write` if the config format changed, then `biome check --write .`.
   - **Claude Code**: README "Needs Claude Code **X or newer**" and CLAUDE.md step 1 name the
     *minimum* engine version the plugin needs, not the tool pin. Raise them only if the code now
     uses an engine feature newer than the stated minimum (check the changelog / `types/`), and say
     so in the report.
4. **CI pins in `.gitlab-ci.yml`** (the `check` job):
   - Image (`node:<ver>-bookworm@sha256:...`): its Node version follows `mise.toml`'s `node` pin
     (bump both together). Re-resolve the tag,
     `docker buildx imagetools inspect node:<ver>-bookworm --format '{{.Manifest.Digest}}'`
     (or `skopeo inspect --format '{{.Digest}}' docker://node:<ver>-bookworm`), and set the
     digest only if the new image is at least a day old. The digest is a multi-arch index digest.
     Keep a full (non-slim) Debian image: mise's Node needs `libatomic`, and the job needs curl +
     git without an `apt-get` step.
   - `MISE_VERSION` + `MISE_SHA256`: newest mise release at least a day old
     (`mise ls-remote github:jdx/mise --json`). Download
     `https://github.com/jdx/mise/releases/download/<V>/SHASUMS256.txt`, take the sha256 on the
     `mise-<V>-linux-x64` line, update **both** variables together. (Verify the hash against the
     release page, not against a binary you downloaded yourself in the same step.)
   - The `cache.key.files: [mise.lock]` keeps the tool cache in step with the lock automatically.
5. Verify (fix forward or pin back with a reason in the report):
   `mise exec -- biome ci .` · `mise exec -- claude --version` ·
   `mise exec -- claude plugin validate .` · `mise exec -- claude plugin test .` ·
   `mise exec -- node --test scripts/` · `mise exec -- node scripts/check-audits.mjs`.
   (validate's "plugin directory" notes about the icon are informational.)

## Phase 2 — Memory (only if the repo has any)

`.claude/agent-memory/` (+ its `MEMORY.md`) exists only if someone added it. If present: verify
each file's claims (named files, flags, versions, commands) against the current tree, update what
drifted, delete what is obsolete or now recorded in the repo, merge near-duplicates, keep the index
in sync. Never persist secrets. If the directory does not exist, skip.

## Phase 3 — Docs (reconcile with the implementation)

Ground truth first:

| Surface | Source of truth |
|---|---|
| Behaviour, pane layout, status marks | `hooks/session.tsx`, `hooks/pane.tsx`, `hooks/store.ts`, `hooks/forge.ts`, wired in `hooks/register.tsx` (+ `hooks/register.test.tsx`) |
| Status-file path rules | `hooks/paths.ts` |
| Refresh triggers | `hooks/hooks.json` |
| User-facing strings | `locales/*.ts` via `hooks/i18n.ts` |
| Options (`progressFile`, ...), version | `.claude-plugin/plugin.json` `userConfig` / `version` |
| Status-file shape and agent protocol | `skills/progress-panel/SKILL.md` |

Scope the drift: `git log --oneline $(git log -1 --format=%H -- README.md)..HEAD`.

Reconcile, skipping files with nothing to change, and verify every claim against code before
writing it:

- **README.md** (humans): the pane mock-up, install / update / remove commands, the status-file
  example and the `status` table (marks, colours, what is hidden), refresh behaviour, Develop
  commands (must match the real gates and `mise.toml`), minimum Claude Code version.
- **CLAUDE.md** (agents): setup steps A (commands, version floor, config option names) and repo
  rules B (toolchain, TDD, i18n, `$` constraints, the audit/seal rules, Done = green list).
- **skills/progress-panel/SKILL.md**: file location order, the shape, statuses and their marks,
  and the update protocol must equal what the code reads. A shape change bumps `plugin.json`
  `version` (`claude plugin update` keys on it).
- **docs/**: `docs/design/*` status blocks and indexes; `docs/audits/README.md` index of passes and
  "Next free ID" (never mention open findings' content; `node scripts/check-audits.mjs` guards it).
- **.claude/skills/\*/SKILL.md** and **.claude/agents/\*.md**: commands and file names they cite
  still exist.
- Public repo: no secrets, hostnames, private URLs or personal paths anywhere.

## Phase 4 — Gates (mandatory, loop until clean)

Run them all; zero warnings, zero errors, then once more after any fix:

```sh
mise exec -- biome ci .
mise exec -- claude plugin validate .
mise exec -- claude plugin test .
mise exec -- node --test scripts/
mise exec -- node scripts/check-audits.mjs
```

Run the type-check too: `mise exec npm:typescript@7.0.2 -- tsc --noEmit -p .` (a local gate — the engine's types under
`.claude-plugin/types/` are not in git, so CI does not run it). Never silence a diagnostic (`biome-ignore`,
`@ts-expect-error`); fix it or raise it to the user.

## Phase 5 — Report, then commit

Report: tool bumps (from -> to, anything pinned back and why), CI pin changes (digest, mise version
+ checksum source), doc changes per file, memory changes, gate results (each command: clean or
not), decisions left for the user. Then commit in logical units, Conventional Commits, co-author
trailer: `chore(deps): ...` (mise.toml + mise.lock + biome.json schema), `chore(ci): ...`
(.gitlab-ci.yml pins), `docs: ...`. Bump `.claude-plugin/plugin.json` `version` only for a behaviour
change, not for a toolchain or docs bump. Never push.
