import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signAccessToken } from '../src/auth/tokens.js';
import { prisma } from '../src/db.js';
import { resetDb, startServer } from './helpers.js';

const { server, call } = startServer();

let provider: { id: string },
  other: { id: string },
  service: { id: string },
  alice: { id: string },
  bob: { id: string };
let aliceAuth: Record<string, string>, bobAuth: Record<string, string>;

const iso = (days: number, h: number, m = 0) =>
  new Date(Date.UTC(2031, 0, 1 + days, h, m)).toISOString();
const body = (startsAt: string, extra: object = {}) => ({
  providerId: provider.id,
  serviceId: service.id,
  startsAt,
  ...extra,
});

before(async () => {
  await resetDb();
  provider = await prisma.provider.create({ data: { name: 'P', email: 'p@x.co' } });
  other = await prisma.provider.create({ data: { name: 'Q', email: 'q@x.co' } });
  service = await prisma.service.create({ data: { name: 'S', durationMinutes: 30 } });
  alice = await prisma.customer.create({ data: { name: 'alice', email: 'alice@x.co' } });
  bob = await prisma.customer.create({ data: { name: 'bob', email: 'bob@x.co' } });
  aliceAuth = { authorization: `Bearer ${signAccessToken(alice.id)}` };
  bobAuth = { authorization: `Bearer ${signAccessToken(bob.id)}` };
});
after(async () => {
  server.close();
  await prisma.$disconnect();
});

describe('auth', () => {
  it('POST /bookings and GET /bookings require a valid access token', async () => {
    assert.equal((await call('POST', '/bookings', body(iso(0, 9)))).status, 401);
    assert.equal((await call('GET', '/bookings')).status, 401);
    const bad = { authorization: 'Bearer nonsense' };
    assert.equal((await call('POST', '/bookings', body(iso(0, 9)), bad)).status, 401);
    assert.equal((await call('GET', '/bookings', undefined, bad)).status, 401);
    assert.equal(await prisma.appointment.count(), 0);
  });
});

describe('POST /bookings', () => {
  it('creates a PENDING hold with endsAt from the service and the caller as owner', async () => {
    const r = await call('POST', '/bookings', body(iso(0, 9)), aliceAuth);
    assert.equal(r.status, 201);
    const b = r.json.booking;
    assert.equal(b.status, 'PENDING');
    assert.equal(new Date(b.endsAt).getTime() - new Date(b.startsAt).getTime(), 30 * 60_000);
    assert.ok(b.holdExpiresAt);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: b.id } });
    assert.equal(row.customerId, alice.id);
  });

  it('ignores customerId, status, endsAt and id sent by the client', async () => {
    const evil = {
      customerId: bob.id,
      status: 'CONFIRMED',
      endsAt: iso(0, 23),
      id: '00000000-0000-7000-8000-00000000beef',
      holdExpiresAt: null,
    };
    const r = await call('POST', '/bookings', body(iso(0, 10), evil), aliceAuth);
    assert.equal(r.status, 201);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: r.json.booking.id } });
    assert.equal(row.customerId, alice.id);
    assert.equal(row.status, 'PENDING');
    assert.notEqual(row.id, evil.id);
    assert.equal(row.endsAt.toISOString(), iso(0, 10, 30));
  });

  it('rejects invalid input with 400 and writes nothing', async () => {
    const before = await prisma.appointment.count();
    const cases: unknown[] = [
      {},
      body('not a date'),
      body('2031-01-05T09:00:00'), // no offset
      body(new Date(Date.now() - 3600_000).toISOString()), // in the past
      { ...body(iso(1, 9)), providerId: 'nope' },
      { ...body(iso(1, 9)), serviceId: 123 },
      '[]',
    ];
    for (const c of cases) {
      const r = await call('POST', '/bookings', c, aliceAuth);
      assert.equal(r.status, 400, JSON.stringify(c));
    }
    assert.equal(await prisma.appointment.count(), before);
  });

  it('404s for an unknown or inactive provider/service', async () => {
    const ghost = '00000000-0000-7000-8000-000000000000';
    let r = await call('POST', '/bookings', { ...body(iso(2, 9)), providerId: ghost }, aliceAuth);
    assert.equal(r.status, 404);
    r = await call('POST', '/bookings', { ...body(iso(2, 9)), serviceId: ghost }, aliceAuth);
    assert.equal(r.status, 404);
    const off = await prisma.provider.create({
      data: { name: 'x', email: 'off@x.co', active: false },
    });
    r = await call('POST', '/bookings', { ...body(iso(2, 9)), providerId: off.id }, aliceAuth);
    assert.equal(r.status, 404);
  });

  it('409s on an overlapping slot, allows back-to-back and other providers', async () => {
    assert.equal((await call('POST', '/bookings', body(iso(3, 9)), aliceAuth)).status, 201);
    assert.equal((await call('POST', '/bookings', body(iso(3, 9)), bobAuth)).status, 409);
    assert.equal((await call('POST', '/bookings', body(iso(3, 9, 15)), bobAuth)).status, 409);
    assert.equal((await call('POST', '/bookings', body(iso(3, 9, 30)), bobAuth)).status, 201);
    const r = await call(
      'POST',
      '/bookings',
      { ...body(iso(3, 9)), providerId: other.id },
      bobAuth,
    );
    assert.equal(r.status, 201);
  });

  it('a cancelled or expired booking frees the slot', async () => {
    const first = await call('POST', '/bookings', body(iso(4, 9)), aliceAuth);
    await prisma.appointment.update({
      where: { id: first.json.booking.id },
      data: { status: 'CANCELLED' },
    });
    assert.equal((await call('POST', '/bookings', body(iso(4, 9)), bobAuth)).status, 201);
    const held = await call('POST', '/bookings', body(iso(4, 12)), aliceAuth);
    await prisma.$executeRaw`UPDATE "Appointment" SET "holdExpiresAt" = now() - interval '1 minute' WHERE id = ${held.json.booking.id}::uuid`;
    assert.equal((await call('POST', '/bookings', body(iso(4, 12)), bobAuth)).status, 201);
  });

  it('a token for a deleted customer is refused', async () => {
    const ghost = await prisma.customer.create({ data: { name: 'g', email: 'g@x.co' } });
    const auth = { authorization: `Bearer ${signAccessToken(ghost.id)}` };
    await prisma.customer.delete({ where: { id: ghost.id } });
    assert.equal((await call('POST', '/bookings', body(iso(5, 9)), auth)).status, 401);
  });

  // create is check-then-insert with no lock, so both requests can pass the check.
  // This proves the existing database constraint still prevents a double booking
  // and that the loser gets a clean 409, not a 500.
  it('simultaneous requests for one slot: exactly one wins, the other is 409', async () => {
    const start = iso(6, 9);
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call('POST', '/bookings', body(start), i % 2 ? aliceAuth : bobAuth),
      ),
    );
    const statuses = replies.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409, 409, 409]);
    const rows = await prisma.appointment.count({
      where: { providerId: provider.id, startsAt: new Date(start) },
    });
    assert.equal(rows, 1);
  });
});

describe('GET /bookings', () => {
  it("returns only the caller's bookings, never another customer's", async () => {
    await resetDb();
    provider = await prisma.provider.create({ data: { name: 'P', email: 'p2@x.co' } });
    service = await prisma.service.create({ data: { name: 'S', durationMinutes: 30 } });
    alice = await prisma.customer.create({ data: { name: 'alice', email: 'alice2@x.co' } });
    bob = await prisma.customer.create({ data: { name: 'bob', email: 'bob2@x.co' } });
    aliceAuth = { authorization: `Bearer ${signAccessToken(alice.id)}` };
    bobAuth = { authorization: `Bearer ${signAccessToken(bob.id)}` };

    const a2 = await call('POST', '/bookings', body(iso(1, 11)), aliceAuth);
    const a1 = await call('POST', '/bookings', body(iso(1, 9)), aliceAuth);
    const b1 = await call('POST', '/bookings', body(iso(1, 10)), bobAuth);
    assert.deepEqual([a1.status, a2.status, b1.status], [201, 201, 201]);

    const mine = await call('GET', '/bookings', undefined, aliceAuth);
    assert.equal(mine.status, 200);
    // soonest first
    assert.deepEqual(
      mine.json.bookings.map((b: { id: string }) => b.id),
      [a1.json.booking.id, a2.json.booking.id],
    );
    const bobs = await call('GET', '/bookings', undefined, bobAuth);
    assert.deepEqual(
      bobs.json.bookings.map((b: { id: string }) => b.id),
      [b1.json.booking.id],
    );
    assert.ok(!mine.text.includes(b1.json.booking.id));
    assert.ok(!('customerId' in mine.json.bookings[0]));
  });

  it('returns an empty list for a customer with no bookings', async () => {
    const carol = await prisma.customer.create({ data: { name: 'c', email: 'carol@x.co' } });
    const auth = { authorization: `Bearer ${signAccessToken(carol.id)}` };
    const r = await call('GET', '/bookings', undefined, auth);
    assert.deepEqual(r.json, { bookings: [] });
  });

  it('ignores a customerId query parameter', async () => {
    const r = await call('GET', `/bookings?customerId=${bob.id}`, undefined, aliceAuth);
    assert.equal(r.json.bookings.length, 2);
  });
});

describe('database rule: endsAt > startsAt', () => {
  it('rejects zero-length and negative bookings even when the API is bypassed', async () => {
    const insert = (s: string, e: string) =>
      prisma.$executeRaw`INSERT INTO "Appointment" (id, "providerId","customerId","serviceId","startsAt","endsAt","status","updatedAt","holdExpiresAt")
        VALUES (gen_random_uuid(), ${provider.id}::uuid, ${alice.id}::uuid, ${service.id}::uuid, ${s}::timestamptz, ${e}::timestamptz, 'CONFIRMED', now(), NULL)`;
    await assert.rejects(insert(iso(20, 9), iso(20, 9)), /appointment_ends_after_start/);
    await assert.rejects(insert(iso(20, 9), iso(20, 8)), /appointment_ends_after_start/);
  });
});
