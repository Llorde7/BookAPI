import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { createBooking, listBookings } from './service.js';
import { createBookingBody } from './schema.js';

export const bookingsRouter = Router();

bookingsRouter.use(requireAuth);

// Reserve a slot (unpaid hold). The customer is always the one in the access token.
bookingsRouter.post('/', async (req, res) => {
  const body = createBookingBody.parse(req.body);
  const booking = await createBooking({ ...body, customerId: req.auth!.customerId });
  res.status(201).json({ booking });
});

// Only the caller's own bookings, soonest first.
bookingsRouter.get('/', async (req, res) => {
  res.json({ bookings: await listBookings(req.auth!.customerId) });
});
