// render.js — turn talk text (markdown + LaTeX) into safe HTML for the cards.
//
// The extracted data mixes three things:
//   - plain prose
//   - properly delimited math: $E_1$, $\phi: E_1 \to E_2$
//   - BARE, undelimited LaTeX in prose: \mathbb{Z}^n, \Lambda_p  (the model didn't wrap it)
//
// Pipeline per field: protect $...$ math -> auto-wrap stray \commands -> markdown-it
// (which HTML-escapes untrusted text for us) -> swap math placeholders for KaTeX HTML.

import MarkdownIt from 'markdown-it';
import katex from 'katex';
import 'katex/dist/katex.min.css';

const md = new MarkdownIt({
  html: false, // never emit raw HTML from the (LLM-generated) source — escape it
  linkify: true,
  breaks: false,
});

// A bare LaTeX token like \mathbb{Z}^n, \Lambda_p, \to, possibly followed by ^.. / _.. / {..}.
// Deliberately conservative: must start with a backslash-command so ordinary prose is untouched.
const BARE_LATEX = /\\[a-zA-Z]+(?:\s*[_^]\s*(?:\{[^}]*\}|[A-Za-z0-9]))*(?:\{[^}]*\})?/g;

// Placeholder that survives markdown rendering untouched: alphanumeric only (no
// markdown-special chars), no whitespace dependency, unlikely to appear in real prose.
const PLACEHOLDER = (i) => `xkatexmathx${i}xendx`;
const PLACEHOLDER_RE = /xkatexmathx(\d+)xendx/g;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderMathSafely(tex, displayMode) {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false, // bad LaTeX -> rendered in error color, never crashes the page
    });
  } catch {
    return escapeHtml(tex);
  }
}

/**
 * Render a markdown+LaTeX string to safe HTML.
 * @param {string|null|undefined} text
 * @param {{inline?: boolean}} [opts] inline = render without wrapping <p> (for titles)
 * @returns {string} HTML
 */
export function renderRich(text, opts = {}) {
  if (text == null) return '';
  let src = String(text);

  const mathSpans = [];
  const stash = (tex, displayMode) => {
    const i = mathSpans.length;
    mathSpans.push(renderMathSafely(tex, displayMode));
    return PLACEHOLDER(i);
  };

  // 1. Protect explicitly delimited math first, so auto-wrap can't touch its innards.
  src = src.replace(/\$\$([^$]+)\$\$/g, (_, tex) => stash(tex.trim(), true));
  src = src.replace(/\$([^$\n]+)\$/g, (_, tex) => stash(tex.trim(), false));

  // 2. Auto-wrap remaining BARE LaTeX commands sitting in plain prose.
  src = src.replace(BARE_LATEX, (m) => stash(m, false));

  // 3. Markdown-render (HTML-escapes the surrounding prose for us).
  let html = opts.inline ? md.renderInline(src) : md.render(src);

  // 4. Swap placeholders back for KaTeX HTML.
  html = html.replace(PLACEHOLDER_RE, (_, i) => mathSpans[Number(i)] ?? '');
  return html;
}
