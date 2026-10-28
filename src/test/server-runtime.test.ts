import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
// @ts-expect-error CLI is native import-safe JavaScript.
import { loadRuntimeConfig } from "../../scripts/start-server.mjs";
import { createApplication } from "../../server/app.ts";
import { createMemorySessionStore } from "../../server/sessionStore.ts";
const dirs: string[] = [];
function root() {
  const d = mkdtempSync(join(process.env.TMPDIR!, "bff-runtime-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("application construction requires durable encryption configuration or explicit fixture memory injection", () => {
  expect(() =>
    createApplication(
      { publicOrigin: "https://app.fixture.invalid" },
      async () => {
        throw Error("UNEXPECTED_NETWORK");
      },
    ),
  ).toThrow("SESSION_STORE_UNAVAILABLE");
  const app = createApplication(
    {
      publicOrigin: "https://app.fixture.invalid",
      sessionStore: createMemorySessionStore(),
    },
    async () => {
      throw Error("UNEXPECTED_NETWORK");
    },
  );
  app.close();
});
it("owned encrypted store is released on server close and restores the same anonymous cookie context on restart", async () => {
  const dir = root();
  const config = {
    publicOrigin: "https://app.fixture.invalid",
    sessionEncryptionKey: "ac".repeat(32),
    serverSessionFile: join(dir, "sessions.enc"),
  };
  async function start() {
    const s = createApplication(config, async () => {
      throw Error("UNEXPECTED_NETWORK");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const a = s.address();
    if (!a || typeof a === "string") throw Error();
    return { s, base: `http://127.0.0.1:${a.port}` };
  }
  const stop = async (s: ReturnType<typeof createApplication>) => {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  };
  const first = await start();
  let cookie = "",
    body: unknown;
  try {
    const r = await fetch(first.base + "/api/auth/bootstrap", {
      method: "POST",
      headers: {
        Origin: config.publicOrigin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(r.status).toBe(200);
    cookie = r.headers.get("set-cookie")!.split(";")[0];
    body = await r.json();
  } finally {
    await stop(first.s);
  }
  const next = await start();
  try {
    const r = await fetch(next.base + "/api/auth/session", {
      headers: { Origin: config.publicOrigin, Cookie: cookie },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await r.json()).toEqual(body);
  } finally {
    await stop(next.s);
  }
});
const key = "ef".repeat(32);
it.each([undefined, "", "bad", "a".repeat(63), "g".repeat(64)])(
  "runtime fails closed for missing or malformed encryption key %s",
  async (k) => {
    await expect(
      loadRuntimeConfig(
        root(),
        k === undefined ? {} : { SESSION_ENCRYPTION_KEY: k },
      ),
    ).rejects.toThrow("SERVER_SESSION_KEY_INVALID");
  },
);
it("runtime reads only unprefixed server configuration and never opens .env.local", async () => {
  const d = root();
  writeFileSync(
    join(d, ".env"),
    `SESSION_ENCRYPTION_KEY=${key}\nSUPABASE_URL=https://fixture.private.invalid\nSUPABASE_PUBLISHABLE_KEY=private-public-fixture\n`,
  );
  mkdirSync(join(d, ".env.local")); // Reading publicEnv would fail with EISDIR.
  const c = await loadRuntimeConfig(d, {});
  expect(c.sessionEncryptionKey).toBe(key);
  expect(c.serverSessionFile).toBe(join(d, ".private", "bff-sessions.enc"));
  expect(c.supabaseUrl).toBe("https://fixture.private.invalid");
  expect(c.supabasePublicKey).toBe("private-public-fixture");
  const overridden = await loadRuntimeConfig(d, {
    SESSION_STORE_PATH: "custom/sessions.enc",
    SUPABASE_URL: "https://override.fixture.invalid",
  });
  expect(overridden.serverSessionFile).toBe(join(d, "custom", "sessions.enc"));
  expect(overridden.supabaseUrl).toBe("https://override.fixture.invalid");
});
it("public VITE values cannot configure the backend even when private URL/key are absent", async () => {
  const d = root();
  writeFileSync(
    join(d, ".env.local"),
    "VITE_SUPABASE_URL=https://public.fixture.invalid\nVITE_SUPABASE_ANON_KEY=forbidden-fallback\nSESSION_ENCRYPTION_KEY=" +
      key +
      "\n",
  );
  const c = await loadRuntimeConfig(d, {
    SESSION_ENCRYPTION_KEY: key,
    VITE_SUPABASE_URL: "https://also-forbidden.invalid",
    VITE_SUPABASE_ANON_KEY: "also-forbidden",
  });
  expect(c.supabaseUrl).toBe("");
  expect(c.supabasePublicKey).toBe("");
});
it("CLI import is side-effect free under native Node with empty configuration", () => {
  const cli = fileURLToPath(
    new URL("../../scripts/start-server.mjs", import.meta.url),
  );
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(cli).href)});console.log('NATIVE_IMPORT_SAFE');`,
    ],
    {
      cwd: root(),
      env: { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR! },
      timeout: 10000,
      encoding: "utf8",
    },
  );
  expect(result.trim()).toBe("NATIVE_IMPORT_SAFE");
});
it("native Node serves cross-site public navigation while readiness remains closed and SID cookies persist", () => {
  const app = pathToFileURL(
    fileURLToPath(new URL("../../server/app.ts", import.meta.url)),
  ).href;
  const store = pathToFileURL(
    fileURLToPath(new URL("../../server/sessionStore.ts", import.meta.url)),
  ).href;
  const d = root();
  writeFileSync(join(d, "index.html"), "<!doctype html><h1>native shell</h1>");
  writeFileSync(join(d, "sw.js"), "// native worker");
  writeFileSync(
    join(d, "asset-manifest.json"),
    JSON.stringify({ buildId: "native", assets: ["/index.html"] }),
  );
  const script = `
    import assert from 'node:assert/strict';
    import {createApplication} from ${JSON.stringify(app)};
    import {createMemorySessionStore} from ${JSON.stringify(store)};
    let clock=1000;const origin='https://native.fixture.invalid';
    const store=createMemorySessionStore({now:()=>clock,ttlMs:100999});
    const server=createApplication({publicOrigin:origin,distDir:${JSON.stringify(d)},sessionStore:store},async()=>{throw Error('UNEXPECTED_PROVIDER');},()=>clock);
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    const fetchNative=globalThis.fetch;globalThis.fetch=(url,init)=>{assert(String(url).startsWith(base+'/'));return fetchNative(url,init);};
    try {
      for(const path of ['/?x1','/index.html?x1','/sw.js?build=native'])for(const method of ['GET','HEAD']){
        const r=await fetch(base+path,{method,headers:{Origin:'https://external.invalid','Sec-Fetch-Site':'cross-site'}});assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('cache-control'),'no-store');
        if(method==='HEAD')assert.equal(await r.text(),'');
      }
      assert.equal((await fetch(base+'/readyz')).status,503);
      assert.equal((await fetch(base+'/sw.js?build=native&x=1')).status,404);
      assert.equal((await fetch(base+'/settings')).status,404);
      assert.equal((await fetch(base+'/api/auth/session',{headers:{Accept:'text/html','Sec-Fetch-Site':'cross-site'}})).status,403);
      const boot=async(cookie='')=>fetch(base+'/api/auth/bootstrap',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:'{}'});
      const a=await boot();const cookie=a.headers.get('set-cookie').split(';')[0];const identity=await a.json();assert(a.headers.get('set-cookie').includes('Max-Age=100'));clock=2501;
      const b=await boot(cookie);assert.equal(b.headers.get('set-cookie').split(';')[0],cookie);assert(b.headers.get('set-cookie').includes('Max-Age=99'));assert.deepEqual(await b.json(),identity);
      console.log(JSON.stringify({native:true,publicNavigation:true,readinessClosed:true,sameSid:true}));
    }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: d,
      env: { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR! },
      timeout: 15000,
      encoding: "utf8",
    },
  );
  expect(JSON.parse(output)).toEqual({
    native: true,
    publicNavigation: true,
    readinessClosed: true,
    sameSid: true,
  });
});
it("native Node exercises fixture auth + fixed JWT sync without Vite transforms or network providers", () => {
  const app = pathToFileURL(
    fileURLToPath(new URL("../../server/app.ts", import.meta.url)),
  ).href;
  const store = pathToFileURL(
    fileURLToPath(new URL("../../server/sessionStore.ts", import.meta.url)),
  ).href;
  const script = `
 import assert from 'node:assert/strict';
 import {createApplication} from ${JSON.stringify(app)};
 import {createMemorySessionStore} from ${JSON.stringify(store)};
 const origin='http://127.0.0.1';const id='f0000000-0000-4000-8000-000000000001';const calls=[];
 const server=createApplication({publicOrigin:origin,supabaseUrl:'https://provider.fixture.invalid',supabasePublicKey:'PUBLIC_FIXTURE',sessionStore:createMemorySessionStore(),rateLimit:{perIp:100,global:100,maxIps:10,windowMs:60000}},async r=>{calls.push(r);if(r.url.includes('grant_type=password'))return {status:200,body:{access_token:'USER_JWT',refresh_token:'USER_REFRESH',expires_in:3600,user:{id}}};if(r.url.endsWith('/user'))return {status:200,body:{id,app_metadata:{ibs_marker_username:'alice'}}};if(r.url.includes('tracker_changes')){assert.deepEqual(r.headers,{apikey:'PUBLIC_FIXTURE',Authorization:'Bearer USER_JWT'});return {status:200,body:[]};}throw Error('UNEXPECTED_PROVIDER');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let cookie='';
 const nativeFetch=globalThis.fetch;globalThis.fetch=(url,init)=>{assert(String(url).startsWith(base+'/'));return nativeFetch(url,init);};
 const req=(path,body,extra={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),Cookie:cookie,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try {let r=await req('/api/auth/session');assert.equal(r.status,428);assert.equal(r.headers.get('set-cookie'),null);
 r=await req('/api/auth/bootstrap',{});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];assert(cookie.startsWith('ibs_session='));assert(!r.headers.get('set-cookie').includes('Secure'));let b=await r.json();
 r=await req('/api/auth/prepare',{authRevision:b.authRevision});b=await r.json();r=await req('/api/auth/login',{username:'alice',password:'fixture-only',authRevision:b.authRevision,attemptId:b.attemptId});assert.equal(r.status,200);b=await r.json();assert.equal(b.user.id,id);assert.equal(r.headers.get('set-cookie'),null);
 r=await req('/api/sync/pull?cursor=0&limit=100',undefined,{'X-Auth-Revision':b.authRevision});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,rows:[]});console.log(JSON.stringify({native:true,requests:calls.length,cookieHttpOnly:true,userJwt:true}));
 }finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
 `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: root(),
      env: { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR! },
      timeout: 15000,
      encoding: "utf8",
    },
  );
  expect(JSON.parse(output)).toEqual({
    native: true,
    requests: 3,
    cookieHttpOnly: true,
    userJwt: true,
  });
});
