import { readFileSync } from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { buildContract, serialise } from '../../scripts/build-contract.mjs';

/**
 * The served contract is generated from the handoff contract plus an overlay.
 *
 * These tests are what makes that safe: the handoff stays byte-identical and is provably the
 * base, the generated file provably matches the overlay, and the overlay provably only widens
 * what the API accepts. A change that would reject a previously valid request fails here
 * rather than in a client.
 */

type AjvInstance = {
  addSchema: (schema: unknown, key: string) => void;
  compile: (schema: unknown) => (value: unknown) => boolean;
};
const Ajv2020 = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  options: Record<string, unknown>,
) => AjvInstance;
const addFormats = ((addFormatsModule as { default?: unknown }).default ?? addFormatsModule) as (
  ajv: AjvInstance,
) => void;

const kitRoot = new URL('../../opportunity-engine-build-kit/', import.meta.url);
const base = JSON.parse(readFileSync(new URL('contracts/openapi.json', kitRoot), 'utf8'));
const generated = JSON.parse(
  readFileSync(new URL('../../contracts/openapi.json', import.meta.url), 'utf8'),
);

function validatorFor(document: unknown, key: string, schema: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(document, key);
  return ajv.compile({ $ref: `${key}#/components/schemas/${schema}` });
}

describe('generation', () => {
  it('is deterministic and matches the committed file', () => {
    expect(serialise(buildContract())).toBe(
      readFileSync(new URL('../../contracts/openapi.json', import.meta.url), 'utf8'),
    );
  });

  it('names the handoff document as its base', () => {
    const overlay = JSON.parse(
      readFileSync(new URL('../../contracts/overlay.json', import.meta.url), 'utf8'),
    );
    expect(overlay.base).toBe('opportunity-engine-build-kit/contracts/openapi.json');
    // Every change carries a written reason; an unexplained contract change is a review gap.
    for (const change of overlay.changes) {
      expect(typeof change.why, JSON.stringify(change)).toBe('string');
      expect(change.why.length).toBeGreaterThan(20);
    }
  });
});

describe('M1 compatibility', () => {
  it('keeps every path and operation the handoff declared', () => {
    // A superset, not an equality: M2 adds operations. What must not happen is a path or an
    // operationId the handoff declared going missing or being renamed under a client.
    expect(Object.keys(generated.paths)).toEqual(expect.arrayContaining(Object.keys(base.paths)));
    for (const [path, item] of Object.entries(
      base.paths as Record<string, Record<string, { operationId?: string }>>,
    )) {
      for (const [method, operation] of Object.entries(item)) {
        if (!operation.operationId) continue;
        expect(generated.paths[path]?.[method]?.operationId, `${method} ${path}`).toBe(
          operation.operationId,
        );
      }
    }
  });

  it('never lowers the minimum role of an operation', () => {
    const rank = { viewer: 0, operator: 1, reviewer: 2, owner: 3 } as const;
    for (const [path, item] of Object.entries(
      base.paths as Record<string, Record<string, { 'x-minimum-role'?: keyof typeof rank }>>,
    )) {
      for (const [method, operation] of Object.entries(item)) {
        const before = operation['x-minimum-role'];
        if (!before) continue;
        const after = generated.paths[path][method]['x-minimum-role'] as keyof typeof rank;
        expect(rank[after], `${method} ${path}`).toBeGreaterThanOrEqual(rank[before]);
      }
    }
  });

  it('keeps every component schema the handoff declared', () => {
    expect(Object.keys(generated.components.schemas)).toEqual(
      expect.arrayContaining(Object.keys(base.components.schemas)),
    );
  });

  /**
   * Added operations are where a contract quietly loses its guarantees: a new endpoint with no
   * declared minimum role reads as "anyone", and a new write with no idempotency key reads as
   * "retry at your own risk". Both are checked here for everything the overlay adds, so the
   * next added path cannot skip them either.
   */
  it('holds added operations to the same rules as the handoff ones', () => {
    const roles = ['viewer', 'operator', 'reviewer', 'owner'];
    for (const [path, item] of Object.entries(
      generated.paths as Record<string, Record<string, { 'x-minimum-role'?: string }>>,
    )) {
      if (path in base.paths) continue;
      for (const [method, operation] of Object.entries(item)) {
        expect(roles, `${method} ${path}`).toContain(operation['x-minimum-role']);
      }
    }
  });

  it('still requires an Idempotency-Key and a CSRF token on every unsafe operation', () => {
    for (const [path, item] of Object.entries(
      generated.paths as Record<
        string,
        Record<string, { parameters?: { name: string; required?: boolean }[] }>
      >,
    )) {
      for (const [method, operation] of Object.entries(item)) {
        if (!['post', 'patch', 'put', 'delete'].includes(method)) continue;
        const names = (operation.parameters ?? []).filter((p) => p.required).map((p) => p.name);
        expect(names, `${method} ${path}`).toEqual(
          expect.arrayContaining(['Idempotency-Key', 'X-CSRF-Token']),
        );
      }
    }
  });
});

/**
 * Which schemas a request body uses. Narrowing one of these would reject a call that used to
 * work; narrowing a response schema only obliges the server to send more, which it does.
 */
const REQUEST_SCHEMAS = new Set([
  'CreateAccount',
  'AuthorizationInput',
  'CreateScan',
  'ReviewFinding',
  'CreateReport',
  'ChangeBudget',
  'PauseBudget',
  'ExpectedVersion',
]);

describe('the overlay only widens what the API accepts', () => {
  it('never adds a required property to a request schema', () => {
    for (const name of REQUEST_SCHEMAS) {
      const before: string[] = base.components.schemas[name]?.required ?? [];
      const after: string[] = generated.components.schemas[name]?.required ?? [];
      expect(
        after.filter((key) => !before.includes(key)),
        name,
      ).toEqual([]);
    }
  });

  it('records every op it used, and uses only the two it supports', () => {
    const overlay = JSON.parse(
      readFileSync(new URL('../../contracts/overlay.json', import.meta.url), 'utf8'),
    );
    for (const change of overlay.changes) {
      expect(['set', 'add'], JSON.stringify(change.pointer)).toContain(change.op);
    }
  });
});

describe('supplied examples and previously valid payloads', () => {
  const examples = JSON.parse(
    readFileSync(new URL('contracts/examples/index.json', kitRoot), 'utf8'),
  ) as { examples: { file: string; schema: string }[] };

  it.each(examples.examples)(
    '$file still validates against the generated contract',
    ({ file, schema }) => {
      const payload = JSON.parse(
        readFileSync(new URL(`contracts/examples/${file}`, kitRoot), 'utf8'),
      );
      expect(validatorFor(base, 'base.json', schema)(payload), 'invalid against the handoff').toBe(
        true,
      );
      expect(
        validatorFor(generated, 'gen.json', schema)(payload),
        'invalid against the served contract',
      ).toBe(true);
    },
  );

  /**
   * Payloads the M1 contract accepted. Each must still be accepted: widening a contract may
   * add what is allowed, never remove it.
   */
  const previouslyValid: { schema: string; value: unknown }[] = [
    {
      schema: 'CreateScan',
      value: {
        account_id: '00000000-0000-4000-8000-000000000001',
        venture_id: '00000000-0000-4000-8000-000000000002',
        target_url: 'https://shop.example.com/p',
        authorization_id: '00000000-0000-4000-8000-000000000003',
        max_unique_pages: 5,
        detectors: ['MF-LINK-01'],
        max_cost: { currency: 'USD', amount_micro: '0' },
      },
    },
    { schema: 'Money', value: { currency: 'EUR', amount_micro: '999999999999999' } },
    { schema: 'ExpectedVersion', value: { expected_version: 1 } },
  ];

  it.each(previouslyValid)('still accepts a valid M1 $schema payload', ({ schema, value }) => {
    expect(validatorFor(base, 'base.json', schema)(value)).toBe(true);
    expect(validatorFor(generated, 'gen.json', schema)(value)).toBe(true);
  });

  it('accepts the detectors M2 adds, and still refuses the ones it has not implemented', () => {
    const validate = validatorFor(generated, 'gen.json', 'CreateScan');
    const scan = (detectors: string[]) => ({
      account_id: '00000000-0000-4000-8000-000000000001',
      venture_id: '00000000-0000-4000-8000-000000000002',
      target_url: 'https://shop.example.com/p',
      authorization_id: '00000000-0000-4000-8000-000000000003',
      max_unique_pages: 2,
      detectors,
      max_cost: { currency: 'USD', amount_micro: '0' },
    });
    expect(validate(scan(['MF-ASSET-01']))).toBe(true);
    expect(validate(scan(['MF-LINK-01', 'MF-ASSET-01']))).toBe(true);
    // Specified in contracts/detectors.json, not implemented, so not requestable.
    for (const detector of ['MF-DATA-01', 'PDP-CONTENT-01', 'PDP-VISUAL-01', 'PDP-MOBILE-01']) {
      expect(validate(scan([detector])), detector).toBe(false);
    }
    // Still bounded: no duplicates, no unbounded list.
    expect(validate(scan(['MF-LINK-01', 'MF-LINK-01']))).toBe(false);
    expect(validate(scan([]))).toBe(false);
  });
});
