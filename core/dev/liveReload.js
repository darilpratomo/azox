// The snippet injected into pages served by `azox dev`. It is never
// written to disk by `azox compile`, so production output stays free
// of dev machinery.

import { RELOAD_PATH } from './server.js';

const SNIPPET = `<script>
  (() => {
    const source = new EventSource('${RELOAD_PATH}');
    source.addEventListener('reload', () => location.reload());
    // Losing the connection means the dev server stopped; EventSource
    // retries on its own, so the page reloads when it comes back.
  })();
</script>`;

export function injectLiveReload(html) {
  return html.includes('</body>')
    ? html.replace('</body>', `${SNIPPET}\n</body>`)
    : html + SNIPPET;
}
