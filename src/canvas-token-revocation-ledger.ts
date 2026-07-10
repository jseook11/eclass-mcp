import type { CachedToken, CachedTokenRevocation, CachedTokenV2 } from './types.js';
import type { CanvasTokenLock } from './canvas-token-lock.js';
import {
  deriveCanvasTokenHint,
  isCachedTokenV2,
  normalizePendingRevocations,
  retryPendingCanvasTokenRevocations,
} from './canvas-token-lifecycle.js';
import {
  deleteCredential,
  getCredential,
  getCredentialBackend,
  setCredential,
} from './credential-store.js';

export const CANVAS_TOKEN_REVOCATION_LEDGER_SERVICE = 'eclass-mcp';
export const CANVAS_TOKEN_REVOCATION_LEDGER_PREFIX = 'token-revocations:';

export interface CanvasTokenRevocationLedgerState {
  version: 1;
  pending_revocations: CachedTokenRevocation[];
}

export interface CanvasTokenRevocationLedgerCredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

async function assertSecureLedgerBackend(): Promise<void> {
  if (await getCredentialBackend() === 'file') {
    throw new Error('Canvas token revocation ledger requires a secure credential backend');
  }
}

const secureCredentialStore: CanvasTokenRevocationLedgerCredentialStore = {
  get: async (service, account) => {
    await assertSecureLedgerBackend();
    return getCredential(service, account);
  },
  set: async (service, account, value) => {
    await assertSecureLedgerBackend();
    await setCredential(service, account, value, { allowFileFallback: false });
  },
  delete: async (service, account) => {
    await assertSecureLedgerBackend();
    await deleteCredential(service, account);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidRevocation(value: unknown): value is CachedTokenRevocation {
  return normalizePendingRevocations([value as CachedTokenRevocation]).length === 1;
}

export function parseCanvasTokenRevocationLedgerCredential(
  raw: string | null,
): CanvasTokenRevocationLedgerState {
  if (raw === null) return { version: 1, pending_revocations: [] };

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Canvas token revocation ledger contains invalid JSON');
  }
  if (
    !isRecord(decoded) ||
    decoded.version !== 1 ||
    !Array.isArray(decoded.pending_revocations) ||
    !decoded.pending_revocations.every(isValidRevocation)
  ) {
    throw new Error('Canvas token revocation ledger has a corrupt or unsupported schema');
  }
  return {
    version: 1,
    pending_revocations: normalizePendingRevocations(decoded.pending_revocations),
  };
}

function sameRevocations(
  left: readonly CachedTokenRevocation[],
  right: readonly CachedTokenRevocation[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return entry.id === other?.id && entry.token_hint === other?.token_hint;
  });
}

function activeIdentity(
  cached: CachedToken | null | undefined,
): CachedTokenRevocation | undefined {
  if (!cached) return undefined;
  return isCachedTokenV2(cached)
    ? { id: cached.id, token_hint: cached.token_hint }
    : { token_hint: deriveCanvasTokenHint(cached.token) };
}

class CanvasTokenRevocationLedgerChangedError extends Error {
  constructor() {
    super('Canvas token revocation ledger changed during a locked update');
  }
}

export class CanvasTokenRevocationLedger {
  readonly account: string;

  constructor(
    username: string,
    private readonly store: CanvasTokenRevocationLedgerCredentialStore = secureCredentialStore,
  ) {
    if (!username.trim()) throw new Error('Canvas token revocation ledger requires a username');
    this.account = `${CANVAS_TOKEN_REVOCATION_LEDGER_PREFIX}${username}`;
  }

  async read(lock: CanvasTokenLock): Promise<CachedTokenRevocation[]> {
    await lock.assertOwned();
    const raw = await this.store.get(CANVAS_TOKEN_REVOCATION_LEDGER_SERVICE, this.account);
    return parseCanvasTokenRevocationLedgerCredential(raw).pending_revocations;
  }

  private async persist(
    lock: CanvasTokenLock,
    pending: readonly CachedTokenRevocation[],
  ): Promise<void> {
    await lock.assertOwned();
    if (pending.length === 0) {
      await this.store.delete(CANVAS_TOKEN_REVOCATION_LEDGER_SERVICE, this.account);
      return;
    }
    const state: CanvasTokenRevocationLedgerState = {
      version: 1,
      pending_revocations: [...pending],
    };
    await this.store.set(
      CANVAS_TOKEN_REVOCATION_LEDGER_SERVICE,
      this.account,
      JSON.stringify(state),
    );
  }

  private async replace(
    lock: CanvasTokenLock,
    expected: readonly CachedTokenRevocation[],
    desired: readonly CachedTokenRevocation[],
    activeToken?: CachedToken | null,
  ): Promise<CachedTokenRevocation[]> {
    const normalized = normalizePendingRevocations(desired, activeIdentity(activeToken));
    await lock.assertOwned();
    const current = await this.read(lock);
    if (!sameRevocations(current, expected)) {
      throw new CanvasTokenRevocationLedgerChangedError();
    }
    if (sameRevocations(current, normalized)) return normalized;

    try {
      await this.persist(lock, normalized);
      return normalized;
    } catch (err) {
      // A secure backend may report an error after the mutation reached durable
      // storage. Read back once before deciding that the update was lost.
      const observed = await this.read(lock);
      if (sameRevocations(observed, normalized)) return normalized;
      throw err;
    }
  }

  async append(
    lock: CanvasTokenLock,
    revocation: CachedTokenRevocation,
    activeToken?: CachedToken | null,
  ): Promise<CachedTokenRevocation[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const expected = await this.read(lock);
      const desired = normalizePendingRevocations(
        [...expected, revocation],
        activeIdentity(activeToken),
      );
      if (sameRevocations(expected, desired)) return expected;
      try {
        return await this.replace(lock, expected, desired, activeToken);
      } catch (err) {
        if (!(err instanceof CanvasTokenRevocationLedgerChangedError)) throw err;
      }
    }
    throw new Error('Canvas token revocation ledger kept changing during append');
  }

  /**
   * Merge the independent ledger with pending work carried by the active token,
   * retry it once, and durably store only failures. The ledger is updated before
   * callers compact the token cache, so a crash can cause duplicate 404-safe
   * retries but cannot lose a revocation target.
   */
  async retry(
    lock: CanvasTokenLock,
    activeToken: CachedTokenV2,
    additionalPending: readonly CachedTokenRevocation[],
    fetchImpl: typeof fetch = fetch,
  ): Promise<CachedTokenRevocation[]> {
    const expected = await this.read(lock);
    const combined = normalizePendingRevocations(
      [...expected, ...additionalPending],
      activeToken,
    );
    const remaining = await retryPendingCanvasTokenRevocations(
      activeToken.token,
      combined,
      fetchImpl,
    );
    return this.replace(lock, expected, remaining, activeToken);
  }
}
