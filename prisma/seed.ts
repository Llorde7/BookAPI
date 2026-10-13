// Sample data for local development. Safe to run repeatedly: customers,
// providers and services are upserted, and the sample appointments and
// payments are deleted and recreated with dates relative to today.
//
//   npm run db:seed
import { prisma } from '../src/db.js';

// Not a real hash. Nobody can log in with this; replace it once login exists.
const PLACEHOLDER_PASSWORD_HASH = 'PLACEHOLDER_PASSWORD_HASH';

// Fixed ids so re-running the seed updates the same rows.
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const customers = [
  { id: id(1), name: 'Sam Taylor', email: 'sam.taylor@example.com', phone: '+1 555 0101' },
  { id: id(2), name: 'Jordan Lee', email: 'jordan.lee@example.com', phone: '+1 555 0102' },
];

const providers = [
  { id: id(11), name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
  { id: id(12), name: 'Marcus Chen', email: 'marcus.chen@example.com' },
  { id: id(13), name: 'Priya Nair', email: 'priya.nair@example.com' },
];

const services = [
  { id: id(21), name: 'Consultation', durationMinutes: 30, priceCents: 5000 },
  { id: id(22), name: 'Standard session', durationMinutes: 60, priceCents: 9000 },
  { id: id(23), name: 'Intro chat', durationMinutes: 15, priceCents: 0 },
];

// UTC time `days` from today at hh:mm.
function at(days: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCHours(hour, minute, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function main() {
  for (const c of customers) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: { ...c, passwordHash: PLACEHOLDER_PASSWORD_HASH },
      create: { ...c, passwordHash: PLACEHOLDER_PASSWORD_HASH },
    });
  }
  for (const p of providers) {
    await prisma.provider.upsert({ where: { id: p.id }, update: p, create: p });
  }
  for (const s of services) {
    await prisma.service.upsert({ where: { id: s.id }, update: s, create: s });
  }

  const [sam, jordan] = customers;
  const [dana, marcus, priya] = providers;
  const [consultation, standard, intro] = services;
  if (!sam || !jordan || !dana || !marcus || !priya || !consultation || !standard || !intro) {
    throw new Error('seed data is incomplete');
  }

  const book = (
    n: number,
    customer: { id: string },
    provider: { id: string },
    service: { id: string; durationMinutes: number },
    startsAt: Date,
    status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED',
    notes?: string,
  ) => ({
    id: id(100 + n),
    customerId: customer.id,
    providerId: provider.id,
    serviceId: service.id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + service.durationMinutes * 60_000),
    status,
    // An unpaid booking must carry a hold time (database rule).
    holdExpiresAt:
      status === 'PENDING'
        ? new Date(Math.min(Date.now() + 24 * 60 * 60_000, startsAt.getTime()))
        : null,
    notes,
  });

  const appointments = [
    // Dana: two back-to-back bookings (allowed: ranges are half-open).
    book(1, sam, dana, consultation, at(1, 9, 0), 'CONFIRMED'),
    book(2, jordan, dana, standard, at(1, 9, 30), 'CONFIRMED', 'First visit'),
    // Free service, so no payment row.
    book(3, sam, marcus, intro, at(2, 14, 0), 'CONFIRMED'),
    // Unpaid hold on Priya's 11:00 slot...
    book(4, jordan, priya, consultation, at(3, 11, 0), 'PENDING'),
    // ...and a cancelled booking for the same slot (cancelled ones don't block).
    book(5, sam, priya, standard, at(3, 11, 0), 'CANCELLED', 'Customer cancelled'),
    // Past appointment.
    book(6, jordan, marcus, standard, at(-3, 10, 0), 'COMPLETED'),
  ];

  // Payments for the paid bookings (CONFIRMED / COMPLETED means paid).
  const payments = [
    { n: 1, customer: sam, appointmentN: 1, amountCents: consultation.priceCents },
    { n: 2, customer: jordan, appointmentN: 2, amountCents: standard.priceCents },
    { n: 3, customer: jordan, appointmentN: 6, amountCents: standard.priceCents },
  ].map((p) => ({
    id: id(200 + p.n),
    customerId: p.customer.id,
    appointmentId: id(100 + p.appointmentN),
    amountCents: p.amountCents,
    status: 'CAPTURED' as const,
    providerRef: `auth_seed_${p.n}`,
  }));

  // Recreate the sample bookings so their dates stay in the future.
  await prisma.$transaction(async (tx) => {
    await tx.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
    await tx.appointment.deleteMany({ where: { id: { in: appointments.map((a) => a.id) } } });
    await tx.appointment.createMany({ data: appointments });
    await tx.payment.createMany({ data: payments });
  });

  console.log(
    `Seeded ${customers.length} customers, ${providers.length} providers, ` +
      `${services.length} services, ${appointments.length} appointments, ${payments.length} payments`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
