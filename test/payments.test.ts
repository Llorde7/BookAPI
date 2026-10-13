import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AppointmentStateError, SlotTakenError, createHold } from '../src/appointments.js';
import { prisma } from '../src/db.js';
import { FakeGateway } from '../src/payments/fakeGateway.js';
import { PaymentCaptureError, PaymentDeclinedError } from '../src/payments/gateway.js';
import { payAndBook, payForHold, reconcilePayments } from '../src/payments/service.js';
import { resetDb } from './helpers.js';

const gw = new FakeGateway();
let provider: { id: string }, a: { id: string }, b: { id: string }, c: { id: string };
let paid: { id: string }, free: { id: string };
const day = (h: number, m = 0) => new Date(Date.UTC(2031, 0, 1, h, m));
const slot = (cust: { id: string }, h: number, svc = paid) => ({
  providerId: provider.id,
  customerId: cust.id,
  serviceId: svc.id,
  startsAt: day(h),
});
const statusOf = async (id: string) =>
  (await prisma.appointment.findUniqueOrThrow({ where: { id } })).status;

before(async () => {
  await resetDb();
  provider = await prisma.provider.create({ data: { name: 'P', email: 'p@x.co' } });
  a = await prisma.customer.create({ data: { name: 'a', email: 'a@x.co' } });
  b = await prisma.customer.create({ data: { name: 'b', email: 'b@x.co' } });
  c = await prisma.customer.create({ data: { name: 'c', email: 'c@x.co' } });
  paid = await prisma.service.create({
    data: { name: 'Paid', durationMinutes: 30, priceCents: 5000 },
  });
  free = await prisma.service.create({
    data: { name: 'Free', durationMinutes: 30, priceCents: 0 },
  });
});
after(() => prisma.$disconnect());

describe('authorize, book, then capture', () => {
  it('the holder pays: CONFIRMED, payment CAPTURED and linked, provider charged', async () => {
    const hold = await createHold(slot(a, 9));
    const r = await payForHold(
      { appointmentId: hold.id, customerId: a.id, paymentToken: 'tok_ok' },
      gw,
    );
    assert.equal(r.appointment.status, 'CONFIRMED');
    assert.equal(r.payment?.status, 'CAPTURED');
    assert.equal(r.payment?.appointmentId, hold.id);
    assert.equal(r.payment?.amountCents, 5000);
    assert.equal(gw.stateOf(r.payment!.providerRef), 'CAPTURED');
  });

  it('anyone can pay directly for a free slot', async () => {
    const r = await payAndBook({ ...slot(b, 10), paymentToken: 'tok_ok' }, gw);
    assert.equal(r.appointment.status, 'CONFIRMED');
    assert.equal(r.payment?.status, 'CAPTURED');
  });

  it('the price comes from the service, never from the caller', async () => {
    const r = await payAndBook(
      { ...slot(b, 11), paymentToken: 'tok_ok', amountCents: 1 } as never,
      gw,
    );
    assert.equal(r.payment?.amountCents, 5000);
  });

  it('extra fields in the request (status, notes, id) are ignored', async () => {
    const r = await payAndBook(
      {
        ...slot(b, 8),
        paymentToken: 'tok_ok',
        status: 'CANCELLED',
        notes: 'x',
        id: '00000000-0000-7000-8000-00000000beef',
      } as never,
      gw,
    );
    assert.equal(r.appointment.status, 'CONFIRMED');
    assert.equal(r.appointment.notes, null);
    assert.notEqual(r.appointment.id, '00000000-0000-7000-8000-00000000beef');
  });

  it('free services skip payment entirely', async () => {
    const r = await payAndBook({ ...slot(a, 12, free), paymentToken: 'whatever' }, gw);
    assert.equal(r.appointment.status, 'CONFIRMED');
    assert.equal(r.payment, null);
  });
});

describe('failures never leave a free booking or a charge', () => {
  it('a declined card books nothing and leaves the hold alone', async () => {
    const hold = await createHold(slot(a, 13));
    await assert.rejects(
      payForHold({ appointmentId: hold.id, customerId: a.id, paymentToken: 'tok_declined' }, gw),
      PaymentDeclinedError,
    );
    assert.equal(await statusOf(hold.id), 'PENDING');
    assert.equal(await prisma.payment.count({ where: { appointmentId: hold.id } }), 0);
  });

  it('a declined direct payment creates no booking', async () => {
    await assert.rejects(
      payAndBook({ ...slot(c, 14), paymentToken: 'tok_declined' }, gw),
      PaymentDeclinedError,
    );
    assert.equal(await prisma.appointment.count({ where: { startsAt: day(14) } }), 0);
  });

  it('an unknown token is declined', async () => {
    await assert.rejects(
      payAndBook({ ...slot(c, 14), paymentToken: 'tok_nonsense' }, gw),
      PaymentDeclinedError,
    );
  });

  it('paying for an already-paid slot voids the authorization: the loser is never charged', async () => {
    await payAndBook({ ...slot(a, 15), paymentToken: 'tok_ok' }, gw);
    await assert.rejects(
      payAndBook({ ...slot(c, 15), paymentToken: 'tok_ok' }, gw),
      SlotTakenError,
    );
    const loser = await prisma.payment.findFirstOrThrow({ where: { customerId: c.id } });
    assert.equal(loser.status, 'VOIDED');
    assert.equal(gw.stateOf(loser.providerRef), 'VOIDED');
  });

  it('a capture failure cancels the booking, frees the slot and voids the authorization', async () => {
    const hold = await createHold(slot(a, 16));
    await assert.rejects(
      payForHold(
        { appointmentId: hold.id, customerId: a.id, paymentToken: 'tok_capture_fails' },
        gw,
      ),
      PaymentCaptureError,
    );
    const p = await prisma.payment.findFirstOrThrow({ where: { appointmentId: hold.id } });
    assert.equal(await statusOf(hold.id), 'CANCELLED');
    assert.equal(p.status, 'FAILED');
    assert.equal(gw.stateOf(p.providerRef), 'VOIDED');
    const again = await payAndBook({ ...slot(b, 16), paymentToken: 'tok_ok' }, gw);
    assert.equal(again.appointment.status, 'CONFIRMED');
  });

  it("nobody can pay for another customer's hold", async () => {
    const hold = await createHold(slot(a, 17));
    await assert.rejects(
      payForHold({ appointmentId: hold.id, customerId: b.id, paymentToken: 'tok_ok' }, gw),
      AppointmentStateError,
    );
    assert.equal(await statusOf(hold.id), 'PENDING');
    assert.equal(await prisma.payment.count({ where: { appointmentId: hold.id } }), 0);
  });

  it('a bumped holder who tries to pay is never charged', async () => {
    const hold = await createHold(slot(a, 18));
    await payAndBook({ ...slot(b, 18), paymentToken: 'tok_ok' }, gw);
    await assert.rejects(
      payForHold({ appointmentId: hold.id, customerId: a.id, paymentToken: 'tok_ok' }, gw),
      AppointmentStateError,
    );
    const p = await prisma.payment.findFirstOrThrow({
      where: { customerId: a.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(p.status, 'VOIDED');
    assert.equal(gw.stateOf(p.providerRef), 'VOIDED');
  });
});

describe('two people paying at once', () => {
  it('three simultaneous payers: one booked and charged, two voided', async () => {
    const before = await prisma.payment.count();
    const results = await Promise.allSettled(
      [a, b, c].map((cu) => payAndBook({ ...slot(cu, 19), paymentToken: 'tok_ok' }, gw)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const pays = await prisma.payment.findMany({ skip: before, orderBy: { createdAt: 'asc' } });
    assert.equal(pays.filter((p) => p.status === 'CAPTURED').length, 1);
    assert.equal(pays.filter((p) => p.status === 'VOIDED').length, 2);
    for (const p of pays)
      assert.equal(gw.stateOf(p.providerRef), p.status === 'CAPTURED' ? 'CAPTURED' : 'VOIDED');
  });

  it('holder vs stranger at the same moment: charged once, nothing left dangling', async () => {
    const hold = await createHold(slot(a, 20));
    await Promise.allSettled([
      payForHold({ appointmentId: hold.id, customerId: a.id, paymentToken: 'tok_ok' }, gw),
      payAndBook({ ...slot(b, 20), paymentToken: 'tok_ok' }, gw),
    ]);
    const confirmed = await prisma.appointment.findMany({
      where: { startsAt: day(20), status: 'CONFIRMED' },
      include: { payments: true },
    });
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0]!.payments.filter((p) => p.status === 'CAPTURED').length, 1);
    assert.equal(await prisma.payment.count({ where: { status: 'AUTHORIZED' } }), 0);
  });
});

describe('reconcilePayments (settling leftovers from a crash)', () => {
  const old = () => new Date(Date.now() - 60 * 60_000);
  async function leftover(confirmed: boolean, createdAt: Date, hour: number) {
    const auth = await gw.authorize({
      amountCents: 5000,
      paymentToken: 'tok_ok',
      customerId: a.id,
    });
    const appt = confirmed
      ? await prisma.appointment.create({
          data: { ...slot(a, hour), endsAt: day(hour, 30), status: 'CONFIRMED' },
        })
      : null;
    return prisma.payment.create({
      data: {
        customerId: a.id,
        amountCents: 5000,
        providerRef: auth.id,
        status: 'AUTHORIZED',
        appointmentId: appt?.id ?? null,
        createdAt,
      },
    });
  }

  it('captures a paid booking, voids an orphan, leaves recent ones alone', async () => {
    const afterBook = await leftover(true, old(), 21);
    const orphan = await leftover(false, old(), 22);
    const inFlight = await leftover(false, new Date(), 23);
    await reconcilePayments(gw, 10);
    const get = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
    assert.equal((await get(afterBook.id)).status, 'CAPTURED');
    assert.equal(gw.stateOf(afterBook.providerRef), 'CAPTURED');
    assert.equal((await get(orphan.id)).status, 'VOIDED');
    assert.equal(gw.stateOf(orphan.providerRef), 'VOIDED');
    assert.equal((await get(inFlight.id)).status, 'AUTHORIZED');
  });
});
