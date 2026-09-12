// Docs search: one fetch of a 32 KB index, then matching in the page.
//
// No server and no search library. At a hundred sections a linear scan
// finishes well inside a frame, so the simplest thing that works is
// also the fastest thing available.

const overlay = document.querySelector('[data-search]');
if (overlay) {
  const input = overlay.querySelector('[data-search-input]');
  const list = overlay.querySelector('[data-search-results]');
  const status = overlay.querySelector('[data-search-status]');
  const openers = document.querySelectorAll('[data-search-open]');

  let index = null;
  let loading = null;
  let active = -1;
  let results = [];

  const loadIndex = () => {
    if (index) return Promise.resolve(index);
    loading ??= fetch('/search-index.json')
      .then((r) => r.json())
      .then((data) => (index = data))
      .catch(() => (index = []));
    return loading;
  };

  /* ---------- matching ---------- */

  // Every word must appear somewhere in the section. Scored so a hit
  // in a heading outranks one buried in a paragraph — someone typing
  // "keyed" wants the section about keys, not every page mentioning
  // the word in passing.
  // Whether the term appears as its own word rather than inside a
  // longer one. Searching "bind" should find the section about bind:
  // before every page that mentions "binding".
  const wholeWord = (haystack, word) =>
    new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(haystack);

  const score = (entry, words) => {
    const heading = (entry.heading ?? entry.title).toLowerCase();
    const title = entry.title.toLowerCase();
    const text = entry.text.toLowerCase();
    // The API names this section is about, which are often not words
    // in its heading: "Two-way inputs" is the section about bind:.
    const keywords = (entry.keywords ?? []).join(' ').toLowerCase();

    let total = 0;

    for (const word of words) {
      const inHeading = heading.includes(word);
      const inTitle = title.includes(word);
      const inKeywords = keywords.includes(word);
      const at = text.indexOf(word);

      // Every word has to appear somewhere, or this is not a match.
      if (!inHeading && !inTitle && !inKeywords && at === -1) return 0;

      // A keyword match is close to a heading match: it means the
      // section is about that API, not merely mentions it.
      if (inKeywords) total += wholeWord(keywords, word) ? 70 : 30;

      if (inHeading) {
        // An exact heading is the strongest signal there is: someone
        // typing "onmount" wants the onMount section.
        if (heading === word) total += 140;
        else if (wholeWord(heading, word)) total += heading.startsWith(word) ? 80 : 55;
        else total += 18;
      } else if (inTitle) {
        total += wholeWord(title, word) ? 20 : 8;
      }

      if (at !== -1) {
        const whole = wholeWord(text, word);
        total += (whole ? 10 : 3) + (at < 120 ? 4 : 0);
      }
    }

    // A section is a better answer than a whole page, and a top-level
    // section a better one than a subsection beneath it.
    if (entry.heading) total += entry.level === 3 ? 3 : 8;
    return total;
  };

  const search = (query) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    return (index ?? [])
      .map((entry) => ({ entry, score: score(entry, words) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((hit) => hit.entry);
  };

  /* ---------- rendering ---------- */

  const escapeHtml = (text) =>
    text.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);

  // An excerpt centred on the first match, so the result shows why it
  // matched rather than always the opening sentence.
  const excerpt = (text, words) => {
    const lower = text.toLowerCase();
    let at = -1;
    for (const word of words) {
      const found = lower.indexOf(word);
      if (found !== -1 && (at === -1 || found < at)) at = found;
    }

    const from = at > 70 ? Math.max(0, at - 55) : 0;
    const slice = text.slice(from, from + 150);
    const safe = escapeHtml((from ? '…' : '') + slice + (from + 150 < text.length ? '…' : ''));

    // Mark each term. Escaped first, so nothing from the index can
    // introduce markup of its own.
    return words.reduce(
      (out, word) =>
        out.replace(new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>'),
      safe
    );
  };

  const render = (query) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    list.innerHTML = '';
    active = -1;

    if (!query.trim()) {
      status.textContent = 'Type to search the documentation.';
      return;
    }

    if (!results.length) {
      status.textContent = `Nothing matches “${query}”.`;
      return;
    }

    status.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;

    for (const [i, entry] of results.entries()) {
      const item = document.createElement('li');
      const link = document.createElement('a');

      link.href = entry.url;
      link.dataset.index = String(i);
      link.innerHTML = `
        <span class="search-result-title">${escapeHtml(entry.heading ?? entry.title)}</span>
        <span class="search-result-page">${escapeHtml(entry.title)}</span>
        <span class="search-result-text">${excerpt(entry.text, words)}</span>
      `;

      item.appendChild(link);
      list.appendChild(item);
    }
  };

  const highlight = (next) => {
    const links = [...list.querySelectorAll('a')];
    if (!links.length) return;

    active = (next + links.length) % links.length;
    for (const [i, link] of links.entries()) link.dataset.active = String(i === active);
    links[active].scrollIntoView({ block: 'nearest' });
  };

  /* ---------- opening and closing ---------- */

  const open = async () => {
    overlay.dataset.open = 'true';
    document.body.style.overflow = 'hidden';
    input.value = '';
    results = [];
    render('');
    input.focus();
    await loadIndex();
  };

  const close = () => {
    overlay.dataset.open = 'false';
    document.body.style.overflow = '';
  };

  for (const opener of openers) opener.addEventListener('click', open);

  overlay.addEventListener('click', (event) => {
    // Clicking the backdrop, but not the panel itself.
    if (event.target === overlay) close();
  });

  input.addEventListener('input', () => {
    results = search(input.value);
    render(input.value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlight(active + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(active - 1);
    } else if (event.key === 'Enter') {
      const links = list.querySelectorAll('a');
      const target = links[active === -1 ? 0 : active];
      if (target) {
        event.preventDefault();
        target.click();
      }
    }
  });

  list.addEventListener('click', (event) => {
    if (event.target.closest('a')) close();
  });

  // With the client-side router the click is intercepted and the page
  // swaps without a reload, so the dialog would otherwise stay open
  // over the result it just opened.
  document.addEventListener('azox:navigate', close);

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');

    // "/" is the convention for search, and cmd-K is what most people
    // reach for now. Neither should fire while typing somewhere else.
    if (!typing && (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key === 'k'))) {
      event.preventDefault();
      open();
      return;
    }

    if (event.key === 'Escape' && overlay.dataset.open === 'true') {
      close();
    }
  });

  // Warm the index when the pointer reaches the button, so the first
  // keystroke has something to search.
  for (const opener of openers) {
    opener.addEventListener('pointerenter', loadIndex, { once: true });
  }
}
