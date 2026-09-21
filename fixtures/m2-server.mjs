#!/usr/bin/env node
/**
 * M2 fixture site · synthetic product pages for MF-ASSET-01.
 *
 * The kit's own fixture server (port 4179) covers MF-LINK-01 and stays untouched; its README
 * says "Additional platform/variant/lazy-load fixtures belong in M2", so these live with the
 * application instead.
 *
 * Loopback only, GET and HEAD only, no proxying, no outbound request. Every page is fictional:
 * no real merchant, no real photography, and no image here is a picture of a real product.
 * A browser capture of this site is not evidence about anybody's shop.
 *
 * Routes are designed as a matched set: one known positive, and one negative control for each
 * abstention MF-ASSET-01 declares (blocked, pending_lazy_load, decorative_image,
 * variant_changed).
 */
import http from 'node:http';
import { gradientPng } from './png.mjs';

const PORT = Number(process.env.M2_FIXTURE_PORT ?? 4180);

/** Rendered at 480×480 so a capture shows a recognisable image rather than a smear. */
const PRODUCT_IMAGE = gradientPng(480, 480, [214, 219, 226], [120, 132, 148]);
const DETAIL_IMAGE = gradientPng(480, 480, [226, 216, 205], [150, 128, 108]);

/** Alternates per request, so two clean sessions see different product states. */
let variantFlip = 0;

const PAGES = {
  '/product-broken-image': () =>
    productPage({
      title: 'Everyday overshirt',
      note: 'The main product image deliberately returns HTTP 404. This is the known-positive fixture for MF-ASSET-01.',
      images: [
        { src: '/img/missing.png', alt: 'Everyday overshirt, front view' },
        { src: '/img/detail.png', alt: 'Everyday overshirt, collar detail' },
      ],
    }),

  '/product-healthy': () =>
    productPage({
      title: 'Everyday overshirt',
      note: 'Every product image on this page loads. Healthy negative control.',
      images: [
        { src: '/img/product.png', alt: 'Everyday overshirt, front view' },
        { src: '/img/detail.png', alt: 'Everyday overshirt, collar detail' },
      ],
    }),

  // The image is real but arrives after the detector's bounded wait, so the rendered check
  // cannot distinguish "broken" from "not finished yet". The detector must abstain.
  '/product-lazy': () =>
    productPage({
      title: 'Everyday overshirt',
      note: 'The product image is served after a deliberate delay and is marked loading="lazy". A detector must abstain rather than call a slow image a broken one.',
      images: [{ src: '/img/slow.png', alt: 'Everyday overshirt, front view', loading: 'lazy' }],
    }),

  // Only a presentational image fails. Nothing a buyer needs is missing, so no claim.
  '/product-decorative-broken': () =>
    productPage({
      title: 'Everyday overshirt',
      note: 'A decorative background image fails while every product image loads. A decorative failure is not a product-image defect.',
      images: [
        { src: '/img/product.png', alt: 'Everyday overshirt, front view' },
        { src: '/img/missing.png', alt: '', decorative: true },
      ],
    }),

  // A 200 response carrying zero bytes: the request "succeeded" and nothing rendered.
  '/product-empty-image': () =>
    productPage({
      title: 'Everyday overshirt',
      note: 'The product image responds 200 with an empty body. The request looks successful and the image still does not render.',
      images: [{ src: '/img/empty.png', alt: 'Everyday overshirt, front view' }],
    }),

  // The selected product state differs between requests, so two sessions are not comparable.
  '/product-variant': () => {
    variantFlip += 1;
    const size = variantFlip % 2 === 1 ? 'M' : 'L';
    return productPage({
      title: 'Everyday overshirt',
      note: 'The selected size changes between requests. Two captures of different product states are not comparable evidence.',
      size,
      images: [{ src: '/img/missing.png', alt: `Everyday overshirt in size ${size}` }],
    });
  },
};

const IMAGES = {
  '/img/product.png': { status: 200, type: 'image/png', body: PRODUCT_IMAGE },
  '/img/detail.png': { status: 200, type: 'image/png', body: DETAIL_IMAGE },
  '/img/missing.png': {
    status: 404,
    type: 'text/plain; charset=utf-8',
    body: Buffer.from('Not found'),
  },
  '/img/empty.png': { status: 200, type: 'image/png', body: Buffer.alloc(0) },
  '/img/slow.png': { status: 200, type: 'image/png', body: PRODUCT_IMAGE, delayMs: 4000 },
};

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { allow: 'GET, HEAD' });
    return response.end('Read-only fixture');
  }
  const path = new URL(request.url, `http://127.0.0.1:${PORT}`).pathname;

  const image = Object.hasOwn(IMAGES, path) ? IMAGES[path] : null;
  if (image) {
    if (image.delayMs) await new Promise((resolve) => setTimeout(resolve, image.delayMs));
    response.writeHead(image.status, {
      'content-type': image.type,
      'content-length': String(image.body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return response.end(request.method === 'HEAD' ? undefined : image.body);
  }

  const page = Object.hasOwn(PAGES, path) ? PAGES[path] : null;
  if (!page) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('Unknown fixture route');
  }
  const html = page();
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : html);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `M2 synthetic fixtures only: http://127.0.0.1:${PORT}/product-broken-image\n` +
      `  routes: ${Object.keys(PAGES).join(', ')}\n`,
  );
});

/**
 * One product-page shape shared by every route, so the only difference between fixtures is the
 * thing under test. The markup mirrors what the image classifier reads: `alt` text, an
 * explicit presentational marker, and whether the image sits inside <main>.
 */
function productPage({ title, note, images, size = 'M' }) {
  const media = images
    .map((image) => {
      const attributes = [
        `src="${image.src}"`,
        `width="480"`,
        `height="480"`,
        image.decorative ? 'alt="" role="presentation"' : `alt="${escapeHtml(image.alt)}"`,
        image.loading ? `loading="${image.loading}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<figure class="shot"><img ${attributes}></figure>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atelier Nord · synthetic fixture PDP</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#20252b;background:#fff}
.fixture{padding:10px 32px;background:#20252b;color:#fff;font:12px/1.5 ui-monospace,monospace;letter-spacing:.03em}
header{padding:24px 42px;border-bottom:1px solid #dadde2}
.wordmark{font:25px Georgia,serif;letter-spacing:.04em}
main{max-width:1060px;margin:52px auto;padding:0 36px}
.product{display:grid;grid-template-columns:1.15fr 1fr;gap:54px;align-items:start}
.media{display:grid;gap:18px}
.shot{margin:0;background:#f4f6f8;border:1px solid #dadde2;min-height:180px}
.shot img{display:block;width:100%;height:auto}
.details h1{font:36px/1.2 Georgia,serif;margin:14px 0 16px}
.small{font:12px ui-monospace,monospace;color:#5a6572}
.price{font-size:23px}
.sizes{display:flex;gap:10px;margin:20px 0}.sizes span{border:1px solid #bfc6ce;padding:9px 15px}
.sizes span[aria-current]{border-color:#20252b;font-weight:600}
.notice{padding:18px 0;border-top:1px solid #d9dfe5;font-size:13px;color:#596574}
footer{padding:26px 42px;border-top:1px solid #dadde2;font-size:12px;color:#596574}
@media(max-width:650px){.product{grid-template-columns:1fr}main{margin:28px auto;padding:0 20px}}
</style>
<div class="fixture">SYNTHETIC TEST FIXTURE · No real merchant, photography or purchase function</div>
<header><div class="wordmark">ATELIER NORD</div></header>
<main><div class="product">
<div class="media">${media}</div>
<section class="details">
<div class="small">PRODUCT FIXTURE / 002</div>
<h1>${escapeHtml(title)}</h1>
<div class="price">€89.00 <span class="small">fictional price</span></div>
<p>Test content for a reproducible product-page inspection. No claim is made about a real garment.</p>
<div class="small">SELECTED STATE / SIZE ${escapeHtml(size)}</div>
<div class="sizes"><span>S</span><span${size === 'M' ? ' aria-current="true"' : ''}>M</span><span${size === 'L' ? ' aria-current="true"' : ''}>L</span><span>XL</span></div>
<div class="notice">${escapeHtml(note)}</div>
</section></div></main>
<footer>Local test page · browser captures must retain the synthetic-fixture label.</footer></html>`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}
