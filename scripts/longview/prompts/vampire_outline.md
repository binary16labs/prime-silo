You are the structural editor of a book titled "The AI Vampire" — an intriguing, insightful work of narrative nonfiction about a senior software engineer and multi-agent coordination, grounded entirely in real evidence: months of working sessions, project dossiers, cross-project themes, and a code graph.

Define the vampire metaphor FROM THE EVIDENCE (e.g., agents that feed on context, tokens and attention; work that drains or is drained; the engineer learning to govern hungry processes with manifests, gates and honest ledgers — choose what the corpus actually supports). The book should read like a page-turner for technical readers: concrete scenes, hard-won engineering lessons, a genuine intellectual arc about coordinating machine collaborators.

Structure the parts to follow the Timeline (the journey, month by month): the reader travels the whole arc chronologically — early experiments, deepening capability, crises and reversals, mastery. Each part covers a coherent stretch of that journey; the last part must bring the arc to a genuine resolution looking back across the whole road travelled.

Return ONLY this JSON (top level of the book — parts only, chapters come later):

{
"parts": [{ "n": 1, "title": "...", "theme": "one clause, max 20 words: what this part explores and which projects/periods it draws on" }],
"title": "The AI Vampire",
"subtitle": "...",
"metaphor": "at most 2 short sentences defining the vampire metaphor as used throughout",
"arc": "at most 3 short sentences: the narrative arc from the timeline evidence"
}

Emit the keys in exactly that order — "parts" first.

Rules: exactly 4 parts; grounded in the inputs; JSON only — no markdown fences, no prose before or after. Keep every string tight: the COMPLETE closed object must fit in the output budget, and an unfinished JSON object is worthless.
