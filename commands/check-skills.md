---
description: Report which skills are stale, unlinked, or have no recorded provenance (read-only)
allowed-tools: Bash(node:*), Read, Edit, Glob, Grep
argument-hint: "[--no-network]"
---

# Check skills

Skills have no update banner, unlike plugins. This is the substitute: one read-only pass over
every install mechanism on this machine, answering *what is active, where did it come from, and
is any of it behind?*

## Run it

```bash
node scripts/check-skills.mjs $ARGUMENTS
```

| Flag | Effect |
|---|---|
| *(none)* | Full report, refreshes the cache |
| `--json` | Machine-readable output |
| `--no-network` | Skip every remote call — everything becomes "undeterminable" rather than falsely reading as current |
| `--banner` | Session-start hook mode. Cache only, no network. Emits a JSON object or nothing — not for humans. |
| `--refresh` | Run the check, write the cache, print nothing |

Then show the user the report as-is. It is already formatted for a terminal — do not re-summarise
it into a table of your own.

## The session-start banner

A SessionStart hook runs `--banner`, which reads **only** the cache — no network, no git, no npm,
~75ms. If the cache is older than `roots.cacheTtlHours` (default 24) it spawns a detached refresh
whose result appears next session. Session start never waits on ~25 GitHub calls.

It emits **one JSON object, or nothing**. It fires only on states that are actionable *now*:
something behind upstream, something in the repo not linked on this machine, or the checkout
behind origin. Provenance gaps (`undeterminable`, `unattributed`) are deliberately excluded — they
are real but near-permanent, and a banner that fires on a healthy machine every session is one you
learn to scroll past.

**It must be JSON, not plain text.** A SessionStart hook's plain stdout is *added to Claude's
context*, not shown to the user — that is documented behaviour for `SessionStart`,
`UserPromptSubmit` and `UserPromptExpansion`, and it is the opposite of what a banner needs. The
only field that surfaces text to the person at the keyboard is `systemMessage`. The first version
of this shipped as plain text and was therefore invisible to its entire audience.

Installing it on a new machine (machine-local — `~/.claude/settings.json` is not synced):

```json
{ "type": "command",
  "command": "node <abs-path-to>/scripts/check-skills.mjs --banner",
  "timeout": 5 }
```

Add it to the existing `hooks.SessionStart` entry with matcher `.*` — append to its `hooks` array
rather than adding a new matcher block, and **snapshot the file first**. Changes to
`settings.json` need a full CLI restart, not `/clear`.

## The one rule

**This command reports. It never applies.** Do not run any `fix:` line from the output unless the
user asks for that specific one. Two of them are actively dangerous to run reflexively:

- `npx skills update -g` **applies** every update it finds. It is not a dry run. **Note the `-g`**: these skills live in the global lock at `~/.agents/`, and without it the CLI updates *project* scope, reports "No project skills to update", and exits 0 — success-shaped and useless. This file said `npx skills check` until 2026-08-21, which is not a command in that CLI at all; eight skills sat behind for days because following the instruction looked like it had worked.
- `npx impeccable update --help` is not help — **`--help` is unrecognised and the command
  executes**. So does `install --help`, which writes a project-scoped copy plus two hooks into
  `settings.local.json`. Probe unfamiliar CLIs with `<tool> help`, never `<tool> --help`.

## Reading the output

Five sections, one per install mechanism, because they fail in different ways:

| Section | What "behind" means | How to fix |
|---|---|---|
| Own checkout | your skills repo is behind origin on `skills/` | `git pull` |
| Vendored by hand | The pinned copy differs from upstream | Re-vendor; check the `NOTICE-*.md` |
| CLI-managed | Upstream committed to that skill's folder since install | `npx skills update -g` (applies!) |
| Installed locally | npm/git-repo skill version differs from upstream | Per-row `fix:` line |
| Linkage | In the repo but never junctioned, or active with no provenance | Junction it, or add a manifest entry |

Two verdicts are not failures and should not be reported as ones:

- **`?` undeterminable** — the check could not run (no recorded upstream, no version signal, or
  network off). It is a gap in provenance, not evidence of staleness. The fix is recording the
  source in the manifest, not updating anything.
- **`fork, reconciled against …`** — a derivative that was deliberately rewritten. Its content
  will never match upstream; only an upstream *version* bump is a real signal.

## Vendoring a new skill

**Do not copy a skill in by hand.** That is how `improve` ended up permanently undiffable — it was
copied from a shadcn source nobody wrote down. Use the helper, which pins the commit and records
provenance in the same step:

```bash
node scripts/vendor-skill.mjs <owner/repo> <upstream-path> [--as <name>]
node scripts/vendor-skill.mjs --update <name>     # re-pull, re-pin
```

It fetches the tree at the current HEAD SHA, writes `skills/<name>/`, adds the manifest entry
pinned to that SHA, writes `skills/NOTICE-<name>.md` with the licence, and creates the junction.
`--dry-run` shows all of that without touching anything. Pass `--derivative` when you intend to
rewrite the skill locally — it records `syncedUpstreamVersion` instead of expecting the content to
keep matching.

It refuses to overwrite an existing skill without `--update` or `--force`, and refuses a path with
more than 60 files (which almost always means the path is a repo root, not a skill).

Two things it deliberately does *not* do: guess at a `note` you wrote (a preserved note can go
stale after a re-pin — read it), and infer a licence that upstream does not publish (it writes
`NOT DETECTED` rather than something reassuring).

## Adding an entry by hand

`skills/skills-sources.json`. Anything under `skills/` with no entry
defaults to `local` and is checked only via the own-checkout git comparison. Anything installed by
`npx skills` is discovered from `~/.agents/.skill-lock.json` and needs no entry at all.

Hand entries are needed only for things the helper cannot vendor: skills installed as real
directories in `~/.claude/skills` by some other tool (`location: "active"` plus its class — `npm`,
`git-repo`, or `cli`).

If the report shows a name under "active with no recorded provenance", that is the manifest asking
to be filled in.

### Fields that scope the completeness check

The check verifies the whole install, not just `SKILL.md`. Three optional fields tell it what
"whole" means and what to compare against — all added 2026-08-15, after it spent its life
comparing one file and reporting a green tick regardless.

| Field | On | What it does |
|---|---|---|
| `installs` | vendored, git-repo | The upstream paths that make up the skill, relative to the upstream dir. **Required when the skill lives at a repo ROOT**, because it is then a subset of that root — `a git-repo skill` ships `SKILL.md` + `reference/` beside a README, LICENSE and `install.sh`, and comparing root-to-root reports the repo's own furniture as missing. Omit it when the skill owns its own subdirectory; the whole subtree is used. |
| `forkOmits` | vendored + `derivative` | Upstream paths a fork deliberately does not carry as files. `writing-prose` inlines upstream's eight `references/` into one `SKILL.md`, so it declares `["references/"]`. Set this only once the content genuinely matches — it silences the warning, so setting it early buries the gap it exists to reveal. |
| `upstream.tagPattern` | npm | Release-tag template, e.g. `skill-v{version}`. Without it the install is compared against repo HEAD, which fails whenever a maintainer commits between releases: impeccable reported five differing files that were commits made 13 hours *after* the npm publish it was installed from. `{version}` is substituted with the installed skill version. |

A root-level entry with no `installs` is not silently trusted — its row says `(SKILL.md only —
install set not declared)` rather than implying the whole skill was verified.

CLI-managed skills need none of this: `~/.agents/.skill-lock.json` records `skillFolderHash`, which
is the git **tree sha** of the skill folder as installed, and that is used for both staleness and
integrity.
