import { describe, expect, it } from 'vitest';
import {
  extractStructuredFacts,
  extractVisibleFacts,
  parseAmountMinor,
  parseCurrency,
  parseTaxBasis,
} from '@oe/capture';

/**
 * Reading the two statements CE-DATA-01 compares out of a real page.
 *
 * The parser's job is to be right or to say nothing. A price read wrongly by a factor of a
 * hundred, or a currency guessed from a bare `$` on a German page, becomes a false accusation
 * about somebody's shop — so every ambiguous case below is asserted to return null rather than
 * a best guess.
 */

describe('parseAmountMinor', () => {
  it('reads both decimal conventions', () => {
    // 1.234,56 is European and 1,234.56 is not, and both appear on German shops selling
    // internationally. The last separator with two digits after it is the decimal one.
    expect(parseAmountMinor('49,00')).toBe('4900');
    expect(parseAmountMinor('49.00')).toBe('4900');
    expect(parseAmountMinor('1.234,56')).toBe('123456');
    expect(parseAmountMinor('1,234.56')).toBe('123456');
    expect(parseAmountMinor('12.345.678,90')).toBe('1234567890');
  });

  it('reads a whole amount and a thousands group', () => {
    expect(parseAmountMinor('49')).toBe('4900');
    expect(parseAmountMinor('1.234')).toBe('123400');
    expect(parseAmountMinor('1,234')).toBe('123400');
  });

  it('ignores whatever surrounds the number', () => {
    expect(parseAmountMinor('€ 49,00')).toBe('4900');
    expect(parseAmountMinor('EUR 49.00 incl. VAT')).toBe('4900');
    expect(parseAmountMinor('  49,00 € ')).toBe('4900');
  });

  it('returns nothing rather than guessing', () => {
    // A single digit after a separator could be tenths or a mangled thousands group. Wrong
    // by a factor of ten is worse than absent.
    for (const bad of ['', 'from', '49,0', '49.0000', '1.2.3', 'abc']) {
      expect(parseAmountMinor(bad), bad).toBeNull();
    }
  });

  it('refuses an amount too large to be a price', () => {
    expect(parseAmountMinor('1234567890123456789')).toBeNull();
  });
});

describe('parseCurrency', () => {
  it('reads a code or an unambiguous symbol', () => {
    expect(parseCurrency('49,00 €')).toBe('EUR');
    expect(parseCurrency('EUR 49.00')).toBe('EUR');
    expect(parseCurrency('$49.00')).toBe('USD');
    expect(parseCurrency('CHF 49.00')).toBe('CHF');
    expect(parseCurrency('£49.00')).toBe('GBP');
  });

  it('prefers an explicit code over a symbol', () => {
    // "CHF 49" written with a dollar sign somewhere else on the line is still francs.
    expect(parseCurrency('CHF 49.00 ($52 approx.)')).toBe('CHF');
  });

  it('says nothing when a number carries no currency at all', () => {
    expect(parseCurrency('49,00')).toBeNull();
  });
});

describe('parseTaxBasis', () => {
  it('reads the phrases German and English shops actually use', () => {
    expect(parseTaxBasis('49,00 € inkl. MwSt.')).toBe('gross');
    expect(parseTaxBasis('49.00 EUR incl. VAT')).toBe('gross');
    expect(parseTaxBasis('49,00 € zzgl. MwSt.')).toBe('net');
    expect(parseTaxBasis('49.00 EUR excl. tax')).toBe('net');
    expect(parseTaxBasis('Netto 49,00 €')).toBe('net');
  });

  it('says unknown when the page does not say, which is the common case', () => {
    expect(parseTaxBasis('49,00 €')).toBe('unknown');
  });
});

describe('extractStructuredFacts', () => {
  const ld = (body: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(body)}</script></head><body></body></html>`;

  it('reads a single offer', () => {
    const facts = extractStructuredFacts(
      ld({
        '@context': 'https://schema.org',
        '@type': 'Product',
        sku: 'JKT-MED',
        offers: {
          '@type': 'Offer',
          price: '49.00',
          priceCurrency: 'EUR',
          availability: 'https://schema.org/InStock',
        },
      }),
    );
    expect(facts).toEqual({
      offerKind: 'single',
      offerCount: 1,
      price: { amountMinor: '4900', currency: 'EUR', taxBasis: 'unknown' },
      stock: 'in_stock',
      variantId: 'JKT-MED',
    });
  });

  it('reports an aggregate offer as one rather than flattening it to a number', () => {
    // A range across variants has no single figure to compare, and pretending otherwise is
    // how this rule would tell a shop its prices contradict when they simply vary.
    const facts = extractStructuredFacts(
      ld({
        '@type': 'Product',
        offers: { '@type': 'AggregateOffer', lowPrice: '29.00', highPrice: '79.00' },
      }),
    );
    expect(facts.offerKind).toBe('aggregate');
    expect(facts.price).toBeNull();
  });

  it('reads through a @graph', () => {
    const facts = extractStructuredFacts(
      ld({
        '@graph': [
          { '@type': 'WebPage' },
          { '@type': 'Product', offers: { '@type': 'Offer', price: 49, priceCurrency: 'eur' } },
        ],
      }),
    );
    expect(facts.price).toEqual({ amountMinor: '4900', currency: 'EUR', taxBasis: 'unknown' });
  });

  it('reads the tax basis only when the markup states it', () => {
    const withTax = extractStructuredFacts(
      ld({
        '@type': 'Product',
        offers: {
          '@type': 'Offer',
          price: '49.00',
          priceCurrency: 'EUR',
          valueAddedTaxIncluded: false,
        },
      }),
    );
    expect(withTax.price?.taxBasis).toBe('net');
    // Absent means absent, not false. Most markup simply does not say.
    const without = extractStructuredFacts(
      ld({
        '@type': 'Product',
        offers: { '@type': 'Offer', price: '49.00', priceCurrency: 'EUR' },
      }),
    );
    expect(without.price?.taxBasis).toBe('unknown');
  });

  it('maps the availability vocabulary', () => {
    const at = (availability: string) =>
      extractStructuredFacts(ld({ '@type': 'Product', offers: { '@type': 'Offer', availability } }))
        .stock;
    expect(at('https://schema.org/InStock')).toBe('in_stock');
    expect(at('OutOfStock')).toBe('out_of_stock');
    expect(at('http://schema.org/PreOrder')).toBe('preorder');
    expect(at('https://schema.org/Discontinued')).toBe('discontinued');
    expect(at('something-else')).toBeNull();
  });

  it('reports no structured data rather than throwing on malformed JSON', () => {
    // Broken JSON-LD is common and is not a defect this rule reports.
    const facts = extractStructuredFacts('<script type="application/ld+json">{ not json </script>');
    expect(facts.offerKind).toBe('none');
  });

  it('reports none for a page with no markup at all', () => {
    expect(extractStructuredFacts('<html><body><p>49,00 €</p></body></html>').offerKind).toBe(
      'none',
    );
  });
});

describe('extractVisibleFacts', () => {
  it('reads a price only from an element the page marks as one', () => {
    const facts = extractVisibleFacts(
      '<div class="product"><span class="price">49,00&euro;</span><p>Article 1234</p></div>',
      'JKT-MED',
    );
    expect(facts.price).toEqual({ amountMinor: '4900', currency: 'EUR', taxBasis: 'unknown' });
    expect(facts.variantId).toBe('JKT-MED');
  });

  it('reports no price when nothing on the page is marked as one', () => {
    // Guessing which number on a page is the price is how a wrong guess becomes a false
    // accusation. Absent is the honest answer, and the detector abstains on it.
    const facts = extractVisibleFacts('<div><span>49,00 €</span><span>1234</span></div>', 'x');
    expect(facts.price).toBeNull();
  });

  it('reads the tax basis from the text around the number', () => {
    const facts = extractVisibleFacts(
      '<span class="price">49,00 €</span><small>inkl. MwSt.</small>',
      'x',
    );
    expect(facts.price?.taxBasis).toBe('gross');
  });

  it('collects every currency visible on the page, not just the price element', () => {
    // One element being unambiguous does not make the page unambiguous.
    const facts = extractVisibleFacts(
      '<span class="price">49,00 €</span><p>Approx. CHF 47.00 at today’s rate</p>',
      'x',
    );
    expect(facts.currenciesSeen).toEqual(['EUR', 'CHF']);
  });

  it('reads stock phrases in both languages', () => {
    const at = (body: string) => extractVisibleFacts(body, 'x').stock;
    expect(at('<p>In stock</p>')).toBe('in_stock');
    expect(at('<p>Auf Lager</p>')).toBe('in_stock');
    expect(at('<p>Ausverkauft</p>')).toBe('out_of_stock');
    expect(at('<p>Sold out</p>')).toBe('out_of_stock');
    expect(at('<p>Pre-order now</p>')).toBe('preorder');
    expect(at('<p>Nothing about availability.</p>')).toBeNull();
  });

  it('ignores script and style content', () => {
    // A price in a script tag is not what a person saw.
    const facts = extractVisibleFacts(
      '<script>var price = "99,00 €";</script><span class="price">49,00 €</span>',
      'x',
    );
    expect(facts.price?.amountMinor).toBe('4900');
    expect(facts.currenciesSeen).toEqual(['EUR']);
  });
});

describe('two prices in one element', () => {
  it('refuses a struck-through old price beside a new one', () => {
    // Which one did the shopper act on? The rule cannot tell, so it says nothing rather than
    // picking — and the detector abstains on the absence.
    expect(parseAmountMinor('79,00 € 49,00 €')).toBeNull();
    expect(
      extractVisibleFacts('<span class="price"><s>79,00 €</s> 49,00 €</span>', 'x').price,
    ).toBeNull();
  });

  it('still reads a price with surrounding words that carry no digits', () => {
    expect(parseAmountMinor('Now only 49,00 € inkl. MwSt.')).toBe('4900');
  });
});
