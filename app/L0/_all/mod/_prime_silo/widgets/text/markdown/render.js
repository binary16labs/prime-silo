// ADR-001 Phase C — minimal Markdown renderer.
//
// Deliberately tiny so the first migrated widget pulls zero dependencies
// into the shell. Covers the common subset Prime-Silo notes need:
//
//   • ATX headings (#, ##, ### up to ######)
//   • paragraphs separated by blank lines
//   • inline emphasis: **strong**, *em*, `code`
//   • inline links: [text](url) — http/https/relative paths only
//   • unordered lists: - or * at the start of a line
//   • fenced code blocks: ```lang\n...\n```
//   • horizontal rules: --- on their own line
//
// Anything richer (tables, footnotes, MDX) waits until we can justify the
// dependency. The renderer is a pure function and lives in its own module
// so the widget tests can call it without booting any DOM.

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Inline emphasis is applied AFTER escaping. We re-introduce <strong>, <em>,
// <code>, <a> by recognising the (now-escaped) marker characters.
function renderInline(escaped) {
  // Code spans win — content inside backticks is not further interpreted.
  let out = escaped.replace(/`([^`]+)`/g, (_match, body) => `<code>${body}</code>`);

  // Links: [text](href). href limited to http(s)/relative to dodge javascript:.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, href) => {
    if (!isSafeHref(href)) {
      return match;
    }
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // **strong** (must come before *em* to avoid greedy collisions).
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // *em*
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

  return out;
}

function isSafeHref(href) {
  if (/^https?:\/\//i.test(href)) {
    return true;
  }
  if (/^\//.test(href) || /^\.\.?\//.test(href) || /^[\w./-]+$/.test(href)) {
    return true;
  }
  return false;
}

function flushParagraph(buffer, lines) {
  if (buffer.length === 0) {
    return;
  }
  const escaped = escapeHtml(buffer.join(" "));
  lines.push(`<p>${renderInline(escaped)}</p>`);
  buffer.length = 0;
}

function flushList(items, lines) {
  if (items.length === 0) {
    return;
  }
  const rendered = items
    .map((item) => `<li>${renderInline(escapeHtml(item))}</li>`)
    .join("");
  lines.push(`<ul>${rendered}</ul>`);
  items.length = 0;
}

/**
 * Render the markdown text to a sanitised HTML string.
 * The output is meant to be assigned to `innerHTML` on a host element. Every
 * piece of input text is HTML-escaped before any of our markup is added, so
 * it is safe to pass author-controlled content through.
 *
 * @param {string} markdown
 * @returns {string} HTML
 */
export function renderMarkdown(markdown) {
  if (!markdown) {
    return "";
  }

  const rawLines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const para = [];
  const listItems = [];
  let inFence = false;
  let fenceLang = "";
  let fenceBuffer = [];

  for (const rawLine of rawLines) {
    if (inFence) {
      if (/^```\s*$/.test(rawLine)) {
        const body = escapeHtml(fenceBuffer.join("\n"));
        const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : "";
        out.push(`<pre><code${langClass}>${body}</code></pre>`);
        fenceBuffer = [];
        fenceLang = "";
        inFence = false;
      } else {
        fenceBuffer.push(rawLine);
      }
      continue;
    }

    const fenceOpen = rawLine.match(/^```\s*([\w-]*)\s*$/);
    if (fenceOpen) {
      flushParagraph(para, out);
      flushList(listItems, out);
      inFence = true;
      fenceLang = fenceOpen[1] || "";
      continue;
    }

    if (/^---\s*$/.test(rawLine)) {
      flushParagraph(para, out);
      flushList(listItems, out);
      out.push("<hr />");
      continue;
    }

    const heading = rawLine.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(para, out);
      flushList(listItems, out);
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    const listMatch = rawLine.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      flushParagraph(para, out);
      listItems.push(listMatch[1]);
      continue;
    }

    if (/^\s*$/.test(rawLine)) {
      flushParagraph(para, out);
      flushList(listItems, out);
      continue;
    }

    flushList(listItems, out);
    para.push(rawLine.trim());
  }

  if (inFence) {
    // Unclosed fence — emit what we have so the user sees their content.
    const body = escapeHtml(fenceBuffer.join("\n"));
    const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : "";
    out.push(`<pre><code${langClass}>${body}</code></pre>`);
  }

  flushParagraph(para, out);
  flushList(listItems, out);

  return out.join("\n");
}

export const __testing = {
  escapeHtml,
  renderInline,
  isSafeHref
};
