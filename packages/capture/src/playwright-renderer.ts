import type { ScreenshotRenderer } from './local-fixture-adapter.ts';

/**
 * Renders fixture HTML to a PNG with a headless Chromium.
 *
 * The page is loaded with `setContent` in an isolated context with JavaScript disabled and
 * no network access, exactly as VERIFICATION.md describes for the kit's own captures. The
 * screenshot is therefore a real render of the response the transport actually received —
 * not a live crawl of a merchant, and the evidence caption must keep saying so.
 *
 * Playwright is a dev dependency. If it or its browser is missing, `create` returns null and
 * evidence records an explicit "screenshot unavailable" reason instead of a blank image.
 */
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
    async render(html, viewport) {
      let context: Awaited<ReturnType<NonNullable<typeof browser>['newContext']>> | null = null;
      try {
        context = await browser!.newContext({
          viewport,
          javaScriptEnabled: false,
          bypassCSP: false,
          offline: true,
        });
        // Nothing the fixture references may be fetched: the render must show only the
        // bytes the transport recorded.
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        const body = await page.screenshot({ type: 'png', fullPage: false });
        return { ok: true as const, body: new Uint8Array(body) };
      } catch (error) {
        return {
          ok: false as const,
          reason: error instanceof Error ? `render_failed:${error.message.slice(0, 120)}` : 'render_failed',
        };
      } finally {
        await context?.close().catch(() => undefined);
      }
    },
  };
}
