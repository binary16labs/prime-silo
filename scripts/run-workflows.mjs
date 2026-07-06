#!/usr/bin/env node

/**
 * Prime-Silo Workflow Orchestrator
 *
 * Supports:
 *   1. Ingestion: Convert and ingest files from staging directory.
 *   2. Test Lemonade: Run pypes model-bench on active NPU models in Lemonade.
 *   3. Test LM-Studio: Run pypes model-bench on LM-Studio models.
 *   4. Sequenced Run: Executes all of the above in sequence.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// Q0: single resolution path — env BENNY_API_KEY -> per-install keystore
// ($BENNY_HOME/state/hmac-key) -> fail fast. No shipped default remains.
function resolveBennyApiKey(bennyHome, fileConfig) {
  const envKey = process.env.BENNY_API_KEY || fileConfig.BENNY_API_KEY;
  if (envKey) return envKey;
  try {
    const value = fs.readFileSync(path.join(bennyHome, "state", "hmac-key"), "utf8").trim();
    if (value) return value;
  } catch {
    // fall through to fail-fast
  }
  throw new Error(
    "BENNY_API_KEY is not set and no per-install key was found at " +
      "<BENNY_HOME>/state/hmac-key. Set the BENNY_API_KEY environment variable, " +
      "or run `benny init` to generate a per-install keystore."
  );
}

// Load environment config from .env if present, allowing process.env overrides
function loadEnv() {
  const envPath = path.join(projectRoot, ".env");
  const fileConfig = {};

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const parts = trimmed.split("=");
        if (parts.length >= 2) {
          const key = parts[0].trim();
          let value = parts.slice(1).join("=").trim();
          value = value.replace(/^['"]|['"]$/g, ""); // strip quotes
          fileConfig[key] = value;
        }
      }
    }
  }

  const config = {
    PORT: process.env.PORT || fileConfig.PORT || "3020",
    BENNY_HOME: process.env.BENNY_HOME || fileConfig.BENNY_HOME || ".benny_home",
    RUNTIME_BASE_URL:
      process.env.RUNTIME_BASE_URL || fileConfig.RUNTIME_BASE_URL || "http://127.0.0.1:8005",
    BENNY_API_KEY: ""
  };

  // Resolve absolute path for BENNY_HOME
  if (!path.isAbsolute(config.BENNY_HOME)) {
    config.BENNY_HOME = path.resolve(projectRoot, config.BENNY_HOME);
  }

  config.BENNY_API_KEY = resolveBennyApiKey(config.BENNY_HOME, fileConfig);

  return config;
}

const env = loadEnv();
const apiBase = `${env.RUNTIME_BASE_URL}/api`;
const apiKey = env.BENNY_API_KEY;
const bennyHome = env.BENNY_HOME;

/**
 * Probes the backend API to make sure Benny runtime is online
 */
async function assertRuntimeOnline() {
  try {
    const url = `${env.RUNTIME_BASE_URL}/api/health`;
    const res = await fetch(url, {
      headers: { "X-Benny-API-Key": apiKey }
    });
    if (res.status === 200) {
      return true;
    }
    console.log(`API health returned status: ${res.status}`);
  } catch (err) {
    console.error(`API health probe failed with error:`, err.message || err);
  }
  console.error(`ERROR: Benny Python runtime is offline or unreachable at ${env.RUNTIME_BASE_URL}`);
  console.error(`Please start the backend services first. You can run:`);
  console.error(`  python runtime/benny_cli.py up --home ${bennyHome}`);
  console.error(`Or run the dev launcher:`);
  console.error(`  powershell ./scripts/dev.ps1`);
  process.exit(1);
}

/**
 * Creates a workspace if it doesn't already exist
 */
async function createWorkspace(workspaceId) {
  console.log(`Checking/Creating workspace: "${workspaceId}"...`);
  try {
    const res = await fetch(`${apiBase}/workspaces/${workspaceId}`, {
      method: "POST",
      headers: {
        "X-Benny-API-Key": apiKey
      }
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ Workspace "${workspaceId}" is ready.`);
      return data;
    } else {
      console.warn(`  ! Workspace status returned: ${res.statusText}`);
    }
  } catch (err) {
    console.error(`  ✗ Failed to register workspace via API:`, err.message);
  }
}

/**
 * Workflow 1: Ingest Staging Files
 */
async function runIngestion(workspace, deepSynthesis = false) {
  console.log(`\n======================================================`);
  console.log(`WORKFLOW 1: Ingesting files from staging in "${workspace}"`);
  console.log(`======================================================`);

  const stagingDir = path.join(bennyHome, "workspaces", workspace, "staging");
  const dataInDir = path.join(bennyHome, "workspaces", workspace, "data_in");
  const archiveDir = path.join(stagingDir, "archive");

  // Auto-init workspace if directory structure is missing
  if (!fs.existsSync(stagingDir)) {
    await createWorkspace(workspace);
  }

  if (!fs.existsSync(stagingDir)) {
    console.error(`Staging directory does not exist after creation attempt: ${stagingDir}`);
    return;
  }

  const files = fs.readdirSync(stagingDir).filter((f) => {
    const filePath = path.join(stagingDir, f);
    return fs.statSync(filePath).isFile();
  });

  if (files.length === 0) {
    console.log(`No files found in staging folder: ${stagingDir}`);
    console.log(`Please drop raw files into this directory first.`);
    return;
  }

  console.log(`Found ${files.length} raw file(s) for ingestion:`, files);

  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  for (const filename of files) {
    const filePath = path.join(stagingDir, filename);
    console.log(`\nIngesting: ${filename}...`);
    try {
      // 1. Stage and convert using API
      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer], { type: "application/octet-stream" });
      const formData = new FormData();
      formData.append("file", blob, filename);

      console.log(`  Converting raw format to markdown via Docling...`);
      const convertRes = await fetch(
        `${env.RUNTIME_BASE_URL}/api/etl/stage-and-convert?workspace=${workspace}`,
        {
          method: "POST",
          headers: {
            "X-Benny-API-Key": apiKey
          },
          body: formData
        }
      );

      if (!convertRes.ok) {
        throw new Error(
          `ETL stage-and-convert failed: ${convertRes.statusText} (${await convertRes.text()})`
        );
      }

      const convertData = await convertRes.json();
      console.log(`  ✓ Converted to markdown at: data_in/${convertData.markdown_filename}`);

      // 2. Archive original raw file
      const archivePath = path.join(archiveDir, filename);
      fs.renameSync(filePath, archivePath);
      console.log(`  ✓ Archived original file to staging/archive/${filename}`);
    } catch (err) {
      console.error(`  ✗ Error converting ${filename}:`, err.message);
    }
  }

  // 3. Trigger global RAG indexing
  console.log(`\nTriggering ChromaDB RAG Ingestion for workspace "${workspace}"...`);
  try {
    const ingestRes = await fetch(`${apiBase}/rag/ingest`, {
      method: "POST",
      headers: {
        "X-Benny-API-Key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ workspace, deep_synthesis: deepSynthesis })
    });

    if (!ingestRes.ok) {
      throw new Error(
        `RAG Ingest request failed: ${ingestRes.statusText} (${await ingestRes.text()})`
      );
    }

    const ingestData = await ingestRes.json();
    const runId = ingestData.run_id;
    console.log(`  ✓ Ingestion job successfully queued in background. Run ID: ${runId}`);
    console.log(`  Monitoring job progress...`);

    let isCompleted = false;
    let seenAerCount = 0;
    while (!isCompleted) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const taskRes = await fetch(`${apiBase}/tasks/${runId}`, {
          headers: { "X-Benny-API-Key": apiKey }
        });
        if (!taskRes.ok) continue;

        const taskData = await taskRes.json();

        // Print any new Agent Execution Record (AER) logs
        const aerLog = taskData.aer_log || [];
        for (let i = seenAerCount; i < aerLog.length; i++) {
          const entry = aerLog[i];
          // Clear current line before printing AER so it doesn't overlap with progress
          process.stdout.write("\\r\\x1b[K");
          console.log(`    [AER] ${entry.intent || "Event"}: ${entry.observation || ""}`);
        }
        seenAerCount = aerLog.length;

        // Print progress indicator on a single line
        const stepInfo =
          taskData.total_steps > 0
            ? `${taskData.current_step}/${taskData.total_steps} steps`
            : `Preparing`;
        process.stdout.write(
          `\\r    Progress: ${stepInfo} (${taskData.progress}%) [${taskData.status.toUpperCase()}] - ${taskData.message || ""}\\x1b[K`
        );

        if (["completed", "failed", "completed_with_errors"].includes(taskData.status)) {
          isCompleted = true;
          console.log(
            `\\n  ✓ Ingestion job finished with status: ${taskData.status.toUpperCase()}`
          );

          // Save ingestion report for unified metrics
          const wsPath = path.join(bennyHome, "workspaces", workspace);
          const reportsDir = path.join(wsPath, "reports");
          fs.mkdirSync(reportsDir, { recursive: true });
          fs.writeFileSync(
            path.join(reportsDir, "ingest_report.json"),
            JSON.stringify(taskData, null, 2)
          );
        }
      } catch (e) {
        // Ignore fetch errors during polling, backend might be busy
      }
    }
  } catch (err) {
    console.error(`  ✗ RAG Ingest failed:`, err.message);
  }
}

/**
 * Runs a model comparison command using benny_cli
 */
function runModelBench(specPath, workspace, reportPath) {
  return new Promise((resolve, reject) => {
    console.log(`Executing model-bench comparison command...`);
    const args = [
      path.join(projectRoot, "runtime", "benny_cli.py"),
      "pypes",
      "model-bench",
      specPath,
      "--workspace",
      workspace
    ];

    if (reportPath) {
      args.push("--save-report", reportPath);
    }

    const proc = spawn("python", args, {
      cwd: projectRoot,
      stdio: "inherit"
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`model-bench failed with exit code ${code}`));
      }
    });
  });
}

/**
 * Workflow 2: Test Lemonade NPU Models
 */
async function runLemonadeTest(workspaceOverride) {
  console.log(`\n======================================================`);
  console.log(`WORKFLOW 2: Testing Lemonade NPU Models`);
  console.log(`======================================================`);

  const lemonadeUrl = "http://127.0.0.1:13305/api/v1/models";
  console.log(`Probing Lemonade server at: http://127.0.0.1:13305...`);

  let models = [];
  try {
    const res = await fetch(lemonadeUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      throw new Error(`Status ${res.status}`);
    }
    const data = await res.json();
    models = data.data || [];
  } catch (err) {
    console.error(`ERROR: Lemonade server is offline or unreachable at ${lemonadeUrl}`);
    console.error(`Please start Lemonade (with NPU-optimized models) first.`);
    return;
  }

  const targetScopes = [
    "DeepSeek-Qwen3-8B-GGUF",
    "Qwen3-8B-Hybrid",
    "qwen3.5-9b-FLM",
    "qwen3-tk-4b-FLM"
  ];

  // Filter discovered models against the requested test scope
  const filteredModels = models.filter((m) => targetScopes.some((target) => m.id.includes(target)));

  if (filteredModels.length === 0) {
    console.warn(`Lemonade is running, but none of the targeted models are available.`);
    return;
  }

  console.log(`Found ${filteredModels.length} targeted model(s) downloaded in Lemonade:`);
  for (const m of filteredModels) {
    console.log(`  - ${m.id}`);
  }

  for (const model of filteredModels) {
    const rawId = model.id;
    // Strip slashes and special chars for workspace safety
    const cleanId = rawId.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
    const wsName = workspaceOverride || `ws_lemonade_${cleanId}`;

    console.log(`\n--- Benchmarking Model: "${rawId}" in Workspace: "${wsName}" ---`);

    // Create workspace
    await createWorkspace(wsName);

    // Build spec JSON
    const spec = {
      schema_version: "1.0",
      kind: "pypes_model_comparison",
      id: `compare-lemonade-${cleanId}`,
      name: `Lemonade NPU Benchmark: ${rawId}`,
      task: "plan",
      workspace: wsName,
      requirement:
        "Build a data pipeline that loads sales CSV, normalises currency to USD, filters out rows where quantity < 1, and saves a Gold aggregated report of total revenue by region.",
      models: [
        {
          label: cleanId.substring(0, 15),
          id: `lemonade/${rawId}`,
          max_tokens: 2048,
          temperature: 0.2
        }
      ],
      repeats: 1,
      rubric_required_ops: ["load", "filter", "calc", "aggregate"],
      rubric_min_steps: 4,
      rubric_min_gold_steps: 1,
      judge: {
        enabled: false
      }
    };

    const wsPath = path.join(bennyHome, "workspaces", wsName);
    const specDir = path.join(wsPath, "manifests", "templates");
    fs.mkdirSync(specDir, { recursive: true });

    const specPath = path.join(specDir, "model_compare_spec.json");
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");
    console.log(
      `  ✓ Generated comparison spec at: workspaces/${wsName}/manifests/templates/model_compare_spec.json`
    );

    const reportPath = path.join(wsPath, "reports", `npu_benchmark_${cleanId}.md`);

    try {
      await runModelBench(specPath, wsName, reportPath);
      console.log(`  ✓ Benchmark run complete for ${rawId}.`);
      console.log(
        `  ✓ Saved Markdown scorecard to: workspaces/${wsName}/reports/npu_benchmark_${cleanId}.md`
      );
    } catch (err) {
      console.error(`  ✗ Benchmark run failed for model ${rawId}:`, err.message);
    }
  }
}

/**
 * Workflow 3: Test LM-Studio Models
 */
async function runLMStudioTest(workspaceOverride) {
  console.log(`\n======================================================`);
  console.log(`WORKFLOW 3: Testing LM-Studio Models`);
  console.log(`======================================================`);

  const lmStudioUrl = "http://127.0.0.1:1234/v1/models";
  console.log(`Probing LM-Studio server at: http://127.0.0.1:1234...`);

  let models = [];
  try {
    const res = await fetch(lmStudioUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      throw new Error(`Status ${res.status}`);
    }
    const data = await res.json();
    models = data.data || [];
  } catch (err) {
    console.error(`ERROR: LM-Studio server is offline or unreachable at ${lmStudioUrl}`);
    console.error(
      `Please launch LM-Studio, load your model, and enable "Local Server" on port 1234.`
    );
    return;
  }

  if (models.length === 0) {
    console.warn(`LM-Studio is running, but returned zero active models.`);
    return;
  }

  console.log(`Found ${models.length} active model(s) in LM-Studio:`);
  for (const m of models) {
    console.log(`  - ${m.id}`);
  }

  for (const model of models) {
    const rawId = model.id;
    const cleanId = rawId.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
    const wsName = workspaceOverride || `ws_lmstudio_${cleanId}`;

    console.log(`\n--- Benchmarking Model: "${rawId}" in Workspace: "${wsName}" ---`);

    // Create workspace
    await createWorkspace(wsName);

    // Build spec JSON
    const spec = {
      schema_version: "1.0",
      kind: "pypes_model_comparison",
      id: `compare-lmstudio-${cleanId}`,
      name: `LM-Studio Benchmark: ${rawId}`,
      task: "plan",
      workspace: wsName,
      requirement:
        "Build a data pipeline that loads sales CSV, normalises currency to USD, filters out rows where quantity < 1, and saves a Gold aggregated report of total revenue by region.",
      models: [
        {
          label: cleanId.substring(0, 15),
          id: `lmstudio/${rawId}`,
          max_tokens: 2048,
          temperature: 0.2
        }
      ],
      repeats: 1,
      rubric_required_ops: ["load", "filter", "calc", "aggregate"],
      rubric_min_steps: 4,
      rubric_min_gold_steps: 1,
      judge: {
        enabled: false
      }
    };

    const wsPath = path.join(bennyHome, "workspaces", wsName);
    const specDir = path.join(wsPath, "manifests", "templates");
    fs.mkdirSync(specDir, { recursive: true });

    const specPath = path.join(specDir, "model_compare_spec.json");
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");
    console.log(
      `  ✓ Generated comparison spec at: workspaces/${wsName}/manifests/templates/model_compare_spec.json`
    );

    const reportPath = path.join(wsPath, "reports", `lmstudio_benchmark_${cleanId}.md`);

    try {
      await runModelBench(specPath, wsName, reportPath);
      console.log(`  ✓ Benchmark run complete for ${rawId}.`);
      console.log(
        `  ✓ Saved Markdown scorecard to: workspaces/${wsName}/reports/lmstudio_benchmark_${cleanId}.md`
      );
    } catch (err) {
      console.error(`  ✗ Benchmark run failed for model ${rawId}:`, err.message);
    }
  }
}

/**
 * Print CLI Help
 */
function printHelp() {
  console.log(`
Prime-Silo Workflow Runner

Usage:
  node scripts/run-workflows.mjs <command> [workspace] [--deep]

Commands:
  ingest [workspace] [--deep]  Ingest files from staging directory (defaults to "default"). 
                               Use --deep to run LLM triples extraction (deep synthesis).
  test-lemonade                Discover and benchmark downloaded Lemonade NPU models
  test-lmstudio           Discover and benchmark active LM-Studio models
  triples-eval [workspace] Run Triples Extraction Evaluation (LLM-as-a-judge)
  report [workspace]      Generate a consolidated metrics report for the workspace
  all [workspace]         Run all workflows in sequence
  help                    Show this help message
`);
}

/**
 * Workflow 4: Generate Consolidated Report
 */
async function generateReport(workspace) {
  console.log(`\n======================================================`);
  console.log(`WORKFLOW 4: Generating Consolidated Report for "${workspace}"`);
  console.log(`======================================================`);

  const reports = [];

  // 1. Ingestion Metrics
  const wsPath = path.join(bennyHome, "workspaces", workspace);
  const ingestReportPath = path.join(wsPath, "reports", "ingest_report.json");
  if (fs.existsSync(ingestReportPath)) {
    try {
      const taskData = JSON.parse(fs.readFileSync(ingestReportPath, "utf8"));
      let elapsedStr = "N/A";
      if (taskData.created_at && taskData.updated_at) {
        const start = new Date(taskData.created_at);
        const end = new Date(taskData.updated_at);
        elapsedStr = ((end - start) / 1000).toFixed(1) + "s";
      }
      reports.push({
        workflow: "Ingestion",
        model: "Various (LLM/Embed)",
        status: taskData.status,
        elapsed: elapsedStr,
        prompt_tokens: "N/A",
        completion_tokens: "N/A",
        cost: "N/A",
        cpu_mean: "N/A",
        rss_peak: "N/A",
        graph_metrics: taskData.metadata?.graph_metrics || null
      });
    } catch (err) {
      console.warn(`Could not read ingestion report: ${err.message}`);
    }
  }

  // 2. Model Benchmarks
  const runsDir = path.join(bennyHome, "runs", "model-compare");
  if (fs.existsSync(runsDir)) {
    const runDirs = fs.readdirSync(runsDir);
    for (const runDir of runDirs) {
      const resultsPath = path.join(runsDir, runDir, "results.json");
      if (fs.existsSync(resultsPath)) {
        try {
          const resultData = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
          if (resultData.workspace === workspace || runDir.includes(workspace)) {
            const bestPerModel = resultData.best_per_model || [];
            for (const t of bestPerModel) {
              reports.push({
                workflow: resultData.name || "Model Bench",
                model: t.model_id || t.label,
                status: t.status,
                elapsed: t.wall_seconds ? t.wall_seconds.toFixed(1) + "s" : "N/A",
                prompt_tokens: t.prompt_tokens || 0,
                completion_tokens: t.completion_tokens || 0,
                cost: t.cost_usd ? "$" + t.cost_usd.toFixed(4) : "N/A",
                cpu_mean: t.cpu_percent_mean ? t.cpu_percent_mean.toFixed(1) + "%" : "N/A",
                rss_peak: t.rss_mb_peak ? t.rss_mb_peak.toFixed(0) + "MB" : "N/A"
              });
            }
          }
        } catch (err) {
          console.warn(`Could not read model benchmark report in ${runDir}: ${err.message}`);
        }
      }
    }
  }

  if (reports.length === 0) {
    console.log(
      `No metrics found for workspace "${workspace}". Run ingest or test workflows first.`
    );
    return;
  }

  // Generate Table
  const mdTable = [
    `| Workflow | Model | Status | Elapsed | Prompt Toks | Comp Toks | Est. Cost | CPU Mean | Mem Peak |`,
    `|----------|-------|--------|---------|-------------|-----------|-----------|----------|----------|`
  ];
  for (const r of reports) {
    mdTable.push(
      `| ${r.workflow} | ${r.model} | ${r.status} | ${r.elapsed} | ${r.prompt_tokens} | ${r.completion_tokens} | ${r.cost} | ${r.cpu_mean} | ${r.rss_peak} |`
    );
  }

  let mdReport = `# Consolidated Metrics Report: ${workspace}\n\n${mdTable.join("\\n")}\n`;

  // Print to console
  console.log(`\n` + mdTable.join("\n"));

  // Graph Metrics Table
  const graphReports = reports.filter((r) => r.graph_metrics);
  if (graphReports.length > 0) {
    const gTable = [
      `\n## Graph Telemetry`,
      `| Workflow | Triples | Avg Confidence | Safe Links | Communities |`,
      `|----------|---------|----------------|------------|-------------|`
    ];
    for (const r of graphReports) {
      gTable.push(
        `| ${r.workflow} | ${r.graph_metrics.triples} | ${r.graph_metrics.confidence.toFixed(2)} | ${r.graph_metrics.safe_links} | ${r.graph_metrics.clusters} |`
      );
    }
    mdReport += gTable.join("\\n") + "\\n";
    console.log(gTable.join("\n"));
  }

  console.log();

  // Save to file
  const consolidatedPath = path.join(wsPath, "reports", "consolidated_workflow_report.md");
  fs.mkdirSync(path.join(wsPath, "reports"), { recursive: true });
  fs.writeFileSync(consolidatedPath, mdReport, "utf8");
  console.log(
    `  ✓ Saved consolidated report to: workspaces/${workspace}/reports/consolidated_workflow_report.md`
  );
}

/**
 * Workflow 5: Triples Evaluation Benchmark
 */
async function runTriplesEval(workspace) {
  console.log(`\n======================================================`);
  console.log(`WORKFLOW 5: Triples Evaluation Benchmark in "${workspace}"`);
  console.log(`======================================================`);

  const evalText = `
The new memory architecture (Mem-Ray) introduces a tiered caching system. 
L1 cache is integrated directly into the compute units, providing 2ns latency. 
L2 cache is shared across the die, with 10ns latency.
Data from L1 is evicted to L2 using a Least Recently Used (LRU) policy.
The Mem-Ray controller governs this eviction process to prevent thrashing.
`;

  const modelsToTest = [
    "lemonade/DeepSeek-Qwen3-8B-GGUF",
    "lemonade/Qwen3-8B-Hybrid",
    "lemonade/qwen3.5-9b-FLM",
    "lemonade/qwen3-tk-4b-FLM"
  ];

  console.log(
    `Evaluating triples extraction across ${modelsToTest.length} targeted Lemonade models...`
  );
  console.log(`Target Text Length: ${evalText.length} characters`);

  for (const model of modelsToTest) {
    console.log(`\n[ Evaluating Model: ${model} ]`);
    try {
      const res = await fetch(`${BENNY_URL}/api/rag/eval-triples`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: evalText,
          workspace,
          model
        })
      });

      if (!res.ok) {
        console.log(`  ✗ Failed or model unavailable (HTTP ${res.status})`);
        continue;
      }

      const data = await res.json();
      console.log(`  ✓ Extracted ${data.triples_count} triples in ${data.elapsed_seconds}s`);
      console.log(`  ✓ Avg Confidence: ${data.avg_confidence}`);

      if (data.judge_score) {
        console.log(
          `  ✓ Judge Score - Precision: ${data.judge_score.precision}, Recall: ${data.judge_score.recall}`
        );
      } else {
        console.log(`  ⚠ Judge Score unavailable (Judge model might be offline)`);
      }

      if (data.triples && data.triples.length > 0) {
        console.log(
          `  Sample: [${data.triples[0].subject}] -(${data.triples[0].predicate})-> [${data.triples[0].object}]`
        );
      }
    } catch (err) {
      console.log(`  ✗ Error testing model: ${err.message}`);
    }
  }

  console.log(`\nTriples evaluation benchmark complete!`);
}

/**
 * Main Entry Point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const workspaceArg = args[1] || "default";

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  // Ensure Benny runtime API is online before proceeding
  await assertRuntimeOnline();

  // Check if --deep flag is present in any argument
  const runDeep = args.includes("--deep");

  // Clean workspaceArg if it was accidentally --deep
  const workspace = workspaceArg === "--deep" ? "default" : workspaceArg;

  switch (command) {
    case "ingest":
      await runIngestion(workspace, runDeep);
      break;
    case "test-lemonade":
      await runLemonadeTest();
      break;
    case "test-lmstudio":
      await runLMStudioTest();
      break;
    case "triples-eval":
      await runTriplesEval(workspace);
      break;
    case "report":
      await generateReport(workspace);
      break;
    case "all":
      console.log(`Starting sequenced run of all workflows...`);
      await runIngestion(workspace, runDeep);
      await runLemonadeTest();
      await runLMStudioTest();
      await generateReport(workspace);
      console.log(`\n✓ All workflows completed successfully!`);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal workflow orchestrator error:", err);
  process.exit(1);
});
