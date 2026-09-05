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
 * The skill roots a vendor CLI fans one install out to. `npx impeccable update` writes ten of
 * these in a single run; `railway setup agent` writes four.
 */
export const PROVIDER_SKILL_ROOTS = [
  '.claude', '.agents', '.hermes', '.kiro', '.pi/agent', '.qoder',
  '.trae', '.trae-cn', '.rovodev', '.vibe', '.factory', '.config/opencode',
]

/**
 * Neutralise the per-provider templating a vendor applies while installing the SAME skill version
 * into each agent tool's root, so a cross-root compare reports real drift rather than the rewrite.
 *
 * Two substitutions, both measured on impeccable v4.2.0 (2026-09-05), where they accounted for 19
 * of the 32 differing files: the install path (`.claude/skills/…` vs `.agents/skills/…`), and the
 * invocation prefix, which is `/verb` on a host with slash commands and `$verb` on one without.
 *
 * It deliberately does NOT try to neutralise everything. The same install also carries
 * harness-specific PROSE — the `.agents` copy of impeccable's `critique.md` explains Codex's
 * sub-agent permission gate, which is meaningless to Claude Code and absent from its copy. No
 * rewrite rule reaches that; `providerTemplated` in the manifest is what declares it expected.
 */
export const normalizeProviderTemplating = (text, skillName) => {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = String(text)
  for (const root of PROVIDER_SKILL_ROOTS) {
    out = out.replace(new RegExp(`${esc(root)}([/\\\\]{1,2})skills`, 'g'), '<AGENT_ROOT>$1skills')
  }
  if (skillName) out = out.replace(new RegExp(`\\$(?=${esc(skillName)}\\b)`, 'g'), '/')
  return out.replace(/\$(?=command-name\b)/g, '/').replace(/\$(?=<command>)/g, '/')
}

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
