#!/usr/bin/env node
/**
 * check-skills.mjs — read-only provenance + staleness report for Claude Code skills.
 *
 * Answers: what skills are active, where did each come from, and is any of them behind?
 *
 * READ-ONLY BY CONSTRUCTION. It never installs or updates a skill. That is the whole point:
 * `npx skills check` and `npx impeccable update` both APPLY updates on the spot, so neither
 * can be used to decide whether to nag. This reports; you apply.
 *
 * The one thing it DOES write is the banner cache (roots.cache), on every run including
 * `--no-network` — which degrades every row to "undeterminable", so probing with that flag
 * leaves the next session's banner reading an all-clear built from a blinded run. Probe
 * against a temp manifest with its own cache path instead.
 *
 * CHANGING THE COMPLETENESS LOGIC? Run the case table — it is the only thing standing between
 * this and its original bug, which was reporting a green tick while comparing one file:
 *   node scripts/tests/check-skills-completeness.test.mjs
 *
 * Usage:
 *   node check-skills.mjs [--manifest <path>] [--json] [--no-network]
 *
 * Config comes from skills-sources.json (default: ../skills/skills-sources.json).
 * No hardcoded paths, no dependencies — Node >= 18 only (needs global fetch).
 *
 * GitHub auth, in order: $GH_TOKEN, $GITHUB_TOKEN, `gh auth token`, then unauthenticated
 * (60 req/hr, enough for a single run but it will rate-limit if you loop).
 *
 * Originally built as personal tooling; published because the gap it fills is general.
 */

import { readFile, writeFile, mkdir, readdir, lstat, readlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

import { sh, exists, resolvePath, normalize, pool, resolveToken, makeGh } from './lib/skills-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const AS_JSON = flag('--json')
const NO_NETWORK = flag('--no-network')
// SessionStart hook mode: cache-only, no network, always fast. Emits a JSON object carrying
// `systemMessage` (the only field the user actually sees) — or nothing at all. Not for humans;
// run the command with no flags for a readable report.
const BANNER = flag('--banner')
const REFRESH = flag('--refresh') // run the check and write the cache, print nothing

// ─── GitHub ───────────────────────────────────────────────────────────────────

let TOKEN = null
// Replaced with an authenticated caller once the token resolves, inside collect().
let gh = makeGh({ disabled: NO_NETWORK, userAgent: 'check-skills' })

const upstreamFile = (repo, filePath, ref) => gh.file(repo, filePath, ref)

/** Commits touching `filePath`, newest first. */
async function commitsFor(repo, filePath, since) {
  const q = new URLSearchParams({ path: filePath, per_page: '100' })
  if (since) q.set('since', since)
  const r = await gh(`repos/${repo}/commits?${q}`)
  if (!r.ok) return r
  return {
    ok: true,
    data: r.data.map((c) => ({
      sha: c.sha,
      date: c.commit?.committer?.date ?? '',
      message: (c.commit?.message ?? '').split('\n')[0],
    })),
  }
}

/** How many commits touched `filePath` after the pinned `ref`. null = ref not in the last 100. */
async function commitsAheadOf(repo, filePath, ref) {
  const r = await commitsFor(repo, filePath)
  if (!r.ok) return { ok: false, reason: r.reason }
  const matches = (a, b) => a.startsWith(b) || b.startsWith(a)
  const idx = r.data.findIndex((c) => matches(c.sha, ref))
  if (idx < 0) return { ok: true, count: null, newest: r.data[0] ?? null }
  return { ok: true, count: idx, newest: r.data[0] ?? null }
}

// ─── filesystem inspection ────────────────────────────────────────────────────

/** Every entry in a skills dir, tagged as a link (with target) or a real directory. */
async function inspectSkillsDir(dir) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return pool(entries.filter((e) => e.isDirectory() || e.isSymbolicLink()), 8, async (e) => {
    const full = path.join(dir, e.name)
    let target = null
    try {
      const st = await lstat(full)
      if (st.isSymbolicLink()) target = await readlink(full)
    } catch {
      /* unreadable link — treat as a real dir */
    }
    return { name: e.name, full, linked: Boolean(target), target }
  })
}

/** Directories under `dir` that actually contain a SKILL.md (so support dirs are skipped). */
async function realSkills(dir) {
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  const checked = await pool(dirs, 8, async (e) => ({
    name: e.name,
    has: await exists(path.join(dir, e.name, 'SKILL.md')),
  }))
  return checked.filter((c) => c.has).map((c) => c.name)
}

/** A skill's own version, from `version:` in frontmatter or a `<!-- name vX.Y.Z -->` marker. */
function versionFromText(text) {
  if (!text) return null
  const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const scope = fm ? fm[1] : String(text).slice(0, 2000)
  return (
    // Leading whitespace allowed: some skills nest it under `metadata:`.
    scope.match(/^\s*version:\s*["']?([^"'\s]+)/m)?.[1] ??
    String(text).match(/<!--\s*[\w-]+\s+v([\d.]+)\s*-->/)?.[1] ??
    null
  )
}

async function frontmatterVersion(skillMd) {
  try {
    return versionFromText(await readFile(skillMd, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Windows needs a shell to run npm (it is npm.cmd, and execFile refuses .cmd without one).
 * Pass the whole command as one string with an empty args array — args + shell:true is what
 * triggers Node's DEP0190 warning. The package name is manifest-controlled, but validate it
 * anyway since it lands in a shell string.
 */
async function npmVersion(pkg) {
  if (!/^[@a-z0-9][\w.@/-]*$/i.test(String(pkg ?? ''))) return null
  const r =
    process.platform === 'win32'
      ? await sh(`npm view ${pkg} version`, [], { shell: true })
      : await sh('npm', ['view', pkg, 'version'])
  return r.ok ? r.stdout.trim() : null
}

// ─── per-class checks ─────────────────────────────────────────────────────────

const treeCache = new Map()

/** The raw recursive tree at `ref`. One call per repo+ref, shared across that repo's skills. */
async function repoTree(repo, ref = 'HEAD') {
  const key = `${repo}@${ref}`
  if (!treeCache.has(key)) {
    treeCache.set(
      key,
      gh(`repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`).then((r) => (r.ok ? r.data.tree : null)),
    )
  }
  return treeCache.get(key)
}

/** Every blob at `ref`, as {path, sha}. */
async function repoBlobs(repo, ref = 'HEAD') {
  const t = await repoTree(repo, ref)
  return t ? t.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha })) : null
}

/** One blob's text by its object id. Works from any tree, with no path or ref to resolve. */
async function upstreamBlob(repo, sha) {
  const r = await gh(`repos/${repo}/git/blobs/${sha}`)
  if (!r.ok || typeof r.data?.content !== 'string') return null
  if (r.data.encoding !== 'base64') return r.data.content
  return Buffer.from(r.data.content, 'base64').toString('utf8')
}

/** The git tree sha of directory `dir` at `ref` — the exact identity of a folder's contents. */
async function repoDirSha(repo, dir, ref = 'HEAD') {
  const t = await repoTree(repo, ref)
  return t ? (t.find((e) => e.type === 'tree' && e.path === dir)?.sha ?? null) : null
}

/**
 * Upstream files the local copy is missing.
 *
 * The content compare elsewhere in this file looks at ONE file — entry.path, nearly always
 * SKILL.md — so a skill could be missing whole reference files and still report "identical to
 * repo@HEAD". A git-repo skill sat one file short of upstream behind a green tick for months.
 *
 * Both the file set and each file's content are compared, but cheaply: the tree carries every
 * blob's git object id, which is recomputable locally, so an identical file costs nothing. Only a
 * mismatch pays for a fetch — and a mismatch is merely SUSPECT, because a CRLF working copy never
 * matches an LF blob; normalize() settles it. Extra LOCAL files are deliberately not reported,
 * since vendoring legitimately adds LICENSE and SKILL.upstream.md.
 *
 * `ref` matters as much as the file list. Comparing an installed skill against HEAD asks "does my
 * copy match what upstream has today", which is the wrong question for anything installed from a
 * published artifact: impeccable's five "differing" files turned out to be commits made 13 hours
 * AFTER the npm publish it was installed from, and matched byte-for-byte at the release tag.
 *
 * Scope comes from `installs` (paths under the upstream dir) when declared. Otherwise it is the
 * whole subtree under dirname(entry.path) — but ONLY when that dirname is non-empty. A repo-root
 * entry whose skill is a subset of the root (a skill may ship SKILL.md + reference/ beside a
 * README, LICENSE and install.sh) would otherwise report the repo's own furniture as missing, so
 * those must declare `installs` or opt out of this check entirely.
 */
async function missingUpstream(entry, skillDir, { presenceOnly = false, ref = 'HEAD', folderTree = false } = {}) {
  const upstreamPath = entry.path ?? 'SKILL.md'
  const root = path.posix.dirname(upstreamPath.replace(/\\/g, '/'))
  // folderTree: `ref` is the tree sha of the skill folder ITSELF, so its paths are already
  // relative to the skill and there is no prefix to strip. That is the exact state a vendor lock
  // records at install time, which beats guessing a ref from a date.
  const base = folderTree ? '' : root === '.' ? '' : root
  if (!folderTree && !base && !entry.installs) return { checked: false }

  const blobs = await repoBlobs(entry.repo, ref)
  if (!blobs) return { checked: false }

  const at = base ? `${base}/` : ''
  let want = blobs
    .filter((b) => b.path.startsWith(at))
    .map((b) => ({ rel: b.path.slice(at.length), full: b.path, sha: b.sha }))
  if (entry.installs) {
    want = want.filter((w) =>
      entry.installs.some((i) => (i.endsWith('/') ? w.rel.startsWith(i) : w.rel === i)),
    )
  }
  // A fork may deliberately not carry parts of upstream. `forkOmits` records that decision so the
  // report stays quiet about it — while STILL speaking up when upstream adds something new, which
  // is the movement a version pin alone can miss.
  if (entry.forkOmits) {
    want = want.filter(
      (w) => !entry.forkOmits.some((i) => (i.endsWith('/') ? w.rel.startsWith(i) : w.rel === i)),
    )
  }
  if (!want.length) return { checked: false }

  // Case-insensitive: upstream may name it `skill.md` where the install must be `SKILL.md`
  // (rjs/shaping-skills does exactly this for breadboarding), and Windows would not distinguish
  // them anyway. Worst case two upstream files differing only in case under-report; that beats
  // inventing a missing file on every run.
  const local = (await skillFiles(skillDir)) ?? new Map()
  const have = new Map([...local].map(([k, v]) => [k.toLowerCase(), v]))
  const comparedRel = upstreamPath.slice(at.length)

  const missing = []
  const modified = []
  for (const w of want) {
    const mine = have.get(w.rel.toLowerCase())
    if (!mine) {
      missing.push(w.rel)
      continue
    }
    // A fork's files are rewritten on purpose, so diffing their content says nothing.
    if (presenceOnly) continue
    // An entry with `compare` keeps a deliberately modified local file (better-documents rewrites
    // SKILL.md and diffs the pristine SKILL.upstream.md instead). Its divergence is the point, so
    // only its PRESENCE is checked here — the dedicated compare above already covers its content.
    if (entry.compare && w.rel === comparedRel) continue
    // Fast path: git's own object id, free from the tree we already have. Equal means identical.
    if ((await gitBlobSha(mine.abs)) === w.sha) continue
    // Unequal is only SUSPECT — a CRLF working copy never matches an LF blob. Pay for one blob
    // fetch and let the normalized compare decide, so line endings cannot invent a difference.
    //
    // Fetch by BLOB SHA, not by path+ref. The path form needs a repo-root path and a commit-ish
    // ref, neither of which exists when `ref` is a folder's tree sha — it silently 404'd and this
    // loop's `continue` turned that into a clean bill of health for an edited file.
    const up = await upstreamBlob(entry.repo, w.sha)
    if (up === null) continue // cannot prove a difference; stay silent rather than cry wolf
    const text = await readFile(mine.abs, 'utf8').catch(() => null)
    if (text !== null && normalize(text) !== normalize(up)) modified.push(w.rel)
  }
  return { checked: true, missing: missing.sort(), modified: modified.sort() }
}

/**
 * Fold a missing-files result into a row that otherwise reported clean.
 *
 * When the set could not be established the row must SAY so rather than keep implying the whole
 * skill was verified — an unqualified ✓ is the most expensive wrong answer this tool can give.
 */
function withCompleteness(row, gap, repo, comparedFile, scope) {
  // `scope` names what WAS verified, because that differs by class and getting it wrong produces
  // self-contradicting output: a CLI-managed row verified by tree sha once read "SKILL.md matches
  // ... content differs: SKILL.md".
  const verified = scope ?? `${comparedFile} matches ${repo}@HEAD`
  if (!gap.checked) return { ...row, detail: `${row.detail} (${comparedFile} only — install set not declared)` }
  if (!gap.missing.length && !gap.modified.length) return row
  const list = (xs) => {
    const shown = xs.slice(0, 4).join(', ')
    return xs.length > 4 ? `${shown} (+${xs.length - 4} more)` : shown
  }
  const parts = []
  if (gap.missing.length) parts.push(`missing: ${list(gap.missing)}`)
  // "locally modified" would name a cause we have not established. A published package can lag
  // its own repo (impeccable v4.1.1 matched while five of its files had moved on), which looks
  // identical from here to someone editing the install. State the observation, not the story.
  if (gap.modified.length) parts.push(`content differs: ${list(gap.modified)}`)
  return {
    ...row,
    status: 'behind',
    detail: `${verified}, but the install does not — ${parts.join(' · ')}`,
  }
}

async function checkVendored(name, entry, skillDir) {
  const base = { name, class: 'vendored', repo: entry.repo, ref: entry.ref, update: entry.update }
  if (!entry.repo || !entry.path) {
    return { ...base, status: 'unknown', detail: entry.note ?? 'upstream repo/path not recorded' }
  }
  const localPath = path.join(skillDir, entry.compare ?? 'SKILL.md')
  if (!(await exists(localPath))) {
    return { ...base, status: 'unknown', detail: `local copy missing: ${path.basename(localPath)}` }
  }
  const local = await readFile(localPath, 'utf8')
  const up = await upstreamFile(entry.repo, entry.path)
  if (!up.ok) return { ...base, status: 'unknown', detail: up.reason }

  // A derivative was deliberately rewritten, so a content diff always "fails" and means nothing.
  // The only real question is whether UPSTREAM moved since we last pulled its ideas across.
  if (entry.derivative) {
    const latest = versionFromText(up.data)
    const synced = entry.syncedUpstreamVersion ?? null
    if (!latest) return { ...base, status: 'unknown', detail: `fork of ${entry.repo}; upstream exposes no version` }
    if (!synced) return { ...base, status: 'unknown', detail: `fork of ${entry.repo}@v${latest}; no synced version recorded` }
    const row =
      latest === synced
        ? { ...base, status: 'current', detail: `fork, reconciled against ${entry.repo}@v${latest}` }
        : { ...base, status: 'behind', detail: `fork reconciled at v${synced}; upstream now v${latest} — re-read upstream and port what applies` }
    // A matching version is NOT proof the fork saw everything: upstream can add whole reference
    // files without touching the version string, and the pin only records when someone last
    // looked. Presence-only — the fork's own text is rewritten by design.
    const gap = await missingUpstream(entry, skillDir, { presenceOnly: true })
    if (!gap.checked || !gap.missing.length) return row
    const shown = gap.missing.slice(0, 3).join(', ')
    const more = gap.missing.length > 3 ? ` (+${gap.missing.length - 3} more)` : ''
    return {
      ...row,
      status: 'behind',
      detail: `${row.detail} · upstream ships ${gap.missing.length} file${gap.missing.length === 1 ? '' : 's'} this fork has no counterpart for: ${shown}${more} — port them or record them in forkOmits`,
    }
  }

  if (normalize(local) === normalize(up.data)) {
    const row = { ...base, status: 'current', detail: `identical to ${entry.repo}@HEAD` }
    return withCompleteness(row, await missingUpstream(entry, skillDir), entry.repo, path.basename(localPath))
  }
  let detail = `differs from ${entry.repo}@HEAD`
  if (entry.ref) {
    const ahead = await commitsAheadOf(entry.repo, entry.path, entry.ref)
    if (ahead.ok && ahead.count !== null) {
      detail =
        ahead.count === 0
          ? `content differs but pin is at HEAD — locally modified`
          : `${ahead.count} commit${ahead.count === 1 ? '' : 's'} behind${ahead.newest ? ` · latest: ${ahead.newest.message}` : ''}`
    } else if (ahead.ok) {
      detail = `differs; pinned ref not in the last 100 commits on that path`
    }
  } else {
    detail += ' (no pinned ref recorded — could also be a local edit)'
  }
  return { ...base, status: 'behind', detail }
}

async function checkAgentsLock(lockPath, skillsDir) {
  if (!(await exists(lockPath))) return []
  let lock
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch (err) {
    return [{ name: path.basename(lockPath), class: 'cli-managed', status: 'unknown', detail: `unreadable lock: ${err.message}` }]
  }
  const rows = Object.entries(lock.skills ?? {})
  return pool(rows, 5, async ([name, e]) => {
    const base = {
      name,
      class: 'cli-managed',
      repo: e.source,
      update: 'npx skills check',
      warn: '`npx skills check` APPLIES updates — it is not a dry run',
    }
    if (!e.source || !e.skillPath) {
      return { ...base, status: 'unknown', detail: 'lock entry has no source/skillPath' }
    }
    const dir = path.posix.dirname(e.skillPath)
    const since = e.updatedAt ?? e.installedAt

    // `skillFolderHash` is the git TREE sha of the skill folder as installed (verified against
    // firecrawl/cli on 2026-08-15). That is an exact identity, so prefer it over counting commits:
    // a commit that touches a sibling file, or one that is later reverted, moves the date signal
    // without changing this skill at all. It also gives the integrity check a ref that cannot
    // drift — comparing an install against HEAD asks the wrong question the moment upstream
    // commits again, which is what made impeccable report five phantom differences.
    if (e.skillFolderHash) {
      const upSha = await repoDirSha(e.source, dir)
      if (upSha) {
        const row =
          upSha === e.skillFolderHash
            ? { ...base, status: 'current', detail: `unchanged upstream since ${String(since).slice(0, 10)}` }
            : { ...base, status: 'behind', detail: `upstream ${dir} changed since install (${short(e.skillFolderHash)} → ${short(upSha)})` }
        if (row.status !== 'current' || !skillsDir) return row
        const gap = await missingUpstream({ repo: e.source, path: e.skillPath }, path.join(skillsDir, name), {
          ref: e.skillFolderHash,
          folderTree: true,
        })
        return withCompleteness(row, gap, e.source, path.posix.basename(e.skillPath), 'upstream unchanged since install')
      }
    }

    const r = await commitsFor(e.source, dir, since)
    if (!r.ok) return { ...base, status: 'unknown', detail: r.reason }
    if (r.data.length === 0) {
      return { ...base, status: 'current', detail: `no upstream commits on ${dir} since ${String(since).slice(0, 10)}` }
    }
    return {
      ...base,
      status: 'behind',
      detail: `${r.data.length} commit${r.data.length === 1 ? '' : 's'} since ${String(since).slice(0, 10)} · latest: ${r.data[0].message}`,
    }
  })
}

/**
 * A skill distributed by an npm CLI. The PACKAGE version and the SKILL version are separate
 * series — impeccable ships skill v4.0.4 inside package v3.5.0 — so comparing the skill's
 * frontmatter against `npm view <pkg> version` reports a phantom downgrade. Compare skill
 * version to skill version, at the upstream repo; the package version is context only.
 */
async function checkNpm(name, entry, skillDir) {
  const up = entry.upstream ?? {}
  const base = { name, class: 'npm', repo: up.repo ?? `npm:${entry.package}`, update: entry.update, warn: entry.warn }
  const installed = await frontmatterVersion(path.join(skillDir, 'SKILL.md'))
  const pkg = NO_NETWORK ? null : await npmVersion(entry.package)
  const ctx = pkg ? ` · ships in ${entry.package}@${pkg}` : ''

  if (!up.repo || !up.path) {
    return { ...base, status: 'unknown', detail: `skill v${installed ?? '?'}${ctx}; upstream repo/path not recorded` }
  }
  const res = await upstreamFile(up.repo, up.path)
  if (!res.ok) return { ...base, status: 'unknown', detail: `skill v${installed ?? '?'}${ctx}; ${res.reason}` }

  const latest = versionFromText(res.data)
  if (!installed || !latest) {
    return { ...base, status: 'unknown', detail: `skill v${installed ?? '?'} vs upstream v${latest ?? '?'}${ctx}` }
  }
  if (installed !== latest) return { ...base, status: 'behind', detail: `skill v${installed} → v${latest}${ctx}` }
  // A matching version number is not a complete install — same gap as everywhere else here.
  //
  // But compare against the TAG for the installed version, not HEAD. These two questions are
  // different and only the first one HEAD can answer: "is a newer version out" (the check above)
  // versus "is my copy of THIS version intact". A maintainer who commits between releases makes
  // the second question fail against HEAD forever, which is a false alarm, not a finding.
  const row = { ...base, status: 'current', detail: `skill v${installed}${ctx}` }
  const ref = up.tagPattern ? up.tagPattern.replace('{version}', installed) : 'HEAD'
  return withCompleteness(row, await missingUpstream(up, skillDir, { ref }), up.repo, path.posix.basename(up.path))
}

async function checkGitRepoSkill(name, entry, skillDir, manifestDir) {
  const base = { name, class: 'git-repo', repo: entry.repo, update: entry.update }
  const localPath = path.join(skillDir, entry.path ?? 'SKILL.md')
  if (!(await exists(localPath))) return { ...base, status: 'unknown', detail: 'installed copy missing' }
  const local = await readFile(localPath, 'utf8')
  const up = await upstreamFile(entry.repo, entry.path ?? 'SKILL.md')
  if (!up.ok) return { ...base, status: 'unknown', detail: up.reason }
  if (normalize(local) === normalize(up.data)) {
    const row = { ...base, status: 'current', detail: `identical to ${entry.repo}@HEAD` }
    return withCompleteness(row, await missingUpstream(entry, skillDir), entry.repo, path.basename(localPath))
  }
  const checkout = resolvePath(entry.checkout, manifestDir)
  let where = ''
  if (checkout && (await exists(path.join(checkout, '.git')))) {
    where = ` · local checkout: ${checkout}`
  }
  return { ...base, status: 'behind', detail: `installed copy differs from ${entry.repo}@HEAD${where}` }
}

const sha256 = async (file) => {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex')
  } catch {
    return null // unreadable or absent — counts as drift against a recorded hash
  }
}

const short = (sha) => String(sha ?? '').slice(0, 7)

/**
 * Content identity of a skill directory, for comparing the same skill across roots.
 *
 * Normalized, deliberately NOT the raw sha256 above. That one is right for a vendor manifest —
 * it hashes the bytes the vendor wrote — and wrong here: a copy that landed via a CRLF checkout
 * is the same skill, and comparing raw bytes reports a divergence that does not exist.
 */
async function skillFiles(dir) {
  const rels = []
  const walk = async (rel) => {
    let entries
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const next = rel ? path.join(rel, e.name) : e.name
      if (e.isDirectory()) await walk(next)
      else if (e.isFile()) rels.push(next)
    }
  }
  await walk('')
  if (!rels.length) return null
  const out = new Map()
  for (const rel of rels) {
    const abs = path.join(dir, rel)
    const body = await readFile(abs, 'utf8').catch(() => null)
    if (body === null) return null // unreadable file — cannot claim the copies agree
    out.set(rel.replace(/\\/g, '/'), { abs, hash: createHash('sha256').update(normalize(body)).digest('hex') })
  }
  return out
}

/**
 * Git's own object id for a file: sha1("blob <bytelength>\0" + bytes).
 *
 * Recomputing it locally lets a tree response — already fetched — settle "is this file identical
 * to upstream" with no blob download. It is a RAW-byte hash, so a CRLF working copy will not match
 * an LF blob; that is why a mismatch here is treated as "suspect, go look" rather than "differs".
 */
async function gitBlobSha(file) {
  const buf = await readFile(file).catch(() => null)
  if (!buf) return null
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

/**
 * Which relative paths are not identical across every copy — present in some and missing from
 * others, or present everywhere with differing content. Naming them is the point: "the copies
 * differ" without saying where just hands the reader the investigation.
 */
function differingPaths(maps) {
  if (maps.some((m) => !m)) return ['(unreadable copy)']
  const all = [...new Set(maps.flatMap((m) => [...m.keys()]))].sort()
  return all.filter((rel) => {
    const seen = maps.map((m) => m.get(rel)?.hash)
    return seen.some((v) => v !== seen[0])
  })
}

/** Some vendors stamp the version in prose rather than frontmatter (`skill:use-railway@1.3.7`). */
async function inlineVersionTag(skillMd, name) {
  try {
    const text = await readFile(skillMd, 'utf8')
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text.match(new RegExp(`skill:${esc}@([0-9]+(?:\\.[0-9]+)*)`))?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * A skill installed by a vendor's own CLI. There is no lock entry and often no frontmatter
 * version, so the vendor's state file is the only provenance that exists. Declare it in the
 * manifest as `state: { file, format }`.
 *
 * Observed in the wild: a vendor-CLI skill sat seven point releases behind (1.3.0 -> 1.3.7)
 * for seven weeks reading as a benign `?`, because the 2026-06-25 install wrote
 * `source_sha: null`. Nothing here can recover provenance the vendor never wrote — but once
 * it exists, refusing to read it is our bug, not theirs.
 */
async function checkCli(name, entry, skillDir, manifestDir) {
  const base = { name, class: 'cli', update: entry.update, warn: entry.warn }
  const v = (await frontmatterVersion(path.join(skillDir, 'SKILL.md'))) ?? (await inlineVersionTag(path.join(skillDir, 'SKILL.md'), name))
  const vctx = v ? ` · skill v${v}` : ''

  const stateFile = resolvePath(entry.state?.file, manifestDir)
  if (!stateFile || !(await exists(stateFile))) {
    return { ...base, status: 'unknown', detail: `${entry.note ?? 'no vendor state file recorded'}${vctx}` }
  }
  let state
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch {
    return { ...base, status: 'unknown', detail: `${stateFile} is present but unparseable${vctx}` }
  }
  const format = entry.state?.format ?? 'railway'
  if (format !== 'railway') {
    return { ...base, status: 'unknown', detail: `unsupported vendor state format '${format}'${vctx}` }
  }
  return railwayVerdict(base, name, state, stateFile, vctx)
}

/**
 * Railway's ~/.railway/skills.json. `latest_sha` is the CLI's OWN cached view of upstream,
 * refreshed when it last ran — this reads that cache, it does not query upstream. Every
 * verdict is stamped with `last_checked` so a stale state file can never read as a live
 * all-clear.
 *
 * A hash mismatch is reported as `?`, not `behind`: it cannot distinguish a local edit from a
 * partial write, which is the same reason the Railway CLI itself refuses to update ("can't
 * verify it's unmodified"). Consequence, deliberately accepted: local modification does not
 * fire the session banner, since the banner excludes provenance gaps by design.
 *
 * These are raw byte hashes, which on Windows means a CRLF-normalised copy reads as drift even
 * when the content is identical. That is correct for Railway's own manifest — it hashes what it
 * wrote — but do NOT reuse raw hashes to compare copies across roots. Comparing the same skill
 * in ~/.claude/skills (LF, curl-written) against ~/.config/opencode/skills (mixed) reports a
 * divergence that does not exist; strip \r first. Cost me a false "DIVERGED" on 2026-08-13.
 */
async function railwayVerdict(base, name, state, stateFile, vctx) {
  const asOf = state.last_checked ? ` · vendor state as of ${String(state.last_checked).slice(0, 10)}` : ''
  const { source_sha: source, latest_sha: latest } = state

  if (!source) {
    return {
      ...base,
      status: 'unknown',
      detail: `${path.basename(stateFile)} records no source_sha — installed without provenance${vctx}${asOf}`,
    }
  }

  // Verify every file the vendor says it wrote, in every root it wrote to. This doubles as the
  // divergence check: two roots carrying the same skill at different content both show up here.
  const drifted = []
  const roots = []
  for (const [root, skills] of Object.entries(state.targets ?? {})) {
    const files = skills?.[name]?.files
    if (!files) continue
    roots.push(root)
    for (const [rel, want] of Object.entries(files)) {
      if ((await sha256(path.join(root, name, rel))) !== want) drifted.push(`${root}::${rel}`)
    }
  }
  const rootCtx = roots.length ? ` · ${roots.length} root${roots.length === 1 ? '' : 's'}` : ''

  if (source !== latest) {
    return { ...base, status: 'behind', detail: `${short(source)} → ${short(latest)}${vctx}${rootCtx}${asOf}` }
  }
  if (drifted.length) {
    const sample = drifted.slice(0, 2).join(', ') + (drifted.length > 2 ? `, +${drifted.length - 2} more` : '')
    return {
      ...base,
      status: 'unknown',
      detail: `at ${short(source)} but ${drifted.length} file(s) differ from recorded hashes — local edit or partial write: ${sample}`,
    }
  }
  return { ...base, status: 'current', detail: `at ${short(source)}${vctx}${rootCtx}${asOf}` }
}

async function checkOwnCheckout(own, manifestDir) {
  const repo = resolvePath(own.repo, manifestDir)
  const sub = own.skillsSubdir ?? 'skills'
  const remote = own.remote ?? 'origin'
  const branch = own.branch ?? 'main'
  if (!(await exists(path.join(repo, '.git')))) {
    return { status: 'unknown', detail: `${repo} is not a git repo` }
  }
  if (!NO_NETWORK) await sh('git', ['-C', repo, 'fetch', '--quiet', remote, branch])
  const behind = await sh('git', ['-C', repo, 'rev-list', '--count', `HEAD..${remote}/${branch}`, '--', sub])
  const dirty = await sh('git', ['-C', repo, 'status', '--porcelain', '--', sub])
  const n = behind.ok ? Number(behind.stdout.trim()) : NaN
  const uncommitted = dirty.ok ? dirty.stdout.trim().split('\n').filter(Boolean).length : 0
  if (!Number.isFinite(n)) return { status: 'unknown', detail: behind.stderr.trim() || 'rev-list failed', uncommitted }
  return {
    status: n > 0 ? 'behind' : 'current',
    detail:
      n > 0
        ? `${n} commit${n === 1 ? '' : 's'} on ${remote}/${branch} touch ${sub}/ — run: git -C ${repo} pull`
        : `up to date with ${remote}/${branch}`,
    uncommitted,
  }
}

// ─── report ───────────────────────────────────────────────────────────────────

const MARK = { current: '✓', behind: '⚠', unknown: '?', missing: '✗' }
const rank = { behind: 0, unknown: 1, missing: 1, current: 2 }
const pad = (s, n) => String(s).padEnd(n)

function section(title, rows, out) {
  if (rows.length === 0) return
  out.push('', title)
  const w = Math.max(...rows.map((r) => r.name.length), 4)
  for (const r of [...rows].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name))) {
    out.push(`  ${MARK[r.status] ?? '?'} ${pad(r.name, w)}  ${r.detail}`)
    if (r.status === 'behind' && r.update) out.push(`    ${pad('', w)}   fix: ${r.update}`)
    if (r.status === 'behind' && r.warn) out.push(`    ${pad('', w)}   note: ${r.warn}`)
  }
}

// ─── cache + banner ───────────────────────────────────────────────────────────

const cachePathFrom = (roots, manifestDir) =>
  resolvePath(roots.cache ?? '~/.claude/.skill-check-cache.json', manifestDir)

async function readCache(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeCache(file, result) {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    const payload = { checkedAt: result.generatedAt, summary: result.summary, linkage: result.linkage }
    await writeFile(file, JSON.stringify(payload, null, 2))
  } catch {
    /* the cache is an optimisation — never fail a check because it could not be written */
  }
}

/**
 * Re-run the check in a detached process so the banner never waits on ~25 network calls.
 * The result lands in the cache and is shown at the NEXT session start.
 */
function spawnRefresh() {
  try {
    const args = [fileURLToPath(import.meta.url), '--refresh']
    const i = argv.indexOf('--manifest')
    if (i >= 0 && argv[i + 1]) args.push('--manifest', argv[i + 1])
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    /* best effort */
  }
}

/**
 * One line, or nothing at all. Only genuinely actionable states qualify: something is behind,
 * something in the repo is not linked here, or the checkout itself is stale. Provenance gaps
 * ("undeterminable", "unattributed") are real but permanent-ish, and a banner that fires on a
 * healthy machine every single session is a banner that gets ignored.
 */
function bannerLine(cache) {
  const s = cache?.summary
  if (!s) return null
  const bits = []
  if (s.behind) bits.push(`${s.behind} behind upstream`)
  if (s.unlinked) bits.push(`${s.unlinked} in the repo but not linked here`)
  if (s.checkoutBehind) bits.push('skills checkout behind origin')
  if (!bits.length) return null
  return `⚠ Skills: ${bits.join(', ')} — run /check-skills  (checked ${String(cache.checkedAt).slice(0, 10)})`
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function collect() {
  const manifestPath = path.resolve(opt('--manifest', path.join(HERE, '..', 'skills', 'skills-sources.json')))
  const manifestDir = path.dirname(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const entries = manifest.skills ?? {}
  const roots = manifest.roots ?? {}

  TOKEN = await resolveToken()
  gh = makeGh({ token: TOKEN, disabled: NO_NETWORK, userAgent: 'check-skills' })

  const ownRepoDir = resolvePath(roots.own?.repo ?? '..', manifestDir)
  const ownSkillsDir = path.join(ownRepoDir, roots.own?.skillsSubdir ?? 'skills')
  const activeDir = resolvePath(roots.active, manifestDir)
  const agentsLock = resolvePath(roots.agentsLock, manifestDir)
  const agentsSkillsDir = resolvePath(roots.agentsSkills, manifestDir)

  // Vendor CLIs fan out across every agent root they can detect (.agents, .factory,
  // .config/opencode, …), so a root we do not scan is a copy that can drift unseen — #63.
  const extraRoots = (roots.extraSkills ?? []).map((r) => resolvePath(r, manifestDir)).filter(Boolean)

  const [ownSkills, active, agentsOnDisk, ownCheckout, extraOnDisk] = await Promise.all([
    realSkills(ownSkillsDir),
    inspectSkillsDir(activeDir),
    agentsSkillsDir ? realSkills(agentsSkillsDir) : [],
    checkOwnCheckout(roots.own ?? {}, manifestDir),
    Promise.all(extraRoots.map(async (root) => ({ root, names: await realSkills(root) }))),
  ])

  const activeByName = new Map(active.map((a) => [a.name, a]))

  // Vendored skills live inside the own-repo skills dir.
  const vendoredNames = Object.entries(entries).filter(([, e]) => e.class === 'vendored')
  const vendored = await pool(vendoredNames, 5, ([name, e]) =>
    checkVendored(name, e, path.join(ownSkillsDir, name)),
  )

  // Locally installed skills (real dirs in the active dir), by declared class.
  const activeInstalled = []
  for (const [name, e] of Object.entries(entries)) {
    if (e.location !== 'active') continue
    const dir = path.join(activeDir, name)
    if (!(await exists(dir))) {
      activeInstalled.push({ name, class: e.class, status: 'missing', detail: 'declared in manifest but not installed' })
      continue
    }
    if (e.class === 'npm') activeInstalled.push(await checkNpm(name, e, dir))
    else if (e.class === 'git-repo') activeInstalled.push(await checkGitRepoSkill(name, e, dir, manifestDir))
    else if (e.class === 'cli') activeInstalled.push(await checkCli(name, e, dir, manifestDir))
    else {
      const v = await frontmatterVersion(path.join(dir, 'SKILL.md'))
      activeInstalled.push({
        name,
        class: e.class,
        status: 'unknown',
        detail: `${e.note ?? 'no version signal'}${v ? ` (frontmatter v${v})` : ''}`,
        update: e.update,
      })
    }
  }

  const cliManaged = agentsLock ? await checkAgentsLock(agentsLock, agentsSkillsDir) : []

  // Linkage gaps — the class of drift no upstream check can see.
  const notLinked = ownSkills.filter((n) => !activeByName.has(n))
  const declared = new Set(Object.keys(entries))
  const lockNames = new Set(cliManaged.map((r) => r.name))
  const unaccounted = active
    .filter((a) => !a.linked && !declared.has(a.name) && !lockNames.has(a.name))
    .map((a) => a.name)
  // Same skill name, real directory (not a junction), in more than one root — usually a vendor CLI
  // fanning out across every agent tool it detects (`railway setup agent` writes four).
  //
  // NOT a load-order contest: Claude Code reads the active dir only, and .agents / .factory /
  // .config/opencode belong to other harnesses. The real risk is drift — update one copy and the
  // rest silently stay behind. So compare content and only raise a warning when they actually
  // disagree; copies that agree are a drift SURFACE worth listing, not a problem to fix.
  const rootsByName = new Map()
  const noteRoot = (root, names) => {
    for (const n of names) rootsByName.set(n, [...(rootsByName.get(n) ?? []), root])
  }
  noteRoot(activeDir, active.filter((a) => !a.linked).map((a) => a.name))
  if (agentsSkillsDir) noteRoot(agentsSkillsDir, agentsOnDisk)
  for (const { root, names } of extraOnDisk) noteRoot(root, names)
  const duplicated = await pool([...rootsByName].filter(([, rs]) => rs.length > 1), 4, async ([name, rs]) => {
    const differs = differingPaths(await pool(rs, 4, (r) => skillFiles(path.join(r, name))))
    return { name, roots: rs, agree: differs.length === 0, differs }
  })
  // Real in some other harness's root (.agents, .factory, .config/opencode, …) and absent from the
  // active dir entirely — so Claude Code never loads it. Not drift and not a duplicate: a skill
  // installed for a different tool only. Invisible to every other check here, because they all
  // start from either the repo or the active dir. `llm-wiki` (opencode-only) was the first case.
  const elsewhereRoots = [
    ...(agentsSkillsDir ? [{ root: agentsSkillsDir, names: agentsOnDisk }] : []),
    ...extraOnDisk,
  ]
  const elsewhereByName = new Map()
  for (const { root, names } of elsewhereRoots) {
    for (const n of names) {
      if (activeByName.has(n)) continue
      elsewhereByName.set(n, [...(elsewhereByName.get(n) ?? []), root])
    }
  }
  const elsewhereOnly = [...elsewhereByName].map(([name, rs]) => ({ name, roots: rs }))

  const rows = [...vendored, ...cliManaged, ...activeInstalled]
  const summary = {
    behind: rows.filter((r) => r.status === 'behind').length,
    undeterminable: rows.filter((r) => r.status === 'unknown').length,
    unlinked: notLinked.length,
    unattributed: unaccounted.length,
    checkoutBehind: ownCheckout.status === 'behind',
  }

  const result = {
    generatedAt: new Date().toISOString(),
    authenticated: Boolean(TOKEN),
    summary,
    ownCheckout,
    vendored,
    cliManaged,
    activeInstalled,
    linkage: {
      notLinked,
      unaccounted,
      duplicated,
      elsewhereOnly,
      activeCount: active.length,
      repoCount: ownSkills.length,
    },
    marketplace: manifest.marketplace ?? null,
  }

  return {
    result,
    ctx: { manifest, manifestPath, manifestDir, roots, ownRepoDir, ownSkillsDir, activeDir, agentsSkillsDir, agentsLock },
  }
}

function render(result, ctx) {
  const { manifest, manifestPath, roots, ownRepoDir, ownSkillsDir, activeDir, agentsLock } = ctx
  const { ownCheckout, vendored, cliManaged, activeInstalled, summary } = result
  const { notLinked, unaccounted, duplicated, elsewhereOnly = [] } = result.linkage

  // Local date, not the ISO/UTC one — a UTC header reads as yesterday for most of a CET evening.
  const today = new Date().toLocaleDateString('sv-SE')
  const out = [`Skills check — ${today}${result.authenticated ? '' : '  (unauthenticated GitHub — 60 req/hr)'}`]

  out.push('', `OWN CHECKOUT — ${ownRepoDir}`)
  out.push(`  ${MARK[ownCheckout.status] ?? '?'} ${ownCheckout.detail}`)
  if (ownCheckout.uncommitted > 0) {
    out.push(`  ⚠ ${ownCheckout.uncommitted} uncommitted change(s) under ${roots.own?.skillsSubdir ?? 'skills'}/`)
  }

  section(`VENDORED BY HAND — pinned copy vs upstream`, vendored, out)
  section(`CLI-MANAGED — ${agentsLock ?? '(no lock configured)'}`, cliManaged, out)
  section('INSTALLED LOCALLY — npm / git-repo / vendor CLI', activeInstalled, out)

  out.push('', 'LINKAGE')
  out.push(`  ${result.linkage.repoCount} skills in repo · ${result.linkage.activeCount} active in ${activeDir}`)
  if (notLinked.length) {
    out.push(`  ⚠ in repo but NOT active (never linked on this machine): ${notLinked.join(', ')}`)
    out.push(`    fix (Windows): New-Item -ItemType Junction -Path "${path.join(activeDir, '<name>')}" -Target "${path.join(ownSkillsDir, '<name>')}"`)
    out.push(`    fix (POSIX):   ln -s "${path.join(ownSkillsDir, '<name>')}" "${path.join(activeDir, '<name>')}"`)
  }
  if (unaccounted.length) {
    out.push(`  ? active with no recorded provenance: ${unaccounted.join(', ')}`)
    out.push(`    fix: add an entry to ${path.relative(ownRepoDir, manifestPath).replace(/\\/g, '/')}`)
  }
  const diverged = duplicated.filter((d) => !d.agree)
  const agreeing = duplicated.filter((d) => d.agree)
  if (diverged.length) {
    out.push('  ⚠ separate copies in more than one root, and their contents differ:')
    for (const d of diverged) {
      const shown = d.differs.slice(0, 4).join(', ')
      const more = d.differs.length > 4 ? ` (+${d.differs.length - 4} more)` : ''
      out.push(`    ${d.name} — differs in: ${shown}${more}`)
      out.push(`      ${d.roots.join(', ')}`)
    }
    out.push(`    fix: re-install from the source of truth, or junction the others at one copy`)
  }
  // One line, not three. These copies agree, and only the active dir is loaded, so there is
  // nothing to do about them — but they stay visible, because they are the drift surface that
  // makes the ⚠ above possible. A line that repeats an explanation every run is one you skip.
  if (agreeing.length) {
    const names = agreeing.map((d) => d.name).join(', ')
    out.push(`  ? also copied, contents agree, in roots Claude Code does not load: ${names}`)
  }
  if (elsewhereOnly.length) {
    out.push(`  ? installed for another agent tool only — Claude Code never loads these:`)
    for (const e of elsewhereOnly) out.push(`    ${e.name} — ${e.roots.join(', ')}`)
    out.push(`    fix (only if you want it here): install or link it into ${activeDir}`)
  }
  if (!notLinked.length && !unaccounted.length && !duplicated.length && !elsewhereOnly.length) {
    out.push('  ✓ every skill is linked and accounted for')
  }

  if (manifest.marketplace) out.push('', `MARKETPLACE — ${manifest.marketplace.note}`)

  out.push(
    '',
    `SUMMARY: ${summary.behind} behind · ${summary.undeterminable} undeterminable · ${summary.unlinked} unlinked · ${summary.unattributed} unattributed`,
  )
  out.push('This command changes nothing. Run the per-row fix commands yourself.')
  return out.join('\n')
}

async function main() {
  const manifestPath = path.resolve(opt('--manifest', path.join(HERE, '..', 'skills', 'skills-sources.json')))
  if (!(await exists(manifestPath))) {
    if (BANNER) return // a missing manifest must never break session start
    console.error(`check-skills: manifest not found at ${manifestPath}`)
    process.exit(2)
  }

  // Banner path: cache only. No network, no git, no npm — session start must not wait on I/O
  // it cannot bound. If the cache is stale we kick off a detached refresh whose result shows
  // up next session, and still print whatever the last known state was.
  if (BANNER) {
    const roots = JSON.parse(await readFile(manifestPath, 'utf8')).roots ?? {}
    const cache = await readCache(cachePathFrom(roots, path.dirname(manifestPath)))
    const ageMs = cache?.checkedAt ? Date.now() - Date.parse(cache.checkedAt) : Infinity
    if (ageMs > (roots.cacheTtlHours ?? 24) * 3600_000) spawnRefresh()
    const line = bannerLine(cache)
    if (!line) return // nothing actionable — emit nothing at all

    // A SessionStart hook's plain stdout goes to CLAUDE'S CONTEXT, not to the user's screen
    // (docs: "stdout is added as context that Claude can see and act on"). `systemMessage` is
    // the only documented field that surfaces text to the user, so the banner must be JSON.
    // Printing the line as plain text made it invisible to the person it was written for.
    console.log(
      JSON.stringify({
        systemMessage: line,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `Skill staleness detected at session start: ${line}`,
        },
      }),
    )
    return
  }

  const { result, ctx } = await collect()
  await writeCache(cachePathFrom(ctx.roots, ctx.manifestDir), result)
  if (REFRESH) return
  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(render(result, ctx))
}

// Only run as a CLI. Without this guard, importing anything from here for a test would execute
// the whole report — network calls, cache write and all.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  main().catch((err) => {
    if (BANNER) process.exit(0) // a cosmetic banner must never break session start
    console.error(`check-skills: ${err.stack ?? err.message}`)
    process.exit(1)
  })
}

// Test surface. `setGh` swaps the GitHub caller so the completeness logic can be exercised with a
// synthetic tree and no network — see scripts/tests/check-skills-completeness.test.mjs.
export { missingUpstream, withCompleteness, differingPaths, skillFiles, gitBlobSha, repoTree }
export const setGh = (fake) => {
  gh = fake
  treeCache.clear()
}
