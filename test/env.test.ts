// No database needed: validates startup config, the error helper and the boot sequence.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { ZodError, z } from 'zod';
import { JWT_SECRET_PLACEHOLDER, loadAuthEnv } from '../src/env.js';
import { HttpError, errorHandler, notFound } from '../src/errors.js';

const SECRET = 'a'.repeat(32);

describe('loadAuthEnv (JWT_SECRET validation)', () => {
  it('accepts a 32-character secret and defaults the TTL to 15 minutes', () => {
    const env = loadAuthEnv({ JWT_SECRET: SECRET });
    assert.equal(env.JWT_SECRET, SECRET);
    assert.equal(env.ACCESS_TOKEN_TTL_SECONDS, 900);
  });

  it('rejects a missing secret', () => {
    assert.throws(() => loadAuthEnv({}), /JWT_SECRET: is required/);
  });

  it('rejects an empty secret', () => {
    assert.throws(() => loadAuthEnv({ JWT_SECRET: '' }), /JWT_SECRET: must be at least 32/);
  });

  it('rejects 31 characters but accepts exactly 32', () => {
    assert.throws(() => loadAuthEnv({ JWT_SECRET: 'a'.repeat(31) }), /at least 32/);
    assert.doesNotThrow(() => loadAuthEnv({ JWT_SECRET: 'a'.repeat(32) }));
  });

  it('never puts the secret in the error message', () => {
    const weak = 'super-secret-short';
    try {
      loadAuthEnv({ JWT_SECRET: weak });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(!(err as Error).message.includes(weak));
    }
  });

  it('rejects the .env.example placeholder in production only', () => {
    assert.throws(
      () => loadAuthEnv({ JWT_SECRET: JWT_SECRET_PLACEHOLDER, NODE_ENV: 'production' }),
      /placeholder/,
    );
    assert.doesNotThrow(() =>
      loadAuthEnv({ JWT_SECRET: JWT_SECRET_PLACEHOLDER, NODE_ENV: 'development' }),
    );
  });

  it('validates the token lifetime: whole seconds between 1 and 3600', () => {
    for (const bad of ['0', '-5', '3601', '1.5', 'abc', '']) {
      assert.throws(
        () => loadAuthEnv({ JWT_SECRET: SECRET, ACCESS_TOKEN_TTL_SECONDS: bad }),
        /ACCESS_TOKEN_TTL_SECONDS/,
        `ttl=${bad}`,
      );
    }
    for (const good of ['1', '900', '3600']) {
      assert.equal(
        loadAuthEnv({ JWT_SECRET: SECRET, ACCESS_TOKEN_TTL_SECONDS: good })
          .ACCESS_TOKEN_TTL_SECONDS,
        Number(good),
      );
    }
  });

  it('reports every problem at once', () => {
    assert.throws(
      () => loadAuthEnv({ JWT_SECRET: 'short', ACCESS_TOKEN_TTL_SECONDS: '99999' }),
      (err: Error) =>
        /JWT_SECRET/.test(err.message) && /ACCESS_TOKEN_TTL_SECONDS/.test(err.message),
    );
  });
});

describe('boot: the app refuses to start without a valid JWT_SECRET', () => {
  // DOTENV_CONFIG_PATH stops the developer's real .env from supplying a secret.
  const run = (extra: Record<string, string>, killAfterMs?: number) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        env: {
          PATH: process.env.PATH ?? '',
          DOTENV_CONFIG_PATH: '/nonexistent',
          PORT: '0',
          ...extra,
        },
      });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        if (killAfterMs !== undefined && out.includes('listening')) child.kill('SIGTERM');
      });
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
      setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
    });

  it('exits non-zero with a clear message when JWT_SECRET is missing', async () => {
    const { code, out } = await run({});
    assert.notEqual(code, 0);
    assert.match(out, /JWT_SECRET: is required/);
    assert.doesNotMatch(out, /listening/);
  });

  it('exits non-zero when JWT_SECRET is shorter than 32 characters', async () => {
    const { code, out } = await run({ JWT_SECRET: 'x'.repeat(31) });
    assert.notEqual(code, 0);
    assert.match(out, /at least 32 characters/);
    assert.doesNotMatch(out, /listening/);
  });

  it('starts when JWT_SECRET is valid', async () => {
    const { out } = await run({ JWT_SECRET: SECRET }, 1);
    assert.match(out, /listening/);
  });
});

// A minimal fake of Express's response object.
function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}
const handle = (err: unknown) => {
  const res = fakeRes();
  errorHandler(err, {} as never, res as never, () => {});
  return res;
};

describe('error helper', () => {
  it('HttpError becomes its status, code and message', () => {
    const res = handle(new HttpError(409, 'email_taken', 'Taken'));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: 'email_taken', message: 'Taken' });
  });

  it('ZodError becomes a 400 listing the fields', () => {
    const parsed = z.object({ email: z.email() }).safeParse({ email: 'nope' });
    assert.ok(parsed.error instanceof ZodError);
    const res = handle(parsed.error);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(
      (res.body as { details: { field: string }[] }).details.map((d) => d.field),
      ['email'],
    );
  });

  it('a malformed-body error (status 4xx from express.json) becomes 400 without details', () => {
    const res = handle(
      Object.assign(new SyntaxError('Unexpected token } in JSON at position 5'), { status: 400 }),
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'bad_request', message: 'Malformed request' });
  });

  it('an unknown error becomes a generic 500 that leaks nothing', () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const res = handle(new Error('connection to db at 10.0.0.5 failed: password=hunter2'));
      assert.equal(res.statusCode, 500);
      assert.ok(!JSON.stringify(res.body).includes('hunter2'));
      assert.deepEqual(res.body, { error: 'internal_error', message: 'Something went wrong' });
    } finally {
      console.error = quiet;
    }
  });

  it('copes with non-Error throwables (null, strings)', () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.equal(handle(null).statusCode, 500);
      assert.equal(handle('boom').statusCode, 500);
    } finally {
      console.error = quiet;
    }
  });

  it('notFound returns a JSON 404', () => {
    const res = fakeRes();
    notFound({} as never, res as never, () => {});
    assert.equal(res.statusCode, 404);
  });
});
