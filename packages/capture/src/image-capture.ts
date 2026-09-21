import { classifyImage } from '@oe/domain';
import type { ImageCapture } from './port.ts';
import type { TargetPolicy } from './target-policy.ts';

/**
 * Finding and fetching the images a page references.
 *
 * Split out from the page adapter because it is the half of MF-ASSET-01 that is pure policy
 * and parsing: which images count, whether we are allowed to request them, and what each
 * request returned. The rendered half needs a browser and lives in the renderer.
 */

export interface ImageCandidate {
  src: string;
  alt: string | null;
  presentational: boolean;
  insideMain: boolean;
  lazy: boolean;
}

/**
 * Parse `<img>` elements with the attributes classification depends on.
 *
 * Page markup is evidence, never instruction: nothing found here widens what the capture is
 * allowed to request, and every URL is re-checked against the account's policy before a
 * request is made.
 */
export function parseImages(html: string, base: URL): ImageCandidate[] {
  const mainRanges = findMainRanges(html);
  const candidates: ImageCandidate[] = [];
  const tag = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = tag.exec(html)) !== null) {
    const attributes = parseAttributes(match[0]);
    const rawSrc = attributes.src ?? firstSrcsetUrl(attributes.srcset);
    if (!rawSrc || rawSrc.startsWith('data:')) continue;
    let src: string;
    try {
      src = new URL(rawSrc, base).href;
    } catch {
      continue;
    }
    if (candidates.some((candidate) => candidate.src === src)) continue;

    const offset = match.index;
    candidates.push({
      src,
      alt: attributes.alt ?? null,
      presentational:
        attributes.role?.toLowerCase() === 'presentation' ||
        attributes.role?.toLowerCase() === 'none' ||
        attributes['aria-hidden']?.toLowerCase() === 'true',
      // Inclusive lower bound: an <img> written immediately after <main> with no whitespace
      // starts exactly at the range's first byte, and an exclusive test would place a
      // page's primary product image outside its own content area.
      insideMain: mainRanges.some(([start, end]) => offset >= start && offset < end),
      lazy: attributes.loading?.toLowerCase() === 'lazy',
    });
  }
  return candidates;
}

/** Byte ranges covered by a `<main>` element, or the whole document when there is none. */
function findMainRanges(html: string): [number, number][] {
  const ranges: [number, number][] = [];
  const open = /<main\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(html)) !== null) {
    const start = match.index + match[0].length;
    const close = html.toLowerCase().indexOf('</main>', start);
    ranges.push([start, close === -1 ? html.length : close]);
  }
  // A page with no <main> is not thereby free of product images; treat the body as content
  // and let the alt-text requirement carry the classification.
  if (ranges.length === 0) return [[0, html.length]];
  return ranges;
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    attributes[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  // A bare `alt` with no value is an empty alt, which means decorative.
  if (!Object.hasOwn(attributes, 'alt') && /\balt\b(?!\s*=)/i.test(tag)) attributes.alt = '';
  return attributes;
}

function firstSrcsetUrl(srcset: string | undefined): string | null {
  if (!srcset) return null;
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first || null;
}

/** What `fetchImages` returns: an ImageCapture with its request outcome filled in. */
export type FetchedImage = ImageCapture;

/**
 * Request each candidate image under the capture policy and the bounded wait.
 *
 * A request that has not answered when `timeoutMs` expires is recorded as `timedOut`, not as a
 * failure. That distinction is the whole reason MF-ASSET-01 can abstain on a slow image
 * instead of calling it broken.
 */
export async function fetchImages(
  candidates: ImageCandidate[],
  options: {
    approvedHosts: readonly string[];
    targetPolicy: TargetPolicy;
    timeoutMs: number;
    maxImages: number;
    maxBytes: number;
    locale: string;
  },
): Promise<FetchedImage[]> {
  const selected = candidates.slice(0, options.maxImages);
  const results: FetchedImage[] = [];

  for (const candidate of selected) {
    const classification = classifyImage({
      alt: candidate.alt,
      presentational: candidate.presentational,
      insideMain: candidate.insideMain,
    });
    const base: FetchedImage = {
      ...candidate,
      role: classification.role,
      roleReason: classification.reason,
      resourceStatus: null,
      resourceByteLength: null,
      resourceContentType: null,
      timedOut: false,
      policyDenied: null,
      rendered: false,
      renderedWidth: 0,
      renderedHeight: 0,
      body: null,
    };

    // The same policy that admitted the page admits its subresources. SECURITY.md: "Apply
    // policy to redirects and every browser subrequest, not just the top-level page."
    const verdict = options.targetPolicy(candidate.src, options.approvedHosts);
    if (!verdict.allowed) {
      results.push({ ...base, policyDenied: verdict.reason });
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(verdict.url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/*', 'accept-language': options.locale },
      });
      const buffer = new Uint8Array(await response.arrayBuffer());
      results.push({
        ...base,
        resourceStatus: response.status,
        resourceByteLength: buffer.byteLength,
        resourceContentType: response.headers.get('content-type'),
        body:
          response.status >= 200 &&
          response.status < 300 &&
          buffer.byteLength > 0 &&
          buffer.byteLength <= options.maxBytes
            ? buffer
            : null,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      results.push({ ...base, timedOut: aborted, resourceStatus: null });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}
