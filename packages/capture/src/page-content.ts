/**
 * What a recorded page said, and what it declared about its own images.
 *
 * Read by CE-CONTENT-01 and CE-VISUAL-01. Like `product-facts.ts`, everything here works on
 * the recorded HTML rather than a live DOM, for the same reason the renderer disables
 * JavaScript: nothing in a captured page should be able to run. Content a script would have
 * written is therefore not visible here, and is reported as absent -- which is why both rules
 * treat "the page announced a region it did not disclose" as a reason to abstain rather than
 * as evidence of anything.
 *
 * Every function is pure and total. Malformed markup produces less information, never a throw.
 */

/** The page's readable text, with the parts a reader would not see removed. */
export interface PageText {
  /** Whole-page visible text, whitespace collapsed. */
  text: string;
  /**
   * Regions the page announced but did not fill in this capture.
   *
   * Three shapes, all common on product pages and all meaning the same thing here: there is
   * more to this page than the capture read. A `<details>` with nothing inside it, an element
   * whose markup says it loads on demand, and a tab control pointing at a panel that is not in
   * the document. Each entry is a short handle used only to explain an abstention; none of it
   * is shown to a customer.
   */
  undisclosedRegions: string[];
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeEntities(text: string): string {
  return (
    text
      .replace(/&euro;/gi, '€')
      .replace(/&pound;/gi, '£')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&uuml;/gi, 'ü')
      .replace(/&auml;/gi, 'ä')
      .replace(/&ouml;/gi, 'ö')
      .replace(/&szlig;/gi, 'ß')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      // Last, so a doubly-encoded entity does not decode into a tag.
      .replace(/&amp;/gi, '&')
  );
}

/** `<details>` whose body is empty or whitespace: a disclosure control with nothing behind it. */
const EMPTY_DETAILS = /<details\b[^>]*>([\s\S]*?)<\/details>/gi;
/** Markup that says outright that a region arrives later. */
const DEFERRED = /\b(data-(?:lazy|defer|async-content|remote|src-url)|hx-get|data-turbo-frame)\b/gi;
/** A tab control naming a panel. The panel itself is checked for separately. */
const TAB_CONTROL = /\baria-controls=["']([^"']+)["']/gi;

/** Does the document declare this id anywhere? Compared literally, not as a pattern. */
function documentHasId(html: string, id: string): boolean {
  for (const match of html.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    if ((match[1] ?? match[2] ?? match[3] ?? '') === id) return true;
  }
  return false;
}

export function extractPageText(html: string): PageText {
  const text = decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
  const undisclosedRegions: string[] = [];

  for (const match of html.matchAll(EMPTY_DETAILS)) {
    // The `<summary>` is the control's label, not what is behind it. Counting it as content
    // would mean every collapsed "Material & care" section read as disclosed, which is the
    // exact case this check exists for.
    const body = decodeEntities(
      stripTags(match[1]!.replace(/<summary\b[\s\S]*?<\/summary>/gi, ' ')),
    ).trim();
    if (body === '') undisclosedRegions.push('empty <details> region');
  }

  if (DEFERRED.test(html)) undisclosedRegions.push('region declared as loaded on demand');
  DEFERRED.lastIndex = 0;

  for (const match of html.matchAll(TAB_CONTROL)) {
    const id = match[1]!;
    // Nothing in the document carries that id, so the tab's content was never in the capture.
    if (!documentHasId(html, id)) {
      undisclosedRegions.push(`tab panel "${id}" not present in the capture`);
    }
  }

  return { text, undisclosedRegions: [...new Set(undisclosedRegions)] };
}

/** One `<img>` the page presents, as the page described it. */
export interface DeclaredImage {
  src: string;
  alt: string;
  decorative: boolean;
}

const IMG = /<img\b([^>]*)>/gi;
const ATTRIBUTE = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** The region of the document a reader would take to be the page's own content. */
function mainRegion(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (main) return main[1]!;
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (article) return article[1]!;
  // No landmark: the whole document, minus the parts that are never product imagery.
  return html
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
}

/**
 * The images the page offers as being about the product.
 *
 * Scoped to the content landmark, because a header logo and a footer payment badge are images
 * on the page and are not photographs of the thing being sold. Counting them would inflate
 * every count and quietly hide a page with no product imagery at all.
 *
 * `decorative` follows the page's own declaration -- `alt=""`, or an explicit presentational
 * role. An image the page says is decoration is not a product shot, and second-guessing that
 * would mean deciding what a picture is, which nothing here can do.
 */
export function extractDeclaredImages(html: string): DeclaredImage[] {
  const region = mainRegion(html);
  const images: DeclaredImage[] = [];

  for (const tag of region.matchAll(IMG)) {
    const attributes: Record<string, string> = {};
    for (const attribute of tag[1]!.matchAll(ATTRIBUTE)) {
      attributes[attribute[1]!.toLowerCase()] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
    }
    const src = attributes['src'] ?? attributes['data-src'] ?? '';
    if (src === '') continue;
    const alt = decodeEntities(attributes['alt'] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const role = (attributes['role'] ?? '').toLowerCase();
    const decorative =
      role === 'presentation' || role === 'none' || (attributes['alt'] !== undefined && alt === '');
    images.push({ src, alt, decorative });
  }

  return images;
}
