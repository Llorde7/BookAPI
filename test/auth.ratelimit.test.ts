import './env-ratelimit.js';
import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { prisma } from '../src/db.js';
import { resetDb, startServer, uniqueEmail } from './helpers.js';

const { server, call } = startServer();
before(resetDb);
after(async () => {
  server.close();
  await prisma.$disconnect();
});

describe('auth rate limit (5 per 15 minutes per IP in this test)', () => {
  it('blocks the 6th attempt, even with the correct password, and sets Retry-After', async () => {
    const email = uniqueEmail();
    const reg = await call('POST', '/auth/register', {
      email,
      password: 'a-long-enough-pw',
      name: 'RL',
    }); // 1
    assert.equal(reg.status, 201);
    for (let i = 0; i < 4; i++) {
      assert.equal(
        (await call('POST', '/auth/login', { email, password: 'wrong-wrong' })).status,
        401,
      ); // 2..5
    }
    const blocked = await call('POST', '/auth/login', { email, password: 'a-long-enough-pw' }); // 6
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error, 'too_many_requests');
    assert.ok(blocked.headers.get('retry-after') || blocked.headers.get('ratelimit'));
  });

  it('register shares the same limit', async () => {
    assert.equal(
      (
        await call('POST', '/auth/register', {
          email: uniqueEmail(),
          password: 'a-long-enough-pw',
          name: 'RL',
        })
      ).status,
      429,
    );
  });

  it('does not limit other routes: /auth/me and /health still answer', async () => {
    assert.equal((await call('GET', '/auth/me')).status, 401);
    assert.equal((await call('GET', '/health')).status, 200);
  });
});
