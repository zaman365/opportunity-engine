import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Evidence object storage port.
 *
 * INTEGRATIONS.md: "Local fixture objects or approved private R2, never mixed." Object keys
 * are tenant-scoped, and a read must name the tenant it believes it is reading for, so a
 * mistyped key cannot cross a tenant boundary even before RLS is consulted.
 */

export interface StoredObject {
  objectKey: string;
  sha256: string;
  byteLength: number;
  contentType: string;
}

export interface EvidenceStore {
  readonly kind: 'local_fs' | 'r2';
  /** True when the store can actually serve bytes. `false` renders as "evidence unavailable". */
  readonly available: boolean;
  put(input: {
    tenantId: string;
    scanId: string;
    name: string;
    contentType: string;
    body: Uint8Array;
  }): Promise<StoredObject>;
  get(input: {
    tenantId: string;
    objectKey: string;
  }): Promise<{ body: Uint8Array; contentType: string } | null>;
}

export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function objectKeyFor(tenantId: string, scanId: string, name: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(scanId)) {
    throw new TypeError('Evidence keys require UUID tenant and scan identifiers.');
  }
  if (!/^[a-z0-9._-]{1,120}$/i.test(name)) {
    throw new TypeError('Evidence object name must be a short safe token.');
  }
  return `${tenantId}/${scanId}/${name}`;
}

/**
 * Filesystem-backed private store for local development and tests.
 *
 * Rejected outside APP_ENV=local by `loadConfig`, so it can never become a deployed
 * evidence bucket by accident.
 */
export class LocalFsEvidenceStore implements EvidenceStore {
  readonly kind = 'local_fs' as const;
  readonly available = true;
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(objectKey: string): string {
    const full = resolve(this.#root, objectKey);
    // Defence in depth against a traversal in a key that reached us from a row.
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new Error('Evidence object key escaped the store root.');
    }
    return full;
  }

  async put(input: {
    tenantId: string;
    scanId: string;
    name: string;
    contentType: string;
    body: Uint8Array;
  }): Promise<StoredObject> {
    const objectKey = objectKeyFor(input.tenantId, input.scanId, input.name);
    const path = this.#path(objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body, { mode: 0o600 });
    await writeFile(`${path}.meta.json`, JSON.stringify({ contentType: input.contentType }), {
      mode: 0o600,
    });
    return {
      objectKey,
      sha256: sha256Hex(input.body),
      byteLength: input.body.byteLength,
      contentType: input.contentType,
    };
  }

  async get(input: {
    tenantId: string;
    objectKey: string;
  }): Promise<{ body: Uint8Array; contentType: string } | null> {
    // The caller's tenant must match the key's own prefix: a row from another tenant can
    // never be dereferenced even if its key somehow reached this code path.
    if (!input.objectKey.startsWith(`${input.tenantId}/`)) return null;
    const path = this.#path(input.objectKey);
    try {
      await stat(path);
    } catch {
      return null;
    }
    const body = await readFile(path);
    let contentType = 'application/octet-stream';
    try {
      contentType =
        JSON.parse(await readFile(`${path}.meta.json`, 'utf8')).contentType ?? contentType;
    } catch {
      // Missing sidecar means an older object; the default type is still safe to serve.
    }
    return { body: new Uint8Array(body), contentType };
  }
}

/**
 * Placeholder for the private R2 bucket described in ADR-003.
 *
 * It is deliberately inert: no bucket has been provisioned and no jurisdiction setting has
 * been verified, so every call reports the store as unavailable rather than silently
 * writing evidence somewhere unapproved.
 */
export class UnconfiguredR2EvidenceStore implements EvidenceStore {
  readonly kind = 'r2' as const;
  readonly available = false;

  async put(): Promise<StoredObject> {
    throw new Error(
      'R2 evidence store is not configured. Provision an EU-jurisdiction private bucket and record the ADR before enabling it.',
    );
  }

  async get(): Promise<null> {
    return null;
  }
}
