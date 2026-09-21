import { z } from 'zod';

/**
 * Zod mirrors of `contracts/openapi.json` component schemas.
 *
 * The OpenAPI document in the build kit is the authority. `test/openapi-parity.test.ts`
 * compiles the same component schemas with Ajv 2020 and asserts that Zod and Ajv accept
 * and reject identical payloads, so this file cannot silently drift from the contract.
 */

/** RFC 4122 shape check. The database still owns uniqueness and tenant scope. */
export const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** `date-time` in the contract: an RFC 3339 instant. Stored and compared in UTC. */
export const DateTime = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}, 'RFC 3339 date-time required');

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);

/** Integer micro-units as a canonical decimal string. Never a JS number. */
export const MicroAmount = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);

export const Money = z.object({ currency: CurrencyCode, amount_micro: MicroAmount }).strict();
export type Money = z.infer<typeof Money>;

export const Role = z.enum(['viewer', 'operator', 'reviewer', 'owner']);
export type Role = z.infer<typeof Role>;

export const Environment = z.enum(['local', 'staging', 'production']);
export type Environment = z.infer<typeof Environment>;

export const Problem = z
  .object({
    type: z.string(),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    code: z.string().regex(/^[A-Z_]+$/),
    detail: z.string().min(1).max(2000),
    request_id: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();
export type Problem = z.infer<typeof Problem>;

export const Health = z
  .object({
    status: z.enum(['healthy', 'not_ready']),
    environment: Environment,
    missing_bindings: z.array(z.string().min(1)),
  })
  .strict();
export type Health = z.infer<typeof Health>;

export const ExpectedVersion = z.object({ expected_version: z.number().int().min(1) }).strict();
export type ExpectedVersion = z.infer<typeof ExpectedVersion>;

/** Cursor pagination envelope shared by every list projection. */
export function page<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({ items: z.array(item), next_cursor: z.union([z.string().min(1), z.null()]) })
    .strict();
}
