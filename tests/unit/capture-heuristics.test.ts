import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prominentText } from '../../packages/capture/src/local-fixture-adapter.ts';

/**
 * The capture adapter's page heuristics.
 *
 * These decide whether an observation is usable at all, so a false "ambiguous" is as harmful
 * as a false "confirmed": it silently discards a valid check. The kit's own fixtures are the
 * regression cases, because one of them mentions a status code in ordinary body copy.
 */

const kit = new URL('../../opportunity-engine-build-kit/fixtures/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, kit), 'utf8');

const SOFT_404 =
  /(page (is |was )?not (here|found)|page does ?n[o']?t exist|not found|nicht gefunden|seite existiert nicht|fehler 404)/i;

function looksLikeSoft404(html: string): boolean {
  return SOFT_404.test(prominentText(html));
}

describe('prominent text extraction', () => {
  it('reads the title and headings, not the whole body', () => {
    const html = '<title>Shop</title><h1>Everyday overshirt</h1><p>Body copy about page not found.</p>';
    const text = prominentText(html);
    expect(text).toContain('Shop');
    expect(text).toContain('Everyday overshirt');
    expect(text).not.toContain('Body copy');
  });

  it('survives a page with no title or headings', () => {
    expect(prominentText('<div>nothing structural here</div>')).toBe('');
  });
});

describe('soft-404 detection', () => {
  it('does not flag the product fixture, whose body merely mentions a 404', () => {
    const html = read('product.html');
    // The fixture's own copy says "The information link deliberately returns HTTP 404."
    expect(html).toContain('HTTP 404');
    expect(looksLikeSoft404(html)).toBe(false);
  });

  it('does not flag the healthy guide fixture', () => {
    expect(looksLikeSoft404(read('healthy-guide.html'))).toBe(false);
  });

  it('flags a page that announces "not here" in its heading', () => {
    // The kit's missing-guide fixture is served with a real 404, so soft-404 never applies
    // to it in practice; the heuristic still has to recognise the shape.
    expect(looksLikeSoft404(read('missing-guide.html'))).toBe(true);
  });

  it('flags common German not-found wording in a heading', () => {
    expect(looksLikeSoft404('<h1>Seite nicht gefunden</h1>')).toBe(true);
  });

  it('ignores not-found wording that only appears in body copy', () => {
    expect(
      looksLikeSoft404('<title>Size guide</title><p>If a page is not found, contact us.</p>'),
    ).toBe(false);
  });
});
