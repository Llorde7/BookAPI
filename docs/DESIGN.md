# Design decisions

Why BookAPI is built the way it is. Each entry gives the decision, the alternative that
was rejected, and the reason. [README.md](../README.md) says how to run and use it; this
file says why. The last section lists what is weak or missing, in one place.

## Where the project stands

- **Built and tested:** accounts and login (register, login, refresh, logout, `/auth/me`),
  the data model, double-booking protection, unpaid holds, and authorize-then-capture
  payments against a dummy provider.
- **Built, partly:** `POST /bookings` and `GET /bookings` (`src/bookings/`). Payments and
  confirmation exist as tested functions (`src/payments/service.ts`) that nothing calls over
  HTTP yet.
- **Purpose:** this is a learning project, so some choices (a dummy payment provider, tokens
  in the JSON body) favour clarity over production hardening. Those are marked below.

## 1. Preventing double booking

**The database rejects overlapping bookings; the API does not check first.**
`appointment_no_overlap` is a PostgreSQL exclusion constraint on
`(providerId, time range)`.

- _Rejected:_ query for conflicts, then insert. Two requests can both pass the check at the
  same moment and both insert. A constraint is the only place that race can be closed.
- _Cost:_ the rule is raw SQL in the migrations, because Prisma's schema language cannot
  express it, and it needs the `btree_gist` extension. The API must turn the database error
  into a friendly one (`SlotTakenError`).

**Time ranges are half-open (`[start, end)`).** 10:00-10:30 followed by 10:30-11:00 is
allowed. With closed ranges, back-to-back appointments would be impossible.

**Only active statuses block a slot.** `PENDING`, `CONFIRMED`, `COMPLETED` and `NO_SHOW`
block; `CANCELLED`, `EXPIRED` and `BUMPED` free the slot. Cancelled rows are kept for
history instead of deleted.

**Protection is per provider.** Two providers can be booked at the same time.

**Two more database rules:** `endsAt > startsAt`, and a `PENDING` booking must have a
`holdExpiresAt`. They guard against bad data even if the app is bypassed.

**`startsAt` and `endsAt` are both stored**, not start plus the service's duration. The
overlap rule needs the real range, and changing a service from 30 to 45 minutes later must
not rewrite existing appointments.

## 2. Unpaid holds and paying customers

**An unpaid booking holds its slot for a long time (24 hours by default, `HOLD_MINUTES`),
never past the appointment's start.** A long hold lets people pay at their own pace.

**But a paying customer always wins.** If someone else only holds the slot unpaid, their
hold becomes `BUMPED` and the slot goes to the payer. A paid slot can never be taken.

- _Rejected:_ a hold that is exclusive until it expires. That lets someone block a slot for
  a day without paying.

**An expired holder who pays late still wins**, as long as nobody has paid for the slot in
the meantime. Their money arrived; the slot is only lost to someone who paid first.

**Expiry happens lazily.** Every booking call first turns stale holds into `EXPIRED` for
that provider, so no cron job is required. The constraint cannot use `now()`, so stale rows
must actually change status.

**All booking writes for one provider run behind a PostgreSQL advisory lock.** The
constraint alone would still be correct, but two payers swapping holds could deadlock each
other. The lock serializes them; the constraint remains the safety net.

**Callers can only choose four fields** (`providerId`, `customerId`, `serviceId`,
`startsAt`). The code copies just those instead of spreading the input into the database
insert. The tests found this: an extra field in the input (an `id`, `status`, `notes`) used
to flow straight into the insert.

## 3. Payments

**Authorize, then book, then capture.** The card is reserved first, the booking is confirmed
second, and the money is only taken if the booking succeeded.

- _Rejected:_ charge first, then refund the loser. Refunds are slow, cost fees and annoy
  customers. With authorization, a customer who loses a race has the reservation voided and
  is never charged.

**If two people pay at once, whoever reaches the database first gets the slot.** "First"
means first to arrive at the lock, not first to click pay.

**If capture fails after booking, the booking is cancelled** (status `CANCELLED`, payment
`FAILED`). Nobody gets a free appointment.

**`CONFIRMED` means paid.** There is no separate "paid" flag.

**The payment is linked to the appointment inside the same database transaction that
confirms it** (`onConfirmed` callback). A crash cannot leave a confirmed booking whose
payment is unlinked, which would make a leftover authorization look like an orphan.

**`reconcilePayments()` settles leftovers from crashes:** a paid booking gets captured, an
orphan authorization gets voided, and recent ones are left alone (they may be in flight).

**The price always comes from the `Service` row**, never from the request. Free services
skip payment entirely.

**The provider is a dummy** (`FakeGateway`, in memory) behind a small `PaymentGateway`
interface. Swapping in a real one means implementing three methods.

## 4. Passwords and access tokens

**Argon2id** for passwords, library defaults (64 MiB memory, 3 passes), which meet OWASP
guidance. The parameters are stored inside each hash, so they can be raised later.
Length is 8 to 128 characters with no composition rules; the upper bound stops someone
submitting megabytes to burn CPU. Passwords are never trimmed.

- _Rejected:_ bcrypt (kept only as the fallback if Argon2's native build failed; it did not).

**Login failures are uniform.** A wrong password and an unknown email return the same 401
body (`Invalid credentials`), and a dummy hash is checked for unknown emails so the response
takes about the same time. This stops the endpoint from revealing which emails have accounts.

**Registration tells you when an email is taken (409).** That does reveal an email exists;
the alternative needs an email-confirmation flow that does not exist yet.

**Registering over an existing email is always refused, even for guest bookings** (accounts
with no password). Without email verification, letting someone "claim" an email would hand
over that person's booking history.

**Access tokens are HS256 JWTs** (`jsonwebtoken`) lasting 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`,
capped at 1 hour so it cannot become long-lived by accident). They contain only the
customer id. Every check pins the algorithm, issuer, audience and requires an expiry.

- _Why pin the algorithm:_ without it the library accepts any HMAC variant the token's own
  header names (HS256, HS384 or HS512). Pinning to HS256 is the standard defence against
  algorithm-confusion attacks, and a test proves an HS512 token signed with the right
  secret is rejected.
- _Why require an expiry:_ the library accepts tokens without one; this API never does.
- _Why HS256:_ one service signs and verifies, so a shared secret is enough. A second
  service that must verify tokens would need the secret too; asymmetric keys would avoid that.

**`JWT_SECRET` is validated with Zod at startup** and the server exits if it is missing or
under 32 characters. A missing secret should stop the boot, not fail on the first login. The
error message never contains the secret. The seed script never issues tokens and
does not need it, so validation runs when the server starts and on first token use, not when
the config module is loaded.

**`requireAuth` returns `token_expired` for an expired token and `invalid_token` for
anything else.** A client then knows to call `/auth/refresh` instead of sending the user back
to the login screen.

## 5. Refresh tokens

**Opaque random tokens, not JWTs.** 256 random bits, valid for 30 days
(`REFRESH_TOKEN_TTL_DAYS`). They are not self-describing, so the server must look them up,
which is what makes revocation possible.

**Only a SHA-256 hash is stored.** A leaked table is useless to an attacker. A fast hash is
fine here, unlike for passwords, because the input is 256 random bits and cannot be guessed.

**Rotation:** every refresh revokes the old token and issues a new one. The old row is kept
(marked revoked), not deleted, so a replayed token can be recognised.

**Reuse ends every session for that customer.** A revoked token appearing again means it was
stolen or replayed. We cannot tell which copy the thief holds, so all sessions are revoked.

- _Rejected:_ revoke only that token family. That needs a `familyId` column and is more
  precise, but costs more code. This is the stricter, simpler option.
- _Cost:_ see "Weaknesses" 5 and 6.

**One conditional database update decides a race** (`WHERE revokedAt IS NULL`). Exactly one
simultaneous refresh succeeds; the others count as reuse.

**Every refresh failure returns the same `invalid_refresh_token` response**, so a client
cannot tell whether a token never existed, expired, or was used. An expired token is _not_
treated as theft and does not revoke other sessions.

**Logout revokes one session, always returns 204, and needs no access token.** It must work
exactly when the access token has expired. Repeating it is harmless.

**`RefreshToken` cascades on customer delete**, unlike every other relation (`Restrict`).
Tokens are disposable; with `Restrict`, any customer who ever logged in could not be deleted.

## 6. Data model and conventions

- **IDs:** `String @id @default(uuid(7)) @db.Uuid` on every model. UUIDv7 ids cannot be
  enumerated like 1, 2, 3 and are roughly time-ordered, which keeps indexes efficient. (They
  do reveal roughly when a row was created.)
- **Timestamps:** `Timestamptz(6)`, with `createdAt` and `updatedAt` on every model. Overlap
  checks compare exact instants, so daylight saving and time zones cannot cause false
  matches.
- **Deletes:** `Restrict` on customer, provider, service and appointment references, so
  history cannot vanish by accident. Retire a provider or service with its `active` flag.
- **Money:** whole cents (`priceCents`, `amountCents`), never floating point.
- **`name` is required at registration**, because `Customer.name` cannot be empty. The
  alternative is a nullable column, or inventing a name from the email.
- **`Customer.passwordHash` is nullable** so guest bookings without an account are possible.

## 7. Operations and testing

**Auth endpoints are rate limited per IP** (20 attempts per 15 minutes, `AUTH_RATE_LIMIT_MAX`),
counting every attempt. Refresh and logout are not limited: guessing a 256-bit token is
pointless, and sharing the login limiter would let refresh traffic lock people out of
logging in.

**One error helper** (`src/errors.ts`): throw `new HttpError(status, code, message)`.
Validation errors become 400, and anything unexpected becomes a generic 500 that leaks
nothing. This relies on Express 5, which forwards errors from `async` handlers by itself.

**Tests refuse to run unless the database name contains `test`.** They delete all data, so
a mistaken `DATABASE_URL` must not be able to wipe a development database.

**The tests attack the code.** Besides normal use they cover forged, tampered and expired
tokens, `alg: none`, reuse of refresh tokens, simultaneous payers and database-level
bypasses. Several security features were also broken on purpose, by hand, to confirm a test fails
(this check is not part of the suite).

**Prisma 7:** `migrate dev` does not regenerate the client. `npm install` does, through the
`postinstall` script.

## Weaknesses and known gaps

Ordered roughly by how much they matter.

1. **Only create and list exist over HTTP.** No payment, confirm, cancel or availability
   endpoint. `GET /bookings` is not paginated.
   `POST /bookings` is a deliberate check-then-insert with no transaction or lock (the
   rejected design in section 1). Concurrent requests for one slot both pass the check; the
   `appointment_no_overlap` constraint rejects all but one and the API returns 409, so no
   double booking, but it relies entirely on that constraint and on `isOverlapError`
   recognising the driver's error. It also does not use `bumpUnpaidHolds`, so an unpaid hold
   is never taken over by a later request.
2. **Not verified on Docker.** Everything was run on local PostgreSQL 16, not on the
   `postgres:17-alpine` container in `docker-compose.yml`.
3. **No working hours, days off, or provider-to-service link.** Any time can be booked, and
   any provider can do any service.
4. **A customer can book two providers at the same time.** The overlap rule is per provider.
5. **Simultaneous refreshes from one client log the user out everywhere** (two tabs, an app
   resuming). Clients must send one refresh at a time; a short grace window on the server
   would soften this.
6. **Presenting a logged-out refresh token also ends all sessions.** A stale client retrying
   with a dead token has this effect.
7. **Logout and account deletion do not stop an access token already issued.** It works until
   it expires (15 minutes). `requireAuth` checks only signature and expiry, never the
   database, which keeps it fast. `/auth/me` does check the account still exists.
8. **`endsAt` is not tied to the service's duration.** The code computes it; the database does
   not enforce it.
9. **Unpaid holds block slots for up to 24 hours**, and nothing limits how many a customer
   may hold.
10. **The payment provider is a dummy**, and there are no idempotency keys. A retried request
    could start a second authorization with a real provider.
11. **`reconcilePayments()` is not scheduled**, and expired refresh tokens are never deleted.
    Both need a periodic job.
12. **No email verification, password reset, account lockout, or logout-everywhere.** Only the
    per-IP rate limit slows password guessing, and it can lock out several users behind one
    shared address. Behind a reverse proxy, Express's `trust proxy` must be set.
13. **Email case is normalised by the app, not the database.** The unique index is
    case-sensitive, so rows written outside the API could create near-duplicates.
14. **Tokens travel in the JSON body.** A browser frontend should prefer an httpOnly cookie
    for the refresh token.
15. **No notifications.** `BUMPED` and `EXPIRED` are only statuses; telling the customer is
    unbuilt.
16. **Response shapes are slightly inconsistent.** `register` returns `{ id, email }` while
    `/auth/me` returns `{ customer: {...} }`.
17. **The timing equalisation for unknown emails is not covered by a committed test** (a
    timing assertion would be flaky). It was measured by hand once: 82 ms against 80 ms.
18. **Two migrations are dated in the future** (`20261014...` and `20261015...`, named by hand
    before their real date). This was tested and causes no problem; Prisma applies later-
    generated migrations regardless of name order. They were left alone because renaming a
    migration that may already be applied would break that database.
