import { randomUUID } from 'node:crypto';
import {
  BrowserRunCaptureProvider,
  LocalFixtureCaptureProvider,
  createFixtureTargetPolicy,
  createPlaywrightRenderer,
  productionTargetPolicy,
} from '@oe/capture';
import { Database, loadDotEnv } from '@oe/db';
import {
  LocalFsEvidenceStore,
  UnconfiguredR2EvidenceStore,
  type EvidenceStore,
} from '@oe/evidence';
import { loadConfig, type AppConfig } from '@oe/domain';
import { NotConfiguredChannel, RecordedLocalChannel, type VerificationChannel } from '@oe/notify';
import {
  AccessJwtIdentityProvider,
  CsrfTokens,
  FixtureLocalIdentityProvider,
  type IdentityProvider,
} from './auth.ts';
import type { AppDependencies } from './context.ts';

/**
 * Wire real adapters from validated configuration.
 *
 * Nothing here invents a fallback: an unconfigured provider becomes an adapter that reports
 * itself unconfigured, which surfaces as a 503 with a specific reason rather than a scan
 * that silently produces fixture data.
 */
export async function buildDependencies(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AppDependencies> = {},
): Promise<AppDependencies & { config: AppConfig }> {
  const config = loadConfig(env as Record<string, string | undefined>);

  const db = new Database({
    connectionString: config.databaseUrl,
    applicationName: 'oe-api-runtime',
  });
  // The identity role has its own connection because it queries before a tenant is known.
  const identityDb = new Database({
    connectionString: env.IDENTITY_DATABASE_URL ?? config.databaseUrl,
    applicationName: 'oe-api-identity',
    max: 4,
  });

  const identity: IdentityProvider =
    config.authMode === 'access_jwt' && config.access
      ? new AccessJwtIdentityProvider(config.access)
      : new FixtureLocalIdentityProvider(config);

  const capture =
    config.capture.adapter === 'local_fixture'
      ? new LocalFixtureCaptureProvider(
          config.capture.fixtureOrigins,
          await createPlaywrightRenderer(),
        )
      : new BrowserRunCaptureProvider({
          endpoint: env.BROWSER_RUN_ENDPOINT ?? null,
          // ADR-005: no egress proof has been recorded, so live capture stays blocked.
          egressProofRecorded: env.BROWSER_RUN_EGRESS_PROOF === 'recorded',
        });

  const targetPolicy =
    config.capture.adapter === 'local_fixture'
      ? createFixtureTargetPolicy(config.capture.fixtureOrigins)
      : productionTargetPolicy;

  const evidence: EvidenceStore =
    config.evidence.store === 'local_fs'
      ? new LocalFsEvidenceStore(config.evidence.localDir!)
      : new UnconfiguredR2EvidenceStore();

  // No fallback that quietly sends nothing while reporting success: the not-configured
  // channel refuses, and the local one throws if it ever finds itself outside APP_ENV=local.
  const verification: VerificationChannel =
    config.intake.channel === 'recorded_local_only'
      ? new RecordedLocalChannel(config.environment)
      : new NotConfiguredChannel();

  return {
    config,
    db,
    identityDb,
    identity,
    csrf: new CsrfTokens(env.CSRF_SECRET),
    capture,
    targetPolicy,
    evidence,
    verification,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
}

export { loadDotEnv };
