import { describe, expect, it } from 'vitest';
import { extractDeclaredImages, extractPageText } from '@oe/capture';

/**
 * What a recorded page said, read out of the HTML rather than a live DOM.
 *
 * The undisclosed-region detection is the part that matters most: it is the only reason
 * CE-CONTENT-01 is allowed to say "not stated" at all. A page that hides its materials behind
 * a tab and a rule that cannot see the tab would together produce a confident false accusation,
 * which is the exact failure this whole system is arranged to avoid.
 */

describe('extractPageText', () => {
  it('reads the text a person would see, and not the parts they would not', () => {
    const { text } = extractPageText(`
      <html><head><style>.price{color:red}</style>
      <script>var material = "silk";</script></head>
      <body><main><h1>Everyday overshirt</h1>
      <p>Material: 80% Baumwolle</p></main></body></html>
    `);
    expect(text).toContain('Everyday overshirt');
    expect(text).toContain('Material: 80% Baumwolle');
    // A fibre content that only exists in a script was never shown to anybody.
    expect(text).not.toContain('silk');
    expect(text).not.toContain('color:red');
  });

  it('decodes the entities a German page is full of', () => {
    const { text } = extractPageText('<p>Gr&ouml;&szlig;entabelle &amp; R&uuml;ckgabe</p>');
    expect(text).toBe('Größentabelle & Rückgabe');
  });

  it('does not let a doubly-encoded entity decode into a tag', () => {
    const { text } = extractPageText('<p>&amp;lt;script&amp;gt;</p>');
    expect(text).toBe('&lt;script&gt;');
  });

  it('reports nothing undisclosed on a plain page', () => {
    const { undisclosedRegions } = extractPageText('<main><p>Material: wool</p></main>');
    expect(undisclosedRegions).toEqual([]);
  });

  it('notices a disclosure control with nothing behind it', () => {
    const { undisclosedRegions } = extractPageText(
      '<main><details><summary>Material &amp; care</summary></details></main>',
    );
    expect(undisclosedRegions).toEqual(['empty <details> region']);
  });

  it('accepts a details region that actually contains its content', () => {
    const page = extractPageText(
      '<main><details><summary>Material</summary><p>80% Baumwolle</p></details></main>',
    );
    expect(page.undisclosedRegions).toEqual([]);
    expect(page.text).toContain('80% Baumwolle');
  });

  it('notices markup that says a region arrives later', () => {
    const { undisclosedRegions } = extractPageText(
      '<main><div data-lazy="/fragments/materials"></div></main>',
    );
    expect(undisclosedRegions).toEqual(['region declared as loaded on demand']);
  });

  it('notices a tab pointing at a panel that is not in the capture', () => {
    const { undisclosedRegions } = extractPageText(
      '<main><button aria-controls="tab-materials">Material</button></main>',
    );
    expect(undisclosedRegions).toEqual(['tab panel "tab-materials" not present in the capture']);
  });

  it('accepts a tab whose panel is present', () => {
    const { undisclosedRegions } = extractPageText(
      `<main><button aria-controls="tab-materials">Material</button>
       <div id="tab-materials"><p>80% Baumwolle</p></div></main>`,
    );
    expect(undisclosedRegions).toEqual([]);
  });

  it('matches a panel id literally, not as a pattern', () => {
    // An id with regex metacharacters must not accidentally match something else, and must
    // not throw. Both would be silent: one hides a real gap, the other loses the whole page.
    const { undisclosedRegions } = extractPageText(
      '<main><button aria-controls="tab.materials[1]">Material</button></main>',
    );
    expect(undisclosedRegions).toEqual(['tab panel "tab.materials[1]" not present in the capture']);
  });

  it('reports each kind of gap once, however many times it occurs', () => {
    const { undisclosedRegions } = extractPageText(
      '<main><details></details><details></details></main>',
    );
    expect(undisclosedRegions).toEqual(['empty <details> region']);
  });
});

describe('extractDeclaredImages', () => {
  it('reads what the page declared about each image', () => {
    const images = extractDeclaredImages(
      `<main><img src="/img/front.png" alt="Everyday overshirt, front view" width="480">
       <img src='/img/back.png' alt='back view'></main>`,
    );
    expect(images).toEqual([
      { src: '/img/front.png', alt: 'Everyday overshirt, front view', decorative: false },
      { src: '/img/back.png', alt: 'back view', decorative: false },
    ]);
  });

  it('leaves out chrome that is on the page but is not the product', () => {
    // Counting a logo and a payment badge would inflate every count and hide a page with no
    // product photography at all.
    const images = extractDeclaredImages(
      `<header><img src="/logo.svg" alt="Atelier Nord"></header>
       <main><img src="/img/front.png" alt="front view"></main>
       <footer><img src="/visa.svg" alt="Visa"></footer>`,
    );
    expect(images.map((image) => image.src)).toEqual(['/img/front.png']);
  });

  it('falls back sensibly when the page has no content landmark', () => {
    const images = extractDeclaredImages(
      `<header><img src="/logo.svg" alt="Atelier Nord"></header>
       <div><img src="/img/front.png" alt="front view"></div>`,
    );
    expect(images.map((image) => image.src)).toEqual(['/img/front.png']);
  });

  it('takes the page at its word about decoration', () => {
    const images = extractDeclaredImages(
      `<main><img src="/img/a.png" alt="" role="presentation">
       <img src="/img/b.png" alt=""></main>`,
    );
    expect(images.every((image) => image.decorative)).toBe(true);
  });

  it('treats a missing alt attribute as a product image with nothing said about it', () => {
    // Different from `alt=""`. One is "this is decoration"; the other is an omission, which is
    // CE-ASSET-01's business and must not quietly remove the image from the count here.
    const images = extractDeclaredImages('<main><img src="/img/a.png"></main>');
    expect(images).toEqual([{ src: '/img/a.png', alt: '', decorative: false }]);
  });

  it('reads a lazily-declared source when there is no plain one', () => {
    const images = extractDeclaredImages('<main><img data-src="/img/a.png" alt="front"></main>');
    expect(images.map((image) => image.src)).toEqual(['/img/a.png']);
  });

  it('ignores an img with no source at all', () => {
    expect(extractDeclaredImages('<main><img alt="front"></main>')).toEqual([]);
  });
});
