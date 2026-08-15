#!/usr/bin/env node
/**
 * Case table for the completeness check in scripts/check-skills.mjs.
 *
 * Run: node scripts/tests/check-skills-completeness.test.mjs
 *
 * Fully offline. The GitHub caller is stubbed with a synthetic tree, fixtures are built in a temp
 * dir beside this file and removed afterwards, and no token is needed.
 *
 * Exists because this check spent its whole life reporting a green tick while comparing ONE file.
 * A git-repo skill was a reference file short of upstream for months behind "identical to
 * <repo>@HEAD", and a forked skill was missing 40% of its upstream —
 * including every do-not-invent guardrail — while reporting reconciled. A checker that cannot fail
 * is indistinguishable from one that passes, so every row here is a way it must still fail.
 *
 * Three rows guard bugs introduced while FIXING the original one, on 2026-08-15:
 *
 * - CRLF: comparing raw bytes flags a Windows checkout as drift. Cost a false "DIVERGED" once
 *   already, which is why normalize() is the authority and a sha mismatch is only a suspicion.
 * - CASE: rjs/shaping-skills names a skill's file lowercase `skill.md` where the install must be
 *   `SKILL.md`. Matching case-sensitively invented two missing files with total confidence.
 * - FOLDER TREE: when the ref is a folder's tree sha, blob paths are folder-relative, so fetching
 *   by path+ref 404s. The fetch loop's `continue` then turned that into a clean bill of health for
 *   an edited file — the original bug, reintroduced inside its own fix. Blobs are fetched by
 *   object id now, which needs neither path nor ref.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mod = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'check-skills.mjs')).href)
const { missingUpstream, withCompleteness, setGh } = mod

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) return console.log(`  ok   ${name}`)
  failures++
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
}

const blobSha = (text) => {
  const buf = Buffer.from(text, 'utf8')
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

/** A stub GitHub caller serving one tree and its blobs, with no network. */
function stubGh(files, { folderRelative = false } = {}) {
  const blobs = new Map()
  const tree = Object.entries(files).map(([p, text]) => {
    const sha = blobSha(text)
    blobs.set(sha, text)
    return { type: 'blob', path: folderRelative ? p.split('/').slice(2).join('/') : p, sha }
  })
  const fake = async (url) => {
    if (url.includes('/git/trees/')) return { ok: true, data: { tree } }
    const m = url.match(/\/git\/blobs\/([0-9a-f]+)/)
    if (m && blobs.has(m[1])) {
      return { ok: true, data: { encoding: 'base64', content: Buffer.from(blobs.get(m[1]), 'utf8').toString('base64') } }
    }
    return { ok: false, reason: 'HTTP 404' }
  }
  fake.file = async () => ({ ok: false, reason: 'HTTP 404' }) // path+ref form must never be needed
  setGh(fake)
}

const SKILL = '---\nname: demo\n---\n\n# Demo\n\n- one\n- two\n'
const REF = '## Reference\n\n- alpha\n- beta\n'
const UPSTREAM = { 'skills/demo/SKILL.md': SKILL, 'skills/demo/reference/r.md': REF }

const root = await mkdtemp(path.join(tmpdir(), 'check-skills-test-'))
const entry = { repo: 'owner/repo', path: 'skills/demo/SKILL.md' }

async function fixture(name, files) {
  const dir = path.join(root, name)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.join(dir, path.dirname(rel)), { recursive: true })
    await writeFile(path.join(dir, rel), text)
  }
  return dir
}

try {
  console.log('completeness check')

  stubGh(UPSTREAM)

  const intact = await fixture('intact', { 'SKILL.md': SKILL, 'reference/r.md': REF })
  let g = await missingUpstream(entry, intact)
  check('intact install reports no gap', g.checked && !g.missing.length && !g.modified.length, JSON.stringify(g))

  const deleted = await fixture('deleted', { 'SKILL.md': SKILL })
  g = await missingUpstream(entry, deleted)
  check('deleted file is reported missing', g.missing.join() === 'reference/r.md', JSON.stringify(g))

  const edited = await fixture('edited', { 'SKILL.md': SKILL, 'reference/r.md': REF + '\nLOCAL EDIT\n' })
  g = await missingUpstream(entry, edited)
  check('edited file is reported modified', g.modified.join() === 'reference/r.md', JSON.stringify(g))

  // A CRLF working copy has a different blob sha for every file. Only normalize() may decide.
  const crlf = await fixture('crlf', {
    'SKILL.md': SKILL.replace(/\n/g, '\r\n'),
    'reference/r.md': REF.replace(/\n/g, '\r\n'),
  })
  g = await missingUpstream(entry, crlf)
  check('CRLF-only copy is NOT flagged', !g.missing.length && !g.modified.length, JSON.stringify(g))

  // Upstream may name it `skill.md` where the install must be `SKILL.md`.
  stubGh({ 'skills/demo/skill.md': SKILL })
  const cased = await fixture('cased', { 'SKILL.md': SKILL })
  g = await missingUpstream({ repo: 'owner/repo', path: 'skills/demo/skill.md' }, cased)
  check('case-different filename is not "missing"', !g.missing.length, JSON.stringify(g))

  // folderTree: ref is the folder's own tree, so paths arrive folder-relative and there is no
  // repo-root path to fetch by. An edit must still be caught.
  stubGh(UPSTREAM, { folderRelative: true })
  const folderEdit = await fixture('folder-edit', { 'SKILL.md': SKILL + '\nEDIT\n', 'reference/r.md': REF })
  g = await missingUpstream(entry, folderEdit, { folderTree: true })
  check('folderTree mode still catches an edit', g.modified.join() === 'SKILL.md', JSON.stringify(g))

  // presenceOnly is for forks, whose text is rewritten on purpose.
  stubGh(UPSTREAM)
  g = await missingUpstream(entry, edited, { presenceOnly: true })
  check('presenceOnly ignores content', !g.modified.length && !g.missing.length, JSON.stringify(g))

  // An entry with `compare` keeps a deliberately divergent local file; only its presence counts.
  const deliberate = await fixture('deliberate', { 'SKILL.md': SKILL + '\nREWRITTEN\n', 'reference/r.md': REF })
  g = await missingUpstream({ ...entry, compare: 'SKILL.upstream.md' }, deliberate)
  check('`compare` file is exempt from content diff', !g.modified.length, JSON.stringify(g))

  // forkOmits records a deliberate non-carry and must silence only what it names.
  g = await missingUpstream({ ...entry, forkOmits: ['reference/'] }, deleted)
  check('forkOmits silences the paths it names', !g.missing.length, JSON.stringify(g))

  console.log('\nmessage shape')

  const row = { status: 'current', detail: 'unchanged upstream since install' }
  const msg = withCompleteness(row, { checked: true, missing: [], modified: ['SKILL.md'] }, 'owner/repo', 'SKILL.md', 'upstream unchanged since install').detail
  check('caller-supplied scope is used', msg.startsWith('upstream unchanged since install,'), msg)
  check('message does not contradict itself', !/SKILL\.md matches .* content differs: SKILL\.md/.test(msg), msg)

  const undeclared = withCompleteness(row, { checked: false }, 'owner/repo', 'SKILL.md').detail
  check('unverifiable install says so', undeclared.includes('install set not declared'), undeclared)

  const clean = withCompleteness(row, { checked: true, missing: [], modified: [] }, 'owner/repo', 'SKILL.md')
  check('clean gap leaves the row untouched', clean.detail === row.detail && clean.status === 'current')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
