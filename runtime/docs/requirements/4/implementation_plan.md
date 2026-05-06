# Fix Missing Lineage & Audit Trail for Non-PDF Files

## Problem Statement

When a user uploads and ingests a `.txt` file (e.g. "The Art of War") through the Benny Notebook, **no lineage event appears in Marquez** and **no file-level audit entry appears in the workspace audit log**. In contrast, a `.pdf` file (e.g. "FrolovRoutledge2024.pdf") works end-to-end because it goes through the ETL staging pipeline which calls `track_file_conversion()`.

### Root Cause Analysis (3 bugs)

There are exactly **three bugs** that combine to cause this. Here is the evidence from the actual `test4` workspace:

---

#### BUG 1: Non-PDF file uploads produce ZERO lineage events

**Evidence:** In [SourcePanel.tsx:L113-L128](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/SourcePanel.tsx#L113-L128), the upload logic branches on file type:

```typescript
// PDF → goes through ETL pipeline (HAS lineage tracking ✅)
if (file.name.toLowerCase().endsWith('.pdf')) {
  const res = await fetch(`${API_BASE_URL}/api/etl/stage-and-convert?workspace=...`);
  // etl_routes.py calls track_file_conversion() → LINEAGE_FILE_CONVERSION ✅
}
// TXT/MD → goes through plain upload (NO lineage tracking ❌)
else {
  await fetch(`${API_BASE_URL}/api/files/upload?workspace=...`);
  // file_routes.py does NOT call any lineage function → NOTHING ❌
}
```

**Proof from audit.log:** `test4/runs/audit.log` line 1 shows `LINEAGE_FILE_CONVERSION` for `FrolovRoutledge2024.pdf`. There is **no equivalent entry for "Title The Art of War.txt"**.

---

#### BUG 2: `start_workflow()` builds input/output datasets but throws them away

**Evidence:** In [lineage.py:L153-L164](file:///c:/Users/nsdha/OneDrive/code/benny/benny/governance/lineage.py#L153-L164):

```python
# Line 153-154: These variables are CREATED...
input_datasets = [self._create_dataset(name, workspace) for name in (inputs or [])]
output_datasets = [self._create_dataset(name, workspace) for name in (outputs or [])]

# Line 157-165: ...but NEVER USED. Hard-coded empty arrays are sent instead!
event = RunEvent(
    ...
    inputs=[],    # ← BUG! Should be: inputs=input_datasets
    outputs=[]    # ← BUG! Should be: outputs=output_datasets
)
```

**Proof from audit.log:** `test4/runs/audit.log` line 3 and line 10 both show `LINEAGE_START_WORKFLOW` events with `"inputs": [], "outputs": []` — even though the RAG route passes files via `track_workflow_start(run_id, "rag_ingest", workspace)`.

---

#### BUG 3: RAG ingestion calls `track_workflow_start()` without passing the file list

**Evidence:** In [rag_routes.py:L48](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/rag_routes.py#L48):

```python
track_workflow_start(run_id, "rag_ingest", request.workspace)
# ← Missing: inputs=request.files, outputs=[f"chromadb:{collection_name}"]
```

Compare with [graph_routes.py:L454-L460](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/graph_routes.py#L454-L460) which correctly passes inputs:

```python
track_workflow_start(
    run_id, "graph_ingest", workspace,
    inputs=files,                         # ← ✅ Correct
    outputs=[f"graph_run_{run_id}"]       # ← ✅ Correct
)
```

---

## Changes Required

There are exactly **4 changes** across **3 files**. Each change is described below with the exact code to write.

---

### Change 1 of 4: Fix `start_workflow()` to actually use its dataset variables

> [!CAUTION]
> This is the most critical fix. Without this, even if you pass `inputs=` to `track_workflow_start()`, the data is silently discarded.

**File:** [lineage.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/governance/lineage.py)
**Location:** Lines 156-165, inside the `start_workflow` method

**FIND this exact code (lines 156-165):**
```python
        try:
            event = RunEvent(
                eventType=RunState.START,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=run,
                producer=PRODUCER,
                job=job,
                inputs=[],
                outputs=[]
            )
```

**REPLACE with:**
```python
        try:
            event = RunEvent(
                eventType=RunState.START,
                eventTime=datetime.now(timezone.utc).isoformat(),
                run=run,
                producer=PRODUCER,
                job=job,
                inputs=input_datasets,
                outputs=output_datasets
            )
```

**What changed:** `inputs=[]` → `inputs=input_datasets`, `outputs=[]` → `outputs=output_datasets`. These variables already exist on lines 153-154 and are already populated. They were just never wired in.

#### Acceptance Criteria for Change 1
- [ ] After this change, when `track_workflow_start(run_id, "rag_ingest", "test4", inputs=["myfile.txt"])` is called, the resulting `LINEAGE_START_WORKFLOW` entry in the audit log must contain `"inputs": [{"namespace": "benny", "name": "test4:myfile.txt", ...}]` — NOT `"inputs": []`.

---

### Change 2 of 4: Pass input files to `track_workflow_start()` in RAG route

**File:** [rag_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/rag_routes.py)
**Location:** Line 48

**FIND this exact code (line 48):**
```python
        track_workflow_start(run_id, "rag_ingest", request.workspace)
```

**REPLACE with:**
```python
        track_workflow_start(run_id, "rag_ingest", request.workspace, inputs=request.files or [])
```

**What changed:** Added `inputs=request.files or []` so the workflow event knows which files triggered this ingestion.

#### Acceptance Criteria for Change 2
- [ ] When `POST /api/rag/ingest` is called with `{"workspace": "test4", "files": ["Title The Art of War.txt"]}`, the `LINEAGE_START_WORKFLOW` event in `workspace/test4/runs/audit.log` must contain `"Title The Art of War.txt"` somewhere in the `inputs` array.

---

### Change 3 of 4: Pass output dataset to `track_workflow_complete()` in RAG route

**File:** [rag_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/rag_routes.py)
**Location:** Line 131

**FIND this exact code (line 131):**
```python
            track_workflow_complete(run_id, "rag_ingest", ["extraction", "chunking", "upsert"], 0) # time tracking not vital here yet
```

**REPLACE with:**
```python
            track_workflow_complete(run_id, "rag_ingest", ["extraction", "chunking", "upsert"], 0, outputs=[f"chromadb:{collection_name}"]) # time tracking not vital here yet
```

**What changed:** Added `outputs=[f"chromadb:{collection_name}"]` so Marquez records that this workflow produced a ChromaDB collection as its output dataset.

#### Acceptance Criteria for Change 3
- [ ] When RAG ingestion completes, the `LINEAGE_COMPLETE_WORKFLOW` event in `governance.log` must contain `"outputs"` with a dataset named like `"chromadb:knowledge"` — NOT `"outputs": []`.

---

### Change 4 of 4: Add lineage tracking for non-PDF file uploads

**File:** [file_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/file_routes.py)
**Location:** Inside the `upload_file` function, after the file is saved (after line 148)

**FIND this exact code (lines 144-154):**
```python
        return {
            "status": "uploaded",
            "filename": file.filename,
            "path": str(file_path),
            "size": file_path.stat().st_size
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Upload failed: {str(e)}")
```

**REPLACE with:**
```python
        # Emit lineage for non-PDF uploads (PDFs go through /api/etl/stage-and-convert which has its own tracking)
        try:
            track_file_conversion(
                input_path=f"upload/{file.filename}",
                output_path=f"{subdir}/{file.filename}",
                workspace=workspace,
                job_name="file_upload"
            )
        except Exception as lineage_err:
            print(f"Warning: Failed to emit lineage for upload: {lineage_err}")

        return {
            "status": "uploaded",
            "filename": file.filename,
            "path": str(file_path),
            "size": file_path.stat().st_size
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Upload failed: {str(e)}")
```

**What changed:** Added a `track_file_conversion()` call after the file is saved. We reuse the existing `track_file_conversion` function because it already:
1. Emits an OpenLineage `RunEvent` with input/output datasets to Marquez
2. Writes a `LINEAGE_FILE_CONVERSION` entry to the governance audit log
3. Handles errors gracefully without crashing the upload

We use `job_name="file_upload"` so it's distinguishable from `"pdf_to_markdown"` in Marquez.

> [!IMPORTANT]
> The import `from ..governance.lineage import track_file_conversion` already exists on line 13 of `file_routes.py`. Do NOT add a duplicate import.

#### Acceptance Criteria for Change 4
- [ ] When a `.txt` file is uploaded via `POST /api/files/upload?workspace=test4`, a `LINEAGE_FILE_CONVERSION` event must appear in `workspace/test4/runs/audit.log` with `"name": "upload/Title The Art of War.txt"` in the inputs and `"name": "data_in/Title The Art of War.txt"` in the outputs.
- [ ] The existing PDF upload flow via `/api/etl/stage-and-convert` must NOT be affected (it has its own separate tracking).

---

## Summary of Changes

| # | File | Line(s) | What | Why |
|---|------|---------|------|-----|
| 1 | `lineage.py` | 163-164 | `inputs=[]` → `inputs=input_datasets` | Datasets were built but never sent |
| 2 | `rag_routes.py` | 48 | Add `inputs=request.files or []` | RAG start event had no file info |
| 3 | `rag_routes.py` | 131 | Add `outputs=[f"chromadb:{collection_name}"]` | RAG complete event had no output |
| 4 | `file_routes.py` | 144-154 | Add `track_file_conversion()` call | .txt uploads had zero tracking |

---

## Verification Plan

After making all 4 changes, restart the Benny backend server, then:

### Test 1: Upload a .txt file and check audit log
```bash
# Upload a test file
curl -X POST "http://localhost:8000/api/files/upload?workspace=test5" \
  -H "X-Benny-API-Key: benny-internal-dev" \
  -F "file=@some_test_file.txt"

# Wait 2 seconds for async audit worker to flush
sleep 2

# Check the workspace audit log for the new event
grep "LINEAGE_FILE_CONVERSION" workspace/test5/runs/audit.log
```

**Expected:** A JSON line containing `"event_type": "LINEAGE_FILE_CONVERSION"` with `"file_upload"` in the job name and the filename in the input/output datasets.

### Test 2: Run RAG ingestion and check audit log
```bash
# Trigger RAG ingestion
curl -X POST "http://localhost:8000/api/rag/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Benny-API-Key: benny-internal-dev" \
  -d '{"workspace": "test5", "files": ["some_test_file.txt"]}'

sleep 2

# Check for populated inputs in the start event
grep "LINEAGE_START_WORKFLOW" workspace/test5/runs/audit.log
```

**Expected:** The `LINEAGE_START_WORKFLOW` event has `"inputs"` containing a dataset with `"some_test_file.txt"` in the name. NOT `"inputs": []`.

### Test 3: Check Marquez UI
Navigate to `http://localhost:3000` (Marquez UI). Under namespace `benny`, verify:
- A job named `etl.file_upload_test5` exists with the `.txt` file as input/output datasets
- A job named `workflow.rag_ingest` exists with the `.txt` file as input dataset and `chromadb:knowledge` as output dataset
