# skill-drift

A read-only report on the agent skills installed on your machine: where each one came from, whether upstream has moved, and whether the copy on disk is still what it claims to be.

It never installs, updates, or repairs anything. That is the point.

```
$ node scripts/check-skills.mjs

VENDORED BY HAND — pinned copy vs upstream
  ✓ better-documents   identical to owner/repo@HEAD
  ⚠ improve            SKILL.md matches owner/repo@HEAD, but the install does not
                       — missing: references/plan-template.md

CLI-MANAGED — ~/.agents/.skill-lock.json
  ✓ firecrawl-scrape   unchanged upstream since 2026-08-02

INSTALLED LOCALLY — npm / git-repo / vendor CLI
  ⚠ some-skill         skill v4.1.1, but the install does not match the v4.1.1 tag
                       — content differs: reference/new-work.md

SUMMARY: 2 behind · 0 undeterminable · 0 unlinked · 0 unattributed
```

## Why this exists

Plugins have an update banner. Skills do not. So the question "is anything I'm running out of date?" has no answer you can just look up, and the tools that could answer it are the same tools that change things: `npx skills update`, `claude plugin update`, `railway skills update`, `npx impeccable update`. You cannot use an updater to decide whether to update.

That is a small annoyance on its own. The larger one is what the available checks actually compare.

**Almost everything in this space asks "has upstream moved?" Almost nothing asks "is what I have actually what I think it is?"**

Those are different questions, and the second one is where the surprises live:

- A skill's `SKILL.md` can match upstream perfectly while a reference file it depends on is missing entirely. One of the skills that motivated this tool sat a file short of upstream, for months, behind a green tick.
- A published package can lag its own repository. One skill here reported a matching version — v4.1.1 on both sides — while five of its files differed, because the npm package was published thirteen hours before the commits that changed them.
- An install can drift from its own lockfile and become invisible to the installer that wrote it. That is [vercel-labs/skills#1812](https://github.com/vercel-labs/skills/issues/1812), still open: `skills update` compares the lock's recorded hash against upstream and never reads the files, so a drifted install reports `All global skills are up to date` and no number of retries converges it.

None of those are exotic. They are what happens when a check compares *metadata to metadata* and never looks at the bytes.

## Four things that cost me a day

If you write your own version of this — and you might, since a manifest-driven tool is a big ask — these are the parts I would not have guessed.

**Comparing raw bytes reports every Windows checkout as drifted.** Git object ids hash bytes, and `core.autocrlf` rewrites LF to CRLF on disk. Every file mismatches. Treat a hash mismatch as *suspect*, not as drift: fetch that one blob and compare newline-normalised content before reporting anything. The fast path stays free because real mismatches are rare.

**A 404 is not evidence of absence.** GitHub's contents API is case-sensitive. Two skills here were recorded as "not present upstream, locally authored" for months, on the strength of a request for `SKILL.md` against a repo that names the file `skill.md`. They were byte-identical to upstream the whole time. List the directory before concluding a thing does not exist.

**A matching version string is not matching content.** Versions record what someone last stamped, not what shipped. Forks inline their upstream and stop tracking it; packages lag their repos; generated files get synced after release. If a version is your staleness signal, ask what could move the content without moving the version — the answer is usually "several things".

**Compare against what a thing was installed *from*, not against HEAD.** This one is easy to get backwards. Comparing an install to `HEAD` asks whether it matches upstream *today*, which no published artifact can pass the moment a maintainer commits between releases. Pin the comparison to the release tag, or to the tree the lockfile recorded. Keep `HEAD` for the separate question of whether a newer version exists.

There is a fifth, smaller one: a tree response already carries every file's git object id, so you can verify an entire directory with **one** API call and zero downloads. `sha1("blob " + byteLength + "\0" + bytes)` recomputes the id locally. The `npx skills` lockfile's `skillFolderHash` is exactly this — a tree sha — which makes an install verifiable against the exact state it was installed from.

## What it checks

| Install mechanism | How staleness is judged | How integrity is judged |
|---|---|---|
| Vendored by hand | pinned file vs upstream | full install set vs upstream tree |
| `npx skills` (lockfile) | folder tree sha vs upstream | files vs the tree sha recorded at install |
| npm-distributed skill | skill version vs upstream | files vs the release tag for that version |
| Git-repo skill | pinned file vs upstream | declared install set vs upstream |
| Vendor CLI (e.g. Railway) | vendor's own state file | per-file hashes the vendor recorded |
| Multi-root copies | — | contents compared across every agent root |

That last row matters more than it looks. Vendor CLIs that "set up your coding agent" fan out into `~/.claude`, `~/.agents`, `~/.factory` and `~/.config/opencode` by default, so the same skill can exist four times and drift in three of them.

## Usage

```bash
node scripts/check-skills.mjs                      # full report
node scripts/check-skills.mjs --json               # machine-readable
node scripts/check-skills.mjs --no-network         # everything becomes "undeterminable"
node scripts/check-skills.mjs --banner             # cache-only, for a session-start hook
```

Node 18+. No dependencies. GitHub auth is optional but recommended (`$GH_TOKEN`, `$GITHUB_TOKEN`, or `gh auth token`); unauthenticated works at 60 requests/hour.

Configuration lives in `skills/skills-sources.json` — see the example in this repo, which documents each class with the reasoning behind its fields. `scripts/vendor-skill.mjs` is the companion: it vendors a skill from GitHub and records its provenance at the same time, so there is something to verify against later.

The case table in `scripts/tests/` runs offline with no token, and is worth running if you change the comparison logic. Every row is a way the checker must still be able to fail — it was written after discovering that a checker which cannot fail reads exactly like one that passes.

## What it deliberately does not do

- **It does not fix anything.** Every row prints the command that would, and you run it.
- **It does not manage skills.** Installing, updating and removing are what the existing tools are for.
- **It does not treat "unknown" as "fine".** A check it could not run reports `?`, not `✓`. That distinction is the whole reason to have a separate reporting tool.

## Status

This started as personal tooling for one machine with skills from five different sources, and is published because the underlying gap turned out to be general rather than personal. It is not a product, has no roadmap, and the manifest is real setup cost. Take the ideas if the code does not fit — the four traps above are the transferable part.

## License

MIT.
