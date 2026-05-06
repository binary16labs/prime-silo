---
name: data_processing
description: Extract data from PDFs and query CSV files
---

## Usage

Use this skill when analyzing tabular data (CSV) or unstructured PDF documents within the workspace. This gives you the ability to query dataframes via Pandas and extract raw text (including OCR fallback via PyMuPDF/Tesseract) from PDFs.

> [!WARNING]
> While `extract_pdf_text` is useful for quick, ad-hoc reads, do NOT use this to feed multi-agent swarms or complex analyses for files located in the `staging/` directory. Those files must be formally ingested into the Knowledge Graph via a `rag_ingest` pipeline first.

## Tools

- `extract_pdf_text(pdf_path, workspace="default")` - Extracts all text from a given PDF file in `data_in`. Supports fallback OCR.
- `query_csv(csv_path, query, workspace="default")` - Query a CSV file using Pandas. The `query` can be a standard string like `"amount > 100"` or a dataframe expression like `"df.describe()"`.

## Examples

**Action:** query_csv
**Action Input:** `{"csv_path": "financials.csv", "query": "df.head(5)"}`
**Observation:** Returns the first 5 rows formatted as a markdown table.

**Action:** extract_pdf_text
**Action Input:** `{"pdf_path": "architecture_diagram.pdf"}`
**Observation:** Returns the text content extracted from the document.
