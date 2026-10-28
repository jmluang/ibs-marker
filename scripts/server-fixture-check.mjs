import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../server/app.ts";
import { createCurlJsonRequest } from "../server/curlTransport.ts";
import { loadRuntimeConfig } from "./start-server.mjs";
// Never reads the real environment files and never contacts a provider.
const root = await mkdtemp(
  resolve(process.env.TMPDIR || tmpdir(), "invite-native-"),
);
const calls = [];
let server;
try {
  await mkdir(resolve(root, "dist"));
  await writeFile(
    resolve(root, ".env"),
    "INVITE_CODE=native-fixture\nSUPABASE_SECRET_KEY=fake-secret\nPUBLIC_ORIGIN=https://ibs.freecursorfuckoff.top\nSUPABASE_URL=https://fixture.supabase.co\nSUPABASE_PUBLISHABLE_KEY=fake-public\nSESSION_ENCRYPTION_KEY=" + "0".repeat(64) + "\n",
  );
  await writeFile(
    resolve(root, ".env.local"),
    "# No browser provider configuration.\n",
  );
  await writeFile(resolve(root, "dist/index.html"), "<h1>native fixture</h1>");
  await writeFile(
    resolve(root, "dist/asset-manifest.json"),
    JSON.stringify({ buildId: "native-fixture", assets: ["/", "/index.html"] }),
  );
  const config = await loadRuntimeConfig(root, {});
  assert.equal(config.host, "10.21.1.227");
  assert.equal(config.port, 15001);
  assert.equal(config.supabaseAccessToken, "");
  assert.equal(
    typeof createCurlJsonRequest({
      allowedOrigins: ["https://fixture.supabase.co"],
    }),
    "function",
  );
  const user = {
    id: "f0000000-0000-4000-8000-000000000001",
    email: "u-616c696365@ibs-marker.invalid",
    email_confirmed_at: "2026-01-01T00:00:00Z",
    app_metadata: {
      ibs_marker_username: "alice",
      ibs_marker_registration: "invite",
    },
  };
  server = createApplication(config, async (input) => {
    calls.push(input);
    assert.ok(!input.url.includes("api.supabase.com"), "runtime must not call management API");
    if (input.url === "https://fixture.supabase.co/auth/v1/settings") {
      assert.equal(input.headers.apikey, "fake-public");
      return {
        status: 200,
        body: { disable_signup: true, external: { anonymous_users: false } },
      };
    }
    return { status: input.method === "POST" ? 201 : 200, body: user };
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  const post = (inviteCode) =>
    fetch(url + "/api/register", {
      method: "POST",
      headers: {
        Origin: config.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "alice",
        password: "fixture-password",
        inviteCode,
      }),
    });
  let r = await post("wrong");
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, code: "INVITE_INVALID" });
  assert.equal(calls.length, 0);
  r = await post("native-fixture");
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(calls.length, 3);
  r = await fetch(url + "/");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "<h1>native fixture</h1>");
  r = await fetch(url + "/.env");
  assert.equal(r.status, 404);
  console.log(
    JSON.stringify({
      ok: true,
      node: process.version,
      importSafe: true,
      fixtureOnly: true,
      registrationConfirmed: true,
      staticAllowlist: true,
      defaultHost: config.host,
      defaultPort: config.port,
    }),
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await rm(root, { recursive: true, force: true });
}
