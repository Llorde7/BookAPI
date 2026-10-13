# BookAPI

Appointment booking API built with TypeScript, Express, Prisma and PostgreSQL.

**Why it is built this way, and what is still weak:** see [docs/DESIGN.md](docs/DESIGN.md).

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
- **Payment**: an authorization / charge linked to an appointment.
- **RefreshToken**: a stored hash of a long-lived login token, belonging to a customer.
  Deleted along with its customer. The refresh endpoint is not built yet.

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

## Authentication

Customers register with an email and password and log in to get a short-lived JWT
access token (`src/auth/`).

| Endpoint              | Purpose                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| `POST /auth/register` | `{ email, password, name, phone? }` creates an account; returns `{ id, email }` (201) |
| `POST /auth/login`    | `{ email, password }` returns `{ accessToken, tokenType, expiresIn, refreshToken }`   |
| `POST /auth/refresh`  | `{ refreshToken }` returns a new access token **and a new refresh token**             |
| `POST /auth/logout`   | `{ refreshToken }` ends that session; always `204`                                    |
| `GET /auth/me`        | Needs `Authorization: Bearer <accessToken>`; returns `{ customer }`                   |

```sh
curl -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a long passphrase","name":"Me"}'
curl -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a long passphrase"}'
```

- Emails are trimmed and lowercased before saving and before lookup.
- Passwords are hashed with **Argon2id** (parameters live inside each hash). Length is
  8 to 128 characters; there are no composition rules and passwords are never trimmed.
- Tokens are **HS256 JWTs** (`jsonwebtoken`) that expire after 15 minutes
  (`ACCESS_TOKEN_TTL_SECONDS`, 1 to 3600). Only the customer id is inside. The issuer,
  audience, algorithm and expiry are checked on every request; tokens without an expiry are refused.
- A wrong password and an unknown email both return `401 { "error": "invalid_credentials",
"message": "Invalid credentials" }` and take about the same time.
- `JWT_SECRET` is **required**. It is validated with Zod at startup
  (`src/env.ts`): the server prints what is wrong and exits instead of booting without a
  secret of at least 32 characters. Generate one with `openssl rand -base64 48`.
- Login and register are rate limited per IP (`AUTH_RATE_LIMIT_MAX`, default 20 per
  15 minutes). Behind a reverse proxy, set Express's `trust proxy` so real client IPs are used.
- **Refresh tokens** are 256 random bits (not JWTs) valid for 30 days
  (`REFRESH_TOKEN_TTL_DAYS`, 1 to 90). Only their SHA-256 hash is stored. Every use
  **rotates** the token: the old one is revoked and a new one issued.
- **Reuse detection:** presenting a refresh token that was already used or logged out
  revokes **all** of that customer's sessions and returns 401, because it may have been
  stolen. All refresh failures return the same `invalid_refresh_token` response.
- When an access token expires, `requireAuth` answers `401 token_expired` (an invalid or
  forged one gets `invalid_token`), so a client knows to call `/auth/refresh` instead of
  asking the user to log in again.
- **Logout does not revoke the access token already issued**; it stays valid until it
  expires (15 minutes by default).
- Two requests refreshing with the same token at the same moment (two browser tabs, an app
  resuming) look like reuse and log the user out everywhere. Have clients serialize refreshes.
- Tokens travel in the JSON body; a browser frontend should prefer an httpOnly cookie.
- Expired refresh tokens are not deleted automatically yet (the `expiresAt` index is
  ready for a cleanup job).
- The seed's customers use a placeholder hash, so they **cannot log in**. Register a new
  account to try it. Registering with an email that already exists is refused, even for
  guest bookings, because there is no email verification to prove ownership.
- Errors go through one helper (`src/errors.ts`): `throw new HttpError(status, code, message)`.
  Validation errors become `400`, and unexpected errors become a generic `500` that leaks nothing.
- Not built: email verification, password reset, account lockout, logout-everywhere.

## Tests

`npm test` runs everything (about 100 tests: startup config, error helper, register, login,
token attacks, rate limiting, holds, payments and the database rules). The tests **delete all
data**, so they only run against a database whose name contains `test`; anything else is refused.

```sh
npm run db:up
npm run test:db:create    # once: creates the bookapi_test database in the Docker container
export TEST_DATABASE_URL=postgres://bookapi:bookapi@localhost:5432/bookapi_test
npm run test:db:migrate   # whenever migrations change
npm test
```

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
