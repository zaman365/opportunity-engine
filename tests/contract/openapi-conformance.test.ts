import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { componentSchemas } from '@oe/contracts';

/**
 * The OpenAPI document in the build kit is the authority; the Zod schemas are a mirror.
 *
 * Each component schema is compiled with Ajv 2020 and fed the same payloads as its Zod
 * counterpart. Both must agree on every case, so a drift in either direction fails here
 * rather than in production.
 */

const kitRoot = new URL('../../opportunity-engine-build-kit/', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('contracts/openapi.json', kitRoot), 'utf8'));

// Ajv and ajv-formats publish CommonJS with a `default` interop wrapper; under NodeNext the
// callable value sits one level down depending on how the bundler resolved it.
type AjvInstance = {
  addSchema: (schema: unknown, key: string) => void;
  compile: (schema: unknown) => (value: unknown) => boolean;
};
const Ajv2020 = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  options: Record<string, unknown>,
) => AjvInstance;
const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as (ajv: AjvInstance) => void;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// Register the whole document so `$ref`s between component schemas resolve.
ajv.addSchema(spec, 'openapi.json');

function validator(name: string) {
  const compiled = ajv.compile({ $ref: `openapi.json#/components/schemas/${name}` });
  return (value: unknown) => compiled(value) === true;
}

function zodAccepts(name: keyof typeof componentSchemas, value: unknown): boolean {
  return componentSchemas[name].safeParse(value).success;
}

describe('component schema coverage', () => {
  it('mirrors every component schema in the contract', () => {
    const contractNames = Object.keys(spec.components.schemas).sort();
    expect(Object.keys(componentSchemas).sort()).toEqual(contractNames);
  });
});

describe('supplied contract examples', () => {
  const index = JSON.parse(readFileSync(new URL('contracts/examples/index.json', kitRoot), 'utf8'));

  it.each(index.examples as { file: string; schema: keyof typeof componentSchemas }[])(
    '$file validates against $schema under both validators',
    ({ file, schema }) => {
      const payload = JSON.parse(readFileSync(new URL(`contracts/examples/${file}`, kitRoot), 'utf8'));
      expect(validator(schema)(payload), 'Ajv rejected a supplied example').toBe(true);
      expect(zodAccepts(schema, payload), 'Zod rejected a supplied example').toBe(true);
    },
  );

  it('covers every example file in the directory', () => {
    const files = readdirSync(new URL('contracts/examples/', kitRoot))
      .filter((n) => n.endsWith('.json') && n !== 'index.json')
      .sort();
    expect((index.examples as { file: string }[]).map((e) => e.file).sort()).toEqual(files);
  });
});

/**
 * Negative cases. Each one is a mistake the application could plausibly make, and both
 * validators must reject it. "Schema validity is not truth" (AGENTS.md) — but schema
 * invalidity must at least be caught.
 */
const negatives: { schema: keyof typeof componentSchemas; why: string; value: unknown }[] = [
  {
    schema: 'Money',
    why: 'amount as a number loses precision',
    value: { currency: 'USD', amount_micro: 1000 },
  },
  { schema: 'Money', why: 'non-canonical leading zero', value: { currency: 'USD', amount_micro: '0100' } },
  { schema: 'Money', why: 'lowercase currency', value: { currency: 'usd', amount_micro: '1' } },
  {
    schema: 'Money',
    why: 'unknown property',
    value: { currency: 'USD', amount_micro: '1', note: 'x' },
  },
  {
    schema: 'CreateScan',
    why: 'more pages than the bounded scan allows',
    value: {
      account_id: '00000000-0000-4000-8000-000000000001',
      venture_id: '00000000-0000-4000-8000-000000000002',
      target_url: 'https://shop.example.com/p',
      authorization_id: '00000000-0000-4000-8000-000000000003',
      max_unique_pages: 6,
      detectors: ['MF-LINK-01'],
      max_cost: { currency: 'USD', amount_micro: '0' },
    },
  },
  {
    schema: 'CreateScan',
    why: 'detector outside the enabled pack',
    value: {
      account_id: '00000000-0000-4000-8000-000000000001',
      venture_id: '00000000-0000-4000-8000-000000000002',
      target_url: 'https://shop.example.com/p',
      authorization_id: '00000000-0000-4000-8000-000000000003',
      max_unique_pages: 2,
      detectors: ['MF-ASSET-01'],
      max_cost: { currency: 'USD', amount_micro: '0' },
    },
  },
  {
    schema: 'ReviewFinding',
    why: 'reason below the minimum length',
    value: { expected_version: 1, decision: 'confirm', reason: 'ok', acknowledged_limitations: true },
  },
  {
    schema: 'ReviewFinding',
    why: 'limitations not acknowledged',
    value: {
      expected_version: 1,
      decision: 'confirm',
      reason: 'Checked the evidence carefully.',
      acknowledged_limitations: false,
    },
  },
  {
    schema: 'Finding',
    why: 'confirmed without a reviewer',
    value: {
      id: '00000000-0000-4000-8000-000000000004',
      scan_id: '00000000-0000-4000-8000-000000000005',
      asset_id: '00000000-0000-4000-8000-000000000006',
      detector_id: 'MF-LINK-01',
      detector_version: '2.0.0',
      state: 'confirmed',
      version: 2,
      root_cause_key: 'k',
      claim: 'c',
      evidence_ids: ['00000000-0000-4000-8000-000000000007'],
      contrary_evidence_ids: [],
      scope: 's',
      limitations: ['l'],
      evidence_grade: 'A',
      commercial_impact: 'hypothesis',
      captured_at: '2026-09-21T08:00:00Z',
      reviewer_id: null,
      reviewed_at: null,
    },
  },
  {
    schema: 'Finding',
    why: 'confirmed on grade C evidence',
    value: {
      id: '00000000-0000-4000-8000-000000000004',
      scan_id: '00000000-0000-4000-8000-000000000005',
      asset_id: '00000000-0000-4000-8000-000000000006',
      detector_id: 'MF-LINK-01',
      detector_version: '2.0.0',
      state: 'confirmed',
      version: 2,
      root_cause_key: 'k',
      claim: 'c',
      evidence_ids: ['00000000-0000-4000-8000-000000000007'],
      contrary_evidence_ids: [],
      scope: 's',
      limitations: ['l'],
      evidence_grade: 'C',
      commercial_impact: 'hypothesis',
      captured_at: '2026-09-21T08:00:00Z',
      reviewer_id: '00000000-0000-4000-8000-000000000009',
      reviewed_at: '2026-09-21T08:05:00Z',
    },
  },
  {
    schema: 'Finding',
    why: 'no limitations recorded',
    value: {
      id: '00000000-0000-4000-8000-000000000004',
      scan_id: '00000000-0000-4000-8000-000000000005',
      asset_id: '00000000-0000-4000-8000-000000000006',
      detector_id: 'MF-LINK-01',
      detector_version: '2.0.0',
      state: 'candidate',
      version: 1,
      root_cause_key: 'k',
      claim: 'c',
      evidence_ids: [],
      contrary_evidence_ids: [],
      scope: 's',
      limitations: [],
      evidence_grade: 'A',
      commercial_impact: 'hypothesis',
      captured_at: '2026-09-21T08:00:00Z',
      reviewer_id: null,
      reviewed_at: null,
    },
  },
  {
    schema: 'Scan',
    why: 'captured pages exceed the expected denominator',
    value: {
      id: '00000000-0000-4000-8000-000000000005',
      account_id: '00000000-0000-4000-8000-000000000001',
      venture_id: '00000000-0000-4000-8000-000000000002',
      state: 'partial',
      version: 2,
      target_url: 'https://shop.example.com/p',
      created_at: '2026-09-21T08:00:00Z',
      updated_at: '2026-09-21T08:00:00Z',
      coverage: { expected_unique_pages: 2, captured_unique_pages: 9, complete_checks: 0, reasons: [] },
      cost: {
        cap: { currency: 'USD', amount_micro: '0' },
        settled: { currency: 'USD', amount_micro: '0' },
        reserved: { currency: 'USD', amount_micro: '0' },
        settlement_uncertain: false,
      },
      evidence_ids: [],
      finding_ids: [],
      blocked_reason: null,
    },
  },
  {
    schema: 'Report',
    why: 'audience other than the internal tenant',
    value: {
      id: '00000000-0000-4000-8000-000000000010',
      account_id: '00000000-0000-4000-8000-000000000001',
      scan_id: '00000000-0000-4000-8000-000000000005',
      state: 'published',
      version: 1,
      language: 'en',
      scope_summary: 's',
      finding_versions: [],
      created_at: '2026-09-21T08:00:00Z',
      approved_at: null,
      published_at: null,
      audience: 'public',
      limitations: ['l'],
    },
  },
  {
    schema: 'Budget',
    why: 'limit as a number rather than a micro string',
    value: {
      id: '00000000-0000-4000-8000-000000000011',
      scope_kind: 'tenant',
      scope_id: '00000000-0000-4000-8000-000000000001',
      currency: 'USD',
      limit_micro: 5_000_000,
      reserved_micro: '0',
      settled_micro: '0',
      paused: false,
      version: 1,
    },
  },
  {
    schema: 'Session',
    why: 'CSRF token too short to be a real token',
    value: {
      subject: 'operator@fixture.test',
      active_tenant_id: '00000000-0000-4000-8000-000000000001',
      role: 'operator',
      venture_ids: [],
      csrf_token: 'short',
      environment: 'local',
    },
  },
  {
    schema: 'Problem',
    why: 'lowercase error code breaks the stable-code contract',
    value: {
      type: 'https://example.invalid/p',
      title: 't',
      status: 409,
      code: 'budget_exceeded',
      detail: 'd',
      request_id: 'r',
      retryable: false,
    },
  },
];

describe('negative cases', () => {
  it.each(negatives)('rejects $schema: $why', ({ schema, value }) => {
    expect(validator(schema)(value), 'Ajv accepted an invalid payload').toBe(false);
    expect(zodAccepts(schema, value), 'Zod accepted an invalid payload').toBe(false);
  });
});

describe('agreement on the positive shapes', () => {
  const positives: { schema: keyof typeof componentSchemas; value: unknown }[] = [
    { schema: 'Money', value: { currency: 'EUR', amount_micro: '999999999999999' } },
    { schema: 'ExpectedVersion', value: { expected_version: 1 } },
    {
      schema: 'Health',
      value: { status: 'not_ready', environment: 'local', missing_bindings: ['DATABASE_URL'] },
    },
    { schema: 'Accounts', value: { items: [], next_cursor: null } },
    {
      schema: 'CaptureConditions',
      value: {
        captured_at: '2026-09-21T08:00:00Z',
        session_id: 's',
        viewport_width: 1280,
        viewport_height: 900,
        locale: 'de-DE',
        variant: null,
        consent_state: 'no_consent_layer_present',
        browser_version: 'chromium/1',
        test_region: null,
      },
    },
  ];

  it.each(positives)('both validators accept $schema', ({ schema, value }) => {
    expect(validator(schema)(value)).toBe(true);
    expect(zodAccepts(schema, value)).toBe(true);
  });
});
