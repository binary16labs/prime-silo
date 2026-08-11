// EP-A agent runtime — the tool surface (CLI-first; the UI wraps this, never re-implements it).
//
// The tuned policy emits {"name","input"} calls in EITHER dialect (Claude Code: read_file/bash/grep;
// Antigravity: view_file/run_command/grep_search). Both map to the SAME executor here — one surface,
// two vocabularies, exactly as the model was trained. Role gates what runs:
//   • analyst   = read-only navigation of the code + knowledge store (+ finish)
//   • developer = + shell execution (sandboxed to the root; the UI/CLI must opt in)
//
// Every executor returns a short string (the [Tool Result] fed back to the model). Output is capped so
// a huge file/command can't blow the context. Paths resolve inside `root`; escapes are refused.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_OUT = 4000; // chars of tool output fed back per step

const cap = (s) => {
  s = String(s ?? "");
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[+${s.length - MAX_OUT} chars truncated]` : s;
};

// Resolve a model-supplied path safely inside root. The model emits absolute paths: sometimes the
// REAL repo path (c:\…\prime-silo — use directly), sometimes a foreign one from training on other
// machines (f:\optimus\… — strip the drive and nest under root best-effort). Relative paths resolve
// under root. Anything that still escapes root is refused.
// Case-insensitive on Windows (drive letter + path casing); the model often emits lowercase `c:\…`
// while process.cwd() is `C:\…`, so a case-sensitive compare wrongly rejects in-root paths.
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const inside = (root, abs) => norm(abs) === norm(root) || norm(abs).startsWith(norm(root) + path.sep);
function safePath(root, p) {
  if (!p) return null;
  root = path.resolve(root);
  const s = String(p).replace(/\\/g, "/");
  if (path.isAbsolute(s) || /^[a-zA-Z]:\//.test(s)) {
    const asIs = path.resolve(s);
    if (inside(root, asIs)) return asIs; // the model gave the real in-root path
    const rel = s.replace(/^[a-zA-Z]:\//, "").replace(/^\/+/, ""); // foreign absolute -> nest
    const nested = path.resolve(root, rel);
    return inside(root, nested) ? nested : null;
  }
  const abs = path.resolve(root, s);
  return inside(root, abs) ? abs : null;
}

const firstArg = (input, keys) => {
  for (const k of keys) if (input && input[k] != null && input[k] !== "") return input[k];
  return undefined;
};

// name -> {roles, run(input, ctx)}. ctx = { root, allowExec }.
const TOOLS = {
  // ---- read-only navigation (analyst + developer) ----
  read_file: {
    roles: ["analyst", "developer"],
    run(input, { root }) {
      const p = safePath(root, firstArg(input, ["file_path", "AbsolutePath", "path", "TargetFile"]));
      if (!p) return "ERROR: path missing or outside workspace root";
      if (!fs.existsSync(p)) return `ERROR: no such file: ${p}`;
      if (fs.statSync(p).isDirectory()) return `ERROR: is a directory (use list_dir): ${p}`;
      const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
      const start = Number(firstArg(input, ["StartLine", "offset"]) || 1);
      const end = Number(firstArg(input, ["EndLine", "limit"]) || Math.min(lines.length, start + 199));
      const slice = lines.slice(Math.max(0, start - 1), end);
      return cap(slice.map((l, i) => `${start + i}\t${l}`).join("\n"));
    },
  },
  list_dir: {
    roles: ["analyst", "developer"],
    run(input, { root }) {
      const p = safePath(root, firstArg(input, ["DirectoryPath", "path"]) || ".");
      if (!p || !fs.existsSync(p)) return `ERROR: no such directory: ${p}`;
      const entries = fs.readdirSync(p, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name)).sort();
      return cap(entries.join("\n") || "(empty)");
    },
  },
  grep: {
    roles: ["analyst", "developer"],
    run(input, { root }) {
      const pattern = firstArg(input, ["pattern", "Query", "query"]);
      if (!pattern) return "ERROR: pattern missing";
      const where = safePath(root, firstArg(input, ["path", "SearchPath", "Includes"]) || ".") || root;
      if (!where || !fs.existsSync(where)) return `ERROR: no such path: ${where}`;
      let re;
      try { re = new RegExp(String(pattern), "i"); }
      catch { re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      const SKIP = new Set(["node_modules", ".git", "out", "out_ta", "out_p5", "dist", "site"]);
      const hits = [];
      const walk = (dir) => {
        if (hits.length >= 40) return;
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (hits.length >= 40) break;
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(fp); continue; }
          if (/\.(png|jpg|jpeg|gif|pdf|zip|gguf|safetensors|bin|lock)$/i.test(e.name)) continue;
          let txt; try { txt = fs.readFileSync(fp, "utf8"); } catch { continue; }
          txt.split(/\r?\n/).forEach((line, i) => {
            if (hits.length < 40 && re.test(line)) hits.push(`${path.relative(root, fp)}:${i + 1}: ${line.trim().slice(0, 160)}`);
          });
        }
      };
      const stat = fs.statSync(where);
      stat.isDirectory() ? walk(where) : walk(path.dirname(where));
      return cap(hits.join("\n") || "(no matches)");
    },
  },
  // ---- shell execution (developer only, opt-in) ----
  bash: {
    roles: ["developer"],
    run(input, { root, allowExec }) {
      if (!allowExec) return "ERROR: execution not permitted (analyst role / --exec not set)";
      const cmd = firstArg(input, ["command", "CommandLine"]);
      if (!cmd) return "ERROR: command missing";
      if (/192\.168\.68\.125|:1234/.test(cmd)) return "ERROR: refused — LAN LM host is off-limits";
      const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", timeout: 30000,
        maxBuffer: 4 * 1024 * 1024 });
      const out = (r.stdout || "") + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
      return cap(out || `(exit ${r.status})`);
    },
  },
  // ---- terminal / control ----
  finish: {
    roles: ["analyst", "developer"],
    run(input) {
      return `__FINISH__ ${firstArg(input, ["answer", "summary", "text"]) || "done"}`;
    },
  },
};

// Dialect aliases -> canonical tool (both vocabularies the model was trained on).
const ALIASES = {
  view_file: "read_file", read: "read_file", cat: "read_file",
  run_command: "bash", powershell: "bash", shell: "bash",
  grep_search: "grep", search: "grep", ripgrep: "grep",
  list: "list_dir", ls: "list_dir", dir: "list_dir",
  done: "finish", stop: "finish", answer: "finish", final_answer: "finish",
};

export function resolveTool(name) {
  const key = String(name || "").trim();
  const canon = TOOLS[key] ? key : ALIASES[key] || ALIASES[key.toLowerCase()];
  return canon && TOOLS[canon] ? { canon, tool: TOOLS[canon] } : null;
}

export function toolNamesForRole(role) {
  return Object.entries(TOOLS).filter(([, t]) => t.roles.includes(role)).map(([n]) => n);
}

// Execute a {name,input} call under a role. Returns { ok, result, canon, finished }.
export function runTool(call, ctx) {
  const resolved = resolveTool(call?.name);
  if (!resolved) return { ok: false, result: `ERROR: unknown tool "${call?.name}"`, finished: false };
  const { canon, tool } = resolved;
  if (!tool.roles.includes(ctx.role)) {
    return { ok: false, result: `ERROR: tool "${canon}" not allowed for role "${ctx.role}"`, finished: false };
  }
  let result;
  try { result = tool.run(call.input || {}, ctx); }
  catch (e) { result = `ERROR: ${e.message}`; }
  const finished = typeof result === "string" && result.startsWith("__FINISH__");
  return { ok: !String(result).startsWith("ERROR:"), result, canon, finished };
}
