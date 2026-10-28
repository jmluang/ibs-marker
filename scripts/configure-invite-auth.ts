import { constants } from 'node:fs'
import { open, lstat, rename, unlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { dirname, join, resolve } from 'node:path'
import type { JsonRequest, JsonRequestInput } from '../server/curlTransport.ts'

/** This module is inert on import. Only the CLI entrypoint loads private files. */
export interface InviteSetupConfig {
  projectRef: string
  supabaseUrl: string
  publicKey: string
  accessToken: string
  allowApply: boolean
  allowNegativeTests: boolean
}
export interface SecretStore { save(key: string): Promise<void> }
export interface SetupDependencies {
  request: JsonRequest
  secretStore: SecretStore
  nonce?: () => string
}
export interface SetupReport {
  status: 'verified'
  disableSignup: true
  anonymousUsersEnabled: false
  adminKeyVerified: true
  negativeTestsPassed: true
  secretSaved: true
}
class SetupError extends Error {
  constructor(code: string) { super(code); this.name = 'SetupError' }
}
function fail(code: string): never { throw new SetupError(code) }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : Object.create(null)
}
function jwtClaims(key: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return Object.create(null)
  try { return record(JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'))) } catch { return Object.create(null) }
}
function isServerKey(key: unknown, projectRef: string): key is string {
  if (typeof key !== 'string') return false
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return true
  const claims = jwtClaims(key)
  return claims.role === 'service_role' && claims.ref === projectRef
}
function isPublicKey(key: unknown, projectRef: string): key is string {
  if (typeof key !== 'string') return false
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true
  const claims = jwtClaims(key)
  return claims.role === 'anon' && claims.ref === projectRef
}
function keyHeaders(key: string): Record<string, string> {
  // Modern API keys are not JWTs. Only legacy JWTs belong in Authorization.
  return key.startsWith('sb_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` }
}
function validateConfig(config: InviteSetupConfig): void {
  if (config.allowApply !== true || config.allowNegativeTests !== true) fail('SETUP_AUTHORIZATION_REQUIRED')
  if (typeof config.accessToken !== 'string' || !/^sbp_[A-Za-z0-9_-]{10,}$/.test(config.accessToken)) fail('SETUP_MANAGEMENT_PAT_REQUIRED')
  if (!/^[a-z]{20}$/.test(config.projectRef) || config.supabaseUrl !== `https://${config.projectRef}.supabase.co`) fail('SETUP_PROJECT_MISMATCH')
  if (!isPublicKey(config.publicKey, config.projectRef)) fail('SETUP_PUBLIC_KEY_INVALID')
}

/** Caller must authorize both mutation and owned negative probes. No hidden network. */
export function createInviteAuthSetup(input: InviteSetupConfig, dependencies: SetupDependencies): { run(): Promise<SetupReport> } {
  const config = { ...input }
  const { request, secretStore, nonce = () => randomBytes(16).toString('hex') } = dependencies
  async function send(method: JsonRequestInput['method'], url: string, headers: Record<string, string>, body?: unknown) {
    try {
      const result = await request({ method, url, headers, ...(body === undefined ? {} : { body }) })
      if (!result || !Number.isInteger(result.status)) fail('SETUP_RESPONSE_INVALID')
      return result
    } catch { fail('SETUP_REQUEST_FAILED') }
  }
  async function run(): Promise<SetupReport> {
    validateConfig(config)
    if (typeof request !== 'function' || typeof secretStore?.save !== 'function') fail('SETUP_DEPENDENCIES_INVALID')
    const management = `https://api.supabase.com/v1/projects/${config.projectRef}`
    const auth = `${config.supabaseUrl}/auth/v1`
    const managementHeaders = { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' }
    const publicHeaders = { ...keyHeaders(config.publicKey), 'Content-Type': 'application/json' }
    const initial = await send('GET', `${management}/config/auth`, managementHeaders)
    if (initial.status !== 200 || typeof record(initial.body).disable_signup !== 'boolean' || typeof record(initial.body).external_anonymous_users_enabled !== 'boolean') fail('SETUP_AUTH_CONFIG_READ_FAILED')
    const keys = await send('GET', `${management}/api-keys?reveal=true`, managementHeaders)
    if (keys.status !== 200 || !Array.isArray(keys.body)) fail('SETUP_KEY_READ_FAILED')
    // Only existing secret/service_role keys. No create, delete, rotate or guess.
    const entries = keys.body.map(record)
    const modern = entries.find(key => key.type === 'secret' && typeof key.api_key === 'string' && key.api_key.startsWith('sb_secret_') && isServerKey(key.api_key, config.projectRef))
    const legacy = entries.find(key => key.type === 'legacy' && key.name === 'service_role' && typeof key.api_key === 'string' && !key.api_key.startsWith('sb_') && isServerKey(key.api_key, config.projectRef))
    const serverKey = (modern ?? legacy)?.api_key
    if (!isServerKey(serverKey, config.projectRef)) fail('SETUP_SERVER_KEY_UNAVAILABLE')
    const adminHeaders = { ...keyHeaders(serverKey), 'Content-Type': 'application/json' }
    const adminProbe = await send('GET', `${auth}/admin/users?page=1&per_page=1`, adminHeaders)
    if (adminProbe.status !== 200 || !Array.isArray(record(adminProbe.body).users)) fail('SETUP_ADMIN_KEY_READ_FAILED')
    // Never PATCH any other Auth, SMTP, JWT or signing-key settings.
    const patched = await send('PATCH', `${management}/config/auth`, managementHeaders, { disable_signup: true, external_anonymous_users_enabled: false })
    if (patched.status !== 200) fail('SETUP_AUTH_PATCH_FAILED')
    const managementReadback = await send('GET', `${management}/config/auth`, managementHeaders)
    const flags = record(managementReadback.body)
    if (managementReadback.status !== 200 || flags.disable_signup !== true || flags.external_anonymous_users_enabled !== false) fail('SETUP_MANAGEMENT_READBACK_FAILED')
    const publicReadback = await send('GET', `${auth}/settings`, publicHeaders)
    const settings = record(publicReadback.body)
    if (publicReadback.status !== 200 || settings.disable_signup !== true || record(settings.external).anonymous_users !== false) fail('SETUP_PUBLIC_READBACK_FAILED')
    // No rollback: a failed later check must never reopen provider signup.
    const marker = nonce()
    if (!/^[a-f0-9]{32}$/.test(marker)) fail('SETUP_NONCE_INVALID')
    const email = `invite-setup-${marker}@example.com`
    const data = { ibs_invite_setup_nonce: marker }
    async function negativeProbe(anonymous: boolean): Promise<void> {
      const payload = anonymous ? { data } : { email, password: randomBytes(32).toString('base64url'), data }
      const response = await send('POST', `${auth}/signup`, publicHeaders, payload)
      const body = record(response.body)
      const errorCode = body.error_code ?? body.code
      const accepted = anonymous ? ['anonymous_provider_disabled', 'signup_disabled'] : ['signup_disabled']
      if ([400, 422].includes(response.status) && typeof errorCode === 'string' && accepted.includes(errorCode)) return
      // Non-2xx failures are NOT proof of disablement (SMTP, captcha, email, rate limits).
      if (response.status < 200 || response.status >= 300) fail('SETUP_NEGATIVE_TEST_FAILED')
      const user = record(body.user ?? body)
      const ownsUser = (candidate: Record<string, unknown>): boolean => {
        if (typeof candidate.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(candidate.id)) return false
        if (record(candidate.user_metadata).ibs_invite_setup_nonce !== marker) return false
        return anonymous ? candidate.is_anonymous === true && !candidate.email : candidate.email === email && candidate.is_anonymous !== true
      }
      // Never list/search/delete unrelated accounts. Returned nonce alone is not sufficient.
      if (!ownsUser(user)) fail('SETUP_UNEXPECTED_SIGNUP_UNPROVEN')
      const target = `${auth}/admin/users/${user.id}`
      const readback = await send('GET', target, adminHeaders)
      const confirmed = record(record(readback.body).user ?? readback.body)
      if (readback.status !== 200 || confirmed.id !== user.id || !ownsUser(confirmed)) fail('SETUP_UNEXPECTED_SIGNUP_UNPROVEN')
      const removed = await send('DELETE', target, adminHeaders)
      if (![200, 204].includes(removed.status)) fail('SETUP_FIXTURE_CLEANUP_FAILED')
      const deletedReadback = await send('GET', target, adminHeaders)
      const deletedCode = record(deletedReadback.body).code ?? record(deletedReadback.body).error_code
      if (deletedReadback.status !== 404 || deletedCode !== 'user_not_found') fail('SETUP_FIXTURE_CLEANUP_UNVERIFIED')
      fail('SETUP_UNEXPECTED_SIGNUP_CLEANED')
    }
    await negativeProbe(false)
    await negativeProbe(true)
    try { await secretStore.save(serverKey) } catch (error) {
      if (error instanceof SetupError) throw error
      fail('SETUP_SECRET_SAVE_FAILED')
    }
    return { status: 'verified', disableSignup: true, anonymousUsersEnabled: false, adminKeyVerified: true, negativeTestsPassed: true, secretSaved: true }
  }
  return { run }
}

/** Deliberately small literal env grammar; never shell-source, expand, trim values. */
export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const match = /^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match || Object.hasOwn(result, match[1])) fail('SETUP_ENV_INVALID')
    let value = match[2]
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]
      if (value.length < 2 || !value.endsWith(quote) || value.slice(1, -1).includes(quote)) fail('SETUP_ENV_INVALID')
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}
interface FileSnapshot {
  path: string
  text: string
  dev: bigint
  ino: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  size: bigint
}
function assertSafeFile(info: { isFile(): boolean; uid: bigint; mode: bigint }): void {
  if (!info.isFile() || typeof process.getuid !== 'function' || info.uid !== BigInt(process.getuid()) || (info.mode & 0o7777n) !== 0o600n) fail('SETUP_ENV_UNSAFE')
}
function assertGitIgnored(path: string): void {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', path], { cwd: dirname(path), stdio: 'ignore' })
  } catch { fail('SETUP_ENV_NOT_IGNORED') }
}
async function snapshot(path: string): Promise<FileSnapshot> {
  assertGitIgnored(path)
  // lstat first rejects symlinks; O_NOFOLLOW plus fstat closes replacement races.
  let handle
  try {
    assertSafeFile(await lstat(path, { bigint: true }))
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat({ bigint: true })
    assertSafeFile(before)
    if (before.size > 1024n * 1024n) fail('SETUP_ENV_UNSAFE')
    const bytes = await handle.readFile()
    if (!isUtf8(bytes)) fail('SETUP_ENV_INVALID')
    const text = bytes.toString('utf8')
    const after = await handle.stat({ bigint: true })
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('SETUP_ENV_CHANGED')
    const pathInfo = await lstat(path, { bigint: true })
    if (pathInfo.ino !== after.ino || pathInfo.dev !== after.dev) fail('SETUP_ENV_CHANGED')
    return { path, text, dev: after.dev, ino: after.ino, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs, size: after.size }
  } catch (error) {
    if (error instanceof SetupError) throw error
    return fail('SETUP_ENV_UNSAFE')
  } finally { await handle?.close() }
}
export async function loadSetupEnvironment(root: string) {
  const directory = resolve(root)
  const privateSnapshot = await snapshot(join(directory, '.env'))
  const publicSnapshot = await snapshot(join(directory, '.env.local'))
  return { privateEnv: parseEnvText(privateSnapshot.text), publicEnv: parseEnvText(publicSnapshot.text), privateSnapshot }
}
function unchanged(first: FileSnapshot, next: FileSnapshot): boolean {
  const left = Buffer.from(first.text)
  const right = Buffer.from(next.text)
  return first.dev === next.dev && first.ino === next.ino && first.mtimeNs === next.mtimeNs && first.ctimeNs === next.ctimeNs && first.size === next.size && left.length === right.length && timingSafeEqual(left, right)
}
/** Snapshot CAS + exclusive lock; all env writers must honor this lock at publish. */
export function createFileSecretStore(original: FileSnapshot): SecretStore {
  const initial = { ...original }
  let consumed = false
  return { async save(key: string): Promise<void> {
    if (consumed) fail('SETUP_ENV_CHANGED')
    // Key must be single-line and typed, never an env-injection payload.
    if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(key) && jwtClaims(key).role !== 'service_role') fail('SETUP_SERVER_KEY_UNAVAILABLE')
    const lockPath = `${initial.path}.invite-setup.lock`
    const temporary = `${initial.path}.invite-setup-${randomBytes(16).toString('hex')}.tmp`
    let lock
    let output
    let published = false
    try {
      try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) } catch { fail('SETUP_ENV_LOCKED') }
      assertGitIgnored(temporary)
      if (!unchanged(initial, await snapshot(initial.path))) fail('SETUP_ENV_CHANGED')
      const env = parseEnvText(initial.text)
      const line = `SUPABASE_SECRET_KEY=${key}`
      const next = Object.hasOwn(env, 'SUPABASE_SECRET_KEY')
        ? initial.text.replace(/^(?:export )?SUPABASE_SECRET_KEY=.*$/m, line)
        : `${initial.text}${initial.text.endsWith('\n') || initial.text.length === 0 ? '' : '\n'}${line}\n`
      output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await output.writeFile(next, 'utf8')
      await output.sync()
      await output.close()
      output = undefined
      // Re-check immediately before atomic publication; never overwrite observed edits.
      if (!unchanged(initial, await snapshot(initial.path))) fail('SETUP_ENV_CHANGED')
      await rename(temporary, initial.path)
      published = true
      consumed = true
      const directory = await open(dirname(initial.path), constants.O_RDONLY | constants.O_DIRECTORY)
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      if (error instanceof SetupError) throw error
      fail('SETUP_SECRET_SAVE_FAILED')
    } finally {
      await output?.close()
      if (!published) await unlink(temporary).catch(() => {})
      if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}) }
    }
  } }
}
const HELP = `Usage: node scripts/configure-invite-auth.ts --project-ref=<ref> --apply --allow-negative-tests

Explicitly authorizes the two provider flags and owned negative signup probes.
Reads only owner-held, regular, non-symlink, gitignored 0600 .env/.env.local.
Requires server-only SUPABASE_ACCESS_TOKEN (scoped PAT), never APP_PASSWORD.
No secrets in argv. No account pre-provisioning or key creation/rotation.
See docs/invite-setup.md. --help and missing authorization never load env/network.
`
export async function runInviteSetupCli(argv: readonly string[], root = process.cwd()): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(HELP); return 0 }
  try {
    const projectArguments = argv.filter(arg => /^--project-ref=[a-z]{20}$/.test(arg))
    if (argv.length !== 3 || projectArguments.length !== 1 || argv.filter(arg => arg === '--apply').length !== 1 || argv.filter(arg => arg === '--allow-negative-tests').length !== 1) fail('SETUP_AUTHORIZATION_REQUIRED')
    const loaded = await loadSetupEnvironment(root)
    const config: InviteSetupConfig = {
      projectRef: projectArguments[0].slice('--project-ref='.length),
      supabaseUrl: loaded.publicEnv.VITE_SUPABASE_URL ?? '',
      publicKey: loaded.publicEnv.VITE_SUPABASE_PUBLISHABLE_KEY || loaded.publicEnv.VITE_SUPABASE_ANON_KEY || '',
      accessToken: loaded.privateEnv.SUPABASE_ACCESS_TOKEN ?? '',
      allowApply: true, allowNegativeTests: true,
    }
    validateConfig(config)
    const { createCurlJsonRequest } = await import('../server/curlTransport.ts')
    const request = createCurlJsonRequest({ allowedOrigins: [config.supabaseUrl, 'https://api.supabase.com'] })
    const report = await createInviteAuthSetup(config, { request, secretStore: createFileSecretStore(loaded.privateSnapshot) }).run()
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return 0
  } catch (error) {
    const code = error instanceof SetupError ? error.message : 'SETUP_FAILED'
    process.stderr.write(`${JSON.stringify({ status: 'failed', code, verified: false })}\n`)
    return 1
  }
}
if (import.meta.main) process.exitCode = await runInviteSetupCli(process.argv.slice(2))
