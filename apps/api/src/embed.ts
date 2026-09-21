/**
 * The intake form, as a script a venture site drops in.
 *
 * One `<script>` tag and one container element. No framework, no build step, no CSS file, and
 * nothing that reaches outside the host page: the widget writes into a Shadow DOM so the
 * site's stylesheet cannot restyle a disclosure it did not write, and the widget cannot
 * restyle the site.
 *
 * What it will not do, deliberately:
 *
 * - **Pick a workspace.** It posts to the origin it was served from, and the API resolves the
 *   tenant from the host. There is no configuration for it, so an embedding page cannot point
 *   a form at somebody else's workspace by editing an attribute.
 * - **Write its own disclosure.** The purpose text comes from `GET /public/intake/form` and is
 *   rendered as text. A host page that could supply its own wording could promise anything in
 *   this system's name; a host page that could style it could hide it.
 * - **Pre-tick anything.** Asking for a check is not agreeing to be marketed to, and the form
 *   has no marketing checkbox at all — not an unticked one.
 */

const SCRIPT = String.raw`
(function () {
  'use strict';

  // The origin this script came from is the origin it talks to. Deriving it from the script
  // element rather than accepting a parameter means an embedding page cannot redirect
  // submissions elsewhere, and cannot point this form at another workspace.
  var self = document.currentScript;
  var origin = new URL(self.src, location.href).origin;
  var mount = document.querySelector(self.getAttribute('data-target') || '#consistency-scan');
  if (!mount) return;

  var root = mount.attachShadow ? mount.attachShadow({ mode: 'open' }) : mount;
  var style = document.createElement('style');
  style.textContent = [
    ':host, .w { all: initial; font: 16px/1.6 system-ui, sans-serif; color: #16191d; display: block; }',
    '.w * { box-sizing: border-box; font: inherit; color: inherit; }',
    '.w { max-width: 34rem; }',
    '.w h2 { font-size: 1.15rem; margin: 0 0 .5rem; font-weight: 600; }',
    '.w p { margin: 0 0 1rem; }',
    '.w .scope { font-size: .9rem; color: #4a5158; border-left: 3px solid #dfe4e9; padding-left: .9rem; }',
    '.w label { display: block; font-size: .85rem; font-weight: 600; margin: .9rem 0 .25rem; }',
    '.w input, .w textarea { width: 100%; padding: .55rem .7rem; border: 1px solid #b6bfc9; border-radius: 4px; background: #fff; }',
    '.w textarea { min-height: 4.5rem; resize: vertical; }',
    '.w button { margin-top: 1rem; padding: .6rem 1.1rem; border: 1px solid #16191d; border-radius: 4px; background: #16191d; color: #fff; cursor: pointer; }',
    '.w button[disabled] { opacity: .5; cursor: default; }',
    '.w .msg { margin-top: 1rem; padding: .7rem .9rem; border-radius: 4px; font-size: .92rem; }',
    '.w .msg.bad { background: #fbeceb; }',
    '.w .msg.ok { background: #e9f3ef; }',
  ].join('\n');
  root.appendChild(style);

  var el = document.createElement('div');
  el.className = 'w';
  root.appendChild(el);

  function text(tag, value, cls) {
    var node = document.createElement(tag);
    // textContent, never innerHTML: everything below either came from the API or from the
    // person typing, and neither is markup.
    node.textContent = value;
    if (cls) node.className = cls;
    return node;
  }

  function say(message, ok) {
    var old = el.querySelector('.msg');
    if (old) old.remove();
    el.appendChild(text('div', message, 'msg ' + (ok ? 'ok' : 'bad')));
  }

  fetch(origin + '/public/intake/form', { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('unavailable')); })
    .then(render)
    .catch(function () {
      // A form that cannot state its own scope does not render. Showing input fields without
      // the disclosure would collect an address under terms nobody was shown.
      el.appendChild(text('p', 'This form is not available right now.'));
    });

  function render(form) {
    el.appendChild(text('h2', 'Request a check'));
    el.appendChild(text('p', 'We will look at one page and tell you what we observed.'));
    el.appendChild(text('p', form.purpose_text, 'scope'));

    var fields = [
      ['target_url', 'The page to check', 'input', 'https://'],
      ['contact_email', 'Where to send the result', 'input', 'you@example.com'],
      ['purpose', 'What made you ask', 'textarea', ''],
      ['authority_claim', 'Your connection to this site', 'textarea', ''],
    ];
    var inputs = {};
    fields.forEach(function (f) {
      var id = 'cs-' + f[0];
      var label = text('label', f[1]);
      label.setAttribute('for', id);
      var input = document.createElement(f[2]);
      input.id = id;
      input.name = f[0];
      if (f[3]) input.placeholder = f[3];
      if (f[0] === 'contact_email') input.type = 'email';
      inputs[f[0]] = input;
      el.appendChild(label);
      el.appendChild(input);
    });

    var button = text('button', 'Request a check');
    button.type = 'button';
    el.appendChild(button);
    el.appendChild(
      text(
        'p',
        'We use your address to send you this result and nothing else. Asking for a check does not sign you up for anything.',
        'scope',
      ),
    );

    button.addEventListener('click', function () {
      button.disabled = true;
      var payload = {
        target_url: inputs.target_url.value.trim(),
        contact_email: inputs.contact_email.value.trim(),
        purpose: inputs.purpose.value.trim(),
        authority_claim: inputs.authority_claim.value.trim(),
        requested_detectors: form.allowed_detectors.slice(0, 2),
      };
      fetch(origin + '/public/intake', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (result) {
          if (!result.ok) {
            button.disabled = false;
            // The API's own sentence, which is written for a person and says nothing about
            // this system's internals.
            say(result.body.detail || 'That request could not be accepted.', false);
            return;
          }
          el.textContent = '';
          el.appendChild(text('h2', 'Check your inbox'));
          el.appendChild(
            text('p', 'We sent a six-digit code to confirm the address you gave. It is good for ten minutes.'),
          );
          if (result.body.local_verification_code) {
            // Only ever present under the local fixture channel, which sends nothing. A
            // deployed build has no channel that returns a code, so this never renders there.
            el.appendChild(
              text('p', 'Local fixture: the code is ' + result.body.local_verification_code, 'scope'),
            );
          }
        })
        .catch(function () {
          button.disabled = false;
          say('That request could not be sent. Check your connection and try again.', false);
        });
    });
  }
})();
`;

export const EMBED_SCRIPT = SCRIPT;

/**
 * The embed is a script, so its own CSP is about what the *script* may do if the page it
 * lands on has none of its own. `sandbox` is not usable here — it would break the host page —
 * so the protections that matter are the ones inside the script: Shadow DOM, `textContent`
 * everywhere, and an origin derived rather than configured.
 */
export const EMBED_CACHE_CONTROL = 'public, max-age=300';
