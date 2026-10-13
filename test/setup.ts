// Import this FIRST in every DB test file. It points the app at the test database
// and refuses to run against anything else, because the tests wipe all tables.
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'Set TEST_DATABASE_URL to a database whose name contains "test", ' +
      'e.g. postgres://bookapi:bookapi@localhost:5432/bookapi_test (see README).',
  );
}
const dbName = new URL(url).pathname.slice(1);
if (!/test/i.test(dbName)) {
  throw new Error(
    `Refusing to run tests against "${dbName}": the database name must contain "test".`,
  );
}

process.env.DATABASE_URL = url;
process.env.DOTENV_CONFIG_PATH = '/nonexistent'; // never let a developer's .env leak into tests
process.env.JWT_SECRET = 'test-secret-0123456789-0123456789-0123456789';
process.env.ACCESS_TOKEN_TTL_SECONDS = '900';
process.env.AUTH_RATE_LIMIT_MAX ??= '1000';
delete process.env.NODE_ENV;
