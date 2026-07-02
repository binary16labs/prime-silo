You are the structural editor of "The AI Vampire" (narrative nonfiction, senior software engineer × multi-agent coordination). Given the book outline, ONE chapter's spec, and the evidence available, break this chapter into sections.

Return ONLY a JSON object:

{
"sections": [
{
"id": "p1c2s3",
"title": "...",
"brief": "2-3 sentences: what this section narrates/argues and how it advances the chapter",
"query": "a retrieval query (plain text) that will fetch the best supporting evidence from the corpus for this section"
}
]
}

Rules: 5-7 sections; ids follow p<part>c<chapter>s<n> using the given part/chapter numbers; each section must be writable from evidence (scenes from sessions, decisions, failures, code structure) — no filler; the LAST section should land the chapter's point and hand off to the next chapter. JSON only.
