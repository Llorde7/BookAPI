// The only thing the rest of the app knows about a payment provider.
// Swap FakeGateway for a real one (Stripe etc.) by implementing this interface.
export interface PaymentGateway {
  /** Reserve funds on the card without charging. Throws PaymentDeclinedError. */
  authorize(req: {
    amountCents: number;
    paymentToken: string;
    customerId: string;
  }): Promise<{ id: string }>;
  /** Charge a previous authorization. Safe to call twice. */
  capture(authorizationId: string): Promise<void>;
  /** Release a previous authorization without charging. Safe to call twice. */
  void(authorizationId: string): Promise<void>;
}

export class PaymentDeclinedError extends Error {
  constructor(message = 'Payment was declined') {
    super(message);
  }
}

export class PaymentCaptureError extends Error {
  constructor(message = 'Payment could not be captured; the booking was cancelled') {
    super(message);
  }
}
