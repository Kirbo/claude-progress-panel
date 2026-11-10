---
name: audit
description: First-party defensive security and code-quality review of the maintainer's own claude-progress-panel plugin (or one named area) — static source review, adversarially verified findings, a severity-ranked sealed report in docs/audits/open/, fixed findings moved to the public docs/audits/fixed/. Read-only code review; no third-party systems in scope. Use when the maintainer runs /audit or asks for a security review, threat model or hardening pass.
---

# Audit: security first, quality second

The process, formats, IDs (`CPP-NNNN`) and sealing are defined ONCE in
[`docs/audits/README.md`](../../../docs/audits/README.md). Read it first and follow it exactly.

## Authorization and scope (read this first, every run)

A **first-party defensive code review**. The person invoking it is the sole author, owner and
operator of the plugin (public MIT repo `claude-progress-panel`).

- **Purpose:** find defects in the maintainer's own code before users hit them, and feed a fix queue.
- **Target:** the source files in this working tree. Nothing else.
- **Method:** reading source. Static review with a threat-model frame: enumerating who can reach a
  surface is how you decide whether a guard is missing.

**Out of scope, even if a finding seems to invite it:** any host or service (no network probing;
the plugin has none), weaponised or reusable exploit code (a demonstration is a **regression test
in this repo** that fails before the fix and passes after), anything offensive in character, and
**publishing unfixed findings**: a finding that is not fixed lives ONLY in the sealed
`docs/audits/open/` (or `ACCEPTED.md`), never in README / CLAUDE.md / an issue / a commit message.
If a request falls outside this, stop and ask.

## Why the bar is moderate but real

The module runs inside the user's Claude Code process, with their privileges, and reads files other
local sessions (and, later, a model-callable tool) write. No network, no secrets today, so a defect
is mostly "forge or destroy the user's own files", "mislead the user through forged UI" or "break
the supply chain that installs this". Review at that stake level; do not inflate.

## Ground rules

- **Brutally honest. No praise, no hedging.** The report is a defect list; a clean surface gets one
  line in the coverage table.
- **Evidence or it does not ship:** `path:line` plus a one-sentence reachability path.
- **Adversarially verify** (Phase 3) before reporting.
- **Audit ground truth**, not docs. A doc/code gap is itself a finding.
- **Do not fix while auditing.** Report first; fix only with `--fix` or after the user reads the
  report. Exception: an actively exploitable Critical (a live secret in git, plaintext open finding
  tracked) -> stop, tell the user at once and ask.
- **Never re-flag accepted risk** (`docs/audits/ACCEPTED.md`, sealed; read it after `unseal`).
- **Model policy:** the session's model IS the audit's model. The agents `security-auditor` and
  `audit-verifier` carry no `model:`; never pass a `model:` override, never substitute
  `Explore`/`general-purpose`. A failed spawn is re-spawned; a dimension never reviewed goes in the
  report's "Not checked" list. Record the model in the report.
- **Subagents:** read-only fan-out is authorised, at most 10 at once (a ceiling, not a target),
  each with its own scratch filenames, no builds.

## Arguments

- `/audit` — full sweep, every phase.
- `/audit <area>` — `files` | `parse` | `render` | `tool` | `supply-chain`. Still run Phases 0, 3, 4.
- `/audit --fix` — after the report, fix Critical/High (one commit each, "Handling fixes").
- `/audit --quick` — Phases 0, 1, 4 only.

## Phase 0 — Prepare and run the gates

1. `git config core.hooksPath` must be `.githooks`; `node scripts/seal.mjs unseal` (needs the
   identity, see the README) so earlier `open/` passes and `ACCEPTED.md` are readable. A
   still-open finding is not re-reported under a new ID unless materially changed (`carried`).
2. Record every error and warning from: `mise exec -- biome ci .`, `mise exec -- claude plugin
   validate .`, `mise exec -- claude plugin test .`, `mise exec -- node --test scripts/`,
   `mise exec -- node scripts/check-audits.mjs`.
3. Secrets and personal data in the tree and history (public repo): grep the working tree and
   `git log -p` for key shapes (`-----BEGIN`, `ghp_`, `glpat-`, `sk-`, 32+ char hex/base64 assigned
   to a key/token/secret name), `/home/<user>` paths, hostnames, private URLs. The age *private*
   identity shape (`AGE-SECRET-KEY`, `AGE-PLUGIN-PQ-1`) anywhere is a Critical.
4. Sealing sanity: `git ls-files docs/audits` shows only `README.md`, `fixed/*.md`, `*.age`.
   `node scripts/seal.mjs status` is clean.

## Phase 1 — Attack-surface inventory (rebuild it from code, every run)

Regenerate; do not trust this table. It exists so you notice what is missing.

| Surface | Where | Who controls the input |
|---|---|---|
| Status file read (`$.fs.stat` / `$.fs.read`) | `hooks/store.ts`, `hooks/session.tsx` (scan) | the user, any local process or session that can write the file, a cloned repo that ships one if the path option points there |
| Path resolution (`progressFile` option, `~/`, `CLAUDE_CONFIG_DIR`) | `hooks/paths.ts` | the user (option), the environment |
| JSON parsing + pane state (the atoms and their `shape` tags) | `hooks/model.ts` (parsers), `hooks/state.ts` (atoms) | whoever writes the file |
| Rendering file text into the terminal UI | `hooks/pane.tsx` JSX | whoever writes the file: escape sequences, huge or multi-line strings, control chars |
| Refresh hook (`PostToolUse` matcher, mtime check) | `hooks/hooks.json` | tool calls of the session |
| Model-callable tool, shared folder, Buttons (when present) | `hooks/` | the model (prompt-injectable), several concurrent sessions, the user's clicks; anything that writes, deletes or renames |
| `$.process.run`, `$.env.get` (if used) | `hooks/` | arguments and env values; shell/argument injection |
| Plugin manifest + marketplace install | `.claude-plugin/`, README install commands | the repo URL users add; a compromised repo ships code to every installer |
| Toolchain pins | `mise.toml`, `mise.lock` | upstream releases; unpinned or <1-day-old versions |
| CI image + mise download | `.gitlab-ci.yml` | the registry digest and the pinned SHA-256 of the mise binary |
| Sealed audit register | `scripts/seal.mjs`, `.githooks/`, `.sealed.json`, `.gitignore` | the maintainer's own workflow: plaintext leak, wrong recipient |

For each: who writes the input, what limits its size and shape, what the code does on malformed
input, and what the worst outcome is.

## Phase 2 — Deep review (fan out; read-only agents)

One **`security-auditor`** per dimension, in parallel. Give each its dimension, the files it owns,
the ground rules above and the Phase 0 output. Reject any finding without a concrete reachability
path.

1. **Files and paths** — every read/write/delete/rename: path built from the option, env or file
   content; `~/` expansion; traversal (`..`, absolute paths, symlinks into other dirs); the shared
   folder's per-session file names (can a session id escape the folder?); non-atomic writes and
   TOCTOU between `stat` and `read`; delete buttons reaching beyond the item they show.
2. **Untrusted data in** — JSON parsing: wrong types, missing fields, huge files or arrays,
   `__proto__` keys, prototype pollution, numbers as strings, a half-written file from a concurrent
   writer, the `shape` guard on stored state, error text echoing file content.
3. **Terminal rendering** — text from the file rendered into the pane: ANSI/OSC escape sequences,
   control characters, bidi overrides, very long or multi-line strings that spoof the
   "Needs you" section or a button label.
4. **Tool and Buttons (when present)** — input schema validation, length limits, whether a model (or
   injected text it read) can overwrite another session's items, rate/size growth of the folder,
   confirm-before-delete, idempotence. If absent in the tree, say "not present" and stop.
5. **Supply chain** — `mise.toml` exact pins, `mise.lock` covers every platform and matches,
   release age >= 1 day, CI image pinned by digest, the mise binary's SHA-256 pinned and checked
   before `chmod +x`, the cache key, `MISE_LOCKED`, no `curl | sh`, marketplace install docs use the
   canonical URL, `plugin.json` version/homepage, nothing in the package that fetches code.
6. **Sealing and publication hygiene** — `.gitignore` covers every sealed path, the hook cannot be
   bypassed silently, the recipients file holds ONLY public keys (`age1...`), no plaintext open
   finding in history (`git log --all --stat -- docs/audits`), public docs name no open `CPP-` id.
7. **Quality** — correctness bugs (races, silent error swallowing, stale-state), refactors with real
   drift risk, i18n gaps (literals outside `locales/`), test coverage of the paths above, README /
   CLAUDE.md / SKILL.md drift from the code.

## Phase 3 — Verify (kill the false positives)

Send every Critical/High candidate, and any Medium you are less than sure of, to a separate
**`audit-verifier`**, one per finding, whose only job is to *disprove* it. Use a fresh agent, not
the reporter. Verify the rest yourself by re-reading the path from the input to the sink. Where
cheap, prove it with a regression test in `hooks/*.test.tsx`. Fold each verifier's **Residual**
notes back into the candidate pool. 5 real findings beat 30 that need triage.

Severity: **Critical** unauthenticated-equivalent code execution, file write/delete outside the
intended files, or secret disclosure by an untrusted party; **High** a trust anchor never verified,
a delete/overwrite that reaches the wrong target, forged trusted UI; **Medium** hardening gaps with
a real path; **Low** defense in depth; **Quality** no security consequence.

## Phase 4 — Report

Follow `docs/audits/README.md` exactly:

- Write the pass to **`docs/audits/open/AUDIT-YYYY-MM-DD.md`** (`-2` for a second pass that day).
  Number findings from the README's **"Next free ID"** (`CPP-NNNN`), then bump that line and add the
  pass to the index table in the same commit.
- Sealed format: header table (pass, ID range, start date, model, scope, counts) -> verdict ->
  open-findings table -> one section per finding (reachability, `path:line` evidence, impact, fix,
  effort) -> coverage (every Phase 1 surface: reviewed / NOT) -> tooling output -> deltas against
  earlier passes.
- **Nothing about an unfixed finding goes anywhere public:** not README, CLAUDE.md, an issue, a
  code comment or a commit message ("add an audit report" is the whole message).
- Commit with the hook enabled (it seals), then check `git show --stat HEAD` lists only
  `*.md.age` plus the README index. **Never push** without the user's OK.
- Terminal summary: verdict, Critical/High list, recommended fix order.

## Handling fixes (every fix pass, `/audit --fix`, or a single fix)

1. Fix the defect with a regression test that fails before and passes after; bump `version` in
   `.claude-plugin/plugin.json` for a behaviour change. The commit cites the ID
   (`fix(hooks): ... (CPP-NNNN)`, the real id) and may describe the defect openly because it is now fixed.
2. In the same commit move the finding's section from `open/` to `fixed/` of the same pass, in the
   public format, with the fix commit (amend the hash in, or follow up).
3. **Partially fixed:** nothing goes to `fixed/`; the section stays whole in `open/` with
   `Status: partial` and the legs done.
4. Accepted / withdrawn / carried: per the README lifecycle.
5. A pass with nothing left open: delete its `open/` plaintext and `.age`, update the index.
6. Run `mise exec -- node scripts/check-audits.mjs` and the Phase 0 gates, then commit.

**Report style:** a document, not chat. Normal prose, full sentences.
