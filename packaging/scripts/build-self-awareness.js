#!/usr/bin/env node

// Build the Benny self-awareness bundle that ships inside the desktop package.
//
// "Our framework is the demo": instead of seeding a separate demo workspace,
// every desktop build vendors a snapshot of Prime-Silo's own source, a
// lightweight static code-graph, the application manifests, and an index of the
// navigable skills. The bundle is regenerated on every build (local and CI) so
// the skills and graph always track the code that ships beside them, and it is
// fully offline — no Neo4j, no tree-sitter, no network.
//
// On first run the desktop shell seeds the `prime_silo_self` workspace from this
// bundle (see packaging/desktop/self_awareness.js) so Benny boots self-aware.
//
// Output layout (under packaging/self-awareness/, git-ignored, rebuilt each time):
//   bundle.json        — manifest: schema, version, git commit, counts
//   source/            — curated source snapshot (no node_modules / vendor blobs)
//   manifests/         — application + runtime manifest templates
//   skills/            — skills index + copied SKILL definitions
//   code-graph.json    — static folder/file/symbol graph (CONTAINS / DEFINES)

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "../..");

// Source trees that define the shell's behaviour. Kept deliberately tight so the
// bundle stays small and the graph stays meaningful; the runtime ships its own
// agent guide and is vendored separately.
const SOURCE_INCLUDES = ["server", "commands", "app/L0/_all/mod/_prime_silo"];

const MANIFEST_SOURCES = ["manifests", "runtime/manifests/templates"];

// Where to harvest SKILL definitions so Benny can navigate the code.
const SKILL_ROOTS = ["app/L0/_all/mod", "runtime/skills"];

const EXCLUDE_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".github",
  "dist",
  "build",
  "logs",
  "__pycache__",
  ".benny_home",
  "brain",
  "chromadb",
  ".claude",
  "worktrees",
  ".venv",
  "venv",
  "coverage",
  ".pytest_cache",
  ".mypy_cache"
]);

// Skip oversized files (vendored bundles, minified libs) from the snapshot and
// the graph — they bloat the package and add no navigational value.
const MAX_FILE_BYTES = 512 * 1024;

const GRAPH_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isExcludedDir(name) {
  return EXCLUDE_DIR_NAMES.has(name);
}

// Walk a directory, yielding files. Skips excluded directories and oversized
// files. Paths are returned relative to `base`.
function walkFiles(base) {
  const out = [];
  if (!fs.existsSync(base)) {
    return out;
  }
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isExcludedDir(entry.name)) {
          stack.push(full);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        continue;
      }
      out.push({ full, rel: path.relative(base, full).split(path.sep).join("/"), size });
    }
  }
  return out;
}

function copySnapshot(projectRoot, outSourceDir) {
  let fileCount = 0;
  for (const include of SOURCE_INCLUDES) {
    const sourceBase = path.join(projectRoot, include);
    const files = walkFiles(sourceBase);
    for (const file of files) {
      const dest = path.join(outSourceDir, include, file.rel);
      ensureDir(path.dirname(dest));
      fs.copyFileSync(file.full, dest);
      fileCount += 1;
    }
  }
  return fileCount;
}

function copyManifests(projectRoot, outManifestDir) {
  const manifests = [];
  for (const source of MANIFEST_SOURCES) {
    const base = path.join(projectRoot, source);
    const files = walkFiles(base).filter((f) => f.rel.toLowerCase().endsWith(".json"));
    for (const file of files) {
      const dest = path.join(outManifestDir, source, file.rel);
      ensureDir(path.dirname(dest));
      fs.copyFileSync(file.full, dest);
      manifests.push(`${source}/${file.rel}`);
    }
  }
  return manifests;
}

// Pull a one-line description out of a SKILL.md: prefer the frontmatter
// `description:` field, else the first non-heading prose line.
function describeSkill(markdown) {
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^description:\s*(.+)$/i);
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 240);
    }
  }
  return "";
}

function collectSkills(projectRoot, outSkillsDir) {
  const skills = [];
  for (const root of SKILL_ROOTS) {
    const base = path.join(projectRoot, root);
    const skillFiles = walkFiles(base).filter((f) => path.basename(f.rel) === "SKILL.md");
    for (const file of skillFiles) {
      let markdown = "";
      try {
        markdown = fs.readFileSync(file.full, "utf8");
      } catch {
        continue;
      }
      const skillDirRel = path.posix.dirname(`${root}/${file.rel}`);
      const id = path.posix.basename(skillDirRel);
      const destDir = path.join(outSkillsDir, skillDirRel);
      ensureDir(destDir);
      // Copy the whole skill directory (SKILL.md + any sibling .js helpers).
      const skillDirAbs = path.dirname(file.full);
      for (const sibling of walkFiles(skillDirAbs)) {
        const dest = path.join(destDir, sibling.rel);
        ensureDir(path.dirname(dest));
        fs.copyFileSync(sibling.full, dest);
      }
      skills.push({ id, path: skillDirRel, description: describeSkill(markdown) });
    }
  }
  skills.sort((a, b) => a.path.localeCompare(b.path));
  return skills;
}

// Extract top-level symbol names for the static graph. Cheap and language-rough;
// good enough to give Benny a navigable map of where things are defined.
function extractSymbols(rel, content) {
  const ext = path.extname(rel).toLowerCase();
  const symbols = [];
  const seen = new Set();
  const push = (name, kind) => {
    if (!name || seen.has(`${kind}:${name}`)) {
      return;
    }
    seen.add(`${kind}:${name}`);
    symbols.push({ name, kind });
  };
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (symbols.length >= 200) {
      break;
    }
    if (ext === ".py") {
      let m = line.match(/^\s*def\s+([A-Za-z_]\w*)/);
      if (m) push(m[1], "Function");
      m = line.match(/^\s*class\s+([A-Za-z_]\w*)/);
      if (m) push(m[1], "Class");
    } else {
      let m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (m) push(m[1], "Function");
      m = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
      if (m) push(m[1], "Class");
      m = line.match(
        /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
      );
      if (m) push(m[1], "Function");
    }
  }
  return symbols;
}

// Build a static code-graph from the copied snapshot. Nodes: Folder, File,
// Function, Class. Edges: CONTAINS (folder->child), DEFINES (file->symbol).
function buildCodeGraph(outSourceDir) {
  const nodes = [];
  const edges = [];
  const folderIds = new Set();

  const addFolder = (relDir) => {
    const id = `folder:${relDir}`;
    if (folderIds.has(id)) {
      return id;
    }
    folderIds.add(id);
    nodes.push({
      id,
      type: "Folder",
      label: relDir === "." ? "/" : path.posix.basename(relDir),
      path: relDir
    });
    const parent = path.posix.dirname(relDir);
    if (relDir !== "." && parent !== relDir) {
      const parentId = addFolder(parent === "" ? "." : parent);
      edges.push({ from: parentId, to: id, type: "CONTAINS" });
    }
    return id;
  };

  addFolder(".");
  const files = walkFiles(outSourceDir);
  for (const file of files) {
    const rel = file.rel;
    const dirRel = path.posix.dirname(rel) || ".";
    const folderId = addFolder(dirRel);
    const fileId = `file:${rel}`;
    nodes.push({ id: fileId, type: "File", label: path.posix.basename(rel), path: rel });
    edges.push({ from: folderId, to: fileId, type: "CONTAINS" });

    const ext = path.extname(rel).toLowerCase();
    if (!GRAPH_EXTENSIONS.has(ext)) {
      continue;
    }
    let content = "";
    try {
      content = fs.readFileSync(file.full, "utf8");
    } catch {
      continue;
    }
    for (const symbol of extractSymbols(rel, content)) {
      const symbolId = `symbol:${rel}#${symbol.kind}:${symbol.name}`;
      nodes.push({ id: symbolId, type: symbol.kind, label: symbol.name, path: rel });
      edges.push({ from: fileId, to: symbolId, type: "DEFINES" });
    }
  }

  return {
    schema: "prime-silo.self-awareness.code-graph/1",
    generated_at: new Date().toISOString(),
    stats: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges
  };
}

function resolveGitCommit(projectRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function readVersion(projectRoot) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version || ""
    );
  } catch {
    return "";
  }
}

function buildSelfAwarenessBundle(options = {}) {
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
  const outDir = options.outDir || path.join(projectRoot, "packaging", "self-awareness");

  rmrf(outDir);
  ensureDir(outDir);

  const outSourceDir = path.join(outDir, "source");
  const outManifestDir = path.join(outDir, "manifests");
  const outSkillsDir = path.join(outDir, "skills");
  ensureDir(outSourceDir);
  ensureDir(outManifestDir);
  ensureDir(outSkillsDir);

  const sourceFileCount = copySnapshot(projectRoot, outSourceDir);
  const manifests = copyManifests(projectRoot, outManifestDir);
  const skills = collectSkills(projectRoot, outSkillsDir);
  const codeGraph = buildCodeGraph(outSourceDir);

  fs.writeFileSync(path.join(outDir, "code-graph.json"), JSON.stringify(codeGraph));
  fs.writeFileSync(
    path.join(outSkillsDir, "skills-index.json"),
    JSON.stringify({ schema: "prime-silo.self-awareness.skills/1", skills }, null, 2)
  );

  const bundle = {
    schema: "prime-silo.self-awareness/1",
    version: readVersion(projectRoot),
    git_commit: resolveGitCommit(projectRoot),
    generated_at: new Date().toISOString(),
    self_workspace: "prime_silo_self",
    source_includes: SOURCE_INCLUDES,
    counts: {
      source_files: sourceFileCount,
      manifests: manifests.length,
      skills: skills.length,
      graph_nodes: codeGraph.stats.nodes,
      graph_edges: codeGraph.stats.edges
    },
    manifests,
    skills: skills.map((s) => ({ id: s.id, path: s.path }))
  };
  fs.writeFileSync(path.join(outDir, "bundle.json"), JSON.stringify(bundle, null, 2));

  return { outDir, bundle };
}

module.exports = { buildSelfAwarenessBundle };

if (require.main === module) {
  const result = buildSelfAwarenessBundle();
  const c = result.bundle.counts;
  console.log(
    `Built Benny self-awareness bundle at ${path.relative(DEFAULT_PROJECT_ROOT, result.outDir)}`
  );
  console.log(
    `  ${c.source_files} source files · ${c.manifests} manifests · ${c.skills} skills · ` +
      `${c.graph_nodes} graph nodes / ${c.graph_edges} edges`
  );
}
