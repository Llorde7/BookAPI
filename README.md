# BookAPI

Appointment booking API built with TypeScript, Express, Prisma and PostgreSQL.

## Setup

```sh
cp .env.example .env
npm install
npm run db:up       # starts PostgreSQL via docker compose
npm run db:migrate  # creates the tables
npm run dev         # http://localhost:3000/health
```

## Data model

- **Customer**: a person who books.
- **Provider**: a person or resource that gets booked.
- **Service**: what is booked, with a duration and price.
- **Appointment**: a provider + customer + service over a time range, with a status
  (`PENDING`, `CONFIRMED`, `CANCELLED`, `COMPLETED`, `NO_SHOW`).

## Double-booking and holds

Double-booking is prevented by the database itself: an exclusion constraint on
`Appointment` rejects overlapping time ranges for the same provider. It covers
`PENDING`, `CONFIRMED`, `COMPLETED` and `NO_SHOW`; `CANCELLED`, `EXPIRED` and
`BUMPED` free the slot. Back-to-back bookings are allowed. The constraint is raw
SQL in the migrations because Prisma's schema language cannot express it.

Unpaid bookings are holds (`src/appointments.ts`):

- `createHold` reserves a slot as `PENDING` for `HOLD_MINUTES` (default 24h,
  never past the appointment start). Nobody else can hold it meanwhile.
- When the timer runs out the hold becomes `EXPIRED` and the slot is free again.
  This happens lazily on every booking call, so no cron job is required.
  `releaseExpiredHolds()` can also be run on a schedule to keep statuses tidy.
- When someone pays, the booking becomes `CONFIRMED`. If another customer only
  holds the slot unpaid, their hold becomes `BUMPED` and the slot goes to the
  payer. A paid slot can never be taken. An expired holder who pays late still
  wins, unless someone else has paid for the slot in the meantime.
- Failures raise `SlotTakenError` (slot is paid or held by someone else) or
  `AppointmentStateError` (e.g. paying for a `BUMPED` hold). Map these to HTTP 409
  and notify bumped customers in the app.

All booking writes for one provider are serialized with a Postgres advisory lock,
so simultaneous payers cannot deadlock.

## Payments (authorize, then capture)

`src/payments/service.ts`. `CONFIRMED` means "paid". Never call `confirmHold` or
`bookConfirmed` directly from a route; go through these:

- `payForHold({ appointmentId, customerId, paymentToken })`: the holder pays.
- `payAndBook({ providerId, customerId, serviceId, startsAt, paymentToken })`: anyone pays.

Each does three steps:

1. **Authorize** the card (reserve the money). Declined: nothing else happens.
2. **Book**: confirm the slot and link the `Payment` row in one DB transaction.
3. **Capture** (charge) only after the booking succeeded.

If two customers pay at the same moment, whoever reaches the database first gets the
slot. The other loses at step 2, their authorization is **voided**, and they are never
charged, so there is nothing to refund. They get `SlotTakenError` (or
`AppointmentStateError` if they were a holder who just got bumped).

If capture fails after booking, the booking is cancelled (`PaymentCaptureError`),
so nobody gets a free appointment. If the server crashes between steps, an
`AUTHORIZED` payment is left behind; run `reconcilePayments()` on a schedule
(for example every 10 minutes) to capture or void it. Free services (`priceCents = 0`)
skip payment entirely. The price always comes from the database, never from the caller.

The provider is a dummy (`src/payments/fakeGateway.ts`, in memory) behind a small
`PaymentGateway` interface. Payment tokens choose the outcome: `tok_ok`,
`tok_declined`, `tok_capture_fails`. To use a real provider, implement the interface.
Real providers also expect an idempotency key on each call; the dummy does not.

## Scripts

| Script                            | Purpose                             |
| --------------------------------- | ----------------------------------- |
| `npm run dev`                     | Run with reload (tsx)               |
| `npm run build` / `npm start`     | Compile to `dist/`, run             |
| `npm run typecheck`               | Type-check only                     |
| `npm run lint` / `lint:fix`       | ESLint                              |
| `npm run format` / `format:check` | Prettier                            |
| `npm run db:up` / `db:down`       | Start / stop PostgreSQL             |
| `npm run db:migrate`              | Create and apply a migration (dev)  |
| `npm run db:deploy`               | Apply existing migrations (prod/CI) |
| `npm run db:generate`             | Regenerate the Prisma client        |
| `npm run db:studio`               | Browse data in Prisma Studio        |
