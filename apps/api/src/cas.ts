import {createHash, randomBytes} from 'node:crypto';

export type CasSnapshot = {revision: number; etag: string; ciphertext: Uint8Array};
export type Ticket = {hash: string; roomId: string; origin: string; expiresAt: number; used: boolean};

const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('base64url');

export class LocalRoomCas {
  private snapshot: CasSnapshot = {revision: 1, etag: '"sf1.0.1.genesis"', ciphertext: Uint8Array.from([1])};
  private readonly tickets = new Map<string, Ticket>();

  read(): CasSnapshot { return {...this.snapshot, ciphertext: this.snapshot.ciphertext.slice()}; }

  write(ifMatch: string, ciphertext: Uint8Array): CasSnapshot {
    if (ifMatch !== this.snapshot.etag) throw new Error('REVISION_CONFLICT');
    if (ciphertext.byteLength > 524_288) throw new Error('STATE_TOO_LARGE');
    const revision = this.snapshot.revision + 1;
    const etag = `"sf1.0.${revision}.${digest(ciphertext)}"`;
    this.snapshot = {revision, etag, ciphertext: ciphertext.slice()};
    return this.read();
  }

  mintTicket(roomId: string, origin: string, now = Date.now()): string {
    const raw = randomBytes(32);
    const value = raw.toString('base64url');
    this.tickets.set(digest(raw), {hash: digest(raw), roomId, origin, expiresAt: now + 30_000, used: false});
    return value;
  }

  redeemTicket(value: string, roomId: string, origin: string, now = Date.now()): void {
    const raw = Buffer.from(value, 'base64url');
    const ticket = this.tickets.get(digest(raw));
    if (!ticket || ticket.used || ticket.expiresAt < now || ticket.roomId !== roomId || ticket.origin !== origin) throw new Error('TICKET_INVALID');
    ticket.used = true;
  }
}
