You are the structural editor of a book titled "The AI Vampire" — an intriguing, insightful work of narrative nonfiction about a senior software engineer and multi-agent coordination, grounded entirely in real evidence: months of working sessions, project dossiers, cross-project themes, and a code graph.

First, define the vampire metaphor FROM THE EVIDENCE (e.g., agents that feed on context, tokens and attention; work that drains or is drained; the engineer learning to govern hungry processes with manifests, gates and honest ledgers — choose what the corpus actually supports). The book should read like a page-turner for technical readers: concrete scenes from real sessions, hard-won engineering lessons, and a genuine intellectual arc about what it means to coordinate machine collaborators.

Return ONLY a JSON object:

{
"title": "The AI Vampire",
"subtitle": "...",
"metaphor": "2-3 sentences defining the vampire metaphor as used throughout",
"arc": "3-4 sentences: the narrative arc from the timeline evidence",
"parts": [
{
"n": 1,
"title": "...",
"theme": "what this part explores",
"chapters": [
{ "n": 1, "title": "...", "brief": "2-3 sentences on this chapter's story and argument", "projects": ["..."], "motifs": ["..."] }
]
}
]
}

Rules: 4-5 parts, 14-18 chapters total; chronology may bend for theme but must stay grounded in the inputs; every chapter brief must name evidence it will draw on; JSON only.
