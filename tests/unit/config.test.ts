import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, missingBindings } from '@oe/domain';

/**
 * M0 acceptance: "Invalid config fails with specific reason. No real secrets/default
 * production admin. Local auth cannot be enabled on a deployed origin."
 */

const localEnv = {
  APP_ENV: 'local',
  APP_ORIGIN: 'http://127.0.0.1:4173',
  AUTH_MODE: 'fixture_local_only',
  DATABASE_URL: 'postgresql://runtime@localhost/db',
  MIGRATION_DATABASE_URL: 'postgresql://migrate@localhost/db',
  LEDGER_CURRENCY: 'USD',
  LIVE_SPEND_LIMIT_MICRO: '0',
  CAPTURE_ADAPTER: 'local_fixture',
  FIXTURE_ORIGIN: 'http://127.0.0.1:4179',
  EVIDENCE_STORE: 'local_fs',
};

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe('configuration', () => {
  it('accepts a complete local configuration', () => {
    const config = loadConfig(localEnv);
    expect(config.environment).toBe('local');
    expect(config.authMode).toBe('fixture_local_only');
    expect(config.capture.adapter).toBe('local_fixture');
    expect(config.features.publicIntake).toBe(false);
  });

  it('rejects fixture auth in a deployed environment, naming the variable', () => {
    const problems = problemsFor({
      ...localEnv,
      APP_ENV: 'production',
      APP_ORIGIN: 'https://operator.example.com',
    });
    expect(problems.some((p) => p.includes('AUTH_MODE=fixture_local_only is rejected'))).toBe(true);
  });

  it('rejects fixture auth on a non-loopback origin even when APP_ENV says local', () => {
    const problems = problemsFor({ ...localEnv, APP_ORIGIN: 'https://operator.example.com' });
    expect(problems.some((p) => p.includes('requires a loopback APP_ORIGIN'))).toBe(true);
  });

  it('rejects the fixture capture adapter and local evidence store in a deployed build', () => {
    const problems = problemsFor({
      ...localEnv,
      APP_ENV: 'staging',
      APP_ORIGIN: 'https://staging.example.com',
      AUTH_MODE: 'access_jwt',
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'aud',
      ACCESS_JWKS_URL: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    });
    expect(problems.some((p) => p.includes('CAPTURE_ADAPTER=local_fixture is rejected'))).toBe(
      true,
    );
    expect(problems.some((p) => p.includes('EVIDENCE_STORE=local_fs is rejected'))).toBe(true);
  });

  it('requires every Access binding when AUTH_MODE=access_jwt', () => {
    const problems = problemsFor({ ...localEnv, AUTH_MODE: 'access_jwt' });
    expect(problems).toContain('ACCESS_ISSUER is required when AUTH_MODE=access_jwt.');
    expect(problems).toContain('ACCESS_AUDIENCE is required when AUTH_MODE=access_jwt.');
    expect(problems).toContain('ACCESS_JWKS_URL is required when AUTH_MODE=access_jwt.');
  });

  it('refuses to share one credential between runtime and migrations', () => {
    const problems = problemsFor({ ...localEnv, MIGRATION_DATABASE_URL: localEnv.DATABASE_URL });
    expect(problems.some((p) => p.includes('MIGRATION_DATABASE_URL must differ'))).toBe(true);
  });

  it('refuses to start with an out-of-scope capability flag turned on', () => {
    // PUBLIC_INTAKE_ENABLED left this list at M3. The three below have no milestone that
    // turns them on, and outreach now has a legal reason as well as a design one.
    for (const key of [
      'AUTOMATIC_OUTREACH_ENABLED',
      'AUTOMATIC_PRODUCTION_WRITES_ENABLED',
      'AUTOMATIC_TOPUPS_ENABLED',
    ]) {
      const problems = problemsFor({ ...localEnv, [key]: 'true' });
      expect(problems.some((p) => p.startsWith(`${key}=true is not supported`))).toBe(true);
    }
  });

  describe('public intake', () => {
    it('refuses to open a public surface with no way to verify a contact address', () => {
      const problems = problemsFor({ ...localEnv, PUBLIC_INTAKE_ENABLED: 'true' });
      expect(problems.some((p) => p.includes('requires INTAKE_VERIFICATION_CHANNEL'))).toBe(true);
    });

    it('refuses to open it without a secret to key codes and counters with', () => {
      const problems = problemsFor({
        ...localEnv,
        PUBLIC_INTAKE_ENABLED: 'true',
        INTAKE_VERIFICATION_CHANNEL: 'recorded_local_only',
      });
      expect(problems.some((p) => p.includes('requires INTAKE_SECRET'))).toBe(true);
    });

    it('refuses a secret short enough to guess', () => {
      const problems = problemsFor({
        ...localEnv,
        PUBLIC_INTAKE_ENABLED: 'true',
        INTAKE_VERIFICATION_CHANNEL: 'recorded_local_only',
        INTAKE_SECRET: 'too-short',
      });
      expect(problems.some((p) => p.includes('at least 32 characters'))).toBe(true);
    });

    it('accepts the local fixture channel with a real secret', () => {
      expect(
        problemsFor({
          ...localEnv,
          PUBLIC_INTAKE_ENABLED: 'true',
          INTAKE_VERIFICATION_CHANNEL: 'recorded_local_only',
          INTAKE_SECRET: 'x'.repeat(32),
        }),
      ).toEqual([]);
    });

    it('refuses the code-returning channel outside local, whatever else is set', () => {
      const problems = problemsFor({
        ...localEnv,
        APP_ENV: 'production',
        APP_ORIGIN: 'https://oe.example.com',
        AUTH_MODE: 'access_jwt',
        ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
        ACCESS_AUDIENCE: 'aud',
        ACCESS_JWKS_URL: 'https://example.cloudflareaccess.com/cdn-cgi/access/certs',
        CAPTURE_ADAPTER: 'browser_run',
        EVIDENCE_STORE: 'r2',
        R2_BUCKET: 'oe-evidence',
        INTAKE_VERIFICATION_CHANNEL: 'recorded_local_only',
      });
      expect(problems.some((p) => p.includes('returns verification codes to the caller'))).toBe(
        true,
      );
    });
  });

  it('refuses live capture without an endpoint', () => {
    const problems = problemsFor({
      ...localEnv,
      CAPTURE_ADAPTER: 'browser_run',
      LIVE_CAPTURE_ENABLED: 'true',
    });
    expect(problems.some((p) => p.includes('BROWSER_RUN_ENDPOINT'))).toBe(true);
  });

  it('rejects a non-boolean flag instead of coercing it', () => {
    const problems = problemsFor({ ...localEnv, PUBLIC_INTAKE_ENABLED: 'yes' });
    expect(problems.some((p) => p.includes('must be exactly "true" or "false"'))).toBe(true);
  });

  it('reports readiness gaps without contacting any provider', () => {
    const config = loadConfig({ ...localEnv, CAPTURE_ADAPTER: 'browser_run', FIXTURE_ORIGIN: '' });
    expect(missingBindings(config)).toContain('LIVE_CAPTURE');
  });

  it('names APP_ENV first when it is invalid, without listing downstream noise', () => {
    const problems = problemsFor({ ...localEnv, APP_ENV: 'prod' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('APP_ENV must be one of');
  });
});
