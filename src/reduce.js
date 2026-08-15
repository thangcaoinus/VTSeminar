// reduce.js — HTML -> clean main-content text, BEFORE the LLM sees it.
//
// Cuts tokens and improves extraction accuracy. Never feed raw HTML to the model.
//
// Two paths:
//   - Single-article-ish pages: @mozilla/readability (finds the one main article).
//   - MULTI-TALK LIST pages: Readability collapses all talks into one blob and destroys
//     the per-talk segmentation — the spec's #1 failure mode. For those we use a
//     structure-preserving reducer that keeps headings and block boundaries so per-talk
//     delimiters (e.g. `<h3>Speaker: …</h3>`) survive into the reduced text.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

// Block-level tags whose boundaries we preserve as newlines in the structure path.
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'li', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'br', 'table', 'ul', 'ol',
]);
const STRIP_TAGS = ['script', 'style', 'noscript', 'nav', 'footer', 'iframe', 'svg'];

/**
 * Heuristic: does this page list many talks (so Readability would flatten it)?
 * Counts repeated heading blocks and speaker/date markers.
 */
function isMultiTalkPage(document) {
  const headings = document.querySelectorAll('h2, h3, h4');
  let headingCount = headings.length;
  const bodyText = document.body?.textContent ?? '';
  const speakerMatches = (bodyText.match(/\bspeaker\b/gi) || []).length;
  // Either many section headings, or several explicit "Speaker" markers -> it's a list.
  return headingCount >= 3 || speakerMatches >= 3;
}

/**
 * Structure-preserving reduction: strip junk, then serialize block elements
 * newline-delimited so headings and per-talk boundaries survive.
 */
function reduceStructure(document) {
  for (const tag of STRIP_TAGS) {
    for (const el of document.querySelectorAll(tag)) el.remove();
  }
  const root = document.body ?? document.documentElement;
  const lines = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        // text node
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (t) lines.push(t);
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) lines.push('\n');
        walk(child);
        if (isBlock) lines.push('\n');
      }
    }
  };
  walk(root);
  // Collapse runs of blank lines, trim each line.
  return lines
    .join(' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .trim();
}

/**
 * Reduce raw HTML to clean main-content text.
 * @param {string} html
 * @param {string} url  used as the document base URL for Readability
 * @returns {string} clean text
 */
export function reduceHtml(html, url) {
  const dom = new JSDOM(html, { url });
  const { document } = dom.window;

  if (isMultiTalkPage(document)) {
    const structured = reduceStructure(document);
    if (structured) return structured;
  }

  // Single-article path: Readability finds the main article.
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (article && article.textContent && article.textContent.trim()) {
    return article.textContent.trim();
  }

  // Last-resort fallback.
  return document.body?.textContent?.trim() ?? '';
}
