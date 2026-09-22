import type { ScreenshotRenderer, RenderRequest, RenderResult } from './local-fixture-adapter.ts';

/**
 * Renders captured HTML to a PNG and reports what actually painted.
 *
 * Every request the page makes is intercepted. The document itself is fulfilled from the HTML
 * the transport recorded, each image from the bytes the transport already fetched, and
 * everything else is aborted. Nothing reaches the network, and with JavaScript disabled
 * nothing in the page can initiate a request the handler has not seen.
 *
 * The page is navigated to its real URL rather than injected with `setContent`, because the
 * document URL is what root-relative image paths resolve against. Injecting the markup leaves
 * the document at `about:blank`, where `/img/front.png` resolves to nothing and every image
 * silently fails to render — which would turn a healthy page into a false positive.
 *
 * Playwright is a dev dependency. If it or its browser is missing, `create` returns null and
 * evidence records an explicit "screenshot unavailable" reason instead of a blank image.
 */

// The `page.evaluate` bodies below execute in the browser, but this package compiles against
// the Node library only. Declaring the handful of globals they use keeps the DOM lib out of
// server code while still typechecking what runs in the page.
declare const window: { scrollTo(x: number, y: number): void };
interface MeasuredElement {
  tagName: string;
  id: string;
  className: string;
  querySelector(selector: string): MeasuredElement | null;
  closest(selector: string): MeasuredElement | null;
  getAttribute(name: string): string | null;
  textContent: string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}
declare const document: {
  body: { scrollHeight: number };
  images: Iterable<{
    currentSrc: string;
    src: string;
    naturalWidth: number;
    naturalHeight: number;
    complete: boolean;
  }>;
  querySelectorAll(selector: string): Iterable<MeasuredElement>;
  querySelector(selector: string): MeasuredElement | null;
};
declare const getComputedStyle: (element: MeasuredElement) => { position: string };

export async function createPlaywrightRenderer(): Promise<ScreenshotRenderer | null> {
  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    return null;
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    return null;
  }
  const version = browser.version();

  return {
    describe: () => `chromium/${version} (offline setContent render)`,

    async render(request: RenderRequest): Promise<RenderResult> {
      let context: Awaited<ReturnType<NonNullable<typeof browser>['newContext']>> | null = null;
      try {
        context = await browser!.newContext({
          viewport: request.viewport,
          javaScriptEnabled: false,
          bypassCSP: false,
        });

        const bySrc = new Map(request.images.map((image) => [image.src, image]));
        const escaped: string[] = [];
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url === request.pageUrl) {
            return route.fulfill({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              body: request.html,
            });
          }
          const image = bySrc.get(url);
          if (image?.body && image.resourceContentType) {
            return route.fulfill({
              status: 200,
              contentType: image.resourceContentType,
              body: Buffer.from(image.body),
            });
          }
          // Everything else — a failed image, a timed-out one, a stylesheet, a font — is
          // refused. Only recorded bytes may reach the page.
          escaped.push(url);
          return route.abort();
        });

        const page = await context.newPage();
        await page.goto(request.pageUrl, { waitUntil: 'domcontentloaded' });
        void escaped;

        // `loading="lazy"` images only fetch when they approach the viewport, so walk the
        // page before measuring. Bounded: a lazy image that never arrives stays unrendered
        // and the detector abstains on it.
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          window.scrollTo(0, 0);
        });
        // Wait for every image request to SETTLE, not for a fixed interval.
        //
        // A fixed 500ms was enough on an idle machine and not enough on a busy one, which made
        // a healthy image read as broken whenever the suite was under load — a false positive
        // produced by the measuring instrument rather than by the page.
        //
        // Polled with `evaluate` rather than `waitForFunction`, because this context runs with
        // JavaScript disabled and `waitForFunction` polls from inside the page. `evaluate`
        // reaches in from the protocol side and still works; `waitForFunction` silently never
        // fires, which is a worse failure than the one being fixed.
        //
        // `complete` is true for a failed request as well as a successful one, so this waits
        // for an answer rather than for success. The deadline preserves the bounded lazy-load
        // semantics: an image that never arrives is recorded as pending, never as broken.
        const settleBy = Date.now() + Math.max(1000, request.settleMs);
        for (;;) {
          const pending = await page.evaluate(
            () => [...document.images].filter((image) => !image.complete).length,
          );
          if (pending === 0 || Date.now() >= settleBy) break;
          await page.waitForTimeout(50);
        }

        const measured = await page.evaluate(() =>
          [...document.images].map((image) => ({
            src: image.currentSrc || image.src,
            rendered: image.naturalWidth > 0 && image.naturalHeight > 0,
            renderedWidth: image.naturalWidth,
            renderedHeight: image.naturalHeight,
          })),
        );

        // CE-MOBILE-01's half of the capture: what the page positions over itself, measured
        // in the same render that produced the screenshot, so the evidence and the claim are
        // about the same pixels.
        // CE-MOBILE-01's half of the capture: what the page positions over itself, measured
        // in the same render that produced the screenshot, so the evidence and the claim are
        // about the same pixels.
        //
        // Written without any named inner function on purpose. This body is serialised and
        // evaluated inside the page, and the bundler rewrites named function expressions to
        // call its own `__name` helper — which does not exist in the page, so the whole render
        // fails with a ReferenceError and every image reads as "did not render". That is a
        // false positive produced by the build tool, and it is invisible until something looks
        // at a healthy image. Keep this inline.
        const layout = await page.evaluate(() => {
          const DISMISS =
            'button, [role="button"], a[href="#"], [aria-label*="close" i], [aria-label*="dismiss" i], [class*="close" i]';
          const TRANSIENT = '[aria-busy="true"], [data-loading], [class*="skeleton" i]';

          const overlays = [...document.querySelectorAll('body *')]
            .map((element) => ({ element, position: getComputedStyle(element).position }))
            .filter((entry) => entry.position === 'fixed' || entry.position === 'sticky')
            .map((entry) => {
              const box = entry.element.getBoundingClientRect();
              const classes = (entry.element.className || '-').toString().trim().split(/\s+/);
              return {
                // A handle stable enough to match the same element across two sessions, and
                // meaningless enough to carry no page content.
                key: `${entry.element.tagName.toLowerCase()}#${entry.element.id || '-'}.${classes
                  .slice(0, 3)
                  .join('.')}`,
                position: entry.position as 'fixed' | 'sticky',
                rect: { x: box.x, y: box.y, width: box.width, height: box.height },
                hasDismissControl: entry.element.querySelector(DISMISS) !== null,
                looksTransient: entry.element.closest(TRANSIENT) !== null,
              };
            });

          const main =
            document.querySelector('main') ??
            document.querySelector('[role="main"]') ??
            document.querySelector('article');
          const mainBox = main ? main.getBoundingClientRect() : null;
          return {
            overlays,
            contentRect: mainBox
              ? { x: mainBox.x, y: mainBox.y, width: mainBox.width, height: mainBox.height }
              : null,
          };
        });

        const body = await page.screenshot({ type: 'png', fullPage: false });
        return { ok: true, body: new Uint8Array(body), measured, layout };
      } catch (error) {
        return {
          ok: false,
          reason:
            error instanceof Error
              ? `render_failed:${error.message.slice(0, 120)}`
              : 'render_failed',
        };
      } finally {
        await context?.close().catch(() => undefined);
      }
    },
  };
}
