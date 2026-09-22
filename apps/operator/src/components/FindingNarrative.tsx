import { canonicalDetectorId, type Evidence, type Finding } from '@oe/contracts';
import { Chip, Timestamp, type Tone } from './primitives.tsx';

/**
 * Observation, interpretation and limits, kept visibly separate.
 *
 * BUILD_SPEC.md §8 makes this separation mandatory: what was recorded, what it likely means,
 * why it could matter, and — only after delivery — what actually changed. The third is
 * always labelled as a hypothesis and the fourth never appears in M1.
 */
export function FindingNarrative({
  finding,
  evidence,
  references,
  selectedEvidenceId,
  onSelectEvidence,
}: {
  finding: Finding;
  evidence: Evidence[];
  references: Map<string, string>;
  selectedEvidenceId: string | null;
  onSelectEvidence: (evidenceId: string) => void;
}) {
  const contrary = evidence.filter((e) => finding.contrary_evidence_ids.includes(e.id));

  return (
    <div className="narrative">
      <section>
        <h3>
          01 Observed
          {/* Ordered by their matrix reference so E2.1 precedes E2.2 regardless of the
              order the detector happened to record them in. */}
          {[...finding.evidence_ids]
            .sort((a, b) => (references.get(a) ?? '').localeCompare(references.get(b) ?? ''))
            .map((id) => (
              <button
                key={id}
                type="button"
                className="evref"
                aria-pressed={selectedEvidenceId === id}
                onClick={() => onSelectEvidence(id)}
                title="Show this observation"
              >
                {references.get(id) ?? '·'}
              </button>
            ))}
        </h3>
        <p className="claim">{finding.claim}</p>
        <p style={{ marginTop: 'var(--s3)' }}>
          Detector {finding.detector_id} version {finding.detector_version}, captured{' '}
          <Timestamp value={finding.captured_at} />.
        </p>
      </section>

      <section>
        <h3>02 What it may mean</h3>
        <p>{interpretationFor(finding.detector_id)}</p>
        <p style={{ marginTop: 'var(--s2)' }}>
          <Chip tone="unknown">commercial impact · {finding.commercial_impact}</Chip>
        </p>
      </section>

      <section>
        <h3>03 Limits of this evidence</h3>
        <ul>
          {finding.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
          <li>Scope: {finding.scope}</li>
        </ul>
      </section>

      {contrary.length > 0 ? (
        <section>
          <h3>04 Contrary evidence</h3>
          <p>
            Recorded observations that do not support this claim. A confirmation is blocked until
            they are resolved.
          </p>
          <ul>
            {contrary.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="evref"
                  aria-pressed={selectedEvidenceId === item.id}
                  onClick={() => onSelectEvidence(item.id)}
                >
                  {references.get(item.id) ?? '·'}
                </button>{' '}
                {item.final_url} returned {item.http_status ?? 'no response'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The interpretation is the one place this screen says what an observation might mean, so it
 * has to belong to the detector that produced it. A generic sentence here would attach a
 * broken-link rationale to a broken-image finding, which is exactly the "interpretation
 * drifting from observation" BUILD_SPEC.md §8 separates them to prevent.
 */
function interpretationFor(detectorId: string): string {
  // Canonicalised first, so a finding recorded under the handoff namespace (`MF-LINK-01`)
  // gets its own rationale rather than falling through to "none has been written".
  switch (canonicalDetectorId(detectorId) ?? detectorId) {
    case 'CE-LINK-01':
      return 'A linked information page that does not load can interrupt a buying decision. That is a reason to repair the link, not a measured effect on sales.';
    case 'CE-ASSET-01':
      return 'A product image that does not appear leaves a buyer without something they were meant to see. That is a reason to repair the asset, not a measured effect on sales.';
    case 'CE-DATA-01':
      return 'A page whose markup contradicts what it shows can be read one way by a shopper and another by a shopping feed or a search result. Which figure is correct is for the shop to say; that they disagree is what was observed.';
    default:
      return 'No interpretation has been written for this detector. Read the observation and its limits directly.';
  }
}

export function findingTone(finding: Finding): { tone: Tone; label: string } {
  switch (finding.state) {
    case 'confirmed':
      return { tone: 'confirmed', label: 'confirmed by reviewer' };
    case 'rejected':
      return { tone: 'blocked', label: 'rejected' };
    case 'stale':
      return { tone: 'attention', label: 'evidence changed since review' };
    case 'unknown':
      return { tone: 'unknown', label: 'not established' };
    default:
      return { tone: 'attention', label: 'needs review' };
  }
}
