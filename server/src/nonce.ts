import { randomBytes } from 'node:crypto';

/** 8 random bytes -> 16 hex chars. */
export function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Tracks every nonce issued during the process lifetime and records any
 * collision. A reused nonce means a provider cache could be serving the
 * response, which would fake determinism — so a duplicate invalidates the run.
 *
 * The registry can also be seeded from previously persisted records so that
 * uniqueness holds across restarts and page reloads, not just within one run.
 */
export class NonceRegistry {
  private readonly seen = new Set<string>();
  private readonly duplicates = new Set<string>();
  private issuedCount = 0;

  /**
   * Issue a fresh nonce. Loops until it has never been seen before, so a
   * collision can only be introduced by external seeding (i.e. real reuse on
   * disk), never by this generator.
   */
  issue(): string {
    for (let i = 0; i < 1000; i++) {
      const nonce = randomHex(8);
      if (!this.seen.has(nonce)) {
        this.seen.add(nonce);
        this.issuedCount++;
        return nonce;
      }
      this.duplicates.add(nonce);
    }
    throw new Error('nonce generation failed: 1000 consecutive collisions');
  }

  /** Record a nonce observed in persisted data; flags reuse across runs. */
  observe(nonce: string): void {
    if (this.seen.has(nonce)) this.duplicates.add(nonce);
    else this.seen.add(nonce);
  }

  audit(): { issued: number; unique: number; duplicates: string[]; ok: boolean } {
    const duplicates = [...this.duplicates].sort();
    return {
      issued: this.issuedCount,
      unique: this.seen.size,
      duplicates,
      ok: duplicates.length === 0,
    };
  }
}