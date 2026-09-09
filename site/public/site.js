// Site behaviour that is not part of any page's reactive state:
// copying snippets, and downloading a whole example as a file.
//
// Kept as a plain script rather than an Azox page, because it acts on
// markup produced by many different pages.

const FEEDBACK_MS = 1400;

function flash(button, message) {
  const original = button.textContent;
  button.textContent = message;
  button.dataset.copied = 'true';

  setTimeout(() => {
    button.textContent = original;
    delete button.dataset.copied;
  }, FEEDBACK_MS);
}

async function copyText(text, button) {
  try {
    // The async clipboard API needs a secure context, which rules out
    // plain http:// on a LAN address during development.
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    flash(button, 'Copied');
  } catch {
    flash(button, 'Press ⌘C');
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy], [data-copy-text]');
  if (!button) return;

  // Either the text is given directly, or it comes from the <pre>
  // inside the same code block.
  const explicit = button.dataset.copyText;
  const block = button.closest('.code, .pg-pane');
  const source = explicit ?? block?.querySelector('pre, textarea')?.textContent ?? '';

  if (source) copyText(source, button);
});

// Scroll-in animation is handled entirely in CSS, so nothing here
// needs to run for the page to be readable.

// A light that follows the pointer across a card. Purely decorative:
// the CSS defaults to a centred position, so a card looks correct
// before this runs and if it never runs at all.
//
// Skipped on coarse pointers, where there is no hover to follow, and
// when the visitor has asked for less motion.
const wantsMotion = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const hasFinePointer = window.matchMedia?.('(pointer: fine)').matches ?? false;

if (wantsMotion && hasFinePointer) {
  let queued = null;

  // Coalesced into one frame: pointermove fires far more often than
  // the screen refreshes, and writing a custom property on every
  // event would be wasted work.
  const apply = () => {
    if (!queued) return;
    const { card, x, y } = queued;
    queued = null;

    card.style.setProperty('--mx', `${x}%`);
    card.style.setProperty('--my', `${y}%`);
  };

  document.addEventListener(
    'pointermove',
    (event) => {
      const card = event.target.closest?.('.card');
      if (!card) return;

      const box = card.getBoundingClientRect();
      const wasQueued = queued !== null;

      queued = {
        card,
        x: ((event.clientX - box.left) / box.width) * 100,
        y: ((event.clientY - box.top) / box.height) * 100,
      };

      if (!wasQueued) requestAnimationFrame(apply);
    },
    { passive: true }
  );
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-download]');
  if (!button) return;

  const block = button.closest('.code, .pg-pane');
  const content = block?.querySelector('pre, textarea')?.textContent ?? '';
  if (!content) return;

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = button.dataset.download || 'snippet.txt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  flash(button, 'Saved');
});
