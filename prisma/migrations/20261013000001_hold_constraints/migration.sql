-- Existing unpaid bookings (none in a fresh database) get a 24h hold, capped at the start time.
UPDATE "Appointment"
SET "holdExpiresAt" = LEAST(now() + interval '24 hours', "startsAt")
WHERE "status" = 'PENDING' AND "holdExpiresAt" IS NULL;

-- An unpaid booking must always say when its hold runs out.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_pending_has_hold"
  CHECK ("status" <> 'PENDING' OR "holdExpiresAt" IS NOT NULL);

-- Same rule as before, but CANCELLED, EXPIRED and BUMPED now all free the slot.
-- Switching a PENDING row to BUMPED/EXPIRED and a new row to CONFIRMED is how a
-- paying customer takes over a slot (see src/appointments.ts).
ALTER TABLE "Appointment" DROP CONSTRAINT "appointment_no_overlap";
ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist (
    "providerId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  ) WHERE ("status" IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW'));
