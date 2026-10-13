import { randomUUID } from 'node:crypto';
import { PaymentDeclinedError, type PaymentGateway } from './gateway.js';

type AuthState = 'AUTHORIZED' | 'CAPTURED' | 'VOIDED';

// Dummy provider for learning. State lives in memory (lost on restart).
// The payment token picks the behaviour:
//   tok_ok               everything succeeds
//   tok_declined         authorize is declined
//   tok_capture_fails    authorize works, capture fails
export class FakeGateway implements PaymentGateway {
  private auths = new Map<string, { amountCents: number; token: string; state: AuthState }>();

  async authorize(req: { amountCents: number; paymentToken: string; customerId: string }) {
    if (req.paymentToken === 'tok_declined') throw new PaymentDeclinedError('Card declined');
    if (req.paymentToken !== 'tok_ok' && req.paymentToken !== 'tok_capture_fails') {
      throw new PaymentDeclinedError('Unknown payment token');
    }
    const id = `auth_${randomUUID()}`;
    this.auths.set(id, {
      amountCents: req.amountCents,
      token: req.paymentToken,
      state: 'AUTHORIZED',
    });
    return { id };
  }

  async capture(id: string) {
    const a = this.get(id);
    if (a.state === 'CAPTURED') return;
    if (a.state === 'VOIDED') throw new Error(`Authorization ${id} was voided`);
    if (a.token === 'tok_capture_fails') throw new Error('Capture failed');
    a.state = 'CAPTURED';
  }

  async void(id: string) {
    const a = this.get(id);
    if (a.state === 'VOIDED') return;
    if (a.state === 'CAPTURED') throw new Error(`Authorization ${id} was already captured`);
    a.state = 'VOIDED';
  }

  /** For tests and debugging: what state is this authorization in? */
  stateOf(id: string): AuthState {
    return this.get(id).state;
  }

  private get(id: string) {
    const a = this.auths.get(id);
    if (!a) throw new Error(`Unknown authorization ${id}`);
    return a;
  }
}
