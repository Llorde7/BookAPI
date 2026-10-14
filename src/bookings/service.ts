import { config } from '../config.js';
import { prisma } from '../db.js';
import { HttpError } from '../errors.js';
import { isOverlapError, releaseExpiredHolds } from '../appointments.js';

// Never expose another table's data or internals: list exactly these fields.
const bookingFields = {
  id: true,
  providerId: true,
  serviceId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  holdExpiresAt: true,
  createdAt: true,
} as const;

// Statuses that block a slot. Keep in sync with "appointment_no_overlap".
const blocking = ['PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW'] as const;

export interface CreateBookingInput {
  customerId: string;
  providerId: string;
  serviceId: string;
  startsAt: Date;
}

// Deliberately a plain check-then-insert: no transaction, no lock. Two requests for the
// same slot can both pass the check below. The only thing stopping the second insert is
// the existing "appointment_no_overlap" database constraint, which we turn into a 409.
export async function createBooking(input: CreateBookingInput) {
  const [customer, provider, service] = await Promise.all([
    prisma.customer.findUnique({ where: { id: input.customerId }, select: { id: true } }),
    prisma.provider.findUnique({ where: { id: input.providerId } }),
    prisma.service.findUnique({ where: { id: input.serviceId } }),
  ]);
  if (!customer) throw new HttpError(401, 'invalid_token', 'Account no longer exists');
  if (!provider?.active) throw new HttpError(404, 'provider_not_found', 'Provider not found');
  if (!service?.active) throw new HttpError(404, 'service_not_found', 'Service not found');

  const startsAt = input.startsAt;
  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

  // Stale unpaid holds still block at the database until their status changes.
  await releaseExpiredHolds(prisma, provider.id);

  // Half-open ranges, same as the constraint: back-to-back is allowed.
  const clash = await prisma.appointment.findFirst({
    where: {
      providerId: provider.id,
      status: { in: [...blocking] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  });
  if (clash) throw new HttpError(409, 'slot_taken', 'That time slot is not available');

  const holdExpiresAt = new Date(
    Math.min(Date.now() + config.holdMinutes * 60_000, startsAt.getTime()),
  );
  try {
    return await prisma.appointment.create({
      data: {
        customerId: customer.id,
        providerId: provider.id,
        serviceId: service.id,
        startsAt,
        endsAt,
        status: 'PENDING',
        holdExpiresAt,
      },
      select: bookingFields,
    });
  } catch (err) {
    if (isOverlapError(err))
      throw new HttpError(409, 'slot_taken', 'That time slot is not available');
    throw err;
  }
}

export function listBookings(customerId: string) {
  return prisma.appointment.findMany({
    where: { customerId },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    select: bookingFields,
  });
}
