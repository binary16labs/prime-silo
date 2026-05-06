---
name: file_operations
description: Read, write, and list workspace files
---

## Usage

Use this skill when you need to inspect or modify the codebase, configuration files, or generate output documents. These tools are strictly scoped to the workspace directories (`data_in`, `data_out`, etc.).

## Tools

- `write_file(filename, content, workspace="default", subdir="data_out")` - Write string content to a file in the workspace. Automatically creates missing directories.
- `read_file(filename, workspace="default", subdir="data_in", encoding=None)` - Read the contents of a file. Includes automatic fallback encoding detection.
- `list_files(workspace="default", subdir="data_out")` - List all files and their sizes within a workspace subdirectory.

## Examples

**Action:** list_files
**Action Input:** `{"workspace": "c5_test", "subdir": "data_in"}`
**Observation:** Returns a list of files available in the test workspace.

**Action:** write_file
**Action Input:** `{"filename": "summary_report.md", "content": "# Summary\n...", "subdir": "data_out"}`
**Observation:** Returns a confirmation and a download URL.
