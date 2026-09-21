/**
 * Merging the catalogue's scope with the owner's price approval.
 *
 * These are two different decisions by two different authorities, so they live in two files.
 * `opportunity-engine-build-kit/config/offer-catalog.json` defines what a SKU promises and
 * stays byte-identical to the handoff; `config/offer-approvals.json` records what the owner
 * approved on top of it.
 *
 * The merge is where the kit's rule — "draft disabled prices until approved", "no approved
 * invented price" — is checked before anything reaches the database. Migration 0009 enforces
 * the same rule as a CHECK constraint; this layer exists so a bad approval fails with a
 * sentence rather than a constraint violation, and so the failure names the SKU.
 */

/** A catalogue entry merged with its approval, ready to be written as an `oe.offers` row. */
export interface MergedOffer {
  sku: string;
  version: number;
  /** Venture slug. A catalogue is scoped to the venture that sells it. */
  venture: string;
  promise: string;
  detectorFamilies: string[];
  inclusions: string[];
  exclusions: string[];
  prerequisites: string[];
  acceptance: string[];
  currency: string | null;
  priceMinor: string | null;
  taxTreatment: string | null;
  minEffortMinutes: number | null;
  maxEffortMinutes: number | null;
  enabled: boolean;
  /** Identity of the approver, resolved to a membership by the caller that has the database. */
  approvedBySubject: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
}

export interface MergeResult {
  offers: MergedOffer[];
  /** Every rejection names the SKU and the rule it broke. Empty means the merge is usable. */
  problems: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

/** Minor units arrive as a string so no price passes through a float on its way to the database. */
function minorUnits(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return value;
}

function optionalMinutes(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function mergeOfferCatalog(catalogJson: unknown, approvalsJson: unknown): MergeResult {
  const problems: string[] = [];
  const catalog = asRecord(catalogJson);
  const approvalsDoc = asRecord(approvalsJson);

  const rawOffers = catalog && Array.isArray(catalog['offers']) ? catalog['offers'] : null;
  if (!rawOffers) {
    problems.push('offer-catalog.json must have an "offers" array.');
    return { offers: [], problems };
  }
  const rawApprovals =
    approvalsDoc && Array.isArray(approvalsDoc['approvals']) ? approvalsDoc['approvals'] : null;
  if (!rawApprovals) {
    problems.push('offer-approvals.json must have an "approvals" array.');
    return { offers: [], problems };
  }

  // Keyed by SKU *and version*: an approval is for the scope it was read against. If the
  // catalogue version moves, the approval does not follow it — someone has to look again.
  const approvals = new Map<string, Record<string, unknown>>();
  for (const [index, entry] of rawApprovals.entries()) {
    const approval = asRecord(entry);
    if (
      !approval ||
      typeof approval['sku'] !== 'string' ||
      typeof approval['version'] !== 'number'
    ) {
      problems.push(`approvals[${index}] needs a string "sku" and a numeric "version".`);
      continue;
    }
    const key = `${approval['sku']}@${approval['version']}`;
    if (approvals.has(key)) problems.push(`Two approvals for ${key}. Only one can be current.`);
    approvals.set(key, approval);
  }

  const offers: MergedOffer[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of rawOffers.entries()) {
    const raw = asRecord(entry);
    const sku = raw?.['sku'];
    const version = raw?.['version'];
    if (!raw || typeof sku !== 'string' || typeof version !== 'number') {
      problems.push(`offers[${index}] needs a string "sku" and a numeric "version".`);
      continue;
    }
    const key = `${sku}@${version}`;
    if (seen.has(key)) {
      problems.push(`Duplicate catalogue entry ${key}.`);
      continue;
    }
    seen.add(key);

    const promise = raw['promise'];
    const venture = raw['venture'];
    const detectorFamilies = stringArray(raw['detectors']);
    const inclusions = stringArray(raw['inclusions']);
    const exclusions = stringArray(raw['exclusions']);
    const prerequisites = stringArray(raw['prerequisites']);
    const acceptance = stringArray(raw['acceptance']);

    if (typeof promise !== 'string' || promise.length === 0)
      problems.push(`${key}: "promise" must be a non-empty string.`);
    if (typeof venture !== 'string' || venture.length === 0)
      problems.push(`${key}: "venture" must be a non-empty string.`);
    if (!detectorFamilies || detectorFamilies.length === 0)
      problems.push(`${key}: "detectors" must be a non-empty array of strings.`);
    if (!inclusions) problems.push(`${key}: "inclusions" must be an array of strings.`);
    if (!exclusions) problems.push(`${key}: "exclusions" must be an array of strings.`);
    if (!prerequisites) problems.push(`${key}: "prerequisites" must be an array of strings.`);
    if (!acceptance || acceptance.length === 0)
      problems.push(`${key}: "acceptance" must be a non-empty array of strings.`);
    if (
      typeof promise !== 'string' ||
      typeof venture !== 'string' ||
      !detectorFamilies ||
      !inclusions ||
      !exclusions ||
      !prerequisites ||
      !acceptance
    ) {
      continue;
    }

    const approval = approvals.get(key);
    approvals.delete(key);

    // No approval at all is a legitimate state, not an error: the SKU stays disabled and
    // unpriced, which is exactly what the kit ships.
    if (!approval) {
      offers.push({
        sku,
        version,
        venture,
        promise,
        detectorFamilies,
        inclusions,
        exclusions,
        prerequisites,
        acceptance,
        currency: null,
        priceMinor: null,
        taxTreatment: null,
        minEffortMinutes: null,
        maxEffortMinutes: null,
        enabled: false,
        approvedBySubject: null,
        approvedAt: null,
        approvalNote: null,
      });
      continue;
    }

    const enabled = approval['enabled'] === true;
    const currency = typeof approval['currency'] === 'string' ? approval['currency'] : null;
    const priceMinor = minorUnits(approval['price_minor']);
    const approvedBySubject =
      typeof approval['approved_by_subject'] === 'string' ? approval['approved_by_subject'] : null;
    const approvedAt = typeof approval['approved_at'] === 'string' ? approval['approved_at'] : null;
    const minEffortMinutes = optionalMinutes(approval['min_effort_minutes']);
    const maxEffortMinutes = optionalMinutes(approval['max_effort_minutes']);

    if (
      approval['price_minor'] !== undefined &&
      approval['price_minor'] !== null &&
      priceMinor === null
    ) {
      problems.push(
        `${key}: "price_minor" must be a string of digits in minor units (e.g. "29000" for EUR 290.00).`,
      );
    }
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
      problems.push(`${key}: "currency" must be a three-letter uppercase code.`);
    }
    // The catalogue may already state the currency a scope is priced in. An approval that
    // disagrees is a mistake worth stopping for, not a value to silently prefer.
    const catalogCurrency = typeof raw['currency'] === 'string' ? raw['currency'] : null;
    if (catalogCurrency !== null && currency !== null && catalogCurrency !== currency) {
      problems.push(
        `${key}: approval currency ${currency} contradicts catalogue currency ${catalogCurrency}.`,
      );
    }
    if (minEffortMinutes === undefined)
      problems.push(`${key}: "min_effort_minutes" must be a non-negative integer.`);
    if (maxEffortMinutes === undefined)
      problems.push(`${key}: "max_effort_minutes" must be a non-negative integer.`);
    if (
      typeof minEffortMinutes === 'number' &&
      typeof maxEffortMinutes === 'number' &&
      maxEffortMinutes < minEffortMinutes
    ) {
      problems.push(`${key}: "max_effort_minutes" is below "min_effort_minutes".`);
    }

    // The rule that matters, checked here and again as a database constraint.
    if (
      enabled &&
      (priceMinor === null ||
        currency === null ||
        approvedBySubject === null ||
        approvedAt === null)
    ) {
      problems.push(
        `${key}: enabled requires an approved price — "price_minor", "currency", "approved_by_subject" and "approved_at" must all be present.`,
      );
    }
    if (approvedAt !== null && Number.isNaN(Date.parse(approvedAt))) {
      problems.push(`${key}: "approved_at" is not a parseable timestamp.`);
    }

    offers.push({
      sku,
      version,
      venture,
      promise,
      detectorFamilies,
      inclusions,
      exclusions,
      prerequisites,
      acceptance,
      currency,
      priceMinor,
      taxTreatment:
        typeof approval['tax_treatment'] === 'string' ? approval['tax_treatment'] : null,
      minEffortMinutes: minEffortMinutes ?? null,
      maxEffortMinutes: maxEffortMinutes ?? null,
      enabled,
      approvedBySubject,
      approvedAt,
      approvalNote:
        typeof approval['approval_note'] === 'string' ? approval['approval_note'] : null,
    });
  }

  // An approval nobody can apply is a signal, not debris: usually a SKU whose scope version
  // moved after it was approved, which is the case the version key exists to catch.
  for (const key of approvals.keys()) {
    problems.push(`Approval for ${key} matches no catalogue entry at that version.`);
  }

  return { offers, problems };
}
