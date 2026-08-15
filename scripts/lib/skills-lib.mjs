/**
 * Shared helpers for the skills tooling — check-skills.mjs and vendor-skill.mjs.
 *
 * Zero dependencies, Node >= 18 (needs global fetch). Kept deliberately small: everything here
 * is used by both scripts, and anything used by only one belongs in that script.
 *
 * Shared helpers for check-skills.mjs and vendor-skill.mjs.
 */

import { access, symlink, lstat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

// ─── process + filesystem ─────────────────────────────────────────────────────

export async function sh(cmd, args = [], options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...options,
    })
    return { ok: true, stdout: String(stdout), stderr: String(stderr) }
  } catch (err) {
    return { ok: false, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message) }
  }
}

export const exists = (p) => access(p).then(() => true, () => false)

/** Resolve a manifest path value: `~` → home, absolute stays, else relative to the manifest dir. */
export function resolvePath(value, baseDir) {
  if (!value) return null
  if (value.startsWith('~')) return path.join(os.homedir(), value.slice(1).replace(/^[/\\]/, ''))
  return path.resolve(baseDir, value)
}

/** Ignore line-ending and trailing-whitespace churn so a CRLF checkout does not read as "behind". */
export const normalize = (text) =>
  String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()

/**
 * Link a skill into the active skills dir.
 * On Windows this MUST be a junction: a plain symlink needs admin or Developer Mode, and the
 * failure mode is a silently-copied directory that then drifts. See reference_claude_config_commands_junction.
 */
export async function linkSkill(targetDir, linkPath) {
  await symlink(path.resolve(targetDir), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

/** True if the path exists and is a link (junction or symlink), rather than a real directory. */
export async function isLink(p) {
  try {
    return (await lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}

/** Run `worker` over `items` with bounded concurrency — the GitHub API dislikes 25 at once. */
export async function pool(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

/** $GH_TOKEN, then $GITHUB_TOKEN, then the gh CLI. null means unauthenticated (60 req/hr). */
export async function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const r = await sh('gh', ['auth', 'token'])
  return r.ok ? r.stdout.trim() : null
}

/**
 * Build a GitHub API caller. Returns `{ok:true, data}` or `{ok:false, status, reason}` — it never
 * throws, because both callers want to degrade to "undeterminable" rather than die.
 */
export function makeGh({ token = null, disabled = false, userAgent = 'claude-skills-tooling' } = {}) {
  const gh = async (pathname, { raw = false, accept } = {}) => {
    if (disabled) return { ok: false, status: 0, reason: 'network disabled (--no-network)' }
    const headers = {
      'User-Agent': userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
      Accept: accept ?? (raw ? 'application/vnd.github.raw' : 'application/vnd.github+json'),
    }
    if (token) headers.Authorization = `Bearer ${token}`
    let res
    try {
      res = await fetch(`https://api.github.com/${pathname}`, { headers })
    } catch (err) {
      return { ok: false, status: 0, reason: err.message }
    }
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining')
      const reason =
        res.status === 403 && remaining === '0'
          ? 'GitHub rate limit exhausted — set GH_TOKEN or run `gh auth login`'
          : `HTTP ${res.status}`
      return { ok: false, status: res.status, reason }
    }
    return { ok: true, data: raw ? await res.text() : await res.json() }
  }

  /** Raw text of one file, optionally at a specific ref. */
  gh.file = (repo, filePath, ref) =>
    gh(`repos/${repo}/contents/${encodeURI(filePath)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, { raw: true })

  return gh
}
