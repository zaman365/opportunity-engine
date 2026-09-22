import { describe, expect, it } from 'vitest';
import { EMBED_COPY, fill, PAGE_COPY, REPORT_FRAME } from '../../apps/api/src/copy.ts';

/**
 * The words, checked as words.
 *
 * Two kinds of assertion here. The mechanical ones — every language has every key, every
 * placeholder resolves — catch a half-finished translation, which is worse than none because
 * it looks finished. The substantive ones check that the German says the same careful things
 * the English does: scope-limited, never "your site is fine", never a promise.
 */

const LANGUAGES = ['en', 'de'] as const;

describe('every language is complete', () => {
  it('has the same report-frame keys, and no empty strings', () => {
    const keys = Object.keys(REPORT_FRAME.en).sort();
    expect(Object.keys(REPORT_FRAME.de).sort()).toEqual(keys);
    for (const language of LANGUAGES) {
      const frame = REPORT_FRAME[language];
      expect(frame.baseLimitations.length, language).toBe(REPORT_FRAME.en.baseLimitations.length);
      expect(frame.exclusions.length, language).toBe(REPORT_FRAME.en.exclusions.length);
      for (const value of [frame.title, frame.partialPages, frame.findingsLanguageNote]) {
        expect(value.trim().length, language).toBeGreaterThan(10);
      }
    }
  });

  it('has the same page and embed keys', () => {
    expect(Object.keys(PAGE_COPY.de).sort()).toEqual(Object.keys(PAGE_COPY.en).sort());
    expect(Object.keys(EMBED_COPY.de).sort()).toEqual(Object.keys(EMBED_COPY.en).sort());
    for (const language of LANGUAGES) {
      for (const [key, value] of Object.entries(EMBED_COPY[language])) {
        expect(value.trim().length, `${language}.${key}`).toBeGreaterThan(2);
      }
    }
  });

  it('keeps every placeholder in both languages', () => {
    // A template that lost its placeholder in translation renders a sentence with a hole in
    // it, and nothing else would notice.
    const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
    expect(placeholders(REPORT_FRAME.de.title)).toEqual(placeholders(REPORT_FRAME.en.title));
    expect(placeholders(REPORT_FRAME.de.partialPages)).toEqual(
      placeholders(REPORT_FRAME.en.partialPages),
    );
    expect(placeholders(PAGE_COPY.de.pagesCaptured)).toEqual(
      placeholders(PAGE_COPY.en.pagesCaptured),
    );
  });
});

describe('the German says the same careful things', () => {
  it('keeps the no-defect sentence scope-limited', () => {
    // "Kein belegter Mangel *in der geprüften Auswahl*" — about this sample, never about the
    // site. A translation that dropped the qualifier would turn a scoped result into a clean
    // bill of health, which is the single most damaging thing this document could say.
    expect(PAGE_COPY.de.noDefectHeading).toContain('geprüften Auswahl');
    expect(PAGE_COPY.de.noDefectBody).toContain('nicht über die gesamte Website');
    expect(PAGE_COPY.en.noDefectBody).toContain('not a statement about the whole site');
  });

  it('keeps the exclusions as refusals rather than reassurances', () => {
    const joined = REPORT_FRAME.de.exclusions.join(' ');
    expect(joined).toContain('nichts verändert');
    expect(joined).toContain('keine Zusage');
  });

  it('keeps the limitation that revenue was not measured', () => {
    expect(REPORT_FRAME.de.baseLimitations.join(' ')).toContain('Umsatz wurde nicht gemessen');
  });

  it('keeps the form privacy sentence, including that a request is not a sign-up', () => {
    expect(EMBED_COPY.de.privacy).toContain('ausschließlich');
    expect(EMBED_COPY.de.privacy).toContain('keine Anmeldung');
  });

  it('says why a finding is not translated, and covers scan notes too', () => {
    // Scan notes are recorded when a scan runs, before any report language exists, so the
    // note has to cover them as well — otherwise a German report carries English sentences
    // with nothing explaining them.
    expect(REPORT_FRAME.de.findingsLanguageNote).toContain('nicht übersetzt');
    expect(REPORT_FRAME.de.findingsLanguageNote).toContain('Prüfnotizen');
    expect(REPORT_FRAME.en.findingsLanguageNote).toContain('not translated');
    expect(REPORT_FRAME.en.findingsLanguageNote).toContain('scan notes');
  });

  it('does not leak English into the German frame', () => {
    const german = [
      REPORT_FRAME.de.title,
      ...REPORT_FRAME.de.baseLimitations,
      ...REPORT_FRAME.de.exclusions,
      REPORT_FRAME.de.partialPages,
      REPORT_FRAME.de.findingsLanguageNote,
      ...Object.values(PAGE_COPY.de).filter((v): v is string => typeof v === 'string'),
    ].join(' ');
    for (const english of [' the ', ' and ', ' were ', ' page ', 'What we']) {
      expect(german, english).not.toContain(english);
    }
  });
});

describe('fill', () => {
  it('substitutes what it is given and leaves what it is not', () => {
    expect(fill('{a} of {b}', { a: 1, b: 2 })).toBe('1 of 2');
    // An unknown placeholder stays visible rather than becoming "undefined" in a customer
    // document — which is the difference between an obvious bug and a quiet one.
    expect(fill('{a} of {b}', { a: 1 })).toBe('1 of {b}');
  });
});
