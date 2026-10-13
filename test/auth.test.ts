import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { signAccessToken } from '../src/auth/tokens.js';
import { prisma } from '../src/db.js';
import { resetDb, startServer, uniqueEmail } from './helpers.js';

const { server, call } = startServer();
const SECRET = process.env.JWT_SECRET!;
const PW = 'correct horse battery staple';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

const register = (over: Record<string, unknown> = {}) =>
  call('POST', '/auth/register', {
    email: uniqueEmail(),
    password: PW,
    name: 'Test User',
    ...over,
  });
const login = (email: unknown, password: unknown) =>
  call('POST', '/auth/login', { email, password });
const me = (token?: string, scheme = 'Bearer') =>
  call(
    'GET',
    '/auth/me',
    undefined,
    token === undefined ? {} : { authorization: `${scheme} ${token}` },
  );

async function newUser() {
  const email = uniqueEmail('login');
  const r = await register({ email });
  assert.equal(r.status, 201);
  const l = await login(email, PW);
  assert.equal(l.status, 200);
  return { email, id: r.json.id as string, token: l.json.accessToken as string };
}

before(resetDb);
after(async () => {
  server.close();
  await prisma.$disconnect();
});

describe('POST /auth/register', () => {
  it('creates the account and returns exactly { id, email }', async () => {
    const email = uniqueEmail();
    const r = await register({ email });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json).sort(), ['email', 'id']);
    assert.equal(r.json.email, email);
    assert.match(r.json.id, /^[0-9a-f-]{36}$/);
  });

  it('never returns the hash or the password, in any form', async () => {
    const r = await register({ password: 'unique-needle-password-1' });
    assert.ok(!/passwordHash|argon2|unique-needle/i.test(r.text));
  });

  it('stores an Argon2id hash, not the password', async () => {
    const email = uniqueEmail();
    await register({ email, password: 'stored-as-hash-123' });
    const row = await prisma.customer.findUniqueOrThrow({ where: { email } });
    assert.match(row.passwordHash!, /^\$argon2id\$/);
    assert.ok(!row.passwordHash!.includes('stored-as-hash-123'));
  });

  it('hashes with a fresh salt: same password, different hashes', async () => {
    const a = uniqueEmail(),
      b = uniqueEmail();
    await register({ email: a });
    await register({ email: b });
    const rows = await prisma.customer.findMany({ where: { email: { in: [a, b] } } });
    assert.notEqual(rows[0]!.passwordHash, rows[1]!.passwordHash);
  });

  it('trims and lowercases the email before saving', async () => {
    const base = uniqueEmail('mixed');
    const r = await register({ email: `   ${base.toUpperCase()}  ` });
    assert.equal(r.status, 201);
    assert.equal(r.json.email, base);
    const row = await prisma.customer.findUnique({ where: { email: base } });
    assert.ok(row, 'row is stored under the normalised email');
  });

  it('rejects a duplicate email with 409, ignoring case and surrounding spaces', async () => {
    const email = uniqueEmail('dup');
    assert.equal((await register({ email })).status, 201);
    for (const variant of [email, email.toUpperCase(), `  ${email}  `]) {
      const r = await register({ email: variant });
      assert.equal(r.status, 409, variant);
      assert.equal(r.json.error, 'email_taken');
    }
  });

  it('only one of many simultaneous registrations for the same email wins', async () => {
    const email = uniqueEmail('race');
    const replies = await Promise.all(Array.from({ length: 6 }, () => register({ email })));
    const statuses = replies.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
    assert.equal(await prisma.customer.count({ where: { email } }), 1);
  });

  it('accepts plus-addressing and subdomains', async () => {
    assert.equal((await register({ email: `me+tag${Date.now()}@mail.example.co.uk` })).status, 201);
  });

  it('rejects invalid emails with 400', async () => {
    const bad = [
      '',
      '   ',
      'plain',
      'no-at.example.com',
      '@example.com',
      'a@',
      'a b@example.com',
      'a@@example.com',
      `${'x'.repeat(250)}@example.com`,
    ];
    for (const email of bad) {
      const r = await register({ email });
      assert.equal(r.status, 400, JSON.stringify(email));
      assert.equal(r.json.error, 'validation_error');
    }
  });

  it('rejects non-string emails and passwords', async () => {
    for (const email of [null, 42, true, ['a@b.co'], { a: 1 }])
      assert.equal((await register({ email })).status, 400);
    for (const password of [null, 12345678, true, ['password'], { a: 1 }])
      assert.equal((await register({ password })).status, 400);
  });

  it('enforces password length: 8 to 128 characters', async () => {
    assert.equal((await register({ password: 'x'.repeat(7) })).status, 400);
    assert.equal((await register({ password: 'x'.repeat(8) })).status, 201);
    assert.equal((await register({ password: 'x'.repeat(128) })).status, 201);
    assert.equal((await register({ password: 'x'.repeat(129) })).status, 400);
    assert.equal((await register({ password: '' })).status, 400);
  });

  it('does not trim or alter the password (spaces and unicode count)', async () => {
    const email = uniqueEmail('spaces');
    const pw = '  padded pässwörd 日本語 🔑  ';
    assert.equal((await register({ email, password: pw })).status, 201);
    assert.equal((await login(email, pw)).status, 200);
    assert.equal((await login(email, pw.trim())).status, 401);
  });

  it('requires a name (the Customer table needs one)', async () => {
    assert.equal(
      (await call('POST', '/auth/register', { email: uniqueEmail(), password: PW })).status,
      400,
    );
    assert.equal((await register({ name: '   ' })).status, 400);
  });

  it('ignores extra fields: a client cannot set its own id or hash', async () => {
    const email = uniqueEmail('extra');
    const evilId = '00000000-0000-7000-8000-00000000dead';
    const r = await register({ email, id: evilId, passwordHash: 'x', role: 'admin' });
    assert.equal(r.status, 201);
    assert.notEqual(r.json.id, evilId);
    const row = await prisma.customer.findUniqueOrThrow({ where: { email } });
    assert.match(row.passwordHash!, /^\$argon2id\$/);
  });

  it('rejects bad bodies: nothing, empty, array, malformed JSON, wrong content type', async () => {
    assert.equal((await call('POST', '/auth/register')).status, 400);
    assert.equal((await call('POST', '/auth/register', {})).status, 400);
    assert.equal((await call('POST', '/auth/register', [])).status, 400);
    const malformed = await call('POST', '/auth/register', '{"email": ');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error, 'bad_request');
    const plain = await call('POST', '/auth/register', 'email=a@b.co&password=12345678', {
      'content-type': 'text/plain',
    });
    assert.equal(plain.status, 400);
  });

  it('does not leak internals on errors', async () => {
    const r = await call('POST', '/auth/register', '{bad json');
    assert.ok(!/node_modules|\sat\s|Error:/.test(r.text));
  });

  it('stores an optional phone', async () => {
    const email = uniqueEmail('phone');
    await register({ email, phone: ' +1 555 0100 ' });
    assert.equal(
      (await prisma.customer.findUniqueOrThrow({ where: { email } })).phone,
      '+1 555 0100',
    );
  });
});

describe('POST /auth/login', () => {
  it('returns a Bearer access token valid for 15 minutes', async () => {
    const { token, email } = await newUser();
    const r = await login(email, PW);
    assert.equal(r.status, 200);
    assert.equal(r.json.tokenType, 'Bearer');
    assert.equal(r.json.expiresIn, 900);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(token.split('.').length === 3);
  });

  it('signs an HS256 JWT with the customer id, issuer, audience and exactly 900s lifetime', async () => {
    const { token, id } = await newUser();
    const { header, payload } = jwt.decode(token, { complete: true }) as {
      header: { alg: string };
      payload: jwt.JwtPayload;
    };
    assert.equal(header.alg, 'HS256');
    assert.equal(payload.sub, id);
    assert.equal(payload.iss, 'bookapi');
    assert.equal(payload.aud, 'bookapi');
    assert.equal(payload.exp! - payload.iat!, 900);
    assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'sub']);
    assert.doesNotThrow(() => jwt.verify(token, SECRET, { algorithms: ['HS256'] }));
  });

  it('a token does not contain the password, hash or email', async () => {
    const { token, email } = await newUser();
    const decoded = Buffer.from(token.split('.')[1]!, 'base64url').toString();
    assert.ok(!/password|argon2|@/i.test(decoded) && !decoded.includes(email));
  });

  it('wrong password and unknown email return the SAME 401 body: "Invalid credentials"', async () => {
    const { email } = await newUser();
    const wrong = await login(email, 'definitely not it');
    const unknown = await login(uniqueEmail('ghost'), 'definitely not it');
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.text, unknown.text);
    assert.deepEqual(wrong.json, { error: 'invalid_credentials', message: 'Invalid credentials' });
    assert.ok(!('accessToken' in wrong.json));
  });

  it('is case- and whitespace-insensitive for the email, but exact for the password', async () => {
    const { email } = await newUser();
    assert.equal((await login(`  ${email.toUpperCase()} `, PW)).status, 200);
    assert.equal((await login(email, PW.toUpperCase())).status, 401);
    assert.equal((await login(email, `${PW} `)).status, 401);
  });

  it('returns 401 for accounts that cannot log in: placeholder hash and no hash', async () => {
    await prisma.customer.create({
      data: {
        email: 'seeded@example.com',
        name: 'Seeded',
        passwordHash: 'PLACEHOLDER_PASSWORD_HASH',
      },
    });
    await prisma.customer.create({ data: { email: 'guest@example.com', name: 'Guest' } });
    assert.equal((await login('seeded@example.com', 'PLACEHOLDER_PASSWORD_HASH')).status, 401);
    assert.equal((await login('guest@example.com', 'anything at all')).status, 401);
    assert.equal((await login('guest@example.com', '')).status, 400);
  });

  it('validates the input: 400, not 401 or 500', async () => {
    assert.equal((await login('not-an-email', PW)).status, 400);
    assert.equal((await login('', PW)).status, 400);
    assert.equal((await login(undefined, PW)).status, 400);
    assert.equal((await login(uniqueEmail(), '')).status, 400);
    assert.equal((await login(uniqueEmail(), undefined)).status, 400);
    assert.equal((await login(uniqueEmail(), 123456)).status, 400);
    assert.equal((await login(null, null)).status, 400);
    assert.equal((await call('POST', '/auth/login')).status, 400);
    assert.equal((await call('POST', '/auth/login', '{nope')).status, 400);
  });

  it('rejects a 129+ character password with 400 instead of hashing it', async () => {
    assert.equal((await login(uniqueEmail(), 'x'.repeat(129))).status, 400);
    assert.equal((await login(uniqueEmail(), 'x'.repeat(100_000))).status, 400);
  });

  it('treats SQL-looking input as data: 401/400, never 500', async () => {
    for (const email of [
      `o'brien${Date.now()}@example.com`,
      `a"; DROP TABLE "Customer"; --@example.com`,
      "' OR '1'='1",
    ]) {
      const r = await login(email, PW);
      assert.ok(r.status === 401 || r.status === 400, `${email} -> ${r.status}`);
    }
    assert.ok((await prisma.customer.count()) > 0, 'the table still exists');
  });

  it("does not log in one user with another user's password", async () => {
    const a = await newUser();
    const b = uniqueEmail('other');
    await register({ email: b, password: 'a-completely-different-pw' });
    assert.equal((await login(b, PW)).status, 401);
    assert.equal((await login(a.email, 'a-completely-different-pw')).status, 401);
  });

  it('issues a new token on each login (they differ once the second ticks over)', async () => {
    const { email } = await newUser();
    const first = await login(email, PW);
    await new Promise((r) => setTimeout(r, 1100)); // iat has 1 second resolution
    const second = await login(email, PW);
    assert.notEqual(first.json.accessToken, second.json.accessToken);
  });
});

describe('access tokens on GET /auth/me', () => {
  it('a fresh token reaches the account, with no hash in the response', async () => {
    const { token, id, email } = await newUser();
    const r = await me(token);
    assert.equal(r.status, 200);
    assert.equal(r.json.customer.id, id);
    assert.equal(r.json.customer.email, email);
    assert.ok(!/passwordHash|argon2/.test(r.text));
  });

  it('accepts the scheme case-insensitively', async () => {
    const { token } = await newUser();
    assert.equal((await me(token, 'bearer')).status, 200);
    assert.equal((await me(token, 'BEARER')).status, 200);
  });

  it('rejects a missing header, wrong scheme, empty token and garbage', async () => {
    const { token } = await newUser();
    const none = await me();
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await me(token, 'Basic')).status, 401);
    assert.equal((await me('', 'Bearer')).status, 401);
    const bad = await me('abc.def.ghi');
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'invalid_token');
    assert.equal((await me('not-a-jwt')).status, 401);
    assert.equal((await call('GET', '/auth/me', undefined, { authorization: token })).status, 401);
  });

  it('rejects a token with a tampered payload (user id swapped)', async () => {
    const a = await newUser(),
      b = await newUser();
    const [h, , s] = a.token.split('.');
    const forged = `${h}.${b64({ sub: b.id, iss: 'bookapi', aud: 'bookapi', iat: 1, exp: 9999999999 })}.${s}`;
    assert.equal((await me(forged)).status, 401);
  });

  it('rejects a token with the signature stripped or flipped', async () => {
    const { token } = await newUser();
    const [h, p, s] = token.split('.');
    assert.equal((await me(`${h}.${p}.`)).status, 401);
    const flipped = s!.slice(0, -2) + (s!.endsWith('AA') ? 'BB' : 'AA');
    assert.equal((await me(`${h}.${p}.${flipped}`)).status, 401);
  });

  it('rejects alg:none forgeries', async () => {
    const { id } = await newUser();
    const body = b64({ sub: id, iss: 'bookapi', aud: 'bookapi', iat: 1, exp: 9999999999 });
    for (const alg of ['none', 'None', 'NONE']) {
      assert.equal((await me(`${b64({ alg, typ: 'JWT' })}.${body}.`)).status, 401, alg);
    }
  });

  it('rejects other algorithms even when signed with the right secret (HS512)', async () => {
    const { id } = await newUser();
    const t = jwt.sign({}, SECRET, {
      algorithm: 'HS512',
      subject: id,
      issuer: 'bookapi',
      audience: 'bookapi',
      expiresIn: 600,
    });
    assert.equal((await me(t)).status, 401);
  });

  it('rejects tokens signed with a different secret', async () => {
    const { id } = await newUser();
    const t = jwt.sign({}, 'y'.repeat(48), {
      subject: id,
      issuer: 'bookapi',
      audience: 'bookapi',
      expiresIn: 600,
    });
    assert.equal((await me(t)).status, 401);
  });

  it('rejects the wrong issuer or audience', async () => {
    const { id } = await newUser();
    const mk = (iss: string, aud: string) =>
      jwt.sign({}, SECRET, { subject: id, issuer: iss, audience: aud, expiresIn: 600 });
    assert.equal((await me(mk('evil', 'bookapi'))).status, 401);
    assert.equal((await me(mk('bookapi', 'other-app'))).status, 401);
    assert.equal((await me(mk('bookapi', 'bookapi'))).status, 200);
  });

  it('rejects tokens with no expiry or no subject', async () => {
    const { id } = await newUser();
    const noExp = jwt.sign({}, SECRET, { subject: id, issuer: 'bookapi', audience: 'bookapi' });
    const noSub = jwt.sign({}, SECRET, { issuer: 'bookapi', audience: 'bookapi', expiresIn: 600 });
    assert.equal((await me(noExp)).status, 401);
    assert.equal((await me(noSub)).status, 401);
  });

  it('rejects an already-expired token', async () => {
    const { id } = await newUser();
    const past = Math.floor(Date.now() / 1000) - 60;
    const t = jwt.sign({ iat: past - 900, exp: past }, SECRET, {
      subject: id,
      issuer: 'bookapi',
      audience: 'bookapi',
    });
    const r = await me(t);
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'token_expired');
    assert.match(r.headers.get('www-authenticate') ?? '', /expired/);
  });

  it('a short-lived token works, then stops working after it expires', async () => {
    const { id } = await newUser();
    const t = signAccessToken(id, 1);
    assert.equal((await me(t)).status, 200);
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal((await me(t)).status, 401);
  });

  it('rejects a valid token whose account was deleted', async () => {
    const { id, token } = await newUser();
    assert.equal((await me(token)).status, 200);
    await prisma.customer.delete({ where: { id } });
    assert.equal((await me(token)).status, 401);
  });

  it('rejects a well-formed token for an id that never existed', async () => {
    assert.equal((await me(signAccessToken('00000000-0000-7000-8000-0000000000ff'))).status, 401);
  });
});

describe('the app around auth', () => {
  it('unknown routes return a JSON 404', async () => {
    const r = await call('GET', '/definitely/not/here');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not_found');
  });

  it('does not advertise Express', async () => {
    assert.equal((await call('GET', '/health')).headers.get('x-powered-by'), null);
  });

  it('/health reports the database as up', async () => {
    const r = await call('GET', '/health');
    assert.deepEqual(r.json, { status: 'ok', db: 'up' });
  });

  it('wrong HTTP methods on auth routes are 404, not a crash', async () => {
    assert.equal((await call('GET', '/auth/login')).status, 404);
    assert.equal((await call('PUT', '/auth/register', {})).status, 404);
  });
});
