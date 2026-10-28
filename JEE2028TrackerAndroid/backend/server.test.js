'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let child; let base; let temp;
async function call(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); return { status: response.status, data };
}
before(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'jee-api-test-'));
  const port = 18000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', JWT_SECRET: 'test-only-secret-that-is-at-least-32-bytes-long', DATA_FILE: path.join(temp, 'store.json'), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, stdio: 'ignore' });
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`API exited early (${child.exitCode})`);
    try { if ((await fetch(base + '/health')).ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('API did not start in time');
});
after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  if (temp) await rm(temp, { recursive: true, force: true });
});
test('register, login, isolate user data, and revoke session', async () => {
  const first = await call('/api/auth/register', { method: 'POST', body: { name: 'A Student', email: 'student@example.test', password: 'a-secure-test-password' } });
  assert.equal(first.status, 200); assert.equal(first.data.user.email, 'student@example.test'); assert.ok(first.data.token);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { name: 'A Student', email: 'student@example.test', password: 'a-secure-test-password' } })).status, 409);
  const login = await call('/api/auth/login', { method: 'POST', body: { email: 'student@example.test', password: 'a-secure-test-password' } });
  assert.equal(login.status, 200);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'student@example.test', password: 'wrong-password' } })).status, 401);
  const tracker = { c: { 'Physics:1:2': 1 }, h: { '2026-10': { r0: [28] } }, n: {} };
  assert.equal((await call('/api/data', { method: 'PUT', token: first.data.token, body: { data: tracker } })).status, 200);
  assert.deepEqual((await call('/api/data', { token: first.data.token })).data.data.data, tracker);
  const second = await call('/api/auth/register', { method: 'POST', body: { name: 'Another Student', email: 'other@example.test', password: 'another-secure-password' } });
  assert.equal((await call('/api/data', { token: second.data.token })).data.data, null);
  assert.equal((await call('/api/auth/logout', { method: 'POST', token: first.data.token, body: {} })).status, 200);
  assert.equal((await call('/api/auth/me', { token: first.data.token })).status, 401);
});
test('reject malformed and oversized tracker data', async () => {
  const account = await call('/api/auth/register', { method: 'POST', body: { name: 'Student', email: 'limit@example.test', password: 'a-secure-test-password' } });
  assert.equal((await call('/api/data', { method: 'PUT', token: account.data.token, body: { data: [] } })).status, 400);
  assert.equal((await call('/api/data', { method: 'PUT', token: account.data.token, body: { data: { blob: 'x'.repeat(70_000) } } })).status, 413);
});
test('health is public and Google OAuth reports missing configuration', async () => {
  assert.equal((await call('/health')).data.ok, true);
  const result = await call('/api/auth/google/start', { method: 'POST', body: { redirectUri: 'jee2028://oauth/callback', codeChallenge: 'A'.repeat(43) } });
  assert.equal(result.status, 503);
});
