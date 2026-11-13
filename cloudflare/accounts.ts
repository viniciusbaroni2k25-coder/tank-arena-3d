type Account = {
  username: string;
  nickname: string;
  salt: string;
  passwordHash: string;
  recoveryHashes: string[];
  recoveryAcknowledged: boolean;
  kills: number;
  crystals: number;
  createdAt: number;
};
type Session = { username: string; expiresAt: number };
type RateRecord = { count: number; expiresAt: number };

const SESSION_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(value: string): Uint8Array {
  return new Uint8Array(value.match(/.{2}/g)?.map(byte => Number.parseInt(byte, 16)) ?? []);
}
async function sha256(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
async function derivePassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBuffer = hexToBytes(salt).slice().buffer as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations: PASSWORD_ITERATIONS }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
function secureEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
function makeRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const random = crypto.getRandomValues(new Uint8Array(10));
    const hex = bytesToHex(random).toUpperCase();
    return `${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}-${hex.slice(15)}`;
  });
}
function normalizedCode(code: unknown): string {
  return typeof code === 'string' ? code.toUpperCase().replace(/[^A-F0-9]/g, '') : '';
}
function normalizedUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get('Cookie') ?? '';
  for (const item of raw.split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}
function json(body: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
function cookie(token: string, maxAge: number): string {
  return `tank_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && encoder.encode(value).length <= 256;
}
async function newSession(storage: DurableObjectStorage, username: string): Promise<string> {
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await sha256(token);
  await storage.put<Session>(`account-session:${digest}`, { username, expiresAt: Date.now() + SESSION_SECONDS * 1000 });
  return token;
}
async function sessionRecord(request: Request, storage: DurableObjectStorage): Promise<Session | null> {
  const token = cookieValue(request, 'tank_session');
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const key = `account-session:${await sha256(token)}`;
  const session = await storage.get<Session>(key);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { await storage.delete(key); return null; }
  return session;
}
export async function authenticatedAccount(request: Request, storage: DurableObjectStorage): Promise<Pick<Account, 'username' | 'nickname'> | null> {
  const session = await sessionRecord(request, storage);
  if (!session) return null;
  const account = await storage.get<Account>(`account:${session.username}`);
  return account ? { username: account.username, nickname: account.nickname } : null;
}
async function reserveAttempt(storage: DurableObjectStorage, key: string, max: number, windowMs: number): Promise<boolean> {
  return storage.transaction(async transaction => {
    const now = Date.now();
    const current = await transaction.get<RateRecord>(key);
    if (current && current.expiresAt > now && current.count >= max) return false;
    await transaction.put<RateRecord>(key, !current || current.expiresAt <= now
      ? { count: 1, expiresAt: now + windowMs }
      : { ...current, count: current.count + 1 });
    return true;
  });
}
async function accountBody(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('Content-Length') ?? 0) > 4096) return null;
  try {
    const raw = await request.text();
    if (encoder.encode(raw).length > 4096) return null;
    const body: unknown = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
}

export async function handleAccountRequest(request: Request, storage: DurableObjectStorage): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'Origem inválida.' }, 403);
  if (request.method === 'GET') {
    const user = await authenticatedAccount(request, storage);
    if (!user) return json({ user: null });
    const account = await storage.get<Account>(`account:${user.username}`);
    if (url.searchParams.get('view') === 'leaderboard') {
      const sort = url.searchParams.get('sort') === 'crystals' ? 'crystals' : 'rank';
      const records = await storage.list<Account>({ prefix: 'account:', limit: 1000 });
      const entries = [...records.values()].sort((a, b) =>
        sort === 'crystals' ? b.crystals - a.crystals || b.kills - a.kills : b.kills - a.kills || b.crystals - a.crystals
      ).slice(0, 50).map((entry, index) => ({
        place: index + 1, nickname: entry.nickname, kills: entry.kills, crystals: entry.crystals,
        rank: rankForKills(entry.kills), current: entry.username === user.username
      }));
      return json({ entries, sort });
    }
    return json({ user: account ? { ...user, kills: account.kills, crystals: account.crystals } : null, needsRecoveryCodes: account ? !account.recoveryAcknowledged : false });
  }
  if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);
  const body = await accountBody(request);
  if (!body) return json({ error: 'Requisição inválida.' }, 400);
  const action = body.action;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const username = normalizedUsername(body.username);
  const usernameHash = await sha256(username || 'missing-user');
  const ipHash = await sha256(ip);

  if (action === 'logout') {
    const token = cookieValue(request, 'tank_session');
    if (token && /^[a-f0-9]{64}$/i.test(token)) await storage.delete(`account-session:${await sha256(token)}`);
    return json({ ok: true }, 200, cookie('', 0));
  }

  if (action === 'register') {
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 20) : '';
    if (!/^[a-z0-9_]{3,20}$/.test(username) || nickname.length < 2 || !validPassword(body.password)) {
      return json({ error: 'Use usuário com 3–20 letras/números/_, apelido com 2–20 caracteres e senha com 12–128 caracteres.' }, 400);
    }
    const registerKey = `account-register:${ipHash}`;
    if (!await reserveAttempt(storage, registerKey, 10, 24 * 60 * 60 * 1000)) return json({ error: 'Limite diário de cadastros atingido. Tente novamente amanhã.' }, 429);
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const recoveryCodes = makeRecoveryCodes();
    const account: Account = {
      username, nickname, salt, passwordHash: await derivePassword(body.password, salt),
      recoveryHashes: await Promise.all(recoveryCodes.map(code => sha256(normalizedCode(code)))), recoveryAcknowledged: false,
      kills: 0, crystals: 500, createdAt: Date.now()
    };
    const created = await storage.transaction(async transaction => {
      if (await transaction.get<Account>(`account:${username}`)) return false;
      await transaction.put<Account>(`account:${username}`, account);
      return true;
    });
    if (!created) return json({ error: 'Esse nome de usuário já está em uso.' }, 409);
    const sessionToken = await newSession(storage, username);
    return json({ user: { username, nickname, kills: account.kills, crystals: account.crystals }, recoveryCodes }, 201, cookie(sessionToken, SESSION_SECONDS));
  }

  if (action === 'login') {
    const limitKey = `account-login:${ipHash}:${usernameHash}`;
    if (!await reserveAttempt(storage, limitKey, 8, 15 * 60 * 1000)) return json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' }, 429);
    const account = await storage.get<Account>(`account:${username}`);
    const candidateSalt = account?.salt ?? '00000000000000000000000000000000';
    const candidateHash = validPassword(body.password) ? await derivePassword(body.password, candidateSalt) : 'invalid';
    if (!account || !validPassword(body.password) || !secureEqual(candidateHash, account.passwordHash)) {
      return json({ error: 'Usuário ou senha incorretos.' }, 401);
    }
    await storage.delete(limitKey);
    const sessionToken = await newSession(storage, username);
    return json({ user: { username, nickname: account.nickname, kills: account.kills, crystals: account.crystals } }, 200, cookie(sessionToken, SESSION_SECONDS));
  }

  if (action === 'recover') {
    const limitKey = `account-recovery:${ipHash}:${usernameHash}`;
    if (!await reserveAttempt(storage, limitKey, 5, 15 * 60 * 1000)) return json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' }, 429);
    if (!validPassword(body.password)) return json({ error: 'A nova senha precisa ter de 12 a 128 caracteres.' }, 400);
    const code = normalizedCode(body.recoveryCode);
    const codeHash = await sha256(code || 'invalid-recovery-code');
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const recoveryCodes = makeRecoveryCodes();
    const passwordHash = await derivePassword(body.password, salt);
    const recoveryHashes = await Promise.all(recoveryCodes.map(value => sha256(normalizedCode(value))));
    const account = await storage.transaction(async transaction => {
      const current = await transaction.get<Account>(`account:${username}`);
      if (!current || !current.recoveryHashes.some(saved => secureEqual(saved, codeHash))) return null;
      current.salt = salt;
      current.passwordHash = passwordHash;
      current.recoveryHashes = recoveryHashes;
      current.recoveryAcknowledged = false;
      await transaction.put<Account>(`account:${username}`, current);
      return current;
    });
    if (!account) return json({ error: 'Usuário ou código de recuperação inválido.' }, 401);
    await storage.delete(limitKey);
    const sessions = await storage.list<Session>({ prefix: 'account-session:', limit: 1000 });
    for (const [key, session] of sessions) if (session.username === username) await storage.delete(key);
    const sessionToken = await newSession(storage, username);
    return json({ user: { username, nickname: account.nickname, kills: account.kills, crystals: account.crystals }, recoveryCodes }, 200, cookie(sessionToken, SESSION_SECONDS));
  }
  if (action === 'rotate-codes' || action === 'confirm-codes') {
    const session = await sessionRecord(request, storage);
    if (!session) return json({ error: 'Entre novamente na sua conta.' }, 401);
    const account = await storage.get<Account>(`account:${session.username}`);
    if (!account) return json({ error: 'Conta não encontrada.' }, 401);
    if (action === 'rotate-codes') {
      const recoveryCodes = makeRecoveryCodes();
      account.recoveryHashes = await Promise.all(recoveryCodes.map(code => sha256(normalizedCode(code))));
      account.recoveryAcknowledged = false;
      await storage.put<Account>(`account:${session.username}`, account);
      return json({ recoveryCodes });
    }
    account.recoveryAcknowledged = true;
    await storage.put<Account>(`account:${session.username}`, account);
    return json({ ok: true });
  }
  return json({ error: 'Ação desconhecida.' }, 400);
}

const rankNames = ['Recruta', 'Soldado', 'Cabo', 'Sargento', 'Tenente', 'Capitão', 'Major', 'Coronel', 'General'];
const rankThresholds = [0, 5, 15, 30, 50, 80, 120, 175, 250];
function rankForKills(kills: number): string {
  let rank = 0;
  for (let i = 0; i < rankThresholds.length; i++) if (kills >= rankThresholds[i]) rank = i;
  return rankNames[rank];
}
