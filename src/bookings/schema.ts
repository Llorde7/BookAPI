import { z } from 'zod';

// What a customer may choose. The customer comes from the access token, and the
// end time, status and hold timer are computed by the server. Unknown keys are dropped.
export const createBookingBody = z.object({
  providerId: z.uuid(),
  serviceId: z.uuid(),
  // An exact instant: the offset ("Z" or "+02:00") is required so there is no
  // guessing which time zone was meant.
  startsAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .refine((d) => d.getTime() > Date.now(), 'startsAt must be in the future'),
});

export type CreateBookingBody = z.infer<typeof createBookingBody>;
