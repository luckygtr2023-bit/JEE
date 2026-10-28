'use strict';

// Zero-dependency companion API. Keep it behind HTTPS in production.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.resolve(process.env.DATA_FILE || './data/store.json');
const SECRET = process.env.JWT_SECRET || '';
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const MAX_BODY = 128 * 1024;
const DAY = 86400;
const oauthStates = new Map();
const exchangeCodes = new Map();
const rateBuckets = new Map();
let db = { users: [], records: {} };

function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function b64url(v) { return Buffer.from(v).toString('base64url'); }
function random(size = 32) { return crypto.randomBytes(size).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function timingSafeText(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function persist() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!Array.isArray(db.users) || typeof db.records !== 'object') throw new Error('Invalid data store');

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}
function redirect(res, location) { res.writeHead(302, { location, 'cache-control': 'no-store' }); res.end(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = (process.env.CORS_ORIGINS || '*').split(',').map(x => x.trim());
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.setHeader('access-control-allow-origin', allowed.includes('*') ? '*' : origin);
    if (!allowed.includes('*')) res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('access-control-max-age', '600');
}
function clientIp(req) { return req.socket.remoteAddress || 'unknown'; }
function countLimit(key, limit, message) {
  const now = Date.now(); const old = rateBuckets.get(key);
  const entry = old && now - old.start < 60_000 ? old : { start: now, count: 0 };
  entry.count++; rateBuckets.set(key, entry);
  if (entry.count > limit) fail(429, message);
  if (rateBuckets.size > 5000) for (const [bucket, val] of rateBuckets) if (now - val.start > 120_000) rateBuckets.delete(bucket);
}
function throttle(req) { countLimit(`ip:${clientIp(req)}`, 120, 'Too many requests'); }
function throttleAuth(req, identity) {
  if (identity) countLimit(`auth-id:${digest(String(identity).trim().toLowerCase())}`, 8, 'Too many attempts for this account. Try again in a minute.');
  else countLimit(`auth-ip:${clientIp(req)}`, 20, 'Too many sign-in attempts. Try again in a minute.');
}
function requireSecret() { if (Buffer.byteLength(SECRET) < 32) fail(503, 'Server is not configured: set JWT_SECRET to at least 32 characters'); }
function tokenFor(user) {
  requireSecret();
  const payload = { sub: user.id, sid: random(24), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + DAY };
  const input = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', SECRET).update(input).digest('base64url');
  return { token: `${input}.${sig}`, expiresIn: DAY };
}
function authUser(req) {
  requireSecret();
  const value = req.headers.authorization || '';
  const match = /^Bearer ([\w.-]+)$/.exec(value); if (!match) fail(401, 'Sign in required');
  const parts = match[1].split('.'); if (parts.length !== 3) fail(401, 'Invalid session');
  const expected = crypto.createHmac('sha256', SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!timingSafeText(expected, parts[2])) fail(401, 'Invalid session');
  let p; try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { fail(401, 'Invalid session'); }
  if (!p.sub || !p.sid || p.exp <= Date.now() / 1000 || db.revoked?.includes(p.sid)) fail(401, 'Session expired');
  const user = db.users.find(x => x.id === p.sub); if (!user) fail(401, 'Account not found');
  return { user, sid: p.sid };
}
function safeUser(user) { return { id: user.id, name: user.name, email: user.email, provider: user.provider || 'password', createdAt: user.createdAt }; }
function issue(res, user) { json(res, 200, { ...tokenFor(user), user: safeUser(user) }); }
function validEmail(email) { return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.pbkdf2(password, salt, 310000, 32, 'sha256', (e, key) => e ? reject(e) : resolve({ salt, hash: key.toString('hex') })));
}
async function verifyPassword(password, record) {
  const { hash } = await hashPassword(password, record.salt);
  return timingSafeText(hash, record.passwordHash);
}
function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
async function googleUser(code) {
  if (!GOOGLE_ID || !GOOGLE_SECRET) fail(503, 'Google sign-in is not configured on this server');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET, redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(10000) });
  const tokens = await tokenRes.json(); if (!tokenRes.ok || !tokens.access_token) fail(401, 'Google sign-in could not be verified');
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) });
  const info = await infoRes.json(); if (!infoRes.ok || !info.email || info.email_verified !== true) fail(401, 'Google account email is not verified');
  return info;
}
async function handle(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  throttle(req);
  const url = new URL(req.url, publicBase(req));
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'jee2028-tracker-api', time: new Date().toISOString() });

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    throttleAuth(req);
    const body = await readBody(req); const email = String(body.email || '').trim().toLowerCase();
    throttleAuth(req, email);
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) fail(400, 'Password must be 10–128 characters');
    const name = String(body.name || '').trim().slice(0, 80); if (!name) fail(400, 'Enter your name');
    if (db.users.some(x => x.email === email)) fail(409, 'An account with this email already exists');
    const pw = await hashPassword(body.password);
    const user = { id: random(18), email, name, passwordHash: pw.hash, salt: pw.salt, provider: 'password', createdAt: new Date().toISOString() };
    db.users.push(user); persist(); return issue(res, user);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    throttleAuth(req);
    const body = await readBody(req); const email = String(body.email || '').trim().toLowerCase();
    throttleAuth(req, email);
    const user = db.users.find(x => x.email === email && x.passwordHash);
    if (!user || typeof body.password !== 'string' || !(await verifyPassword(body.password, user))) fail(401, 'Email or password is incorrect');
    return issue(res, user);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/google/start') {
    throttleAuth(req);
    if (!GOOGLE_ID || !GOOGLE_SECRET) fail(503, 'Google sign-in is not configured on this server');
    const body = await readBody(req); const redirectUri = String(body.redirectUri || ''); const challenge = String(body.codeChallenge || '');
    if (!/^jee2028:\/\/oauth\/callback$/.test(redirectUri)) fail(400, 'Invalid app callback URI');
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) fail(400, 'Invalid PKCE challenge');
    const state = random(24); oauthStates.set(state, { redirectUri, challenge, expires: Date.now() + 5 * 60_000 });
    const params = new URLSearchParams({ client_id: GOOGLE_ID, redirect_uri: GOOGLE_REDIRECT, response_type: 'code', scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account' });
    return json(res, 200, { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }
  if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
    const state = url.searchParams.get('state'); const flow = oauthStates.get(state); oauthStates.delete(state);
    if (!flow || flow.expires < Date.now()) fail(400, 'Sign-in expired. Return to the app and try again.');
    if (url.searchParams.has('error')) {
      const appReturn = new URL(flow.redirectUri); appReturn.searchParams.set('error', 'access_denied'); appReturn.searchParams.set('state', state);
      return redirect(res, appReturn.toString());
    }
    const info = await googleUser(url.searchParams.get('code') || '');
    let user = db.users.find(x => x.email === String(info.email).toLowerCase());
    if (!user) { user = { id: random(18), email: String(info.email).toLowerCase(), name: String(info.name || info.email).slice(0, 80), provider: 'google', createdAt: new Date().toISOString() }; db.users.push(user); persist(); }
    const code = random(32); exchangeCodes.set(code, { userId: user.id, state, challenge: flow.challenge, expires: Date.now() + 120_000 });
    const appReturn = new URL(flow.redirectUri); appReturn.searchParams.set('code', code); appReturn.searchParams.set('state', state);
    return redirect(res, appReturn.toString());
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/google/exchange') {
    const body = await readBody(req); const item = exchangeCodes.get(String(body.code || '')); exchangeCodes.delete(String(body.code || ''));
    const verifier = String(body.codeVerifier || ''); const state = String(body.state || '');
    if (!item || item.expires < Date.now() || !timingSafeText(item.state, state) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !timingSafeText(crypto.createHash('sha256').update(verifier).digest('base64url'), item.challenge)) fail(401, 'Sign-in could not be completed. Please try again.');
    const user = db.users.find(x => x.id === item.userId); if (!user) fail(401, 'Account not found');
    return issue(res, user);
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const { user } = authUser(req); return json(res, 200, { user: safeUser(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const { sid } = authUser(req); db.revoked = [...new Set([...(db.revoked || []), sid])].slice(-10000); persist(); return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/data') {
    const { user } = authUser(req); return json(res, 200, { data: db.records[user.id] || null });
  }
  if (req.method === 'PUT' && url.pathname === '/api/data') {
    const { user } = authUser(req); const body = await readBody(req);
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) fail(400, 'Invalid tracker data');
    const serialized = JSON.stringify(body.data); if (Buffer.byteLength(serialized) > 64 * 1024) fail(413, 'Tracker data is too large');
    db.records[user.id] = { data: body.data, updatedAt: new Date().toISOString() }; persist();
    return json(res, 200, db.records[user.id]);
  }
  return json(res, 404, { error: 'Not found' });
}
const server = http.createServer((req, res) => handle(req, res).catch(err => {
  if (res.headersSent) return res.destroy();
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(err);
  json(res, status, { error: status >= 500 ? 'Server error' : err.message });
}));
server.listen(PORT, HOST, () => console.log(`JEE Tracker API listening on http://${HOST}:${PORT}`));
for (const map of [oauthStates, exchangeCodes]) setInterval(() => { const now = Date.now(); for (const [key, val] of map) if (val.expires < now) map.delete(key); }, 60_000).unref();
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
