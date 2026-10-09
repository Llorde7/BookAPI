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

Double-booking is prevented by the database itself: an exclusion constraint on
`Appointment` rejects overlapping time ranges for the same provider (cancelled
appointments are ignored, back-to-back bookings are allowed). It lives in the
init migration as raw SQL because Prisma's schema language cannot express it.
Handle the resulting database error in the API rather than checking availability
first, since a check-then-insert has a race condition.

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
