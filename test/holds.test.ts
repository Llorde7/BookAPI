import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  SlotTakenError,
  AppointmentStateError,
  bookConfirmed,
  confirmHold,
  createHold,
} from '../src/appointments.js';
import { prisma } from '../src/db.js';
import { resetDb } from './helpers.js';

let provider: { id: string },
  a: { id: string },
  b: { id: string },
  c: { id: string },
  service: { id: string };
const day = (h: number, m = 0) => new Date(Date.UTC(2030, 0, 1, h, m));
const slot = (cust: { id: string }, h: number) => ({
  providerId: provider.id,
  customerId: cust.id,
  serviceId: service.id,
  startsAt: day(h),
});
const statusOf = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id } })).status;
const expireNow = (id: string) =>
  prisma.$executeRaw`UPDATE "Appointment" SET "holdExpiresAt" = now() - interval '1 minute' WHERE id = ${id}::uuid`;

before(async () => {
  await resetDb();
  provider = await prisma.provider.create({ data: { name: 'P', email: 'p@x.co' } });
  a = await prisma.customer.create({ data: { name: 'a', email: 'a@x.co' } });
  b = await prisma.customer.create({ data: { name: 'b', email: 'b@x.co' } });
  c = await prisma.customer.create({ data: { name: 'c', email: 'c@x.co' } });
  service = await prisma.service.create({
    data: { name: 'S', durationMinutes: 30, priceCents: 5000 },
  });
});
after(() => prisma.$disconnect());

describe('holds', () => {
  it('createHold reserves the slot as PENDING with a timer and the service duration', async () => {
    const h = await createHold(slot(a, 9));
    assert.equal(h.status, 'PENDING');
    assert.ok(h.holdExpiresAt);
    assert.equal(h.endsAt.getTime() - h.startsAt.getTime(), 30 * 60_000);
  });

  it('a second unpaid hold on a held slot is rejected', async () => {
    await createHold(slot(a, 10));
    await assert.rejects(createHold(slot(b, 10)), SlotTakenError);
  });

  it('an overlapping (not identical) slot is rejected too, back-to-back is allowed', async () => {
    await createHold(slot(a, 11));
    await assert.rejects(createHold({ ...slot(b, 11), startsAt: day(11, 15) }), SlotTakenError);
    assert.equal((await createHold({ ...slot(b, 11), startsAt: day(11, 30) })).status, 'PENDING');
  });

  it('the hold never outlasts the appointment start time', async () => {
    const soon = new Date(Date.now() + 2 * 3600_000);
    const h = await createHold({ ...slot(a, 0), startsAt: soon });
    assert.equal(h.holdExpiresAt!.getTime(), soon.getTime());
  });

  it('after the timer runs out another customer can hold the slot, and the old hold is EXPIRED', async () => {
    const old = await createHold(slot(a, 12));
    await expireNow(old.id);
    assert.equal((await createHold(slot(b, 12))).status, 'PENDING');
    assert.equal(await statusOf(old.id), 'EXPIRED');
  });
});

describe('extra fields are never copied into the database', () => {
  const evil = {
    id: '00000000-0000-7000-8000-00000000beef',
    notes: 'injected',
    status: 'COMPLETED',
    holdExpiresAt: new Date(0),
    createdAt: new Date(0),
  };

  it('createHold ignores id, status, notes and timestamps supplied by the caller', async () => {
    const h = await createHold({ ...slot(a, 7), ...evil } as never);
    assert.notEqual(h.id, evil.id);
    assert.equal(h.notes, null);
    assert.equal(h.status, 'PENDING');
    assert.ok(h.holdExpiresAt!.getTime() > Date.now());
  });

  it('bookConfirmed ignores them too', async () => {
    const h = await bookConfirmed({ ...slot(a, 8), ...evil } as never);
    assert.notEqual(h.id, evil.id);
    assert.equal(h.notes, null);
    assert.equal(h.status, 'CONFIRMED');
    assert.equal(h.holdExpiresAt, null);
  });
});

describe('a paying customer takes the slot', () => {
  it('bookConfirmed bumps an unpaid hold, which then cannot be confirmed', async () => {
    const hold = await createHold(slot(a, 13));
    const paid = await bookConfirmed(slot(b, 13));
    assert.equal(paid.status, 'CONFIRMED');
    assert.equal(await statusOf(hold.id), 'BUMPED');
    await assert.rejects(confirmHold(hold.id));
  });

  it('a paid slot can never be taken or held', async () => {
    await bookConfirmed(slot(a, 14));
    await assert.rejects(bookConfirmed(slot(c, 14)), SlotTakenError);
    await assert.rejects(createHold(slot(c, 14)), SlotTakenError);
  });

  it('the holder can pay for their own hold', async () => {
    const hold = await createHold(slot(a, 15));
    const done = await confirmHold(hold.id);
    assert.equal(done.status, 'CONFIRMED');
    assert.equal(done.holdExpiresAt, null);
  });

  it("an expired holder who pays late still wins, bumping a different customer's unpaid hold", async () => {
    const mine = await createHold(slot(a, 16));
    await expireNow(mine.id);
    const theirs = await createHold(slot(b, 16));
    assert.equal((await confirmHold(mine.id)).status, 'CONFIRMED');
    assert.equal(await statusOf(theirs.id), 'BUMPED');
  });

  it('an expired holder who pays late loses if someone else already PAID', async () => {
    const mine = await createHold(slot(a, 17));
    await expireNow(mine.id);
    await bookConfirmed(slot(b, 17));
    await assert.rejects(confirmHold(mine.id), SlotTakenError);
  });

  it('cannot confirm a cancelled appointment', async () => {
    const hold = await createHold(slot(a, 18));
    await prisma.appointment.update({
      where: { id: hold.id },
      data: { status: 'CANCELLED', holdExpiresAt: null },
    });
    await assert.rejects(confirmHold(hold.id), AppointmentStateError);
  });

  it('a cancelled booking frees the slot', async () => {
    const first = await bookConfirmed(slot(a, 19));
    await prisma.appointment.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });
    assert.equal((await bookConfirmed(slot(b, 19))).status, 'CONFIRMED');
  });
});

describe('races', () => {
  it('3 simultaneous payers for one slot: exactly one wins', async () => {
    const results = await Promise.allSettled([a, b, c].map((cu) => bookConfirmed(slot(cu, 20))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results)
      if (r.status === 'rejected') assert.ok(r.reason instanceof SlotTakenError);
  });

  it('holder paying at the same moment as a stranger: exactly one CONFIRMED, no deadlock', async () => {
    const hold = await createHold(slot(a, 21));
    await Promise.allSettled([confirmHold(hold.id), bookConfirmed(slot(b, 21))]);
    assert.equal(
      await prisma.appointment.count({ where: { startsAt: day(21), status: 'CONFIRMED' } }),
      1,
    );
  });
});

describe('the database enforces the rules even if the app is bypassed', () => {
  const insert = (status: string, hold: string, start: string, end: string) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "Appointment"(id,"providerId","customerId","serviceId","startsAt","endsAt","status","holdExpiresAt","updatedAt")
       VALUES (gen_random_uuid(), '${provider.id}', '${a.id}', '${service.id}', '${start}', '${end}', '${status}'::"AppointmentStatus", ${hold}, now())`,
    );

  it('rejects an overlapping insert', async () => {
    await bookConfirmed(slot(a, 22));
    await assert.rejects(insert('CONFIRMED', 'NULL', '2030-01-01 22:10+00', '2030-01-01 22:20+00'));
  });

  it('rejects ends-before-start', async () => {
    await assert.rejects(insert('CONFIRMED', 'NULL', '2030-01-01 23:30+00', '2030-01-01 23:00+00'));
  });

  it('rejects a PENDING booking without a hold time', async () => {
    await assert.rejects(insert('PENDING', 'NULL', '2030-01-02 09:00+00', '2030-01-02 09:30+00'));
  });
});
