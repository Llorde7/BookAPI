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
- `confirmHold` (holder pays) and `bookAndPay` (anyone pays) mark the booking
  `CONFIRMED`. If another customer only holds the slot unpaid, their hold becomes
  `BUMPED` and the slot goes to the payer. A paid slot can never be taken.
- Failures raise `SlotTakenError` (slot is paid or held by someone else) or
  `AppointmentStateError` (e.g. confirming a `BUMPED` appointment). Map these to
  HTTP 409 and notify bumped customers.

All booking writes for one provider are serialized with a Postgres advisory lock,
so simultaneous payers cannot deadlock. There is no payment integration yet:
`CONFIRMED` means "paid", and callers should invoke `confirmHold`/`bookAndPay`
only after payment succeeds.

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
