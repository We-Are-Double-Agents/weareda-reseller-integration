/**
 * order.status - the two status columns, the ladder and the exceptions
 * (contract 6.1).
 *
 * `integration_status` always moves. `orders.status` - the CUSTOMER-FACING
 * column the tenant's staff see and edit - moves only when the tenant
 * registered `orderStatusWrite: true` at connect time.
 */
import { describe, expect, it } from 'vitest';
import {
  MAPPED_ORDER_STATES,
  ORDER_STATUS_EXCEPTIONS,
  ORDER_STATUS_LADDER,
  mapsToIntegrationStatus,
  mapsToOrderStatus,
  resolveOrderStatusTransition,
} from '../src/weareda/types.js';

/** Runs a sequence of reseller states and returns the resulting status. */
function replay(start: string, states: string[], orderStatusWrite = true) {
  let current = start;
  const steps = states.map((state) => {
    const transition = resolveOrderStatusTransition({
      currentStatus: current,
      state,
      orderStatusWrite,
    });
    if (transition.outcome === 'applied' && transition.orderStatus) {
      current = transition.orderStatus;
    }
    return transition;
  });
  return { current, steps };
}

describe('state mapping - both columns', () => {
  it.each([
    ['accepted', 'accepted', 'confirmed'],
    ['acknowledged', 'accepted', 'confirmed'],
    ['ack', 'accepted', 'confirmed'],
    ['shipped', 'completed', 'shipped'],
    ['fulfilled', 'completed', 'shipped'],
    ['delivered', 'completed', 'delivered'],
    ['completed', 'completed', 'delivered'],
    ['cancelled', 'cancelled', 'cancelled'],
    ['canceled', 'cancelled', 'cancelled'],
    ['returned', 'returned', 'refunded'],
    ['return', 'returned', 'refunded'],
    ['refunded', 'returned', 'refunded'],
    ['not_delivered', 'returned', 'refunded'],
    ['undelivered', 'returned', 'refunded'],
    ['rejected', 'manual_review', null],
    ['failed', 'manual_review', null],
    ['error', 'manual_review', null],
  ])('maps %s to %s / %s', (state, integrationStatus, orderStatus) => {
    expect(mapsToIntegrationStatus(state)).toBe(integrationStatus);
    expect(mapsToOrderStatus(state)).toBe(orderStatus);
  });

  it('does not map anything else', () => {
    expect(mapsToIntegrationStatus('packed_in_warehouse')).toBeNull();
    expect(mapsToOrderStatus('packed_in_warehouse')).toBeNull();
  });

  it('lists every mapped state, and the five new return aliases among them', () => {
    for (const state of MAPPED_ORDER_STATES) {
      expect(mapsToIntegrationStatus(state)).not.toBeNull();
    }
    expect(MAPPED_ORDER_STATES).toContain('returned');
    expect(MAPPED_ORDER_STATES).toContain('not_delivered');
  });

  it('derives the order status from the RAW state, because integration_status collapses', () => {
    // Both are `completed`, but one is shipped and one is delivered.
    expect(mapsToIntegrationStatus('shipped')).toBe(mapsToIntegrationStatus('delivered'));
    expect(mapsToOrderStatus('shipped')).not.toBe(mapsToOrderStatus('delivered'));
  });

  it('maps fulfilled to shipped, not delivered - the cheaper wrong guess', () => {
    // Guessing `delivered` would make the ladder discard the real one later.
    expect(mapsToOrderStatus('fulfilled')).toBe('shipped');
    const { current } = replay('confirmed', ['fulfilled', 'delivered']);
    expect(current).toBe('delivered');
  });

  it('treats a return as a return, not a cancellation', () => {
    // cancelled = never shipped. returned = shipped and came back.
    expect(mapsToOrderStatus('returned')).toBe('refunded');
    expect(mapsToOrderStatus('cancelled')).toBe('cancelled');
    expect(mapsToIntegrationStatus('returned')).toBe('returned');
  });
});

describe('the ladder', () => {
  it('is the documented sequence, with two exceptions off it', () => {
    expect(ORDER_STATUS_LADDER).toEqual([
      'draft',
      'pending',
      'confirmed',
      'processing',
      'shipped',
      'delivered',
    ]);
    expect(ORDER_STATUS_EXCEPTIONS).toEqual(['cancelled', 'refunded']);
  });

  it('advances confirmed -> shipped -> delivered', () => {
    const { current, steps } = replay('confirmed', ['accepted', 'shipped', 'delivered']);
    expect(current).toBe('delivered');
    expect(steps.map((s) => s.detail)).toEqual([
      'completed; status unchanged (already_current)',
      'completed; status confirmed→shipped',
      'completed; status shipped→delivered',
    ]);
  });

  it('ignores a lower rung arriving after a higher one', () => {
    const { current, steps } = replay('shipped', ['accepted']);
    expect(current).toBe('shipped');
    expect(steps[0]).toMatchObject({
      outcome: 'unchanged',
      reason: 'backward',
      detail: 'completed; status unchanged (backward)',
      errorCode: null,
    });
  });

  it('reports a re-sent state as already_current, not as a move', () => {
    const transition = resolveOrderStatusTransition({
      currentStatus: 'shipped',
      state: 'shipped',
      orderStatusWrite: true,
    });
    expect(transition.detail).toBe('completed; status unchanged (already_current)');
  });

  it('advances a status that is not on the ladder at all', () => {
    const transition = resolveOrderStatusTransition({
      currentStatus: 'awaiting_payment',
      state: 'shipped',
      orderStatusWrite: true,
    });
    expect(transition.outcome).toBe('applied');
  });
});

describe('the exceptions', () => {
  it('applies cancelled and refunded from any rung at any time', () => {
    expect(replay('confirmed', ['cancelled']).current).toBe('cancelled');
    expect(replay('confirmed', ['shipped', 'returned']).current).toBe('refunded');
    expect(replay('confirmed', ['shipped', 'delivered', 'refunded']).current).toBe('refunded');
  });

  it('accepts a refund after delivery as an ordinary outcome', () => {
    const { steps } = replay('confirmed', ['shipped', 'delivered', 'not_delivered']);
    expect(steps[2]).toMatchObject({ outcome: 'applied', orderStatus: 'refunded' });
  });
});

describe('the conflict', () => {
  it('rejects a fulfilment step for an order already held as cancelled', () => {
    const transition = resolveOrderStatusTransition({
      currentStatus: 'cancelled',
      state: 'shipped',
      orderStatusWrite: true,
    });
    expect(transition).toMatchObject({
      outcome: 'rejected',
      // The order is left untouched; only the integration side moves.
      orderStatus: null,
      integrationStatus: 'manual_review',
      errorCode: 'order_status_conflict',
      detail: 'rejected; order_status_conflict',
    });
  });

  it('does the same from refunded', () => {
    expect(
      resolveOrderStatusTransition({
        currentStatus: 'refunded',
        state: 'delivered',
        orderStatusWrite: true,
      }).errorCode,
    ).toBe('order_status_conflict');
  });

  it('does not conflict when the incoming state is itself an exception', () => {
    expect(
      resolveOrderStatusTransition({
        currentStatus: 'cancelled',
        state: 'refunded',
        orderStatusWrite: true,
      }).outcome,
    ).toBe('applied');
  });
});

describe('the opt-in', () => {
  it('leaves the customer-facing status frozen when it is off', () => {
    const { current, steps } = replay('confirmed', ['shipped', 'delivered'], false);
    expect(current).toBe('confirmed');
    for (const step of steps) {
      expect(step.detail).toBe('completed; status unchanged (status_write_disabled)');
      // integration_status still moves on every event.
      expect(step.integrationStatus).toBe('completed');
    }
  });

  it('does not notice a conflict when it is off - WeAreDA never consults the column', () => {
    const transition = resolveOrderStatusTransition({
      currentStatus: 'cancelled',
      state: 'shipped',
      orderStatusWrite: false,
    });
    expect(transition.outcome).toBe('unchanged');
    expect(transition.integrationStatus).toBe('completed');
  });
});

describe('operation diagnostics', () => {
  it.each([
    ['confirmed', 'shipped', true, 'completed; status confirmed→shipped', null],
    ['confirmed', 'shipped', false, 'completed; status unchanged (status_write_disabled)', null],
    ['confirmed', 'rejected', true, 'completed; status unchanged (unmapped_state)', null],
    ['shipped', 'shipped', true, 'completed; status unchanged (already_current)', null],
    ['delivered', 'shipped', true, 'completed; status unchanged (backward)', null],
    ['confirmed', 'teleported', true, 'rejected; unknown_order_state', 'unknown_order_state'],
  ])('reports %s + %s as %s', (currentStatus, state, write, detail, errorCode) => {
    const transition = resolveOrderStatusTransition({
      currentStatus,
      state,
      orderStatusWrite: write as boolean,
    });
    expect(transition.detail).toBe(detail);
    expect(transition.errorCode).toBe(errorCode);
  });

  it('leaves both columns alone for an unknown state', () => {
    const transition = resolveOrderStatusTransition({
      currentStatus: 'confirmed',
      state: 'packed_in_warehouse',
      orderStatusWrite: true,
    });
    expect(transition.integrationStatus).toBeNull();
    expect(transition.orderStatus).toBeNull();
  });

  it('names the timestamp to fill in, and only for shipped and delivered', () => {
    expect(
      resolveOrderStatusTransition({
        currentStatus: 'confirmed',
        state: 'shipped',
        orderStatusWrite: true,
      }).fillTimestamp,
    ).toBe('shipped_at');
    expect(
      resolveOrderStatusTransition({
        currentStatus: 'shipped',
        state: 'delivered',
        orderStatusWrite: true,
      }).fillTimestamp,
    ).toBe('delivered_at');
    expect(
      resolveOrderStatusTransition({
        currentStatus: 'shipped',
        state: 'cancelled',
        orderStatusWrite: true,
      }).fillTimestamp,
    ).toBeNull();
    // A backward event names no timestamp, so a late `shipped` cannot
    // overwrite a shipped_at that is already set.
    expect(
      resolveOrderStatusTransition({
        currentStatus: 'delivered',
        state: 'shipped',
        orderStatusWrite: true,
      }).fillTimestamp,
    ).toBeNull();
  });
});
