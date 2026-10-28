import { describe, it, expect } from 'vitest'
import { createInviteAuthSetup, parseEnvText, loadSetupEnvironment, createFileSecretStore } from '../../scripts/configure-invite-auth.ts'
import { mkdtemp, writeFile, readFile, chmod, symlink, rm, stat, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ref = 'abcdefghijklmnopqrst'
const token = 'sbp_fc_fixture_only_token'
const secret = 'sb_secret_fixture_only_secret'
const publicKey = 'sb_publishable_fixture_only_public'
const config = { projectRef: ref, supabaseUrl: `https://${ref}.supabase.co`, publicKey, accessToken: token, allowApply: true, allowNegativeTests: true }
const closed = { disable_signup: true, external_anonymous_users_enabled: false }
const settings = { disable_signup: true, external: { anonymous_users: false } }
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const nonce = '0123456789abcdef0123456789abcdef'
type Request = { method: string; url: string; headers?: Record<string, string>; body?: any }
function fixture(overrides: (r: Request, index: number) => any = () => undefined) {
  const calls: Request[] = []
  const saved: string[] = []
  const request = async (r: Request) => {
    calls.push(r)
    const custom = overrides(r, calls.length)
    if (custom !== undefined) return custom
    if (r.url.includes('/config/auth')) return { status: 200, body: r.method === 'PATCH' || calls.length > 3 ? closed : { ...closed, disable_signup: false, smtp_pass: 'provider-private-secret' } }
    if (r.url.endsWith('/api-keys?reveal=true')) return { status: 200, body: [{ type: 'publishable', api_key: publicKey }, { type: 'secret', api_key: secret }] }
    if (r.url.endsWith('/admin/users?page=1&per_page=1')) return { status: 200, body: { users: [{ id, email: 'private-existing-user@example.com' }] } }
    if (r.url.endsWith('/settings')) return { status: 200, body: settings }
    if (r.url.endsWith('/signup')) return { status: 422, body: { error_code: r.body.email ? 'signup_disabled' : 'anonymous_provider_disabled' } }
    throw new Error('unexpected fixture request')
  }
  const run = (changes = {}, store = { save: async (key: string) => { saved.push(key) } }) => createInviteAuthSetup({ ...config, ...changes }, { request, secretStore: store, nonce: () => nonce }).run()
  return { calls, saved, run }
}

describe('controlled invite-auth setup (injected transport only)', () => {
  it('imports and executes the factory in native Node 26 with real env and child-process access denied', () => {
    const script = fileURLToPath(new URL('../../scripts/configure-invite-auth.ts', import.meta.url))
    const nativeCode = `
      import assert from 'node:assert/strict';
      assert.equal(process.permission.has('child'), false);
      assert.equal(process.permission.has('fs.read', ${JSON.stringify(fileURLToPath(new URL('../../.env', import.meta.url)))}), false);
      globalThis.fetch = () => { throw Error('NETWORK_FORBIDDEN') };
      const { createInviteAuthSetup, runInviteSetupCli } = await import(${JSON.stringify(new URL('../../scripts/configure-invite-auth.ts', import.meta.url).href)});
      const config = ${JSON.stringify(config)};
      let saved = false; let calls = 0;
      const request = async r => {
        calls++;
        if (r.url.includes('/config/auth')) return {status:200, body:${JSON.stringify(closed)}};
        if (r.url.endsWith('/api-keys?reveal=true')) return {status:200,body:[{type:'secret',api_key:${JSON.stringify(secret)}}]};
        if (r.url.includes('/admin/users?')) return {status:200,body:{users:[]}};
        if (r.url.endsWith('/settings')) return {status:200,body:${JSON.stringify(settings)}};
        if (r.url.endsWith('/signup')) return {status:422,body:{error_code:r.body.email?'signup_disabled':'anonymous_provider_disabled'}};
        throw Error('UNEXPECTED_FIXTURE_REQUEST');
      };
      const result = await createInviteAuthSetup(config,{request,secretStore:{save:async k=>{assert.equal(k,${JSON.stringify(secret)});saved=true}}}).run();
      assert.equal(result.status,'verified'); assert.equal(saved,true); assert.equal(calls,8);
      assert.equal(await runInviteSetupCli([],'/forbidden-root'),1);
      console.log('NATIVE_FIXTURE_PASS');
    `
    const result = execFileSync(process.execPath, ['--permission', `--allow-fs-read=${script}`, '--input-type=module', '--eval', nativeCode], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(result.trim()).toBe('NATIVE_FIXTURE_PASS')
  })
  it('fails before all requests/writes without both explicit authorizations or a management PAT', async () => {
    for (const change of [{ allowApply: false }, { allowNegativeTests: false }, { accessToken: '' }, { accessToken: secret }, { accessToken: publicKey }, { accessToken: ' sbp_fc_fixture_only_token ' }, { projectRef: `${ref}/bad` }, { supabaseUrl: 'https://other.supabase.co' }, { publicKey: secret }]) {
      const f = fixture()
      await expect(f.run(change)).rejects.toThrow(/SETUP_/)
      expect(f.calls).toHaveLength(0)
      expect(f.saved).toHaveLength(0)
    }
  })
  it('only patches the two flags; reads management/public/Admin and both negative probes before saving an existing key', async () => {
    const f = fixture()
    const report = await f.run()
    expect(f.calls.map(r => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual([
      `GET /v1/projects/${ref}/config/auth`, `GET /v1/projects/${ref}/api-keys?reveal=true`,
      'GET /auth/v1/admin/users?page=1&per_page=1', `PATCH /v1/projects/${ref}/config/auth`,
      `GET /v1/projects/${ref}/config/auth`, 'GET /auth/v1/settings', 'POST /auth/v1/signup', 'POST /auth/v1/signup',
    ])
    expect(f.calls[3].body).toEqual(closed)
    expect(f.calls.filter(r => r.method === 'POST').every(r => !r.url.includes('/admin/'))).toBe(true)
    expect(f.calls[6].body.email).toBe(`invite-setup-${nonce}@example.com`)
    expect(f.calls[6].body.data).toEqual({ ibs_invite_setup_nonce: nonce })
    expect(f.calls[7].body).toEqual({ data: { ibs_invite_setup_nonce: nonce } })
    expect(f.saved).toEqual([secret])
    expect(report).toEqual({ status: 'verified', disableSignup: true, anonymousUsersEnabled: false, adminKeyVerified: true, negativeTestsPassed: true, secretSaved: true })
    for (const value of [token, secret, 'provider-private-secret', 'private-existing-user']) expect(JSON.stringify(report)).not.toContain(value)
  })
  it('accepts a valid existing legacy service_role JWT for this project, never anon', async () => {
    const jwt = (role: string, project = ref) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, ref: project })).toString('base64url')}.fixture_signature`
    for (const [key, succeeds] of [[jwt('service_role'), true], [jwt('anon'), false], [jwt('service_role', 'wrong'), false], [publicKey, false]] as const) {
      const f = fixture(r => r.url.endsWith('/api-keys?reveal=true') ? { status: 200, body: [{ type: 'legacy', name: 'service_role', api_key: key }] } : undefined)
      if (succeeds) { await f.run(); expect(f.saved).toEqual([key]) }
      else { await expect(f.run()).rejects.toThrow('SETUP_SERVER_KEY_UNAVAILABLE'); expect(f.calls.every(r => r.method === 'GET')).toBe(true) }
    }
  })
  it('requires management read/key-read/Admin authority before PATCH, never logs upstream secrets', async () => {
    for (const failureAt of [1, 2, 3]) {
      const f = fixture((_r, i) => i === failureAt ? { status: 403, body: { message: `${token} ${secret}` } } : undefined)
      let failure: unknown
      try { await f.run() } catch (error) { failure = error }
      expect(String(failure)).toMatch(/SETUP_/)
      expect(String(failure)).not.toContain(token)
      expect(String(failure)).not.toContain(secret)
      expect(f.calls.every(r => r.method === 'GET')).toBe(true)
      expect(f.saved).toHaveLength(0)
    }
  })
  it('does not claim disabled/save/probe when either exact readback fails; never reopens signup', async () => {
    for (const body of [{ disable_signup: false, external_anonymous_users_enabled: false }, { disable_signup: true }, { disable_signup: true, external_anonymous_users_enabled: 'false' }]) {
      const f = fixture((r, i) => i === 5 ? { status: 200, body } : undefined)
      await expect(f.run()).rejects.toThrow('SETUP_MANAGEMENT_READBACK_FAILED')
      expect(f.saved).toHaveLength(0)
      expect(f.calls.filter(r => r.method === 'PATCH').map(r => r.body)).toEqual([closed])
      expect(f.calls.some(r => r.method === 'POST')).toBe(false)
    }
    for (const body of [{ disable_signup: false, external: { anonymous_users: false } }, { disable_signup: true, external: {} }, { disable_signup: true, external: { anonymous_users: true } }]) {
      const f = fixture(r => r.url.endsWith('/settings') ? { status: 200, body } : undefined)
      await expect(f.run()).rejects.toThrow('SETUP_PUBLIC_READBACK_FAILED')
      expect(f.saved).toHaveLength(0)
      expect(f.calls.some(r => r.method === 'POST')).toBe(false)
    }
  })
  it('rejects SMTP/invalid-email/ambiguous errors, 429 and 5xx instead of pretending signup is closed', async () => {
    for (const body of [{ error_code: 'email_address_invalid' }, { error_code: 'unexpected_failure', msg: 'SMTP signup_disabled' }, { msg: 'Signups not allowed' }]) {
      const f = fixture(r => r.url.endsWith('/signup') ? { status: 422, body } : undefined)
      await expect(f.run()).rejects.toThrow('SETUP_NEGATIVE_TEST_FAILED')
      expect(f.saved).toHaveLength(0)
      expect(f.calls.filter(r => r.method === 'POST')).toHaveLength(1)
    }
    for (const status of [200, 401, 429, 500]) {
      const f = fixture(r => r.url.endsWith('/signup') ? { status, body: { error_code: 'signup_disabled' } } : undefined)
      await expect(f.run()).rejects.toThrow(/SETUP_/)
      expect(f.saved).toHaveLength(0)
    }
  })
  it('accepts global signup_disabled for anonymous only after exact anonymous false readback', async () => {
    const f = fixture(r => r.url.endsWith('/signup') ? { status: 422, body: { code: 'signup_disabled' } } : undefined)
    await f.run()
    expect(f.saved).toHaveLength(1)
  })
  it('cleans up only an unexpectedly created exact nonce/email/id fixture, verifies deletion, then aborts', async () => {
    let deleted = false
    const user = { id, email: `invite-setup-${nonce}@example.com`, user_metadata: { ibs_invite_setup_nonce: nonce }, is_anonymous: false }
    const f = fixture(r => {
      if (r.url.endsWith('/signup')) return { status: 200, body: { user } }
      if (r.url.endsWith(`/admin/users/${id}`)) {
        if (r.method === 'DELETE') { deleted = true; return { status: 200, body: {} } }
        return deleted ? { status: 404, body: { code: 'user_not_found' } } : { status: 200, body: user }
      }
    })
    await expect(f.run()).rejects.toThrow('SETUP_UNEXPECTED_SIGNUP_CLEANED')
    expect(f.calls.slice(-3).map(r => r.method)).toEqual(['GET', 'DELETE', 'GET'])
    expect(f.saved).toHaveLength(0)
  })
  it('never deletes unknown or mismatching account even if response claims success', async () => {
    for (const user of [{ id }, { id, email: 'real@example.com', user_metadata: { ibs_invite_setup_nonce: nonce } }, { id, email: `invite-setup-${nonce}@example.com`, user_metadata: { ibs_invite_setup_nonce: 'another-run' } }]) {
      const f = fixture(r => r.url.endsWith('/signup') ? { status: 200, body: { user } } : undefined)
      await expect(f.run()).rejects.toThrow('SETUP_UNEXPECTED_SIGNUP_UNPROVEN')
      expect(f.calls.some(r => r.method === 'DELETE')).toBe(false)
      expect(f.saved).toHaveLength(0)
    }
    const user = { id, email: `invite-setup-${nonce}@example.com`, user_metadata: { ibs_invite_setup_nonce: nonce }, is_anonymous: false }
    const f = fixture(r => r.url.endsWith('/signup') ? { status: 200, body: { user } } : r.url.endsWith(`/admin/users/${id}`) ? { status: 200, body: { ...user, user_metadata: {} } } : undefined)
    await expect(f.run()).rejects.toThrow('SETUP_UNEXPECTED_SIGNUP_UNPROVEN')
    expect(f.calls.some(r => r.method === 'DELETE')).toBe(false)
  })
  it('sanitizes thrown transport/store errors, saves no key until all gates pass', async () => {
    const f = fixture()
    await expect(f.run({}, { save: async () => { throw Error(`${token} ${secret}`) } })).rejects.toThrow('SETUP_SECRET_SAVE_FAILED')
    const run = createInviteAuthSetup(config, { request: async () => { throw Error(`${token} ${secret}`) }, secretStore: { save: async () => {} } }).run
    await expect(run()).rejects.toThrow('SETUP_REQUEST_FAILED')
  })
})

async function diskFixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'invite-setup-fixture-'))
  try {
    execFileSync('git', ['init', '-q', root])
    await writeFile(join(root, '.gitignore'), '.env\n.env.*\n')
    await writeFile(join(root, '.env'), `SUPABASE_ACCESS_TOKEN=${token}\nAPP_PASSWORD='  untouched $VALUE  '\n`, { mode: 0o600 })
    await writeFile(join(root, '.env.local'), `VITE_SUPABASE_URL=${config.supabaseUrl}\nVITE_SUPABASE_PUBLISHABLE_KEY=${publicKey}\n`, { mode: 0o600 })
    await fn(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}
describe('fixture-only secure environment and secret persistence', () => {
  it('never evaluates/interpolates/trims secret values or retains prototype properties', () => {
    const env = parseEnvText("PASSWORD='  literal $VAR $(touch /never)  '\nTOKEN=  keep spaces  \n__proto__=literal\n")
    expect(env.PASSWORD).toBe('  literal $VAR $(touch /never)  ')
    expect(env.TOKEN).toBe('  keep spaces  ')
    expect(Object.getPrototypeOf(env)).toBeNull()
    expect(() => parseEnvText('A=1\nA=2')).toThrow('SETUP_ENV_INVALID')
  })
  it('loads only fixture files and CAS-saves only server key preserving obsolete fields; no backup', async () => diskFixture(async root => {
    const loaded = await loadSetupEnvironment(root)
    expect(loaded.privateEnv.APP_PASSWORD).toBe('  untouched $VALUE  ')
    const store = createFileSecretStore(loaded.privateSnapshot)
    await store.save(secret)
    expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600)
    const actual = await readFile(join(root, '.env'), 'utf8')
    expect(actual).toContain("APP_PASSWORD='  untouched $VALUE  '")
    expect(parseEnvText(actual).SUPABASE_SECRET_KEY).toBe(secret)
    expect((await readdir(root)).sort()).toEqual(['.env', '.env.local', '.git', '.gitignore'])
    await expect(store.save(secret)).rejects.toThrow('SETUP_ENV_CHANGED')
  }))
  it('aborts on concurrent secret-file edits, preserving new content verbatim', async () => diskFixture(async root => {
    const loaded = await loadSetupEnvironment(root)
    const changed = 'APP_PASSWORD=new-user-edit\n'
    await writeFile(join(root, '.env'), changed)
    await expect(createFileSecretStore(loaded.privateSnapshot).save(secret)).rejects.toThrow('SETUP_ENV_CHANGED')
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(changed)
  }))
  it('rejects permissive, symlink and non-gitignored files before consuming them', async () => {
    await diskFixture(async root => {
      await chmod(join(root, '.env.local'), 0o644)
      await expect(loadSetupEnvironment(root)).rejects.toThrow('SETUP_ENV_UNSAFE')
    })
    await diskFixture(async root => {
      await rm(join(root, '.env'))
      await symlink('.env.local', join(root, '.env'))
      await expect(loadSetupEnvironment(root)).rejects.toThrow('SETUP_ENV_UNSAFE')
    })
    await diskFixture(async root => {
      await writeFile(join(root, '.gitignore'), '')
      await expect(loadSetupEnvironment(root)).rejects.toThrow('SETUP_ENV_NOT_IGNORED')
    })
  })
})
