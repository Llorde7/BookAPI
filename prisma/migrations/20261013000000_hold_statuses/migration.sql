-- New enum values cannot be used in the transaction that adds them, so the
-- constraints that reference them live in the next migration.
ALTER TYPE "AppointmentStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "AppointmentStatus" ADD VALUE 'BUMPED';

ALTER TABLE "Appointment" ADD COLUMN "holdExpiresAt" TIMESTAMPTZ(6);
