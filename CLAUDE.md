# claude-progress-panel — instructions for agents

Two jobs live here: **(A) setting the panel up on a machine** and **(B) working on this repo**.
How to _use_ the panel during a task is the bundled skill:
[`skills/progress-panel/SKILL.md`](skills/progress-panel/SKILL.md).

## A. Set the panel up on a machine (exact steps)

Follow [`docs/AGENT-SETUP.md`](docs/AGENT-SETUP.md) step by step (version check, marketplace install,
removing older copies, store folder, the forge's CLI, verification).

## B. Working on this repo

- **Toolchain: mise only.** `mise install`; run tools as `mise exec -- <tool>`. Pins are exact in
  `mise.toml`; after a bump run `mise lock` and commit `mise.lock`. Pin only releases at least one
  day old.
- **Lint/format: Biome** (`biome check .`; `--write` to fix). No ESLint/Prettier.
- **TDD.** Write the failing test first (`claude plugin test .`), then the code: pure logic in
  `hooks/model.ts` ↔ `hooks/model.test.ts` and `hooks/pipelines.ts` ↔ `hooks/pipelines.test.ts`
  (each pure module has its `*.test.ts`); everything that touches the engine — I/O, tool, timers,
  pane — is tested through `hooks/register.test.tsx`, whose `engine()` helper stands in for the
  engine (`on('<op>', …)` stubs, a fake disk, `mock.clock`) — reuse and extend it, don't fork it.
- **Where engine code lives** (each layer imports only the ones before it): `hooks/state.ts`
  (constants, the atoms, `self` = what this session's copy remembers between hooks, the queues of
  notes owed to an agent) → `hooks/store.ts` (the progress folder: the only place a session file or
  sidecar is written) → `hooks/forge.ts` (`glab`/`gh`/`tea`/custom command, pipeline polls) →
  `hooks/session.tsx` (scan, the tool's updates, agents, switches, doctor) → `hooks/pane.tsx` (the
  drawing and its presses) → `hooks/register.tsx` (only the `on(…)` hooks). Module-level mutable
  state goes in `self` (state.ts), never a new `let` elsewhere.
- **i18n.** Every user-facing string is a key in `locales/en.ts`, read through `t()` from
  `hooks/i18n.ts` — never a literal in JSX, a command answer, a tool answer or an error on a row
  (`scripts/i18n-literals.test.mjs` fails on one). Left literal on purpose: the tool's schema
  descriptions (`hooks/schema.ts`, the model's API documentation) and shell commands shown to run.
- **The module has no Node/DOM.** Everything outside goes through `$` (`$.fs`, `$.env`, …). A
  function that takes `$` must be a top-level function declaration (the validator follows `$`
  only into those) — across files too, so never an arrow function bound to a name. `$.env.get`
  takes string literals only. Every `on(…)` call is written in `register` itself (one handed to
  another function is not registered). An atom is declared once, in `hooks/state.ts`, and read or
  changed only through its `read…`/`update…` function there: `read`/`update` take an atom written
  in the same file, and a reference by plugin + key from another file loses its initial value.
- **State shape:** the pane's values are the `sessions`, `folds` and `sort` atoms; change an
  atom's `shape` tag whenever its stored type changes, so an old value from before a reload is
  declined. `types/index.d.ts` is the contract and must stay self-contained (no imports).
- **CI runs Linux and macOS only — no Windows job** (user decision 2026-11-09: the only user never
  runs Windows; GitLab's Windows runner made every pipeline ~6× slower). Windows-specific code paths
  (`cd /d`, `del`, Windows file URLs, process lookup) keep their tests, which run on Linux/macOS;
  don't re-add a Windows job without asking.
- **The design** (store format, tool semantics, refresh, retention) is
  `docs/design/MULTI-SESSION.md` — keep it in step with the code.
- **Done = green:** `biome check .`, `claude plugin test .`, `claude plugin validate .`,
  `node --test scripts/`, `node scripts/check-audits.mjs` and the type-check
  `mise exec npm:typescript@7.0.2 -- tsc --noEmit -p .` all clean. The type-check is a local gate
  only, and deliberately not pinned in `mise.toml`: it checks against the engine's types in
  `.claude-plugin/types/`, which Claude Code writes when it loads the plugin and git ignores, so CI
  cannot run it and should not install it
  (validate's "plugin directory" notes about the icon are informational). Bump `version` in
  `.claude-plugin/plugin.json` for any behaviour change — `claude plugin update` keys on it — in
  the LAST commit of that version: on `main`, CI's `release` job makes a GitLab Release `v<version>`
  at the commit that first carried it, its notes git-cliff's (`cliff.toml`) over the Conventional
  Commits since the version before (`scripts/release.mjs`; `node scripts/release.mjs --dry-run`
  previews). So commit subjects are release notes: write them for users.
- **Hooks:** once per clone `git config core.hooksPath .githooks` (`check-audits.mjs` fails locally
  until it is set). The pre-commit hook runs Biome
  over the staged files first — fixes what it can, re-stages fully staged files (never a partly
  staged one), refuses the commit on anything left (`scripts/lint-staged.mjs`) — then seals audit
  findings (see below).
- **Audits (`/audit`, `.claude/skills/audit/`).** Process, formats, IDs (`CPP-NNNN`) and sealing:
  [`docs/audits/README.md`](docs/audits/README.md). **A finding that is not fixed is never readable
  in the clear** — only in the age-sealed `docs/audits/open/*.md.age` (plaintext gitignored, sealed
  by the pre-commit hook to the maintainer key). Never write an open finding's content into
  README/CLAUDE.md/docs, a code comment, a test name, an issue or a commit message. A fix commit
  cites the ID, ships a regression test and moves the finding to `docs/audits/fixed/` in the same
  commit. Never commit with `--no-verify`; never print, copy or create the private identity (only
  `.age-recipients`, public keys, is in the repo). `node scripts/seal.mjs status|unseal|verify`.
- **Maintenance (`/maintain`, `.claude/skills/maintain/`):** toolchain + CI pin bumps (releases at
  least 1 day old), docs reconciliation, all gates.
- **Screenshots** (`docs/screenshots/pane.png`, shown in the README): demo data, never a real
  session's store. Regenerate after a visible change with the `screenshots` skill
  (`.claude/skills/screenshots/`).
- Scripts (`scripts/*.mjs`) are plain Node with no dependencies, tested with `node --test scripts/`.
- **A setting's default** is written twice by necessity — the manifest's `userConfig` and the code's
  fallback (`readSettings`, `NUMBER_DEFAULTS`, `defaultsFrom`); `scripts/defaults.test.mjs` fails
  when they differ. Change both.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- **GitHub mirror** (`github.com/Kirbo/claude-progress-panel`; read-only copy for discovery — issues
  and MRs live on GitLab, its issues/wiki are off): GitLab push-mirrors every branch and tag to it
  automatically (Settings → Repository → Mirroring repositories; a fine-grained GitHub token for that
  one repo, held by GitLab). Never push to it directly. GitLab stays canonical (`repository` in the
  manifest, the update check, the Releases).
- Public repo: no secrets, hostnames, private URLs or personal paths in code, docs or tests.
