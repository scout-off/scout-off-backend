/**
 * Unit tests for deterministic event ordering (#1111).
 */

import {
  normalizeAndSortEvents,
  groupCoTransactionEvents,
  parseEventIdOrdinals,
  compareEventOrdinals,
  type RawIndexerEvent,
} from '../../src/services/eventOrdering';

function ev(partial: Partial<RawIndexerEvent> & Pick<RawIndexerEvent, 'ledger' | 'txHash'>): RawIndexerEvent {
  return { contractId: 'C', ...partial };
}

describe('eventOrdering', () => {
  describe('parseEventIdOrdinals', () => {
    it('parses padded RPC-style ids', () => {
      expect(parseEventIdOrdinals('0000123456-0000000003-0000000001')).toEqual({
        ledger: 123456,
        txApplicationOrder: 3,
        eventIndex: 1,
      });
    });

    it('returns null for unparseable tokens', () => {
      expect(parseEventIdOrdinals('not-an-id')).toBeNull();
      expect(parseEventIdOrdinals(undefined)).toBeNull();
    });
  });

  describe('normalizeAndSortEvents', () => {
    it('produces a stable total order regardless of RPC return order', () => {
      // Interleaved same-ledger events returned out of order from the RPC.
      const shuffled: RawIndexerEvent[] = [
        ev({ ledger: 10, txHash: 'txB', id: '10-1-0', contractId: 'progress' }),
        ev({ ledger: 10, txHash: 'txA', id: '10-0-1', contractId: 'progress' }),
        ev({ ledger: 10, txHash: 'txA', id: '10-0-0', contractId: 'register' }),
        ev({ ledger: 9, txHash: 'txZ', id: '9-0-0', contractId: 'register' }),
        ev({ ledger: 10, txHash: 'txB', id: '10-1-1', contractId: 'subscription' }),
      ];

      const forward = normalizeAndSortEvents(shuffled);
      const reverse = normalizeAndSortEvents([...shuffled].reverse());

      const key = (e: (typeof forward)[number]) =>
        `${e.ledger}:${e.txApplicationOrder}:${e.eventIndex}:${e.contractId}:${e.txHash}`;

      expect(forward.map(key)).toEqual(reverse.map(key));
      expect(forward.map(key)).toEqual([
        '9:0:0:register:txZ',
        '10:0:0:register:txA',
        '10:0:1:progress:txA',
        '10:1:0:progress:txB',
        '10:1:1:subscription:txB',
      ]);
    });

    it('assigns fallback ordinals when RPC ids are absent', () => {
      const events = normalizeAndSortEvents([
        ev({ ledger: 1, txHash: 'b' }),
        ev({ ledger: 1, txHash: 'a' }),
        ev({ ledger: 1, txHash: 'a' }),
      ]);

      // Within a ledger, first-seen order after stable txHash sort: a then b.
      expect(events.map((e) => `${e.txHash}:${e.eventIndex}`)).toEqual([
        'a:0',
        'a:1',
        'b:0',
      ]);
    });
  });

  describe('groupCoTransactionEvents', () => {
    it('groups co-transaction events as an atomic unit', () => {
      const ordered = normalizeAndSortEvents([
        ev({ ledger: 5, txHash: 'tx1', id: '5-0-0' }),
        ev({ ledger: 5, txHash: 'tx1', id: '5-0-1' }),
        ev({ ledger: 5, txHash: 'tx2', id: '5-1-0' }),
      ]);
      const groups = groupCoTransactionEvents(ordered);
      expect(groups).toHaveLength(2);
      expect(groups[0].map((e) => e.eventIndex)).toEqual([0, 1]);
      expect(groups[1].map((e) => e.txHash)).toEqual(['tx2']);
    });
  });

  describe('compareEventOrdinals', () => {
    it('orders by ledger then tx order then event index then contract', () => {
      const a = {
        ledger: 1,
        txApplicationOrder: 0,
        eventIndex: 0,
        contractId: 'a',
        txHash: 't',
      };
      const b = { ...a, contractId: 'b' };
      expect(compareEventOrdinals(a, b)).toBeLessThan(0);
    });
  });
});
