# Security audits

This repo runs deep security and quality reviews of its own code (the `/audit` procedure,
`.claude/skills/audit/SKILL.md`). This folder is where every finding lives, from the moment it is
reported until it is fixed, and afterwards in public.

## Layout: what is public and what is sealed

| Path | Visibility | Holds |
|---|---|---|
| `README.md` (this file) | **public** | the process, the formats, the index of passes |
| `fixed/AUDIT-YYYY-MM-DD.md` | **public, never encrypted** | every finding of that pass that is **fixed**: what was wrong, the fix, the commit |
| `open/AUDIT-YYYY-MM-DD.md` | **sealed** (`.md.age` committed, plaintext gitignored) | every finding of that pass that is **not** fixed yet, in full detail |
| `ACCEPTED.md` | **sealed** | risk the maintainer decided to live with, and what would void each decision |

**The hard rule: a finding that is not fixed is never readable in the clear.** Not in `fixed/`, not
in `README.md` / `CLAUDE.md`, not in a code comment, a commit message, an issue or a merge request.
Unfixed detail lives in `open/` (or `ACCEPTED.md`) and nowhere else. Public text may say *that* open
findings exist ("tracked in the sealed register"), never *what* they are. The repo is public, so a
pushed plaintext cannot be taken back.

## Sealing

Everything under `docs/audits/` except `README.md` and `fixed/*.md` is **sealed** with
[age](https://age-encryption.org) to the maintainer's post-quantum public key ONLY
(`.sealed.json` = which files, `.age-recipients` = to whom; there is no CI key, so CI cannot read
it). The plaintext is gitignored; the armored `<file>.age` blob is what git carries.

- **One-time per clone:** `git config core.hooksPath .githooks`, and `mise install` (pins `node` and
  `age`).
- **Writing:** edit the plaintext, commit. The `pre-commit` hook (`scripts/seal.mjs
  hook-pre-commit`) seals every edited plaintext (public-key encryption: no key, no prompt), stages
  the blob, and **refuses** a commit that stages a plaintext (a `git mv` into `open/` included) or
  when git cannot list the staged files. `node scripts/seal.mjs status` shows what needs a hand.
  Without the hook an edit is invisible to git (the plaintext is ignored and the blob stale), so
  never commit with `--no-verify`.
- **Reading on another machine / after a pull:** `node scripts/seal.mjs unseal` decrypts the blobs
  that changed. It needs the maintainer's private identity (age plugin form, `AGE-PLUGIN-PQ-1...`),
  looked up in this order: `AGE_IDENTITY`, `AGE_IDENTITY_FILE` (also `FNOX_AGE_KEY` /
  `FNOX_AGE_KEY_FILE`), the OS keychain item `claude-progress-panel` / `age-identity`. The identity
  is never stored in the repo. Mirror it into the keychain once from the maintainer's password
  manager (feed it on stdin, never as a shell argument):
  - Linux (libsecret): `secret-tool store --label=claude-progress-panel service claude-progress-panel account age-identity`
  - macOS: `security add-generic-password -U -s claude-progress-panel -a age-identity -w` (prompts)
  - Windows: set `AGE_IDENTITY_FILE` to a file you keep outside the repo.
- **Conflicts:** a plaintext edited here whose blob ALSO changed upstream is kept and reported,
  never overwritten. `node scripts/seal.mjs verify` proves every blob decrypts.
- **Guard:** `scripts/check-audits.mjs` (run by CI and `node --test scripts/`) fails on a tracked
  sealed plaintext, a `.age` file without its armor header, an unfinished status in `fixed/`, and a
  `CPP-NNNN` id in any public file that is not a fixed finding's heading.

## Naming

- One pass = one date: `AUDIT-YYYY-MM-DD.md`, the day the pass **started**. A second pass that day
  gets `-2`.
- The same filename is used in `open/` and `fixed/`: a pass's findings are split between the two.
- **Finding IDs are one global running number: `CPP-NNNN`** (`CPP-0001`, ...), continued across
  passes, never per pass, never reused, never renumbered. A finding keeps its ID when it moves from
  `open/` to `fixed/`.
- **Next free ID: `CPP-0001`.** Update this line in the same commit that writes a new pass.

## Lifecycle of a finding

1. **Reported.** `/audit` writes the whole pass to `open/AUDIT-YYYY-MM-DD.md` (sealed).
2. **Fixed.** The fix commit cites the ID (`fix(hooks): ... (CPP-0007)`) and carries a regression
   test that fails before and passes after. In the same unit of work the finding's section **moves**
   from `open/` to `fixed/` of the same pass, rewritten to the fixed format below.
3. **Partially fixed.** The finding stays in `open/`, **whole**, with `Status: partial` and a record
   of which legs are done. Nothing of it is public until every leg is fixed: even a fixed-legs-only
   entry tells a reader where the rest of the hole is.
4. **Accepted.** Moves to `ACCEPTED.md` with date, rationale and the assumption that would void it.
   Stays sealed (it is still in the shipped code).
5. **Withdrawn** (false positive, not reproducible, obsoleted by a removal). Moves to `fixed/` under
   "Closed without a change", with the reason, only if nothing of it remains exploitable.
6. **Carried.** A later pass re-raises an open finding under a new ID: the old section stays in its
   `open/` file with `Status: carried -> CPP-NNNN`, and moves to `fixed/` together with its successor.
7. **Empty.** When a pass has nothing left open, delete its `open/` plaintext AND `.age` blob.

## The two formats

### `open/AUDIT-YYYY-MM-DD.md` (sealed)

```markdown
# AUDIT-YYYY-MM-DD — open findings (SEALED — never publish)

| | |
|---|---|
| Pass | <full pass / area pass> — IDs `CPP-NNNN`–`CPP-NNNN` |
| Started | YYYY-MM-DD |
| Model | <model the audit ran on> |
| Scope | <full sweep / area> |
| Status | N open · M partially fixed |

## Verdict at the time
<the pass's verdict, verbatim>

## Open findings

| ID | Severity | Surface | Title | Status | Next step |
|---|---|---|---|---|---|

Status: `open` · `partial` · `blocked: <upstream | decision>` · `carried -> CPP-NNNN`.

## CPP-NNNN — <title>
**Severity:** ... · **Surface:** ... · **Status:** ... · **Where:** `path:line`

<reachability, evidence, impact, recommended fix; for `partial`, which legs are done>

## Coverage gaps
<what this pass did NOT review: the next pass starts here>
```

### `fixed/AUDIT-YYYY-MM-DD.md` (public)

```markdown
# AUDIT-YYYY-MM-DD — fixed findings

| | |
|---|---|
| Pass | <kind> — IDs `CPP-NNNN`–`CPP-NNNN` |
| Started | YYYY-MM-DD |
| Model | <model> |
| Scope | <full sweep / area> |
| This file | N fixed · K closed without a change — the pass reported T findings |

## Fixed findings

| ID | Severity | Surface | Title | Fixed |
|---|---|---|---|---|

## CPP-NNNN — <title>
**Severity:** ... · **Surface:** ... · **Fixed:** YYYY-MM-DD in `<hash>` · **Regression test:** `<name>`

**What was wrong.** <who could reach it and what it gave them, past tense>

**The fix.** <what changed, where>

## Closed without a change
| ID | Severity | Title | Why |
```

A public section describes a finding that is fixed in full. It never mentions a still-open related
finding beyond "tracked in the sealed register". The `**Status:**` label is for `open/` only.

## Index of passes

| Pass | IDs | Kind | Fixed (public) | Still open (sealed) |
|---|---|---|---|---|

No pass has run yet. The "still open" column names a sealed file; a pass with nothing open has none.

## Re-verification

Before `fixed/` is trusted, re-verify it: re-derive each public entry against the current code (the
fix at the call site, the siblings it could have missed, the named regression test passing in a
fresh run) and check each sealed entry for having been fixed since. An entry that does not hold up
goes back under seal, whole; one that is now fixed moves out.
