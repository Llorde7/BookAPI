import { Prisma, type Appointment } from './generated/prisma/client.js';
import { config } from './config.js';
import { prisma } from './db.js';

type Tx = Prisma.TransactionClient;

export class SlotTakenError extends Error {
  constructor() {
    super('That time slot is no longer available');
  }
}

export class AppointmentStateError extends Error {}

// Runs inside the same transaction that confirms the booking, so anything it
// writes (e.g. linking a payment) is saved or lost together with the booking.
export type OnConfirmed = (tx: Tx, appointment: Appointment) => Promise<void>;

export interface SlotInput {
  providerId: string;
  customerId: string;
  serviceId: string;
  startsAt: Date;
}

// Copies only the fields a caller is allowed to choose. Anything else on the object
// (id, status, notes, an amount...) is dropped instead of flowing into the database.
export function pickSlot(input: SlotInput): SlotInput {
  const { providerId, customerId, serviceId, startsAt } = input;
  return { providerId, customerId, serviceId, startsAt };
}

// The database constraint is the real guard. This recognises its error however
// the driver wraps it (SQLSTATE 23P01 = exclusion_violation).
export function isOverlapError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const text = JSON.stringify(e, Object.getOwnPropertyNames(Object(e)));
    if (text.includes('appointment_no_overlap') || text.includes('23P01')) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// Run `fn` with all booking writes for one provider queued behind each other.
// The constraint would catch conflicts anyway; the lock stops two payments for
// the same slot from deadlocking while they swap holds.
async function withProviderLock<T>(providerId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${providerId}, 0))`;
      return fn(tx);
    });
  } catch (err) {
    if (isOverlapError(err)) throw new SlotTakenError();
    throw err;
  }
}

// Unpaid holds whose time ran out stop blocking the slot.
// `providerId` omitted = sweep everyone (safe to run from a cron job).
export async function releaseExpiredHolds(tx: Tx | typeof prisma, providerId?: string) {
  const { count } = await tx.appointment.updateMany({
    where: {
      status: 'PENDING',
      holdExpiresAt: { lte: new Date() },
      ...(providerId && { providerId }),
    },
    data: { status: 'EXPIRED' },
  });
  return count;
}

// A paying customer wins: unpaid holds overlapping this range are given up.
async function bumpUnpaidHolds(
  tx: Tx,
  providerId: string,
  startsAt: Date,
  endsAt: Date,
  exceptId?: string,
) {
  const { count } = await tx.appointment.updateMany({
    where: {
      providerId,
      status: 'PENDING',
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(exceptId && { id: { not: exceptId } }),
    },
    data: { status: 'BUMPED', holdExpiresAt: null },
  });
  return count;
}

async function slotRange(tx: Tx, input: SlotInput) {
  const service = await tx.service.findUniqueOrThrow({ where: { id: input.serviceId } });
  const endsAt = new Date(input.startsAt.getTime() + service.durationMinutes * 60_000);
  return { startsAt: input.startsAt, endsAt };
}

// Reserve a slot without paying. Holds it for HOLD_MINUTES (never past the start time).
export function createHold(raw: SlotInput) {
  const input = pickSlot(raw);
  return withProviderLock(input.providerId, async (tx) => {
    await releaseExpiredHolds(tx, input.providerId);
    const { startsAt, endsAt } = await slotRange(tx, input);
    const holdExpiresAt = new Date(
      Math.min(Date.now() + config.holdMinutes * 60_000, startsAt.getTime()),
    );
    return tx.appointment.create({
      data: { ...input, startsAt, endsAt, status: 'PENDING', holdExpiresAt },
    });
  });
}

// Mark a hold CONFIRMED (paid). Call only after the payment is authorized: see
// payments/service.ts. Also works if the hold just expired, as long as nobody
// else has taken the slot in the meantime.
export async function confirmHold(appointmentId: string, onConfirmed?: OnConfirmed) {
  const existing = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  return withProviderLock(existing.providerId, async (tx) => {
    await releaseExpiredHolds(tx, existing.providerId);
    const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    if (appt.status !== 'PENDING' && appt.status !== 'EXPIRED') {
      throw new AppointmentStateError(`Cannot confirm a ${appt.status} appointment`);
    }
    await bumpUnpaidHolds(tx, appt.providerId, appt.startsAt, appt.endsAt, appt.id);
    const confirmed = await tx.appointment.update({
      where: { id: appt.id },
      data: { status: 'CONFIRMED', holdExpiresAt: null },
    });
    await onConfirmed?.(tx, confirmed);
    return confirmed;
  });
}

// Create a CONFIRMED (paid) booking directly. Any unpaid hold on the slot is
// given to this customer. Call only after the payment is authorized.
export function bookConfirmed(raw: SlotInput, onConfirmed?: OnConfirmed) {
  const input = pickSlot(raw);
  return withProviderLock(input.providerId, async (tx) => {
    await releaseExpiredHolds(tx, input.providerId);
    const { startsAt, endsAt } = await slotRange(tx, input);
    await bumpUnpaidHolds(tx, input.providerId, startsAt, endsAt);
    const created = await tx.appointment.create({
      data: { ...input, startsAt, endsAt, status: 'CONFIRMED' },
    });
    await onConfirmed?.(tx, created);
    return created;
  });
}
