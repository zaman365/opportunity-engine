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
declare const document: {
  body: { scrollHeight: number };
  images: Iterable<{
    currentSrc: string;
    src: string;
    naturalWidth: number;
    naturalHeight: number;
  }>;
};

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
        await page.waitForTimeout(Math.min(500, request.settleMs));

        const measured = await page.evaluate(() =>
          [...document.images].map((image) => ({
            src: image.currentSrc || image.src,
            rendered: image.naturalWidth > 0 && image.naturalHeight > 0,
            renderedWidth: image.naturalWidth,
            renderedHeight: image.naturalHeight,
          })),
        );

        const body = await page.screenshot({ type: 'png', fullPage: false });
        return { ok: true, body: new Uint8Array(body), measured };
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
