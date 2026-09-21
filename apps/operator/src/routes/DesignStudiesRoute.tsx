import { useState } from 'react';

/**
 * D0 composition studies.
 *
 * IMPLEMENTATION_PLAN.md: "two or three genuinely different compositions for the same
 * populated case, not palette variations." Both studies below use identical content — the
 * same account, the same two-session MF-LINK-01 result, the same limits — so the comparison
 * is about hierarchy rather than about data.
 *
 * Study A is the direction this application implements. Study B is the alternative that was
 * considered and rejected; the rationale is in docs/design/DESIGN_LOG.md. This route is a
 * design artifact, reachable only by URL, and its content is static and fictional.
 */

const CASE = {
  docket: 'OE-4C21A7',
  account: 'Atelier Nord (synthetic fixture)',
  domain: 'atelier-nord.test',
  title: 'Linked information page returns an error',
  claim: 'The linked information page returned HTTP 404 in 2 recorded checks.',
  scope:
    'One linked information page reached from the product page, checked in two recorded sessions.',
  limitations: [
    'Only the recorded link and conditions were tested.',
    'Store-wide scope and revenue impact are unknown.',
  ],
  observations: [
    { ref: 'E1.1', row: 'Inspected page', session: 1, status: 200, complete: true },
    { ref: 'E1.2', row: 'Inspected page', session: 2, status: 200, complete: true },
    { ref: 'E2.1', row: 'Linked information page', session: 1, status: 404, complete: true },
    { ref: 'E2.2', row: 'Linked information page', session: 2, status: 404, complete: true },
  ],
  coverage: '2 of 2 pages',
  detector: 'MF-LINK-01 v2.0.0',
};

export function DesignStudiesRoute() {
  const [study, setStudy] = useState<'a' | 'b'>('a');
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Composition studies</h1>
          <p>
            Two different compositions of the same review task, on identical content. A design
            artifact, not a product surface: the data below is fictional and no control does
            anything.
          </p>
        </div>
        <div className="filterset" role="group" aria-label="Select a study">
          <button type="button" aria-pressed={study === 'a'} onClick={() => setStudy('a')}>
            A · Agreement first
          </button>
          <button type="button" aria-pressed={study === 'b'} onClick={() => setStudy('b')}>
            B · Document first
          </button>
        </div>
      </div>

      {study === 'a' ? <StudyA /> : <StudyB />}

      <div className="panel" style={{ marginTop: 'var(--s6)' }}>
        <h2>What differs</h2>
        <dl style={{ display: 'grid', gap: 'var(--s4)', margin: 0 }}>
          <div>
            <dt style={{ fontWeight: 600 }}>A · Agreement first (implemented)</dt>
            <dd style={{ margin: 0, color: 'var(--ink-secondary)' }}>
              Leads with the grid of recorded observations, because the whole evidentiary weight of
              this detector is that two independent checks agreed. The claim reads as a consequence
              of the grid. Risk: a reviewer may treat the grid as the whole story and skip the
              limits.
            </dd>
          </div>
          <div>
            <dt style={{ fontWeight: 600 }}>B · Document first (not implemented)</dt>
            <dd style={{ margin: 0, color: 'var(--ink-secondary)' }}>
              Leads with the written assertion and treats the captures as citations beneath it.
              Reads well and resembles the final report. Risk: the reproducibility that justifies
              the claim becomes a footnote, and comparing two sessions needs scrolling.
            </dd>
          </div>
        </dl>
      </div>
    </>
  );
}

function StudyA() {
  return (
    <div className="case" style={{ gridTemplateColumns: '240px minmax(0, 1fr) 340px' }}>
      <aside className="case-rail">
        <p style={microLabel}>This case</p>
        <p style={{ fontSize: 'var(--text-meta)', marginTop: 'var(--s3)' }}>{CASE.account}</p>
        <p style={{ fontSize: 'var(--text-meta)', color: 'var(--ink-secondary)' }}>{CASE.domain}</p>
        <p style={{ ...microLabel, marginTop: 'var(--s5)' }}>Coverage</p>
        <p style={{ font: '20px/1.1 var(--font-mono)', fontWeight: 600 }}>{CASE.coverage}</p>
      </aside>

      <div className="case-main">
        <div className="matrix">
          <table>
            <caption>Recorded observations · one cell per page and clean session</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Page</span>
                </th>
                <th scope="col">Session 1</th>
                <th scope="col">Session 2</th>
              </tr>
            </thead>
            <tbody>
              {['Inspected page', 'Linked information page'].map((row) => (
                <tr key={row}>
                  <th scope="row">{row}</th>
                  {[1, 2].map((session) => {
                    const cell = CASE.observations.find(
                      (o) => o.row === row && o.session === session,
                    )!;
                    return (
                      <td key={session}>
                        <div className="cell" data-verdict={cell.status === 404 ? 'failure' : 'ok'}>
                          <span className="ref">{cell.ref}</span>
                          <span className="status">{cell.status}</span>
                          <span className="note">complete capture</span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="agreement">
            <span aria-hidden="true">=</span>
            Both independent checks returned 404 under the same recorded conditions.
          </p>
        </div>

        <div className="stage">
          <div className="stage-actions">
            <h3 style={microLabel}>Artifact E2.1</h3>
          </div>
          <figure>
            <div className="unavailable" style={{ padding: 'var(--s16) var(--s4)' }}>
              <p>Capture placeholder — this study renders no real artifact.</p>
            </div>
            <figcaption>
              Recorded response to the linked information page. Fictional study content.
            </figcaption>
          </figure>
        </div>
      </div>

      <div className="case-side">
        <div className="narrative">
          <section>
            <h3>01 Observed</h3>
            <p className="claim">{CASE.claim}</p>
          </section>
          <section>
            <h3>03 Limits of this evidence</h3>
            <ul>
              {CASE.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </section>
        </div>
        <div className="seam">
          <p className="hint">Deciding on version 1</p>
          <div className="field">
            <label htmlFor="study-a-note">Reviewer note</label>
            <textarea id="study-a-note" placeholder="Study only — nothing is recorded." />
          </div>
          <div className="actions">
            <button type="button" className="btn" data-variant="primary" disabled>
              Confirm finding
            </button>
            <button type="button" className="btn" disabled>
              Reject
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StudyB() {
  return (
    <div
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--radius-surface)',
        padding: 'var(--s12) var(--s8)',
        maxWidth: '82ch',
        margin: '0 auto',
      }}
    >
      <p style={{ ...microLabel, marginBottom: 'var(--s3)' }}>
        {CASE.docket} · {CASE.detector}
      </p>
      <h2
        style={{
          fontSize: 'var(--text-page)',
          letterSpacing: '-0.02em',
          lineHeight: 1.15,
          fontWeight: 620,
        }}
      >
        {CASE.claim}
      </h2>
      <p style={{ marginTop: 'var(--s4)', color: 'var(--ink-secondary)', maxWidth: '62ch' }}>
        {CASE.scope}
      </p>

      <h3
        style={{
          ...microLabel,
          marginTop: 'var(--s8)',
          paddingBottom: 'var(--s2)',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        Citations
      </h3>
      <ol style={{ margin: 'var(--s4) 0 0', paddingInlineStart: 'var(--s6)' }}>
        {CASE.observations.map((observation) => (
          <li key={observation.ref} style={{ marginBottom: 'var(--s4)' }}>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-meta)' }}>
              {observation.ref} · {observation.row} · session {observation.session} · HTTP{' '}
              {observation.status}
            </p>
            <div
              style={{
                marginTop: 'var(--s2)',
                border: '1px solid var(--rule)',
                borderRadius: 'var(--radius-control)',
                background: 'var(--sunken)',
                height: 96,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--ink-muted)',
                fontSize: 'var(--text-meta)',
              }}
            >
              Capture placeholder
            </div>
          </li>
        ))}
      </ol>

      <h3
        style={{
          ...microLabel,
          marginTop: 'var(--s8)',
          paddingBottom: 'var(--s2)',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        Limits
      </h3>
      <ul
        style={{
          margin: 'var(--s4) 0 0',
          paddingInlineStart: 'var(--s6)',
          color: 'var(--ink-secondary)',
        }}
      >
        {CASE.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>

      <div
        style={{
          marginTop: 'var(--s8)',
          paddingTop: 'var(--s5)',
          borderTop: '2px solid var(--ink)',
        }}
      >
        <div className="field">
          <label htmlFor="study-b-note">Reviewer note</label>
          <textarea id="study-b-note" placeholder="Study only — nothing is recorded." />
        </div>
        <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
          <button type="button" className="btn" data-variant="primary" disabled>
            Confirm finding
          </button>
          <button type="button" className="btn" disabled>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

const microLabel: React.CSSProperties = {
  font: 'var(--text-micro)/1.4 var(--font-mono)',
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  color: 'var(--ink-muted)',
};
