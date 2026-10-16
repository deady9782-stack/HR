import 'dotenv/config';
import crypto, { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_PATH = path.join(__dirname, 'accounts.json');
const scrypt = promisify(scryptCallback);
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const attempts = new Map();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function readAccounts() {
  try {
    const accounts = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    return Array.isArray(accounts) ? accounts : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read account store:', error.message);
    return [];
  }
}
let accounts = readAccounts();
function saveAccounts() {
  const tempPath = `${USERS_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, USERS_PATH);
}
const publicAccount = account => ({ id: account.id, username: account.username, rpName: account.rpName, role: account.role, requestedRole: account.requestedRole, status: account.status, createdAt: account.createdAt });
function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left ?? ''));
  const rightBytes = Buffer.from(String(right ?? ''));
  return leftBytes.length === rightBytes.length && leftBytes.length > 0 && timingSafeEqual(leftBytes, rightBytes);
}
function requestToken(request) {
  const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('fh_session='));
  return cookie ? decodeURIComponent(cookie.slice('fh_session='.length)) : '';
}
function currentAccount(request) {
  const token = requestToken(request);
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const account = accounts.find(item => item.id === session.accountId && item.status === 'active');
  return account ?? null;
}
function createSession(response, account) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_MS;
  sessions.set(token, { accountId: account.id, expiresAt });
  response.setHeader('Set-Cookie', `fh_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
function requireAuth(request, response, next) {
  const account = currentAccount(request);
  if (!account) return response.status(401).json({ error: 'Sign in to continue.' });
  request.account = account;
  return next();
}
function requireHr(request, response, next) {
  if (request.account?.role !== 'hr') return response.status(403).json({ error: 'HR access is required.' });
  return next();
}
function limitAuthAttempts(request, response, next) {
  const key = request.ip || 'unknown';
  const record = attempts.get(key);
  if (record && record.resetAt > Date.now() && record.count >= 10) return response.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!record || record.resetAt <= Date.now()) attempts.set(key, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  else record.count += 1;
  return next();
}
function recordFailedAttempt(request) {
  const key = request.ip || 'unknown';
  const record = attempts.get(key) ?? { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  record.count += 1;
  attempts.set(key, record);
}
async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, salt, 64);
  return { salt, hash: Buffer.from(hash).toString('hex') };
}
async function passwordMatches(password, account) {
  const candidate = await scrypt(password, account.salt, 64);
  const expected = Buffer.from(account.passwordHash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

app.get('/api/auth/me', requireAuth, (request, response) => response.json({ account: publicAccount(request.account) }));
app.post('/api/auth/register', limitAuthAttempts, async (request, response) => {
  const username = String(request.body?.username ?? '').trim();
  const password = String(request.body?.password ?? '');
  const rpName = String(request.body?.rpName ?? '').trim();
  const requestedRole = String(request.body?.role ?? 'employee');
  const bootstrapCode = String(request.body?.bootstrapCode ?? '');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return response.status(400).json({ error: 'Username must be 3–32 characters using letters, numbers, dot, dash, or underscore.' });
  if (password.length < 12 || password.length > 128) return response.status(400).json({ error: 'Password must be between 12 and 128 characters.' });
  if (rpName.length < 2 || rpName.length > 60) return response.status(400).json({ error: 'RP name must be between 2 and 60 characters.' });
  if (!['employee', 'staff', 'hr'].includes(requestedRole)) return response.status(400).json({ error: 'Choose Employee, Staff, or HR.' });
  if (accounts.some(account => account.username.toLowerCase() === username.toLowerCase())) return response.status(409).json({ error: 'That username is already in use.' });

  const hasHr = accounts.some(account => account.role === 'hr' && account.status === 'active');
  const bootstrapAllowed = requestedRole === 'hr' && !hasHr && safeEqual(bootstrapCode, process.env.BOOTSTRAP_HR_CODE);
  if (requestedRole === 'hr' && !hasHr && !bootstrapAllowed) return response.status(403).json({ error: 'The first HR account requires the configured bootstrap code.' });
  const role = requestedRole;
  const status = requestedRole === 'employee' || bootstrapAllowed ? 'active' : 'pending';
  const { salt, hash } = await passwordHash(password);
  const account = { id: crypto.randomUUID(), username, rpName, salt, passwordHash: hash, role, requestedRole, status, createdAt: new Date().toISOString() };
  accounts.push(account);
  saveAccounts();

  if (status === 'pending') return response.status(202).json({ message: `Account created. Your ${requestedRole} access request is pending HR approval. You can sign in after it is approved.` });
  createSession(response, account);
  return response.status(201).json({ account: publicAccount(account) });
});
app.post('/api/auth/login', limitAuthAttempts, async (request, response) => {
  const username = String(request.body?.username ?? '').trim();
  const password = String(request.body?.password ?? '');
  const account = accounts.find(item => item.username.toLowerCase() === username.toLowerCase());
  if (!account || !(await passwordMatches(password, account))) {
    recordFailedAttempt(request);
    return response.status(401).json({ error: 'Username or password is incorrect.' });
  }
  if (account.status !== 'active') return response.status(403).json({ error: 'This account is pending HR approval.' });
  attempts.delete(request.ip || 'unknown');
  createSession(response, account);
  return response.json({ account: publicAccount(account) });
});
app.post('/api/auth/logout', (request, response) => {
  const token = requestToken(request);
  sessions.delete(token);
  response.setHeader('Set-Cookie', `fh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return response.status(204).end();
});
app.get('/api/hr/accounts', requireAuth, requireHr, (request, response) => response.json({ accounts: accounts.map(publicAccount) }));
app.post('/api/hr/accounts/:id/decision', requireAuth, requireHr, (request, response) => {
  const account = accounts.find(item => item.id === request.params.id);
  const decision = String(request.body?.decision ?? '');
  if (!account || account.status !== 'pending' || !['approve', 'deny'].includes(decision)) return response.status(400).json({ error: 'Pending account or decision is invalid.' });
  account.status = decision === 'approve' ? 'active' : 'denied';
  if (decision === 'approve') account.role = account.requestedRole;
  account.reviewedBy = request.account.id;
  account.reviewedAt = new Date().toISOString();
  saveAccounts();
  return response.json({ account: publicAccount(account) });
});
app.post('/api/hr/accounts/:id/role', requireAuth, requireHr, (request, response) => {
  const account = accounts.find(item => item.id === request.params.id);
  const role = String(request.body?.role ?? '');
  if (!account || !['employee', 'staff', 'hr'].includes(role)) return response.status(400).json({ error: 'Account or role is invalid.' });
  if (account.role === 'hr' && role !== 'hr' && accounts.filter(item => item.role === 'hr' && item.status === 'active').length <= 1) return response.status(409).json({ error: 'Keep at least one active HR account.' });
  account.role = role;
  account.requestedRole = role;
  account.status = 'active';
  account.updatedAt = new Date().toISOString();
  for (const [token, session] of sessions) if (session.accountId === account.id) sessions.delete(token);
  saveAccounts();
  return response.json({ account: publicAccount(account) });
});

app.use(express.static(path.join(__dirname, 'dist'), { index: false }));
app.use((request, response) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (!fs.existsSync(indexPath)) return response.status(503).send('Build the portal with npm run build first.');
  return response.sendFile(indexPath);
});

const port = Number(process.env.PORT || 4178);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
app.listen(port, host, () => console.log(`HR portal and account API listening on http://${host}:${port}`));
