/**
 * Startup configuration validation. Fails closed.
 *
 * M0 acceptance: "Invalid config fails with specific reason. Local auth cannot be enabled
 * on a deployed origin." Every rejection names the variable and the rule it broke, so a
 * misconfigured deployment stops instead of silently falling back to fixtures.
 */

export type AppEnvironment = 'local' | 'staging' | 'production';
export type AuthMode = 'access_jwt' | 'fixture_local_only';
export type CaptureAdapterKind = 'local_fixture' | 'browser_run';
export type EvidenceStoreKind = 'local_fs' | 'r2';

export interface AppConfig {
  environment: AppEnvironment;
  appOrigin: string;
  authMode: AuthMode;
  access: { issuer: string; audience: string; jwksUrl: string } | null;
  databaseUrl: string;
  migrationDatabaseUrl: string | null;
  ledgerCurrency: string;
  liveSpendLimitMicro: string;
  capture: { adapter: CaptureAdapterKind; fixtureOrigins: string[]; liveEnabled: boolean };
  evidence: { store: EvidenceStoreKind; localDir: string | null; bucket: string | null };
  features: {
    publicIntake: boolean;
    automaticOutreach: boolean;
    automaticProductionWrites: boolean;
    automaticTopups: boolean;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration rejected:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

export type Env = Record<string, string | undefined>;

function bool(env: Env, key: string, problems: string[], fallback = false): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${key} must be exactly "true" or "false" (got ${JSON.stringify(raw)}).`);
  return fallback;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Resolve and validate configuration, or throw with every problem at once.
 * `bindingsOnly` readiness reporting uses {@link missingBindings} instead of throwing.
 */
export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const environment = env.APP_ENV as AppEnvironment | undefined;
  if (environment !== 'local' && environment !== 'staging' && environment !== 'production') {
    throw new ConfigError([
      `APP_ENV must be one of local | staging | production (got ${JSON.stringify(env.APP_ENV)}).`,
    ]);
  }
  const deployed = environment !== 'local';

  const appOrigin = env.APP_ORIGIN ?? '';
  if (!appOrigin) problems.push('APP_ORIGIN is required so unsafe requests can verify Origin.');
  else {
    try {
      const parsed = new URL(appOrigin);
      if (deployed && parsed.protocol !== 'https:') {
        problems.push('APP_ORIGIN must use https in staging and production.');
      }
    } catch {
      problems.push(`APP_ORIGIN must be an absolute URL (got ${JSON.stringify(appOrigin)}).`);
    }
  }

  const authMode = env.AUTH_MODE as AuthMode | undefined;
  if (authMode !== 'access_jwt' && authMode !== 'fixture_local_only') {
    problems.push(
      `AUTH_MODE must be access_jwt | fixture_local_only (got ${JSON.stringify(env.AUTH_MODE)}).`,
    );
  }
  // ADR-004 and ROLES_PERMISSIONS.md: a fixture identity must be impossible to reach from
  // a deployed origin. Both the environment name and the origin have to be local.
  if (authMode === 'fixture_local_only') {
    if (deployed) {
      problems.push(
        `AUTH_MODE=fixture_local_only is rejected when APP_ENV=${environment}. Deployed builds require access_jwt.`,
      );
    }
    if (appOrigin && !isLoopbackOrigin(appOrigin)) {
      problems.push(
        `AUTH_MODE=fixture_local_only requires a loopback APP_ORIGIN (got ${appOrigin}).`,
      );
    }
  }

  let access: AppConfig['access'] = null;
  if (authMode === 'access_jwt') {
    const issuer = env.ACCESS_ISSUER ?? '';
    const audience = env.ACCESS_AUDIENCE ?? '';
    const jwksUrl = env.ACCESS_JWKS_URL ?? '';
    if (!issuer) problems.push('ACCESS_ISSUER is required when AUTH_MODE=access_jwt.');
    if (!audience) problems.push('ACCESS_AUDIENCE is required when AUTH_MODE=access_jwt.');
    if (!jwksUrl) problems.push('ACCESS_JWKS_URL is required when AUTH_MODE=access_jwt.');
    if (jwksUrl && !jwksUrl.startsWith('https://')) {
      problems.push('ACCESS_JWKS_URL must be https.');
    }
    if (issuer && audience && jwksUrl) access = { issuer, audience, jwksUrl };
  }

  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl)
    problems.push('DATABASE_URL is required; there is no in-memory fallback store.');
  const migrationDatabaseUrl = env.MIGRATION_DATABASE_URL ?? '';
  if (migrationDatabaseUrl && migrationDatabaseUrl === databaseUrl) {
    problems.push(
      'MIGRATION_DATABASE_URL must differ from DATABASE_URL: the runtime role is not the migration role.',
    );
  }

  const ledgerCurrency = env.LEDGER_CURRENCY ?? '';
  if (!/^[A-Z]{3}$/.test(ledgerCurrency)) {
    problems.push(
      `LEDGER_CURRENCY must be a three-letter uppercase code (got ${JSON.stringify(ledgerCurrency)}).`,
    );
  }
  const liveSpendLimitMicro = env.LIVE_SPEND_LIMIT_MICRO ?? '0';
  if (!/^(0|[1-9][0-9]{0,14})$/.test(liveSpendLimitMicro)) {
    problems.push('LIVE_SPEND_LIMIT_MICRO must be a canonical nonnegative integer string.');
  }

  const adapter = (env.CAPTURE_ADAPTER ?? 'local_fixture') as CaptureAdapterKind;
  if (adapter !== 'local_fixture' && adapter !== 'browser_run') {
    problems.push(
      `CAPTURE_ADAPTER must be local_fixture | browser_run (got ${JSON.stringify(env.CAPTURE_ADAPTER)}).`,
    );
  }
  const liveCaptureEnabled = bool(env, 'LIVE_CAPTURE_ENABLED', problems, false);
  // One or more comma-separated loopback origins: the kit's fixture site plus this
  // repository's M2 fixtures. Every one of them is still checked for loopback.
  const fixtureOrigins = (env.FIXTURE_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (adapter === 'local_fixture') {
    if (deployed) {
      problems.push(
        `CAPTURE_ADAPTER=local_fixture is rejected when APP_ENV=${environment}. Fixtures never run in a deployed environment.`,
      );
    }
    if (fixtureOrigins.length === 0) {
      problems.push('FIXTURE_ORIGIN is required for CAPTURE_ADAPTER=local_fixture.');
    }
    for (const origin of fixtureOrigins) {
      if (!isLoopbackOrigin(origin))
        problems.push(`FIXTURE_ORIGIN must be loopback (got ${origin}).`);
    }
    if (liveCaptureEnabled) {
      problems.push(
        'LIVE_CAPTURE_ENABLED=true is incompatible with CAPTURE_ADAPTER=local_fixture.',
      );
    }
  }
  if (adapter === 'browser_run' && liveCaptureEnabled && !env.BROWSER_RUN_ENDPOINT) {
    problems.push(
      'LIVE_CAPTURE_ENABLED=true requires BROWSER_RUN_ENDPOINT plus the recorded egress-policy proof from ADR-005.',
    );
  }

  const store = (env.EVIDENCE_STORE ?? 'local_fs') as EvidenceStoreKind;
  if (store !== 'local_fs' && store !== 'r2') {
    problems.push(
      `EVIDENCE_STORE must be local_fs | r2 (got ${JSON.stringify(env.EVIDENCE_STORE)}).`,
    );
  }
  if (store === 'local_fs' && deployed) {
    problems.push(
      `EVIDENCE_STORE=local_fs is rejected when APP_ENV=${environment}. Deployed evidence uses a private EU-jurisdiction bucket.`,
    );
  }
  if (store === 'r2' && !env.R2_BUCKET)
    problems.push('R2_BUCKET is required when EVIDENCE_STORE=r2.');

  const features = {
    publicIntake: bool(env, 'PUBLIC_INTAKE_ENABLED', problems, false),
    automaticOutreach: bool(env, 'AUTOMATIC_OUTREACH_ENABLED', problems, false),
    automaticProductionWrites: bool(env, 'AUTOMATIC_PRODUCTION_WRITES_ENABLED', problems, false),
    automaticTopups: bool(env, 'AUTOMATIC_TOPUPS_ENABLED', problems, false),
  };
  // These stay off for the whole of M1-M2. Enabling one is an owner decision recorded in an
  // ADR plus its milestone gate, never a stray environment variable.
  for (const [key, flag, milestone] of [
    ['PUBLIC_INTAKE_ENABLED', features.publicIntake, 'M3'],
    ['AUTOMATIC_OUTREACH_ENABLED', features.automaticOutreach, 'out of scope'],
    ['AUTOMATIC_PRODUCTION_WRITES_ENABLED', features.automaticProductionWrites, 'out of scope'],
    ['AUTOMATIC_TOPUPS_ENABLED', features.automaticTopups, 'out of scope'],
  ] as const) {
    if (flag) problems.push(`${key}=true is not supported by this build (${milestone}).`);
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    environment,
    appOrigin,
    authMode: authMode!,
    access,
    databaseUrl,
    migrationDatabaseUrl: migrationDatabaseUrl || null,
    ledgerCurrency,
    liveSpendLimitMicro,
    capture: {
      adapter,
      fixtureOrigins: adapter === 'local_fixture' ? fixtureOrigins : [],
      liveEnabled: liveCaptureEnabled,
    },
    evidence: {
      store,
      localDir: store === 'local_fs' ? (env.EVIDENCE_LOCAL_DIR ?? '.local-evidence') : null,
      bucket: store === 'r2' ? (env.R2_BUCKET ?? null) : null,
    },
    features,
  };
}

/**
 * Readiness, not liveness. Health proves the process answers; readiness names the bindings
 * a request would need. Neither spends money or contacts a provider.
 */
export function missingBindings(config: AppConfig): string[] {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (config.authMode === 'access_jwt' && !config.access) missing.push('ACCESS_JWKS');
  if (config.capture.adapter === 'browser_run' && !config.capture.liveEnabled) {
    missing.push('LIVE_CAPTURE');
  }
  if (config.evidence.store === 'r2' && !config.evidence.bucket) missing.push('R2_BUCKET');
  return missing;
}
