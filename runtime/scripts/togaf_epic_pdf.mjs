// TOGAF EPIC — md → HTML (mermaid-aware, table-aware) → PDF via the system
// browser's headless print (same zero-dependency approach as the LONGVIEW
// book's lib/book_pdf.mjs, extended with: markdown tables, ```mermaid fences
// rendered to REAL SVG diagrams by the vendored mermaid.min.js, and a
// dump-dom validation pass that counts rendered <svg> elements so a silently
// broken diagram fails the build instead of shipping as an empty box.
//
// Usage: node scripts/togaf_epic_pdf.mjs <in.md> <out.pdf> [--html out.html]
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERMAID = path.join(HERE, "vendor", "mermaid.min.js");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

function mdToHtml(md, title) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let mode = null; // null | 'code' | 'mermaid' | 'table' | 'list'
  let mermaidCount = 0;
  const close = () => {
    if (mode === "list") out.push("</ul>");
    if (mode === "table") out.push("</tbody></table>");
    mode = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (mode === "code" || mode === "mermaid") {
      if (line.trim().startsWith("```")) {
        out.push(mode === "mermaid" ? "</pre>" : "</code></pre>");
        mode = null;
      } else {
        out.push(mode === "mermaid" ? line : esc(line));
      }
      continue;
    }
    const fence = /^```(\w*)/.exec(line.trim());
    if (fence) {
      close();
      if (fence[1] === "mermaid") {
        mermaidCount++;
        out.push('<pre class="mermaid">');
        mode = "mermaid";
      } else {
        out.push("<pre><code>");
        mode = "code";
      }
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      if (mode !== "table") {
        close();
        out.push('<table><thead><tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>");
        mode = "table";
      } else {
        out.push("<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      }
      continue;
    }
    if (mode === "table") close();
    if (/^# /.test(line)) { close(); out.push(`<h1>${inline(line.slice(2))}</h1>`); }
    else if (/^## /.test(line)) { close(); out.push(`<h2 class="chapter">${inline(line.slice(3))}</h2>`); }
    else if (/^### /.test(line)) { close(); out.push(`<h3>${inline(line.slice(4))}</h3>`); }
    else if (/^---+\s*$/.test(line)) { close(); out.push("<hr/>"); }
    else if (/^\s*[-*] /.test(line)) {
      if (mode !== "list") { close(); out.push("<ul>"); mode = "list"; }
      out.push(`<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`);
    } else if (/^> /.test(line)) { close(); out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); }
    else if (line.trim() === "") { close(); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  const mermaidSrc = fs.readFileSync(MERMAID, "utf8");
  return {
    mermaidCount,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font:11.5pt/1.55 Georgia,'Times New Roman',serif;color:#16202b;max-width:180mm;margin:0 auto;padding:10mm 0}
  h1{font-size:22pt;line-height:1.2;border-bottom:3px solid #16202b;padding-bottom:6pt}
  h2.chapter{font-size:15pt;page-break-before:always;border-bottom:1px solid #9aa7b5;padding-bottom:4pt;margin-top:0}
  h3{font-size:12.5pt;color:#26445e}
  pre{background:#f4f6f9;border:1px solid #dde3ec;border-radius:6px;padding:8px;font:8.5pt/1.4 Consolas,monospace;white-space:pre-wrap;word-break:break-word}
  pre.mermaid{background:#fff;border:none;text-align:center;page-break-inside:avoid}
  pre.mermaid svg{max-width:100%;height:auto}
  table{border-collapse:collapse;width:100%;font-size:9.5pt;page-break-inside:avoid}
  th,td{border:1px solid #c8d1dd;padding:4px 7px;text-align:left}
  th{background:#eef1f6}
  blockquote{border-left:3px solid #9aa7b5;margin:8px 0;padding:2px 12px;color:#4a5a6b;font-style:italic}
  code{background:#f0f3f7;padding:0 3px;border-radius:3px;font:0.9em Consolas,monospace}
  hr{border:none;border-top:1px solid #c8d1dd;margin:14px 0}
  @page{margin:16mm 14mm}
</style>
<script>${mermaidSrc}</script>
</head><body>
${out.join("\n")}
<script>
  mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "loose" });
  (async () => {
    try { await mermaid.run({ querySelector: "pre.mermaid" }); } catch (e) { /* per-diagram errors leave the code visible */ }
    document.body.setAttribute("data-mermaid-done", "1");
  })();
</script>
</body></html>`
  };
}

function findBrowser() {
  for (const p of [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ]) if (fs.existsSync(p)) return p;
  return null;
}

const [mdPath, pdfPath] = process.argv.slice(2);
if (!mdPath || !pdfPath) { console.error("usage: node togaf_epic_pdf.mjs <in.md> <out.pdf> [--html out.html]"); process.exit(2); }
const htmlFlag = process.argv.indexOf("--html");
const htmlPath = htmlFlag > 0 ? process.argv[htmlFlag + 1] : pdfPath.replace(/\.pdf$/i, ".html");

const md = fs.readFileSync(mdPath, "utf8");
const { html, mermaidCount } = mdToHtml(md, path.basename(mdPath));
fs.writeFileSync(htmlPath, html);

const browser = findBrowser();
if (!browser) { console.error("no Edge/Chrome found for headless print"); process.exit(3); }
const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");

// 1. VALIDATION: dump the rendered DOM and count real <svg> diagrams.
const dump = spawnSync(browser, [
  "--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=30000",
  "--dump-dom", fileUrl
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
const svgCount = (dump.stdout.match(/<svg[^>]*aria-roledescription/g) || []).length;
const errCount = (dump.stdout.match(/aria-roledescription="error"/g) || []).length;

// 2. PRINT to PDF (same virtual-time budget so diagrams are painted).
const print = spawnSync(browser, [
  "--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=30000",
  `--print-to-pdf=${pdfPath}`, "--no-pdf-header-footer", fileUrl
], { encoding: "utf8", timeout: 180000 });

const printed = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 10000;
// ok = the GATE verdict, not just "a pdf exists": every mermaid block must
// have rendered as a real, non-error SVG.
const ok = printed && errCount === 0 && svgCount >= mermaidCount;
const result = {
  ok,
  printed,
  pdf: pdfPath,
  pdf_bytes: ok ? fs.statSync(pdfPath).size : 0,
  html: htmlPath,
  mermaid_blocks: mermaidCount,
  svg_rendered: svgCount,
  svg_errors: errCount,
  browser: path.basename(browser)
};
console.log(JSON.stringify(result));
process.exit(ok ? 0 : 1);
