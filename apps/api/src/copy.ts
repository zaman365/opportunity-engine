/**
 * The words this system writes, in the languages it writes them.
 *
 * ## What is translated, and what deliberately is not
 *
 * **The frame is translated.** Headings, limitations, exclusions, the sentence about how many
 * pages were captured — this system authors those, at report time, from a fixed set. A German
 * customer should read them in German.
 *
 * **A confirmed claim is not.** A finding's claim and its limitations are the exact text a
 * reviewer read and put their name to. Translating them afterwards would produce a sentence
 * nobody confirmed, in a document whose entire value is that somebody did. So a German report
 * carries its findings in the language they were confirmed in, and says so — which is the
 * honest arrangement rather than a gap in it.
 *
 * That is also why there is no machine translation anywhere near this file. A claim about
 * somebody's shop, rendered into a language nobody checked, is exactly the kind of plausible
 * text this system exists not to produce.
 */

export type Language = 'en' | 'de';

export interface ReportFrame {
  /** `{account}` is replaced. Neutral about scope: one report may carry any mix of findings. */
  title: string;
  baseLimitations: string[];
  exclusions: string[];
  /** `{captured}` and `{expected}` are replaced. */
  partialPages: string;
  /**
   * Shown above anything recorded at scan or review time, which may not be in the report's
   * language: a confirmed finding's claim, and the notes a scan recorded about its own
   * coverage. Both are written when they happen, not when the report is composed.
   */
  findingsLanguageNote: string;
}

export const REPORT_FRAME: Readonly<Record<Language, ReportFrame>> = {
  en: {
    title: '{account} · inspected pages and assets',
    baseLimitations: [
      'Only the pages, links and assets listed under "inspected" were checked.',
      'The effect on sales has not been measured.',
      'Private account configuration was not inspected.',
    ],
    exclusions: [
      'No change was made to the inspected site.',
      'No private or logged-in area was accessed.',
      'This assessment is not a guarantee of platform approval, compliance or revenue.',
    ],
    partialPages:
      '{captured} of {expected} pages were captured. The remaining pages could not be inspected.',
    findingsLanguageNote:
      'Findings and scan notes are reproduced in the language they were recorded in, at the time they were recorded. They are not translated, because a translated claim is not the claim anybody checked.',
  },
  de: {
    title: '{account} · geprüfte Seiten und Elemente',
    baseLimitations: [
      'Geprüft wurden ausschließlich die unter „Geprüft“ aufgeführten Seiten, Links und Elemente.',
      'Eine Auswirkung auf den Umsatz wurde nicht gemessen.',
      'Nicht öffentliche Konteneinstellungen wurden nicht geprüft.',
    ],
    exclusions: [
      'An der geprüften Website wurde nichts verändert.',
      'Es wurde kein geschützter oder eingeloggter Bereich aufgerufen.',
      'Diese Einschätzung ist keine Zusage über Plattformfreigabe, Rechtskonformität oder Umsatz.',
    ],
    partialPages:
      '{captured} von {expected} Seiten wurden erfasst. Die übrigen Seiten konnten nicht geprüft werden.',
    findingsLanguageNote:
      'Feststellungen und Prüfnotizen sind in der Sprache wiedergegeben, in der sie zum Zeitpunkt der Prüfung aufgezeichnet wurden. Sie werden nicht übersetzt, denn eine übersetzte Aussage ist nicht die Aussage, die jemand geprüft hat.',
  },
};

/**
 * The "nothing was found" sentence lives in `PageCopy`, not here.
 *
 * One string, one owner. It is rendered by the customer-facing page and by the operator's
 * report view, and duplicating it into the report frame would give it two places to drift —
 * which for a sentence whose whole job is to stay scope-limited is exactly the wrong risk.
 */
export interface PageCopy {
  invalidTitle: string;
  invalidBody: string[];
  inspected: string;
  found: string;
  doesNotEstablish: string;
  didNotDo: string;
  asOf: string;
  version: string;
  linkExpires: string;
  pagesCaptured: string;
  noDefectHeading: string;
  noDefectBody: string;
  perFindingLimits: string;
  footer: string;
  observations: (count: number) => string;
  evidenceGrade: string;
  notGraded: string;
}

export const PAGE_COPY: Readonly<Record<Language, PageCopy>> = {
  en: {
    invalidTitle: 'This link is not available',
    invalidBody: [
      'It may have expired, or it may have been withdrawn.',
      'If you were expecting to read something here, reply to whoever sent you the link and ask them to issue a new one.',
    ],
    inspected: 'What we inspected',
    found: 'What we found',
    doesNotEstablish: 'What this does not establish',
    didNotDo: 'What we did not do',
    asOf: 'As of',
    version: 'version',
    linkExpires: 'this link expires',
    pagesCaptured: '{captured} of {expected} pages captured, starting from',
    noDefectHeading: 'No supported defect in what we checked',
    noDefectBody:
      'The pages listed above were inspected and nothing met the bar for a supported finding. That is a result about this sample, not a statement about the whole site.',
    perFindingLimits: 'What this does not establish',
    footer:
      'This page is a fixed version of a reviewed assessment. It does not change after publication, and the link that opens it expires.',
    observations: (count) => `${count} recorded observation${count === 1 ? '' : 's'}`,
    evidenceGrade: 'evidence grade',
    notGraded: 'not graded',
  },
  de: {
    invalidTitle: 'Dieser Link ist nicht verfügbar',
    invalidBody: [
      'Er ist möglicherweise abgelaufen oder wurde zurückgezogen.',
      'Wenn Sie hier etwas erwartet haben, antworten Sie der Person, die Ihnen den Link geschickt hat, und bitten Sie um einen neuen.',
    ],
    inspected: 'Was wir geprüft haben',
    found: 'Was wir gefunden haben',
    doesNotEstablish: 'Was daraus nicht folgt',
    didNotDo: 'Was wir nicht getan haben',
    asOf: 'Stand',
    version: 'Fassung',
    linkExpires: 'dieser Link läuft ab am',
    pagesCaptured: '{captured} von {expected} Seiten erfasst, ausgehend von',
    noDefectHeading: 'Kein belegter Mangel in der geprüften Auswahl',
    noDefectBody:
      'Die oben genannten Seiten wurden geprüft, und nichts hat die Schwelle für eine belegte Feststellung erreicht. Das ist eine Aussage über diese Auswahl, nicht über die gesamte Website.',
    perFindingLimits: 'Was daraus nicht folgt',
    footer:
      'Diese Seite ist eine feste Fassung einer geprüften Einschätzung. Sie ändert sich nach der Veröffentlichung nicht, und der Link, der sie öffnet, läuft ab.',
    observations: (count) => `${count} erfasste Beobachtung${count === 1 ? '' : 'en'}`,
    evidenceGrade: 'Belegstufe',
    notGraded: 'nicht bewertet',
  },
};

export interface EmbedCopy {
  heading: string;
  intro: string;
  targetUrl: string;
  contactEmail: string;
  purpose: string;
  authority: string;
  submit: string;
  submitting: string;
  privacy: string;
  unavailable: string;
  failed: string;
  sent: string;
  sentBody: string;
  localCode: string;
}

export const EMBED_COPY: Readonly<Record<Language, EmbedCopy>> = {
  en: {
    heading: 'Request a check',
    intro: 'We will look at one page and tell you what we observed.',
    targetUrl: 'The page to check',
    contactEmail: 'Where to send the result',
    purpose: 'What made you ask',
    authority: 'Your connection to this site',
    submit: 'Request a check',
    submitting: 'Sending…',
    privacy:
      'We use your address to send you this result and nothing else. Asking for a check does not sign you up for anything.',
    unavailable: 'This form is not available right now.',
    failed: 'That request could not be sent. Check your connection and try again.',
    sent: 'Check your inbox',
    sentBody:
      'We sent a six-digit code to confirm the address you gave. It is good for ten minutes.',
    localCode: 'Local fixture: the code is',
  },
  de: {
    heading: 'Prüfung anfragen',
    intro: 'Wir sehen uns eine Seite an und sagen Ihnen, was wir beobachtet haben.',
    targetUrl: 'Die zu prüfende Seite',
    contactEmail: 'Wohin das Ergebnis gehen soll',
    purpose: 'Was Sie zu dieser Anfrage veranlasst',
    authority: 'Ihr Bezug zu dieser Website',
    submit: 'Prüfung anfragen',
    submitting: 'Wird gesendet…',
    privacy:
      'Wir verwenden Ihre Adresse ausschließlich, um Ihnen dieses Ergebnis zu senden. Eine Anfrage ist keine Anmeldung zu irgendetwas.',
    unavailable: 'Dieses Formular ist derzeit nicht verfügbar.',
    failed:
      'Die Anfrage konnte nicht gesendet werden. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
    sent: 'Bitte prüfen Sie Ihr Postfach',
    sentBody:
      'Wir haben einen sechsstelligen Code gesendet, um Ihre Adresse zu bestätigen. Er gilt zehn Minuten.',
    localCode: 'Lokale Testumgebung: der Code lautet',
  },
};

/** `{name}` substitution, with no partial application and no missing-key silence. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}
