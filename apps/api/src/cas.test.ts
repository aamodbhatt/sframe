import {describe, expect, it} from 'vitest';
import {LocalRoomCas} from './cas.js';

describe('local room CAS/ticket spike', () => {
  it('requires the exact ETag and preserves ciphertext bytes', () => {
    const cas = new LocalRoomCas();
    const first = cas.read();
    const next = cas.write(first.etag, Uint8Array.from([2, 3, 5]));
    expect(next.revision).toBe(2);
    expect(next.ciphertext).toEqual(Uint8Array.from([2, 3, 5]));
    expect(() => cas.write(first.etag, Uint8Array.from([8]))).toThrow('REVISION_CONFLICT');
  });

  it('redeems a room/origin-bound ticket once and rejects reuse/context/expiry', () => {
    const cas = new LocalRoomCas();
    const ticket = cas.mintTicket('room-a', 'http://app.localhost:4173', 1_000);
    cas.redeemTicket(ticket, 'room-a', 'http://app.localhost:4173', 1_001);
    expect(() => cas.redeemTicket(ticket, 'room-a', 'http://app.localhost:4173', 1_002)).toThrow('TICKET_INVALID');
    const other = cas.mintTicket('room-a', 'http://app.localhost:4173', 1_000);
    expect(() => cas.redeemTicket(other, 'room-b', 'http://app.localhost:4173', 1_001)).toThrow('TICKET_INVALID');
    const expired = cas.mintTicket('room-a', 'http://app.localhost:4173', 1_000);
    expect(() => cas.redeemTicket(expired, 'room-a', 'http://app.localhost:4173', 31_001)).toThrow('TICKET_INVALID');
  });
});
