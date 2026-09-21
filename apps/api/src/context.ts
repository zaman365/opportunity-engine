import type { Database, MembershipRecord } from '@oe/db';
import type { EvidenceStore } from '@oe/evidence';
import type { CaptureProvider, TargetPolicy } from '@oe/capture';
import type { VerificationChannel } from '@oe/notify';
import type { AppConfig } from '@oe/domain';
import type { CsrfTokens, IdentityProvider, VerifiedIdentity } from './auth.ts';

/** Everything the API needs, injected so tests construct a real app with real adapters. */
export interface AppDependencies {
  config: AppConfig;
  /** Runtime connection: non-owner role, tenant context per transaction. */
  db: Database;
  /** Identity connection: separate role, reads memberships before a tenant is known. */
  identityDb: Database;
  identity: IdentityProvider;
  csrf: CsrfTokens;
  capture: CaptureProvider;
  /**
   * Production policy, or the loopback fixture policy when the local fixture adapter is
   * configured. Never a relaxed version of the production one.
   */
  targetPolicy: TargetPolicy;
  evidence: EvidenceStore;
  /**
   * How a one-time code reaches a member of the public. The default sends nothing and says
   * so; an adapter that actually sends mail needs owner approval it does not have.
   */
  verification: VerificationChannel;
  /** Injected for deterministic tests; production passes `() => new Date()`. */
  now: () => Date;
  /** Injected so admission tests can assert exact identifiers. */
  newId: () => string;
  /** Called after a scan is admitted so the local runner can pick it up immediately. */
  onScanAdmitted?: (input: { tenantId: string; scanId: string }) => void;
}

export interface RequestActor {
  identity: VerifiedIdentity;
  membership: MembershipRecord;
}

/** Hono variable map. */
export type AppVariables = {
  requestId: string;
  actor: RequestActor;
};

export type AppEnv = { Variables: AppVariables; Bindings: Record<string, never> };

export const ROLE_RANK: Record<MembershipRecord['role'], number> = {
  viewer: 0,
  operator: 1,
  reviewer: 2,
  owner: 3,
};

export function hasRole(
  actual: MembershipRecord['role'],
  required: MembershipRecord['role'],
): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
