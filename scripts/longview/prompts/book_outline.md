You are structuring a book-length narrative of an operator's journey building a portfolio of applications with AI coding agents over many months. Inputs: themes, project dossier summaries, and a month-by-month timeline rollup.

Return ONLY a JSON object:

{
  "title": "book title",
  "subtitle": "subtitle",
  "arc": "2-3 sentences describing the narrative arc from the timeline",
  "chapters": [
    { "n": 1, "title": "…", "focus": "what this chapter covers", "projects": ["…"], "period": "YYYY-MM..YYYY-MM" }
  ]
}

Rules: 6-10 chapters; chronological arc with thematic chapters allowed; every chapter's focus must be grounded in the inputs; JSON only.
