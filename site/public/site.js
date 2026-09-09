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

// Scroll-in animation is handled entirely in CSS with a scroll-driven
// animation, so nothing here needs to run for the page to be readable.

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
