import {
  checkSubmission,
  judgeRateLimits,
  rateLimitsFor,
  canAttemptVerification,
  REQUEST_TTL_SECONDS,
  VERIFICATION_TTL_SECONDS,
  windowStart,
  type IntakeRefusal,
} from '@oe/domain';
import {
  consumeVerification,
  countRateLimitHit,
  getIntakeRequest,
  getLiveVerification,
  insertAuditEvent,
  insertIntakeRequest,
  insertIntakeVerification,
  markIntakeRequestVerified,
  recordVerificationAttempt,
  resolveIntakeChannel,
  type IntakeChannelRow,
  type IntakeRequestRow,
} from '@oe/db';
import { codeMatches, hashCode, newVerificationCode, opaqueKey } from '@oe/notify';
import { ApiProblem } from '../problem.ts';
import type { AppDependencies } from '../context.ts';

/**
 * Requested intake: somebody outside the workspace asks for a check.
 *
 * Two boundaries hold this together, and everything else follows from them.
 *
 * **The caller does not choose the tenant.** BUILD_SPEC.md §14: "Clients never choose a tenant
 * by sending an arbitrary trusted body field." The tenant comes from the public host the
 * request arrived on, matched against a channel an owner registered. There is no tenant field
 * in any request body here, and no way to add one without changing the contract.
 *
 * **A request is not permission.** Verifying a contact address proves control of an inbox, not
 * of a website. Nothing in this file admits a scan, reserves budget or touches an account. A
 * verified request lands in a queue an owner works through; recording the account and the
 * authorization stays exactly the owner act it was in M1.
 */

/** The host a public request arrived on, from the trusted forwarded header or the URL. */
export function requestHost(request: Request): string | null {
  const url = new URL(request.url);
  const host = (request.headers.get('x-forwarded-host') ?? url.hostname).split(',')[0]?.trim();
  if (!host) return null;
  // Strip a port and lower-case: a channel is registered by hostname, and `Example.com:443`
  // and `example.com` are the same site.
  const withoutPort = host.replace(/:\d+$/, '').toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(withoutPort) ? withoutPort : null;
}

function requireIntake(deps: AppDependencies): { secret: string } {
  if (!deps.config.features.publicIntake) {
    // Deliberately 404, not 403. A disabled public surface should be indistinguishable from
    // one that was never built, so probing cannot map which workspaces have it turned on.
    throw new ApiProblem('NOT_FOUND', 'No such resource.');
  }
  if (deps.config.intake.secret === null) {
    throw new ApiProblem(
      'PROVIDER_NOT_CONFIGURED',
      'Requested intake is enabled without a configured secret. Refusing rather than accepting unverifiable requests.',
    );
  }
  return { secret: deps.config.intake.secret };
}

/**
 * Resolve the channel, on the identity connection, before any tenant is known.
 *
 * Same shape as membership resolution (ADR-013): the tenant is the answer to this lookup, so
 * it cannot also be its precondition.
 */
export async function channelForRequest(
  deps: AppDependencies,
  request: Request,
): Promise<IntakeChannelRow> {
  requireIntake(deps);
  const host = requestHost(request);
  if (host === null) throw new ApiProblem('NOT_FOUND', 'No such resource.');
  const channel = await deps.identityDb.withoutTenant((tx) => resolveIntakeChannel(tx, host));
  // Unregistered and disabled are the same answer from outside. Distinguishing them would
  // tell a prober which hostnames this system knows about.
  if (!channel) throw new ApiProblem('NOT_FOUND', 'No such resource.');
  return channel;
}

export interface SubmissionInput {
  targetUrl: string;
  requestedDetectors: string[];
  purpose: string;
  authorityClaim: string;
  contactEmail: string;
  /** Hashed, never stored raw. Used only to count one source's submissions. */
  sourceFingerprint: string;
}

export interface SubmissionResult {
  request: IntakeRequestRow;
  /** Present only under the local fixture channel, which sends nothing. */
  localCode: string | null;
  deliveryDetail: string;
}

function refuse(refusal: IntakeRefusal): never {
  if (typeof refusal === 'object') {
    // The specific preflight reason is useful to an honest requester and useless to an
    // attacker: it says something about the URL they sent, not about this system.
    throw new ApiProblem('UNSAFE_TARGET', `That address cannot be checked: ${refusal.target}.`);
  }
  switch (refusal) {
    case 'detector_not_offered':
      throw new ApiProblem('UNSUPPORTED_DETECTOR', 'That check is not offered on this form.');
    case 'intake_disabled':
    case 'channel_disabled':
    case 'channel_unknown':
      throw new ApiProblem('NOT_FOUND', 'No such resource.');
    case 'duplicate_request':
      throw new ApiProblem(
        'VERSION_CONFLICT',
        'A request for this address is already open. Check your inbox rather than submitting again.',
      );
    case 'rate_limited':
      throw new ApiProblem('RATE_LIMITED', 'Too many requests. Try again later.');
  }
}

/**
 * Count this submission against every window, then judge.
 *
 * Counting happens before the decision and for every rule, so a caller who reliably trips one
 * limit is still counted against the others. It also means a refused submission still costs
 * the attacker a count — a rate limiter that only counts successes is one an attacker can run
 * flat out for free.
 */
async function enforceRateLimits(
  deps: AppDependencies,
  input: {
    secret: string;
    channel: IntakeChannelRow;
    contactEmail: string;
    source: string;
    targetHost: string;
  },
): Promise<void> {
  const now = deps.now();
  const keys: Record<string, string> = {
    contact: opaqueKey(input.secret, 'intake_contact', input.contactEmail),
    source: opaqueKey(input.secret, 'intake_source', input.source),
    target: opaqueKey(input.secret, 'intake_target', input.targetHost),
    channel: opaqueKey(input.secret, 'intake_channel', input.channel.id),
  };

  const counted: { rule: ReturnType<typeof rateLimitsFor>[number]; hits: number }[] = [];
  for (const rule of rateLimitsFor(input.channel.daily_request_limit)) {
    const hits = await deps.db.withoutTenant((tx) =>
      countRateLimitHit(tx, {
        scopeKey: `${rule.key}:${keys[rule.key]}`,
        windowStart: windowStart(now, rule.windowSeconds).toISOString(),
      }),
    );
    counted.push({ rule, hits });
  }

  const decision = judgeRateLimits(counted, now);
  if (!decision.allowed) {
    throw new ApiProblem(
      'RATE_LIMITED',
      `Too many requests. Try again in about ${Math.ceil(decision.retryAfterSeconds / 60)} minutes.`,
    );
  }
}

export async function submitIntakeRequest(
  deps: AppDependencies,
  channel: IntakeChannelRow,
  input: SubmissionInput,
  requestId: string,
): Promise<SubmissionResult> {
  const { secret } = requireIntake(deps);

  const check = checkSubmission(
    { targetUrl: input.targetUrl, requestedDetectors: input.requestedDetectors },
    { enabled: channel.enabled, allowedDetectors: channel.allowed_detectors },
    deps.config.features.publicIntake,
  );

  // Counted before it is refused, not after. A limiter that only counts what it accepts is
  // one an attacker can run flat out for free — and the validation path is exactly what they
  // would run flat out, since it answers questions about what this system will look at.
  await enforceRateLimits(deps, {
    secret,
    channel,
    contactEmail: input.contactEmail,
    source: input.sourceFingerprint,
    // A refused target has no parsed host, so the raw string keys the window instead. Both
    // are hashed before they are stored, so the difference is invisible to a reader.
    targetHost: check.ok ? check.targetHost : `unparsed:${input.targetUrl.slice(0, 200)}`,
  });

  if (!check.ok) refuse(check.refusal);

  const now = deps.now();
  const code = newVerificationCode();
  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_SECONDS * 1000).toISOString();

  // Delivery happens before the write, so a channel that cannot reach anybody refuses the
  // whole submission rather than leaving a request nobody can ever verify.
  const delivery = await deps.verification.deliver({
    audience: 'intake_verification',
    recipient: opaqueKey(secret, 'intake_recipient', input.contactEmail),
    code,
    expiresAt,
  });
  if (!delivery.delivered) {
    throw new ApiProblem('PROVIDER_NOT_CONFIGURED', delivery.detail);
  }

  const result = await deps.db.withTenant(channel.tenant_id, async (tx) => {
    const request = await insertIntakeRequest(tx, {
      id: deps.newId(),
      channelId: channel.id,
      ventureId: channel.venture_id,
      targetUrl: check.targetUrl,
      targetHost: check.targetHost,
      requestedDetectors: input.requestedDetectors,
      purpose: input.purpose,
      authorityClaim: input.authorityClaim,
      // What the requester actually agreed to, fixed at this moment. A later edit of the
      // channel's purpose text cannot retroactively change it.
      agreedPurposeVersion: channel.purpose_version,
      contactEmail: input.contactEmail,
      contactEmailHash: Buffer.from(opaqueKey(secret, 'intake_contact', input.contactEmail), 'hex'),
      expiresAt: new Date(now.getTime() + REQUEST_TTL_SECONDS * 1000).toISOString(),
    });

    await insertIntakeVerification(tx, {
      id: deps.newId(),
      requestId: request.id,
      codeHash: hashCode(secret, 'intake_verification', code),
      expiresAt,
      delivery: delivery.kind,
    });

    await insertAuditEvent(tx, {
      id: deps.newId(),
      // Not a member of this workspace. The actor is the public surface itself, and the
      // request row holds who asked.
      actorSubject: `public:intake@${channel.host}`,
      action: 'intake.submitted',
      objectType: 'intake_request',
      objectId: request.id,
      objectVersion: request.version,
      requestId,
      detail: {
        channel_host: channel.host,
        target_host: request.target_host,
        requested_detectors: request.requested_detectors,
        delivery: delivery.kind,
        // The address itself stays in the row, which is tenant-scoped and role-gated. The
        // audit trail records that a contact was recorded, not what it was.
        contact_recorded: true,
      },
    });

    return request;
  });

  return {
    request: result,
    localCode: delivery.localCode ?? null,
    deliveryDetail: delivery.detail,
  };
}

export interface VerificationResult {
  request: IntakeRequestRow;
}

/**
 * Spend a one-time code.
 *
 * Every refusal below returns the same outward answer through the route, because the
 * differences — expired, wrong, already used, never existed — are all things an attacker
 * would like to learn. Inside, they stay distinct so the audit trail is honest.
 */
export async function verifyIntakeRequest(
  deps: AppDependencies,
  channel: IntakeChannelRow,
  input: { requestId: string; code: string },
  apiRequestId: string,
): Promise<VerificationResult> {
  const { secret } = requireIntake(deps);

  // Read, then count, then judge — in three transactions, not one.
  //
  // This is the whole of the attempt ceiling. An earlier version did all of it inside one
  // transaction and threw on a wrong code, which rolled the counter back with everything
  // else: five wrong guesses cost nothing and the sixth still worked. The integration test
  // for the ceiling is what found it. A guess has to be paid for before it is answered, and
  // a refusal has to leave that payment behind.
  const loaded = await deps.db.withTenant(channel.tenant_id, async (tx) => {
    const request = await getIntakeRequest(tx, input.requestId);
    // A request belongs to the channel it came in on. Without this, a code minted through
    // one venture's form could verify a request made through another's.
    if (!request || request.channel_id !== channel.id) {
      throw new ApiProblem('NOT_FOUND', 'No such request.');
    }
    return { request, live: await getLiveVerification(tx, request.id) };
  });

  const gate = canAttemptVerification(
    loaded.live && {
      requestState: loaded.request.state as never,
      expiresAt: loaded.live.expires_at,
      consumedAt: loaded.live.consumed_at,
      attempts: loaded.live.attempts,
    },
    deps.now(),
  );
  if (!gate.ok) {
    await recordRefusal(deps, channel, loaded.request, apiRequestId, gate.refusal);
    throw new ApiProblem('INVALID_REQUEST', 'That code is not valid. Request a new one.');
  }

  // Its own transaction, committed before the comparison runs, so a wrong answer costs an
  // attempt whether the caller waits for the response or not.
  await deps.db.withTenant(channel.tenant_id, (tx) =>
    recordVerificationAttempt(tx, loaded.live!.id),
  );

  if (
    !codeMatches(
      Buffer.from(loaded.live!.code_hash),
      hashCode(secret, 'intake_verification', input.code),
    )
  ) {
    await recordRefusal(deps, channel, loaded.request, apiRequestId, 'code_incorrect');
    throw new ApiProblem('INVALID_REQUEST', 'That code is not valid. Request a new one.');
  }

  return deps.db.withTenant(channel.tenant_id, async (tx) => {
    const request = loaded.request;
    const live = loaded.live;
    const now = deps.now().toISOString();
    // Whoever wins this update spends the code. A second caller racing with the same correct
    // code finds nothing left to spend.
    if (!(await consumeVerification(tx, { id: live!.id, at: now }))) {
      throw new ApiProblem('INVALID_REQUEST', 'That code is not valid. Request a new one.');
    }
    const verified = await markIntakeRequestVerified(tx, { id: request.id, at: now });
    if (!verified) throw new ApiProblem('INVALID_REQUEST', 'That code is not valid.');

    await insertAuditEvent(tx, {
      id: deps.newId(),
      actorSubject: `public:intake@${channel.host}`,
      action: 'intake.verified',
      objectType: 'intake_request',
      objectId: verified.id,
      objectVersion: verified.version,
      requestId: apiRequestId,
      detail: {
        channel_host: channel.host,
        target_host: verified.target_host,
        // Stated explicitly because it is the thing most easily assumed. Verification proves
        // control of an inbox; it establishes nothing about the target, and grants nothing.
        proves: 'control_of_contact_address_only',
        grants_scan_authority: false,
      },
    });

    return { request: verified };
  });
}

/**
 * Record a refused attempt in its own transaction.
 *
 * The caller throws immediately afterwards, so this cannot share a transaction with the
 * refusal: the audit row would roll back with it and the trail would show only successes.
 */
async function recordRefusal(
  deps: AppDependencies,
  channel: IntakeChannelRow,
  request: IntakeRequestRow,
  apiRequestId: string,
  refusal: string,
): Promise<void> {
  await deps.db.withTenant(channel.tenant_id, (tx) =>
    insertAuditEvent(tx, {
      id: deps.newId(),
      actorSubject: `public:intake@${channel.host}`,
      action: 'intake.verification_refused',
      objectType: 'intake_request',
      objectId: request.id,
      objectVersion: request.version,
      requestId: apiRequestId,
      detail: { reason: refusal, channel_host: channel.host },
    }),
  );
}
