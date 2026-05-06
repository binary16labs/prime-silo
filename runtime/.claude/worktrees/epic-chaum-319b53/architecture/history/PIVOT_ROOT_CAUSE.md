# Architecture Pivot Workflow Failure - Root Cause Analysis

**Status**: Failed consistently since 2026-04-11 10:39:04  
**Latest Failure**: `run-333914f2` at 2026-04-11T11:40:03  
**Error**: `[Errno 13] Permission denied: 'C:\\Users\\nsdha\\OneDrive\\code\\benny\\workspace\\test4\\data_in'`

---

## Root Cause

### The Problem
The workflow "architecture pivot" has a **data node (input_0)** that is misconfigured:

```json
{
  "label": "FrolovRoutledge2024.md",
  "config": {
    "operation": "read"
  }
}
```

**Missing: `path` field in config!**

### What Happens
In [studio_executor.py](benny/api/studio_executor.py#L253-L264):

```python
elif operation == "read":
    filename = config.get("path", "")  # ← Gets EMPTY STRING DEFAULT
    try:
        path = get_workspace_path(workspace, "data_in") / filename  # Path / "" = directory itself!
        if not path.exists():
            path = get_workspace_path(workspace, "data_out") / filename
        if path.exists():
            content = path.read_text(encoding="utf-8")  # ← Tries to read DIRECTORY as text file!
            return {"content": content, "filename": filename}
```

When `filename=""`, the code attempts to:
1. `Path("test4/data_in") / ""` → returns `Path("test4/data_in")`  
2. Tries to read the directory as a text file → **Permission Denied**
3. Python can't read directories as files, hence the error

### Why This Happens
The node configuration is missing the **`path` field** that tells it which file to read. It has:
- ✓ `label`: "FrolovRoutledge2024.md" (display name only)
- ✗ `config.path`: (MISSING - required for "read" operation)

The `label` is just UI display text, NOT the actual file path.

---

## Evidence from Audit Log

```json
{
  "event_type": "NODE_EXECUTION_STATE",
  "data": {
    "node_id": "input_0",
    "status": "error",
    "inputs": {
      "node_config": {
        "label": "FrolovRoutledge2024.md",
        "config": {
          "operation": "read"
        }
      }
    },
    "error": "[Errno 13] Permission denied: 'C:\\Users\\nsdha\\OneDrive\\code\\benny\\workspace\\test4\\data_in'"
  }
}
```

---

## Solution

### Option 1: Use `label` as Fallback (Quick Fix)
Update [studio_executor.py](benny/api/studio_executor.py#L253-L264) to use label if path is missing:

```python
elif operation == "read":
    # Use 'path' from config, fallback to 'label' if not specified
    filename = config.get("path") or node.data.get("label", "")
    if not filename:
        return {"error": "No filename specified in path or label"}
    try:
        path = get_workspace_path(workspace, "data_in") / filename
        if not path.exists():
            path = get_workspace_path(workspace, "data_out") / filename
        if path.exists():
            content = path.read_text(encoding="utf-8")
            return {"content": content, "filename": filename}
        return {"error": f"File not found: {filename}"}
    except Exception as e:
        return {"error": str(e)}
```

### Option 2: Fix the Workflow Design (Recommended)
Ensure that in Studio UI, when creating a data node with "read" operation, the `config.path` field is properly populated:

```json
{
  "label": "FrolovRoutledge2024.md",
  "config": {
    "operation": "read",
    "path": "FrolovRoutledge2024.md"
  }
}
```

---

## Symptoms (All Failed Runs)

| Run ID | Time | Error |
|--------|------|-------|
| run-b8c06af3 | 11:39:04 | Permission denied on data_in |
| run-333914f2 | 11:40:03 | Permission denied on data_in |
| run-61fa6ccb | 09:40:44 | Initialization error (pre-fix) |
| run-3aea04b9 | 10:11:53 | Initialization error (pre-fix) |

All follow same pattern:
- Data node (input_0) tries to read
- Config is incomplete (missing `path` field)
- Defaults to empty filename
- Attempts to read entire directory as file
- Permission Denied error

---

## Implementation Plan

### Step 1: Immediate Fix (Code)
Add fallback to use `node.data.label` if `config.path` is missing.

### Step 2: Validation Fix
In the data node executor, validate that:
- Operation "read" has a valid filename (not empty)
- The file exists before attempting to read

### Step 3: UI Guidance
Update Studio UI to:
- Warn if "read" operation has no path configured
- Auto-populate path from label suggestion
- Show available files as dropdown

---

## Testing After Fix

```python
# This should now work:
node_config = {
    "label": "FrolovRoutledge2024.md",
    "config": {
        "operation": "read",
        "path": "FrolovRoutledge2024.md"  # Now explicitly set!
    }
}
```

Expected: Successfully reads file and returns content.

---

## Key Takeaway

✗ **Before**: Node config missing required `path` field  
→ Defaults to empty string  
→ Code tries to read directory as file  
→ Permission Denied  

✓ **After**: Ensure `path` field present OR fallback to `label`  
→ Reads actual file  
→ Returns content successfully  

