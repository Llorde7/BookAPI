import './setup.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/db.js';
import { resetDb, startServer, uniqueEmail } from './helpers.js';

const { server, call } = startServer();
const PW = 'correct horse battery staple';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const register = (email: string) =>
  call('POST', '/auth/register', { email, password: PW, name: 'R' });
const login = (email: string) => call('POST', '/auth/login', { email, password: PW });
const refresh = (refreshToken: unknown) => call('POST', '/auth/refresh', { refreshToken });
const logout = (refreshToken: unknown) => call('POST', '/auth/logout', { refreshToken });
const me = (token: string) =>
  call('GET', '/auth/me', undefined, { authorization: `Bearer ${token}` });

async function session() {
  const email = uniqueEmail('rt');
  const reg = await register(email);
  assert.equal(reg.status, 201);
  const l = await login(email);
  assert.equal(l.status, 200);
  return {
    email,
    id: reg.json.id as string,
    access: l.json.accessToken as string,
    refresh: l.json.refreshToken as string,
  };
}
const rowFor = (token: string) =>
  prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });

before(resetDb);
after(async () => {
  server.close();
  await prisma.$disconnect();
});

describe('login issues a refresh token', () => {
  it('returns an access token and a 256-bit opaque refresh token', async () => {
    const s = await session();
    assert.match(s.refresh, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(jwt.decode(s.refresh), null, 'it is random, not a JWT');
    const l = await login(s.email);
    assert.deepEqual(Object.keys(l.json).sort(), [
      'accessToken',
      'expiresIn',
      'refreshToken',
      'tokenType',
    ]);
    assert.equal(l.headers.get('cache-control'), 'no-store');
  });

  it('stores only the SHA-256 hash, never the token', async () => {
    const s = await session();
    const row = await rowFor(s.refresh);
    assert.ok(row);
    assert.equal(row.tokenHash, sha256(s.refresh));
    const all = await prisma.refreshToken.findMany();
    assert.ok(all.every((r) => r.tokenHash !== s.refresh && !r.tokenHash.includes(s.refresh)));
  });

  it('expires in 30 days by default and starts unrevoked', async () => {
    const s = await session();
    const row = (await rowFor(s.refresh))!;
    assert.equal(row.revokedAt, null);
    const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.99 && days <= 30, `days=${days}`);
  });

  it('every login is its own session with a different token', async () => {
    const s = await session();
    const second = await login(s.email);
    assert.notEqual(second.json.refreshToken, s.refresh);
    assert.equal(await prisma.refreshToken.count({ where: { customerId: s.id } }), 2);
  });

  it('a failed login issues nothing', async () => {
    const s = await session();
    const before = await prisma.refreshToken.count({ where: { customerId: s.id } });
    await call('POST', '/auth/login', { email: s.email, password: 'wrong password!' });
    assert.equal(await prisma.refreshToken.count({ where: { customerId: s.id } }), before);
  });
});

describe('POST /auth/refresh', () => {
  it('returns a new access token and a new refresh token for the same customer', async () => {
    const s = await session();
    const r = await refresh(s.refresh);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.notEqual(r.json.refreshToken, s.refresh);
    assert.equal(r.json.expiresIn, 900);
    const who = await me(r.json.accessToken);
    assert.equal(who.status, 200);
    assert.equal(who.json.customer.id, s.id);
  });

  it('rotates: the old token is revoked, the new one is stored and usable', async () => {
    const s = await session();
    const r = await refresh(s.refresh);
    assert.ok((await rowFor(s.refresh))!.revokedAt);
    assert.equal((await rowFor(r.json.refreshToken))!.revokedAt, null);
    assert.equal((await refresh(r.json.refreshToken)).status, 200, 'chains');
  });

  it('REUSE: replaying a used token fails AND ends every session of that customer', async () => {
    const s = await session();
    const other = await login(s.email); // a second device
    const r1 = await refresh(s.refresh);
    assert.equal(r1.status, 200);
    const replay = await refresh(s.refresh); // the old token shows up again
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error, 'invalid_refresh_token');
    assert.equal((await refresh(r1.json.refreshToken)).status, 401, 'the newest token is dead too');
    assert.equal((await refresh(other.json.refreshToken)).status, 401, 'so is the other device');
    assert.equal(
      await prisma.refreshToken.count({ where: { customerId: s.id, revokedAt: null } }),
      0,
    );
  });

  it('reuse by one customer never affects another customer', async () => {
    const a = await session(),
      b = await session();
    await refresh(a.refresh);
    await refresh(a.refresh); // reuse -> a's sessions end
    assert.equal((await refresh(b.refresh)).status, 200);
  });

  it('unknown, garbage and reused tokens all get the same 401 (no oracle)', async () => {
    const s = await session();
    await refresh(s.refresh);
    const reused = await refresh(s.refresh);
    const unknown = await refresh('A'.repeat(43));
    const garbage = await refresh('not a token at all');
    assert.equal(reused.status, 401);
    assert.equal(reused.text, unknown.text);
    assert.equal(unknown.text, garbage.text);
    assert.deepEqual(unknown.json, {
      error: 'invalid_refresh_token',
      message: 'Invalid refresh token',
    });
  });

  it('an expired refresh token is rejected, without ending other sessions', async () => {
    const s = await session();
    const other = await login(s.email);
    await prisma.refreshToken.update({
      where: { tokenHash: sha256(s.refresh) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const r = await refresh(s.refresh);
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'invalid_refresh_token');
    assert.equal((await refresh(other.json.refreshToken)).status, 200, 'expiry is not theft');
  });

  it('an access token is not accepted as a refresh token, nor the reverse', async () => {
    const s = await session();
    assert.equal((await refresh(s.access)).status, 401);
    assert.equal((await me(s.refresh)).status, 401);
    const asBearer = await me(s.refresh);
    assert.equal(asBearer.json.error, 'invalid_token');
  });

  it('simultaneous refreshes with one token: exactly one succeeds', async () => {
    const s = await session();
    const replies = await Promise.all(Array.from({ length: 6 }, () => refresh(s.refresh)));
    const statuses = replies.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 401, 401, 401, 401, 401]);
  });

  it('validates the body: 400 for missing, empty, non-string and oversized tokens', async () => {
    assert.equal((await call('POST', '/auth/refresh')).status, 400);
    assert.equal((await call('POST', '/auth/refresh', {})).status, 400);
    assert.equal((await refresh('')).status, 400);
    for (const bad of [null, 123, true, ['x'], { a: 1 }])
      assert.equal((await refresh(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await refresh('x'.repeat(513))).status, 400);
    assert.equal((await call('POST', '/auth/refresh', '{nope')).status, 400);
  });

  it('is not tricked by SQL-looking tokens', async () => {
    const r = await refresh(`' OR '1'='1`);
    assert.equal(r.status, 401);
    assert.ok((await prisma.refreshToken.count()) > 0);
  });

  it('a deleted customer can no longer refresh (tokens cascade away)', async () => {
    const s = await session();
    await prisma.customer.delete({ where: { id: s.id } });
    assert.equal(await rowFor(s.refresh), null);
    assert.equal((await refresh(s.refresh)).status, 401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token and answers 204 with no body', async () => {
    const s = await session();
    const out = await logout(s.refresh);
    assert.equal(out.status, 204);
    assert.equal(out.text, '');
    assert.ok((await rowFor(s.refresh))!.revokedAt);
    assert.equal((await refresh(s.refresh)).status, 401);
  });

  it('works without an access token (it may have expired)', async () => {
    const s = await session();
    const out = await call('POST', '/auth/logout', { refreshToken: s.refresh }); // no Authorization header
    assert.equal(out.status, 204);
  });

  it("only ends that session; the same customer's other devices stay logged in", async () => {
    const s = await session();
    const other = await login(s.email);
    await logout(s.refresh);
    assert.equal((await refresh(other.json.refreshToken)).status, 200);
  });

  it('is idempotent and reveals nothing: unknown and repeated tokens also give 204', async () => {
    const s = await session();
    assert.equal((await logout(s.refresh)).status, 204);
    assert.equal((await logout(s.refresh)).status, 204);
    assert.equal((await logout('A'.repeat(43))).status, 204);
    assert.equal((await logout('garbage')).status, 204);
  });

  it('a repeated logout does not trigger reuse detection against other sessions', async () => {
    const s = await session();
    const other = await login(s.email);
    await logout(s.refresh);
    await logout(s.refresh);
    assert.equal((await refresh(other.json.refreshToken)).status, 200);
  });

  it('validates the body: 400 without a refresh token', async () => {
    assert.equal((await call('POST', '/auth/logout')).status, 400);
    assert.equal((await logout(42)).status, 400);
    assert.equal((await logout('')).status, 400);
  });

  it('KNOWN LIMITATION: an access token already issued keeps working until it expires', async () => {
    const s = await session();
    await logout(s.refresh);
    assert.equal((await me(s.access)).status, 200);
  });
});

describe('requireAuth around refresh', () => {
  it('tells an expired access token apart from a bad one', async () => {
    const s = await session();
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = jwt.sign({ iat: past - 900, exp: past }, process.env.JWT_SECRET!, {
      subject: s.id,
      issuer: 'bookapi',
      audience: 'bookapi',
    });
    const e = await me(expired);
    assert.equal(e.json.error, 'token_expired');
    assert.match(e.headers.get('www-authenticate')!, /error="invalid_token".*expired/);
    const bad = await me(expired.slice(0, -3) + 'abc');
    assert.equal(bad.json.error, 'invalid_token');
    assert.doesNotMatch(bad.headers.get('www-authenticate')!, /expired/);
  });

  it('the full cycle: expired access token -> refresh -> request works again', async () => {
    const s = await session();
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = jwt.sign({ iat: past - 900, exp: past }, process.env.JWT_SECRET!, {
      subject: s.id,
      issuer: 'bookapi',
      audience: 'bookapi',
    });
    assert.equal((await me(expired)).json.error, 'token_expired');
    const r = await refresh(s.refresh);
    assert.equal((await me(r.json.accessToken)).status, 200);
  });
});
