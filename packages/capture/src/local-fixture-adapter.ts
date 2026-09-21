import { classifyLink } from '@oe/domain';
import type { CaptureOutcome, CaptureProvider, CaptureRequest, PageObservation } from './port.ts';

/**
 * Test-only transport to the kit's loopback fixture site.
 *
 * TEST_PLAN.md: "A local test-only transport may connect to it; never weaken production URL
 * policy to make a fixture work." So this adapter has its own rule — the target must be on
 * the configured loopback fixture origin and nowhere else — and the production
 * `preflightTarget` / `resolveAndClassify` path is left untouched. `loadConfig` refuses to
 * construct this adapter outside APP_ENV=local.
 *
 * Fixture captures cost nothing, and the adapter says so rather than inventing a price.
 */
export class LocalFixtureCaptureProvider implements CaptureProvider {
  readonly kind = 'local_fixture' as const;
  readonly configured = true;
  readonly #origin: URL;
  readonly #screenshot: ScreenshotRenderer | null;

  constructor(fixtureOrigin: string, screenshot: ScreenshotRenderer | null = null) {
    this.#origin = new URL(fixtureOrigin);
    const host = this.#origin.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
      throw new Error('The fixture transport only connects to a loopback origin.');
    }
    this.#screenshot = screenshot;
  }

  async capture(request: CaptureRequest): Promise<CaptureOutcome> {
    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      return { status: 'permanent_error', reason: 'invalid_url', detail: 'Target is not a URL.' };
    }
    if (target.origin !== this.#origin.origin) {
      return {
        status: 'blocked',
        reason: 'not_a_fixture_target',
        detail: 'The fixture transport refuses any origin other than the configured loopback fixture site.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.limits.timeoutMs);
    let response: Response;
    const capturedAt = new Date().toISOString();
    try {
      response = await fetch(target, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/html', 'accept-language': request.locale },
      });
    } catch (error) {
      return {
        status: 'retryable_error',
        reason: 'transport_failed',
        detail: error instanceof Error ? error.message : 'Fixture request failed.',
      };
    } finally {
      clearTimeout(timer);
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > request.limits.maxBytes) {
      return {
        status: 'blocked',
        reason: 'byte_limit_exceeded',
        detail: `Response exceeded the ${request.limits.maxBytes} byte ceiling.`,
      };
    }
    const html = new TextDecoder().decode(buffer);
    const observation = buildObservation(response, target, html, buffer);

    if (this.#screenshot) {
      const shot = await this.#screenshot.render(html, request.viewport);
      if (shot.ok) observation.screenshot = { body: shot.body, contentType: 'image/png' };
      else observation.screenshotUnavailableReason = shot.reason;
    } else {
      observation.screenshotUnavailableReason = 'no_renderer_configured';
    }

    return {
      status: 'captured',
      observation,
      conditions: {
        captured_at: capturedAt,
        session_id: request.sessionId,
        viewport_width: request.viewport.width,
        viewport_height: request.viewport.height,
        locale: request.locale,
        variant: extractVariant(html),
        consent_state: 'no_consent_layer_present',
        browser_version: this.#screenshot ? this.#screenshot.describe() : 'http-only-fixture-transport',
        test_region: null,
      },
      providerRequestId: `fixture:${request.operationKey}`,
      costMicro: '0',
    };
  }
}

/** Anything that can turn fixture HTML into a PNG. Keeps Playwright out of the hot path. */
export interface ScreenshotRenderer {
  describe(): string;
  render(
    html: string,
    viewport: { width: number; height: number },
  ): Promise<{ ok: true; body: Uint8Array } | { ok: false; reason: string }>;
}

/**
 * Soft-404 detection.
 *
 * Deliberately narrow: an earlier version also matched a bare "404" anywhere in the body,
 * which flagged a perfectly ordinary product page that merely *mentioned* a status code.
 * A wrong "ambiguous" label is not a harmless conservatism — it silently downgrades a valid
 * observation, so the rule now requires a not-found phrase and only looks at the title and
 * the page's own headings, which is where a real soft 404 announces itself.
 */
const SOFT_404 =
  /(page (is |was )?not (here|found)|page does ?n[o']?t exist|not found|nicht gefunden|seite existiert nicht|fehler 404)/i;
const CHALLENGE = /(access (check|denied)|verify you are human|captcha|unusual traffic|rate limit)/i;
const LOGIN_WALL = /(<input[^>]+type=["']password|sign in to continue|please log in|anmelden um fortzufahren)/i;

function buildObservation(
  response: Response,
  target: URL,
  html: string,
  buffer: Uint8Array,
): PageObservation {
  const challenge = response.status === 403 || response.status === 429 || CHALLENGE.test(html);
  return {
    status: response.status,
    finalUrl: target.href,
    redirectChain: [],
    complete: true,
    challenge,
    loginWall: LOGIN_WALL.test(html),
    // A 200 that announces "not found" is ambiguous. The detector must abstain, not assert.
    soft404: response.status >= 200 && response.status < 300 && SOFT_404.test(prominentText(html)),
    bodyBytes: buffer.byteLength,
    contentType: response.headers.get('content-type'),
    links: extractLinks(html, target),
    body: buffer,
    screenshot: null,
    screenshotUnavailableReason: null,
  };
}

/**
 * The title plus any heading text: what the page itself presents as its subject. Body copy
 * that merely discusses an error is not evidence that this page is one.
 */
export function prominentText(html: string): string {
  const parts: string[] = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) parts.push(stripTags(title[1]!));
  for (const match of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    parts.push(stripTags(match[1]!));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Extract anchors and keep only the ones `classifyLink` calls informational.
 *
 * Page text is evidence, not instruction: nothing in the HTML can widen what the scan is
 * allowed to visit, and every candidate is re-checked against the approved host list before
 * a navigation happens.
 */
function extractLinks(html: string, base: URL): { text: string; href: string }[] {
  const links: { text: string; href: string }[] = [];
  const anchor = /<a\b[^>]*href=(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[2]!;
    const text = stripTags(match[3]!).replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    let resolved: string;
    try {
      resolved = new URL(href, base).href;
    } catch {
      continue;
    }
    if (classifyLink(text, resolved).kind !== 'important_information') continue;
    if (links.some((l) => l.href === resolved)) continue;
    links.push({ text, href: resolved });
  }
  return links;
}

/**
 * The selected product state, when the page states it. Two captures of different variants
 * are not comparable, so this value becomes part of the detector's context key.
 */
function extractVariant(html: string): string | null {
  const match = /SELECTED STATE\s*\/\s*([A-Z0-9 ]+)</i.exec(html);
  return match ? match[1]!.trim() : null;
}
