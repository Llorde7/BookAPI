import type { Appointment, Payment } from '../generated/prisma/client.js';
import {
  bookConfirmed,
  confirmHold,
  pickSlot,
  AppointmentStateError,
  type OnConfirmed,
  type SlotInput,
} from '../appointments.js';
import { prisma } from '../db.js';
import { FakeGateway } from './fakeGateway.js';
import { PaymentCaptureError, type PaymentGateway } from './gateway.js';

export const defaultGateway: PaymentGateway = new FakeGateway();

export interface PayResult {
  appointment: Appointment;
  /** null for free services (nothing to charge). */
  payment: Payment | null;
}

/*
 * Authorize-then-capture:
 *   1. authorize  reserve the money (declined => nothing happened)
 *   2. book       confirm the slot; the payment is linked in the same DB transaction
 *   3. capture    charge it
 * If step 2 loses the slot (someone else paid first) the authorization is
 * voided, so the loser is never charged and never needs a refund.
 * If step 3 fails the booking is cancelled, so nobody gets a free appointment.
 * A crash between steps leaves an AUTHORIZED payment that reconcilePayments()
 * settles later.
 */
async function authorizeBookCapture(
  gateway: PaymentGateway,
  opts: {
    customerId: string;
    serviceId: string;
    paymentToken: string;
    book: (onConfirmed: OnConfirmed) => Promise<Appointment>;
  },
): Promise<PayResult> {
  // Price always comes from the database, never from the caller.
  const service = await prisma.service.findUniqueOrThrow({ where: { id: opts.serviceId } });

  if (service.priceCents === 0) {
    return { appointment: await opts.book(async () => {}), payment: null };
  }

  const auth = await gateway.authorize({
    amountCents: service.priceCents,
    paymentToken: opts.paymentToken,
    customerId: opts.customerId,
  });
  const payment = await prisma.payment.create({
    data: {
      customerId: opts.customerId,
      amountCents: service.priceCents,
      providerRef: auth.id,
      status: 'AUTHORIZED',
    },
  });

  let appointment: Appointment;
  try {
    appointment = await opts.book(async (tx, appt) => {
      await tx.payment.update({ where: { id: payment.id }, data: { appointmentId: appt.id } });
    });
  } catch (err) {
    await voidPayment(gateway, payment).catch(() => {
      // Leave it AUTHORIZED; reconcilePayments() will void it.
    });
    throw err;
  }

  try {
    await gateway.capture(auth.id);
  } catch {
    await prisma.appointment.updateMany({
      where: { id: appointment.id, status: 'CONFIRMED' },
      data: { status: 'CANCELLED' },
    });
    await voidPayment(gateway, payment, 'FAILED').catch(() => {});
    throw new PaymentCaptureError();
  }
  const captured = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'CAPTURED' },
  });
  return { appointment, payment: captured };
}

async function voidPayment(
  gateway: PaymentGateway,
  payment: Payment,
  finalStatus: 'VOIDED' | 'FAILED' = 'VOIDED',
) {
  await gateway.void(payment.providerRef);
  await prisma.payment.update({ where: { id: payment.id }, data: { status: finalStatus } });
}

// The holder pays for their own hold.
export async function payForHold(
  input: { appointmentId: string; customerId: string; paymentToken: string },
  gateway: PaymentGateway = defaultGateway,
) {
  const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: input.appointmentId } });
  if (appt.customerId !== input.customerId) {
    throw new AppointmentStateError('This hold belongs to another customer');
  }
  return authorizeBookCapture(gateway, {
    customerId: input.customerId,
    serviceId: appt.serviceId,
    paymentToken: input.paymentToken,
    book: (onConfirmed) => confirmHold(appt.id, onConfirmed),
  });
}

// Anyone pays for a slot with no hold of their own. An unpaid hold by someone
// else on the slot is given to this customer.
export function payAndBook(
  input: SlotInput & { paymentToken: string },
  gateway: PaymentGateway = defaultGateway,
) {
  const slot = pickSlot(input);
  const { paymentToken } = input;
  return authorizeBookCapture(gateway, {
    customerId: slot.customerId,
    serviceId: slot.serviceId,
    paymentToken,
    book: (onConfirmed) => bookConfirmed(slot, onConfirmed),
  });
}

// Settles authorizations left behind by a crash or timeout between the steps
// above. Run it on a schedule. Leaves recent ones alone: they may be in flight.
export async function reconcilePayments(
  gateway: PaymentGateway = defaultGateway,
  olderThanMinutes = 10,
) {
  const stuck = await prisma.payment.findMany({
    where: {
      status: 'AUTHORIZED',
      createdAt: { lte: new Date(Date.now() - olderThanMinutes * 60_000) },
    },
    include: { appointment: true },
  });
  const done = { captured: 0, voided: 0 };
  for (const p of stuck) {
    if (p.appointment?.status === 'CONFIRMED') {
      try {
        await gateway.capture(p.providerRef);
        await prisma.payment.update({ where: { id: p.id }, data: { status: 'CAPTURED' } });
        done.captured++;
      } catch {
        await prisma.appointment.update({
          where: { id: p.appointment.id },
          data: { status: 'CANCELLED' },
        });
        await voidPayment(gateway, p, 'FAILED').catch(() => {});
      }
    } else {
      await voidPayment(gateway, p);
      done.voided++;
    }
  }
  return done;
}
