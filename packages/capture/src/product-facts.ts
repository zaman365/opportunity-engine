import type { StructuredFacts, TaxBasis, VisibleFacts } from '@oe/domain';

/**
 * The two statements CE-DATA-01 compares: what the markup declares, and what a person sees.
 *
 * Both are read from the recorded HTML rather than from a live DOM, for the same reason the
 * renderer disables JavaScript: nothing in a captured page should be able to run. A price that
 * only exists after a script has run is therefore not visible to this extractor, which reports
 * it as absent — and the detector abstains rather than claiming the page states nothing. That
 * is a real limitation of the rule and is written into its own limitations, not hidden here.
 *
 * Every function is pure and total: malformed markup produces "not established", never a
 * throw and never a guess.
 */

/* ------------------------------------------------------------- money */

/** ISO codes and the symbols that unambiguously mean them in this context. */
const CURRENCY_BY_SYMBOL: Readonly<Record<string, string>> = {
  '€': 'EUR',
  '£': 'GBP',
  $: 'USD',
  CHF: 'CHF',
};

const CODE = /\b(EUR|USD|GBP|CHF|SEK|DKK|NOK|PLN|CZK)\b/;
const SYMBOL = /[€£$]/;

/**
 * One number token, as a person would read it.
 *
 * The first alternative requires at least one thousands group, so `1.234,56` and `1,234.56`
 * both match as a single token; the second covers a plain amount with an optional two-digit
 * fraction. Anything that does not fit either — `49,0`, `49.0000`, `1.2.3` — simply fails to
 * match as one token, which is how ambiguity reaches the caller as ambiguity.
 */
const NUMBER_TOKEN = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?/g;

/**
 * Parse an amount out of human-written price text, into minor units.
 *
 * Two things make this harder than it looks. Decimal separators are inverted across Europe —
 * `1.234,56` is European and `1,234.56` is not, and both appear on German shops selling
 * internationally — and a price element often contains two numbers, a struck-through old price
 * beside a new one.
 *
 * So: exactly one number token, or nothing. A string carrying two prices is ambiguous about
 * which one a shopper acted on, and the detector should abstain rather than pick. Returning
 * null here is what makes it do so.
 */
export function parseAmountMinor(text: string): string | null {
  const tokens = text.match(NUMBER_TOKEN);
  if (tokens === null || tokens.length !== 1) return null;
  const token = tokens[0]!;

  // Three digits after the last separator is a thousands group, not a fraction.
  const fractional = /[.,](\d{2})$/.exec(token);
  const whole = (fractional ? token.slice(0, -3) : token).replace(/[.,]/g, '');
  const fraction = fractional ? fractional[1]! : '00';

  if (!/^\d+$/.test(whole)) return null;
  // Bounded: a "price" of forty digits is a parse failure wearing a number's clothes.
  if (whole.length > 12) return null;
  return `${BigInt(whole) * 100n + BigInt(fraction)}`;
}

/** The ISO code a piece of price text names, by code or by unambiguous symbol. */
export function parseCurrency(text: string): string | null {
  const code = CODE.exec(text.toUpperCase());
  if (code) return code[1]!;
  const symbol = SYMBOL.exec(text);
  return symbol ? (CURRENCY_BY_SYMBOL[symbol[0]] ?? null) : null;
}

/**
 * Whether a price says what it includes.
 *
 * German shops are required to state this and usually do, in words next to the number.
 * `unknown` when nothing says — which is the case that makes the detector abstain on any
 * difference a VAT rate could explain.
 */
export function parseTaxBasis(text: string): TaxBasis {
  const lower = text.toLowerCase();
  if (/(incl?\.?\s*(vat|tax)|inkl\.?\s*mwst|including vat|brutto)/.test(lower)) return 'gross';
  if (/(excl?\.?\s*(vat|tax)|zzgl\.?\s*mwst|exklusive mwst|netto|plus vat)/.test(lower)) {
    return 'net';
  }
  return 'unknown';
}

/* -------------------------------------------------------- structured */

/** schema.org availability URLs and bare tokens, mapped onto the detector's vocabulary. */
function normaliseAvailability(value: unknown): StructuredFacts['stock'] {
  if (typeof value !== 'string') return null;
  const token = value.split('/').pop()?.toLowerCase() ?? '';
  if (token.includes('outofstock') || token.includes('soldout')) return 'out_of_stock';
  if (token.includes('preorder') || token.includes('backorder')) return 'preorder';
  if (token.includes('discontinued')) return 'discontinued';
  if (token.includes('instock') || token.includes('limitedavailability')) return 'in_stock';
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Every node in a JSON-LD document, including `@graph` members and nested arrays. */
function flatten(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out);
    return out;
  }
  const record = asRecord(value);
  if (!record) return out;
  out.push(record);
  if ('@graph' in record) flatten(record['@graph'], out);
  if ('offers' in record) flatten(record['offers'], out);
  return out;
}

function typeOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw];
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * What the page's JSON-LD declares about the product being sold.
 *
 * An `AggregateOffer` is reported as such rather than flattened to its low price: a range
 * across variants has no single figure to compare, and pretending otherwise is how this rule
 * would tell a shop its prices contradict when they simply vary.
 */
export function extractStructuredFacts(html: string): StructuredFacts {
  const none: StructuredFacts = {
    offerKind: 'none',
    offerCount: 0,
    price: null,
    stock: null,
    variantId: null,
  };

  const nodes: Record<string, unknown>[] = [];
  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      flatten(JSON.parse(match[1]!), nodes);
    } catch {
      // Malformed JSON-LD is common and is not a defect this rule reports. Skip it.
      continue;
    }
  }
  if (nodes.length === 0) return none;

  const aggregate = nodes.filter((n) => typeOf(n).includes('AggregateOffer'));
  const offers = nodes.filter((n) => typeOf(n).some((t) => t === 'Offer' || t === 'Demand'));
  const product = nodes.find((n) => typeOf(n).includes('Product')) ?? null;

  const variantId =
    typeof product?.['sku'] === 'string'
      ? product['sku']
      : typeof product?.['mpn'] === 'string'
        ? product['mpn']
        : null;

  if (aggregate.length > 0) {
    return {
      offerKind: 'aggregate',
      offerCount: aggregate.length + offers.length,
      price: null,
      stock: null,
      variantId,
    };
  }
  if (offers.length === 0) return { ...none, variantId };

  const offer = offers[0]!;
  const rawPrice = offer['price'];
  const amountMinor =
    typeof rawPrice === 'number'
      ? parseAmountMinor(rawPrice.toFixed(2))
      : typeof rawPrice === 'string'
        ? parseAmountMinor(rawPrice)
        : null;
  const currency =
    typeof offer['priceCurrency'] === 'string' ? offer['priceCurrency'].toUpperCase() : null;

  // `valueAddedTaxIncluded` is the schema.org way to say it. Absent means absent, not false:
  // most markup simply does not state it.
  const taxBasis: TaxBasis =
    offer['valueAddedTaxIncluded'] === true
      ? 'gross'
      : offer['valueAddedTaxIncluded'] === false
        ? 'net'
        : 'unknown';

  return {
    offerKind: 'single',
    offerCount: offers.length,
    price: amountMinor !== null && currency !== null ? { amountMinor, currency, taxBasis } : null,
    stock: normaliseAvailability(offer['availability']),
    variantId:
      typeof offer['sku'] === 'string' ? offer['sku'] : ((variantId as string | null) ?? null),
  };
}

/* ----------------------------------------------------------- visible */

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&euro;/gi, '€')
    .replace(/&pound;/gi, '£')
    .replace(/&dollar;/gi, '$')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

/** Elements a shop marks as its price. `price` in a class, id or data attribute is universal. */
const PRICE_ELEMENT =
  /<([a-z]+)\b[^>]*(?:class|id|data-testid|itemprop)=["'][^"']*\bprice\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;

const STOCK_PHRASES: [RegExp, NonNullable<VisibleFacts['stock']>][] = [
  [/\b(out of stock|sold out|ausverkauft|nicht auf lager|nicht verf(ü|ue)gbar)\b/i, 'out_of_stock'],
  [/\b(pre-?order|vorbestell)/i, 'preorder'],
  [/\b(discontinued|eingestellt)\b/i, 'discontinued'],
  [/\b(in stock|auf lager|verf(ü|ue)gbar|sofort lieferbar)\b/i, 'in_stock'],
];

/**
 * What a person reading the page would have seen.
 *
 * Deliberately conservative. A price is taken only from an element the page itself marks as a
 * price; anything else would mean guessing which number on a page is the one that matters, and
 * a wrong guess here becomes a false accusation. When no such element exists, the price is
 * reported absent and the detector abstains.
 *
 * `currenciesSeen` covers the whole visible page, not just the price element: a page showing
 * both EUR and CHF is ambiguous even when one element is unambiguous on its own.
 */
export function extractVisibleFacts(html: string, variantId: string | null): VisibleFacts {
  const text = decodeEntities(stripTags(html)).replace(/\s+/g, ' ');

  let price: VisibleFacts['price'] = null;
  for (const match of html.matchAll(PRICE_ELEMENT)) {
    const inner = decodeEntities(stripTags(match[2]!)).replace(/\s+/g, ' ').trim();
    const amountMinor = parseAmountMinor(inner);
    const currency = parseCurrency(inner);
    if (amountMinor === null || currency === null) continue;
    // The tax basis may be stated beside the number rather than inside the element, so the
    // surrounding text is what gets read for it.
    price = { amountMinor, currency, taxBasis: parseTaxBasis(`${inner} ${text}`) };
    break;
  }

  const currenciesSeen: string[] = [];
  for (const match of text.matchAll(new RegExp(`${CODE.source}|${SYMBOL.source}`, 'gi'))) {
    const code = parseCurrency(match[0]!);
    if (code && !currenciesSeen.includes(code)) currenciesSeen.push(code);
  }

  let stock: VisibleFacts['stock'] = null;
  for (const [pattern, value] of STOCK_PHRASES) {
    if (pattern.test(text)) {
      stock = value;
      break;
    }
  }

  return { price, stock, variantId, currenciesSeen };
}
