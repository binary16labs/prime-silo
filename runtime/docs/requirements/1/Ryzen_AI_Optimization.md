# Refined Ryzen AI Optimization: 8-Core Performance & Memory Guardrails

Based on your system specs (**8-Core Ryzen AI 7**, **32GB RAM**, but **low available memory**), we will implement a balanced optimization strategy that maximizes throughput while preventing system crashes.

## User Review Required

> [!CAUTION]
> **Memory Warning**: Your system currently shows only **591 MB** of available physical memory. Docling and local LLMs are RAM-intensive. We will implement "Memory Guardrails" to prevent `std::bad_alloc` errors during ingestion.

> [!IMPORTANT]
>
> - **Parallel Worker Tuning**: Since the IDE and Browser are now offloaded to a separate workstation (Thinkpad T480), we will increase the default to **6 parallel workers** to maximize Ryzen AI throughput.
- **NPU Priority**: Gemma-4 E4B is now configured as the primary model on the XDNA 2 NPU via Lemonade Server.

## Proposed Changes

### 1. Schema & Configuration

#### [MODIFY] [schema.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/schema.py)

- Add `docling_ocr: bool = False`
- Add `docling_table_structure: bool = False`
- Add `max_parallel_workers: int = 6` (Optimized for 8-core CPU with offloaded IDE)
- Add `memory_safety_mode: bool = True` (Triggers aggressive GC after each file)

### 2. Optimized Extraction Layer

#### [MODIFY] [extraction.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/extraction.py)

- Update `extract_structured_text` to respect the new manifest settings.
- Implement `memory_safety_mode`: explicitly call `gc.collect()` and clear internal Docling buffers between documents.

### 3. Batch Ingestion Pipeline

#### [MODIFY] [graph_routes.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/graph_routes.py)

- Update code to use `ProcessPoolExecutor` with `max_parallel_workers` for document parsing.
- Ensure the extraction phase is decoupled from the LLM synthesis phase to prevent memory spikes.

### 4. Ryzen AI Guide

#### [MODIFY] [RYZEN_AI_OPTIMIZATION.md](file:///C:/Users/nsdha/OneDrive/code/benny/docs/guides/RYZEN_AI_OPTIMIZATION.md)

- Tailor the guide for **ASUS Vivobook S 14** specific performance settings.
- Add a section on "Reclaiming RAM" before starting heavy ingestion sessions.

### 5. Distributed Inference (NPU + Thinkpad)

#### [MODIFY] [RYZEN_AI_OPTIMIZATION.md](file:///C:/Users/nsdha/OneDrive/code/benny/docs/guides/RYZEN_AI_OPTIMIZATION.md)

- **Gemma-4 E4B Setup**: Use the `ryzenai-llm` recipe in Lemonade for zero-CPU inference.
- **Remote Access**: Ensure Lemonade is bound to `192.168.68.134` for the Thinkpad to connect.

## Open Questions

- None. The system specs provided are sufficient for tuning the worker counts.

## Verification Plan

### Automated Tests

- Benchmark the `ProcessPoolExecutor` with dummy files to ensure it scales correctly across 4 workers.
- Verify manifest persistence of the new `max_parallel_workers` setting.

### Manual Verification

- Monitor RAM usage in Task Manager during 4-way parallel ingestion to ensure it doesn't exceed 95%.
