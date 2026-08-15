#!/usr/bin/env node
/**
 * vendor-skill.mjs — vendor an external skill and record where it came from, in one step.
 *
 * This exists because provenance gets lost exactly when vendoring is manual. `improve` was
 * copied in from a shadcn source nobody wrote down, so it can never be diffed against upstream;
 * `writing-prose` lost its pin the same way. Every skill this command brings in is pinned to a
 * commit SHA and recorded in the manifest at the moment it arrives.
 *
 * Usage:
 *   node vendor-skill.mjs <owner/repo> <upstream-path> [--as <name>] [--ref <sha|branch>]
 *                         [--derivative] [--no-link] [--force] [--dry-run]
 *   node vendor-skill.mjs --update <name> [--dry-run]     # re-pull an existing entry, re-pin it
 *
 *   <upstream-path> is a directory (pulls the tree) or a single file (pulls just that file).
 *
 * Examples:
 *   node vendor-skill.mjs rjs/shaping-skills shaping
 *   node vendor-skill.mjs BayramAnnakov/team-os-toolkit .claude/skills/init-team-os
 *   node vendor-skill.mjs --update shaping
 *
 * Companion to check-skills.mjs: records provenance at vendoring time so it can be verified later.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { exists, resolvePath, resolveToken, makeGh, pool, linkSkill, isLink } from './lib/skills-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const DRY = flag('--dry-run')
const FORCE = flag('--force')
const NO_LINK = flag('--no-link')
const DERIVATIVE = flag('--derivative')
const UPDATE = opt('--update', null)

/** Pointing at a repo root by mistake should fail loudly, not vendor 400 files. */
const MAX_FILES = 60

const die = (msg) => {
  console.error(`vendor-skill: ${msg}`)
  process.exit(1)
}

function usage() {
  console.log(
    [
      'Usage:',
      '  node vendor-skill.mjs <owner/repo> <upstream-path> [--as <name>] [--ref <sha|branch>]',
      '                        [--derivative] [--no-link] [--force] [--dry-run]',
      '  node vendor-skill.mjs --update <name> [--dry-run]',
      '',
      '  <upstream-path>  a directory (pulls the tree) or a single file (pulls just that file)',
      '  --derivative     you intend to rewrite it; records syncedUpstreamVersion instead of',
      '                   expecting the content to keep matching upstream',
    ].join('\n'),
  )
}

// ─── upstream ─────────────────────────────────────────────────────────────────

async function repoMeta(gh, repo) {
  const r = await gh(`repos/${repo}`)
  if (!r.ok) die(`cannot read ${repo}: ${r.reason}`)
  return { defaultBranch: r.data.default_branch, license: r.data.license?.spdx_id ?? null }
}

async function resolveRef(gh, repo, ref) {
  const r = await gh(`repos/${repo}/commits/${encodeURIComponent(ref)}`)
  if (!r.ok) die(`cannot resolve ref "${ref}" in ${repo}: ${r.reason}`)
  return { sha: r.data.sha, date: r.data.commit?.committer?.date ?? null }
}

const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING', 'COPYING.md']
const isLicense = (p) => LICENSE_NAMES.includes(path.posix.basename(p))

/**
 * Blobs at `sha` under `upstreamPath`, as {path, relative, blobSha}. Handles file or directory.
 * Also returns the repo-root blobs, because MIT/BSD/Apache all require the licence text to travel
 * with the copy and it usually lives at the root rather than inside the skill directory.
 */
async function listFiles(gh, repo, sha, upstreamPath) {
  const r = await gh(`repos/${repo}/git/trees/${sha}?recursive=1`)
  if (!r.ok) die(`cannot read tree of ${repo}@${sha.slice(0, 7)}: ${r.reason}`)
  const clean = upstreamPath.replace(/^\/+|\/+$/g, '')
  const blobs = r.data.tree.filter((e) => e.type === 'blob')
  const rootBlobs = blobs.filter((e) => !e.path.includes('/'))

  const asFile = blobs.find((e) => e.path === clean)
  if (asFile) {
    return { files: [{ path: asFile.path, relative: path.basename(asFile.path), blobSha: asFile.sha }], rootBlobs }
  }

  const prefix = clean === '' ? '' : `${clean}/`
  const under = blobs.filter((e) => e.path.startsWith(prefix))
  if (under.length === 0) die(`nothing found at "${upstreamPath}" in ${repo}@${sha.slice(0, 7)}`)
  return { files: under.map((e) => ({ path: e.path, relative: e.path.slice(prefix.length), blobSha: e.sha })), rootBlobs }
}

/** Blob API returns base64, so this is binary-safe — a skill may ship images or archives. */
async function fetchBlob(gh, repo, file) {
  const r = await gh(`repos/${repo}/git/blobs/${file.blobSha}`)
  if (r.ok && r.data.encoding === 'base64') return Buffer.from(r.data.content, 'base64')
  const raw = await gh.file(repo, file.path)
  if (!raw.ok) die(`cannot fetch ${file.path}: ${raw.reason}`)
  return Buffer.from(raw.data, 'utf8')
}

const versionOf = (text) => {
  const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return (fm ? fm[1] : '').match(/^\s*version:\s*["']?([^"'\s]+)/m)?.[1] ?? null
}

// ─── manifest + notice ────────────────────────────────────────────────────────

async function loadManifest(manifestPath) {
  if (!(await exists(manifestPath))) die(`manifest not found at ${manifestPath}`)
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

function noticeBody({ name, repo, sha, date, license, derivative }) {
  return [
    `# ${name} — attribution`,
    '',
    `Vendored from:`,
    '',
    `- **Repo:** https://github.com/${repo}`,
    `- **Commit:** ${sha}`,
    `- **Retrieved:** ${new Date().toLocaleDateString('sv-SE')}`,
    `- **Upstream committed:** ${date ?? 'unknown'}`,
    `- **License:** ${license ?? 'NOT DETECTED — check the upstream repo before redistributing'}`,
    '',
    derivative
      ? 'Recorded as a **derivative**: this copy is expected to diverge, so it is tracked by upstream *version* rather than by content. Bump `syncedUpstreamVersion` in `skills-sources.json` whenever you reconcile it against a newer upstream.'
      : 'Kept **byte-identical** to upstream so it diffs cleanly against future patches. Put local guidance in a README beside it, never inside the vendored files — `/check-skills` compares content and local edits will show up as drift.',
    '',
    'Re-pull with:',
    '',
    '```bash',
    `node scripts/vendor-skill.mjs --update ${name}`,
    '```',
    '',
  ].join('\n')
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (flag('--help') || flag('-h') || (!UPDATE && argv.filter((a) => !a.startsWith('-')).length < 2)) {
    usage()
    process.exit(UPDATE || argv.length ? 1 : 0)
  }

  const manifestPath = path.resolve(opt('--manifest', path.join(HERE, '..', 'skills', 'skills-sources.json')))
  const manifestDir = path.dirname(manifestPath)
  const manifest = await loadManifest(manifestPath)
  const roots = manifest.roots ?? {}

  const ownRepoDir = resolvePath(roots.own?.repo ?? '..', manifestDir)
  const skillsDir = path.join(ownRepoDir, roots.own?.skillsSubdir ?? 'skills')
  const activeDir = resolvePath(roots.active, manifestDir)

  // Positional args, ignoring flags and their values.
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('-')) {
      if (['--as', '--ref', '--manifest', '--update'].includes(argv[i])) i++
      continue
    }
    positional.push(argv[i])
  }

  let repo, upstreamPath, name, derivative
  if (UPDATE) {
    const entry = manifest.skills?.[UPDATE]
    if (!entry) die(`no manifest entry named "${UPDATE}"`)
    if (!entry.repo || !entry.path) {
      die(`"${UPDATE}" has no recorded repo/path — it cannot be updated automatically. Re-vendor it explicitly:\n  node vendor-skill.mjs <owner/repo> <upstream-path> --as ${UPDATE} --force`)
    }
    name = UPDATE
    repo = entry.repo
    // The manifest records the SKILL.md; re-pull the directory that contains it.
    upstreamPath = entry.path.includes('/') ? path.posix.dirname(entry.path) : entry.path
    derivative = Boolean(entry.derivative)
  } else {
    ;[repo, upstreamPath] = positional
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) die(`"${repo}" is not an owner/repo`)
    name = opt('--as', path.basename(upstreamPath.replace(/\/+$/, ''), '.md'))
    if (name === 'SKILL') die('cannot infer a name from a bare SKILL.md — pass --as <name>')
    derivative = DERIVATIVE
  }

  const target = path.join(skillsDir, name)
  const isNew = !(await exists(target))
  if (!isNew && !UPDATE && !FORCE) {
    die(`${target} already exists. Use --update ${name} to re-pull it, or --force to overwrite.`)
  }

  const token = await resolveToken()
  const gh = makeGh({ token, userAgent: 'vendor-skill' })

  const meta = await repoMeta(gh, repo)
  const { sha, date } = await resolveRef(gh, repo, opt('--ref', meta.defaultBranch))
  const { files, rootBlobs } = await listFiles(gh, repo, sha, upstreamPath)

  // The licence has to come along. If the skill's own tree does not carry one, take the repo-root
  // file — dropping it would break the attribution clause every permissive licence has.
  const rootLicense = files.some((f) => isLicense(f.relative)) ? null : rootBlobs.find((e) => isLicense(e.path))
  if (rootLicense) files.push({ path: rootLicense.path, relative: path.basename(rootLicense.path), blobSha: rootLicense.sha })

  if (files.length > MAX_FILES) {
    die(`${files.length} files under "${upstreamPath}" (limit ${MAX_FILES}). That usually means the path is too broad — point at the skill's own directory.`)
  }

  const existing = manifest.skills?.[name]
  if (UPDATE && existing?.ref === sha) {
    console.log(`${name}: already at ${repo}@${sha.slice(0, 7)} — nothing to do.`)
    return
  }

  const skillFile = files.find((f) => f.relative === 'SKILL.md') ?? files.find((f) => f.relative.endsWith('SKILL.md'))
  if (!skillFile) die(`no SKILL.md under "${upstreamPath}" — that is not a skill directory`)
  const manifestFilePath = skillFile.path // the true upstream path, whatever else got pulled alongside

  if (DRY) {
    console.log(
      [
        `DRY RUN — nothing written.`,
        `  skill      ${name}${derivative ? '  (derivative)' : ''}`,
        `  from       ${repo}@${sha.slice(0, 7)}  (${meta.license ?? 'license not detected'})`,
        `  path       ${upstreamPath}`,
        `  files      ${files.length}: ${files.map((f) => f.relative).join(', ')}`,
        ...(rootLicense ? [`  license    pulling ${rootLicense.path} from the repo root alongside the skill`] : []),
        `  writes     ${target}`,
        `             ${path.join(skillsDir, `NOTICE-${name}.md`)}`,
        `             ${manifestPath}  (skills.${name})`,
        NO_LINK ? `  link       skipped (--no-link)` : `  link       ${path.join(activeDir, name)} -> ${target}`,
      ].join('\n'),
    )
    return
  }

  // Replace the tree rather than merging, so a file deleted upstream does not linger locally.
  if (!isNew) await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  const contents = await pool(files, 5, (f) => fetchBlob(gh, repo, f))
  for (const [i, f] of files.entries()) {
    const dest = path.join(target, f.relative)
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest, contents[i])
  }

  const skillText = contents[files.indexOf(skillFile)].toString('utf8')
  const upstreamVersion = versionOf(skillText)

  manifest.skills ??= {}
  manifest.skills[name] = {
    class: 'vendored',
    ...(derivative ? { derivative: true } : {}),
    repo,
    path: manifestFilePath,
    ...(derivative ? {} : { ref: sha }),
    ...(derivative && upstreamVersion ? { syncedUpstreamVersion: upstreamVersion } : {}),
    ...(meta.license ? { license: meta.license } : {}),
    ...(existing?.note ? { note: existing.note } : {}),
    update: `node scripts/vendor-skill.mjs --update ${name}`,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const noticePath = path.join(skillsDir, `NOTICE-${name}.md`)
  await writeFile(noticePath, noticeBody({ name, repo, sha, date, license: meta.license, derivative }))

  let linkNote = 'skipped (--no-link)'
  if (!NO_LINK) {
    const linkPath = path.join(activeDir, name)
    if (await exists(linkPath)) {
      linkNote = (await isLink(linkPath)) ? 'already linked' : `NOT linked — ${linkPath} is a real directory, remove it first`
    } else {
      await linkSkill(target, linkPath)
      linkNote = `linked -> ${linkPath}`
    }
  }

  console.log(
    [
      `${isNew ? 'Vendored' : 'Updated'} ${name} from ${repo}@${sha.slice(0, 7)}`,
      `  ${files.length} file(s), license ${meta.license ?? 'NOT DETECTED'}${upstreamVersion ? `, upstream v${upstreamVersion}` : ''}`,
      `  provenance recorded in ${path.basename(manifestPath)}, attribution in ${path.basename(noticePath)}`,
      `  ${linkNote}`,
      '',
      `Run /check-skills to confirm it reads as current.`,
    ].join('\n'),
  )
}

main().catch((err) => {
  console.error(`vendor-skill: ${err.stack ?? err.message}`)
  process.exit(1)
})
