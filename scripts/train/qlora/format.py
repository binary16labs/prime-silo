"""Shared row -> chat formatting for T3 (training AND eval import this one file).

The whole point of keeping a single module is that the eval NLL must be computed over
*exactly* the chat template the model was trained on — otherwise a base-vs-tuned delta
could be an artifact of prompt drift rather than the fine-tune. Training builds SFT text
with `to_text`; eval builds masked (input_ids, labels) with `encode_nll` and prompt ids
with `prompt_ids` — all three go through the same `build_messages`.

No system prompt is injected: the tuned model must produce house voice / correct tool
calls from its weights, not because the prompt told it to. RAG is disabled the same way
— the model sees only the instruction (Stream A) or state+goal (Stream B), never retrieved
context. Both properties are what make the T3 number the fine-tune's *own* contribution.
"""

import json

IGNORE = -100  # HF/torch cross-entropy ignore index (prompt tokens are masked out)

_STREAM_B_USER = (
    "State:\n{state}\n\nGoal: {goal}\n\n"
    'Respond with the next tool call as a JSON object with keys "name" and "args".'
)


def _tool_call_json(row):
    tc = row["tool_call"]
    # Stable key order so the reference string is deterministic across runs.
    return json.dumps({"name": tc["name"], "args": tc["args"]}, ensure_ascii=False)


def build_messages(row):
    """Return (user_content, assistant_content) for a Stream A, B or L row."""
    stream = row.get("stream")
    if stream == "A":
        return row["instruction"], row["response"]
    if stream == "B":
        user = _STREAM_B_USER.format(state=row["state"], goal=row["goal"])
        return user, _tool_call_json(row)
    if stream == "L":
        # LONGVIEW distillation (P5) — UNLIKE A/B this is a PROMPTED extraction task: the
        # window_fragment instruction defines the output schema, so it must be present (the ladder
        # bench serves it too). Gemma's chat template folds a system role into the first user turn
        # anyway, so we fold it here — template-agnostic and consistent with how LM Studio renders
        # {system,user} at serve time. Target is the 12B teacher's fragment.
        return f"{row['system']}\n\n--- SLICE ---\n{row['user']}", row["response"]
    if stream == "T":
        # EP-A tool-use distillation — like L, a PROMPTED task: the system prompt defines the
        # agent's job + the {"name","input"} response contract, and user is the transcript so far.
        # Fold system into the user turn (template-agnostic; consistent with L and with how the
        # agent is served). Target is the next tool call the corpus actually made — in EITHER
        # dialect (Claude Code or Antigravity); both are kept on purpose.
        return f"{row['system']}\n\n--- TRANSCRIPT ---\n{row['user']}", row["response"]
    raise ValueError(f"unknown stream {stream!r} in row {row.get('id')!r}")


def to_text(row, tokenizer):
    """Full chat string (user + assistant) for the SFT 'text' field."""
    user, assistant = build_messages(row)
    msgs = [
        {"role": "user", "content": user},
        {"role": "assistant", "content": assistant},
    ]
    return tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)


def prompt_ids(row, tokenizer):
    """Prompt-only token ids (up to the assistant generation prompt) for greedy decode."""
    user, _ = build_messages(row)
    return tokenizer.apply_chat_template(
        [{"role": "user", "content": user}],
        tokenize=True,
        add_generation_prompt=True,
    )


def encode_nll(row, tokenizer, max_len):
    """(input_ids, labels) for held-out NLL: labels = IGNORE on the prompt, real ids on
    the reference completion. Left-truncate the prompt if the pair exceeds max_len so the
    completion we score is never clipped (unless the completion alone is longer than max_len,
    in which case we clip its tail — rare for our short rows)."""
    user, assistant = build_messages(row)
    p_ids = tokenizer.apply_chat_template(
        [{"role": "user", "content": user}],
        tokenize=True,
        add_generation_prompt=True,
    )
    full_ids = tokenizer.apply_chat_template(
        [
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant},
        ],
        tokenize=True,
        add_generation_prompt=False,
    )
    # apply_chat_template(add_generation_prompt=True) is a prefix of the full render, so the
    # completion is the suffix past the prompt length.
    n_prompt = len(p_ids)
    comp_ids = full_ids[n_prompt:]
    if not comp_ids:  # degenerate; should not happen with a non-empty assistant turn
        comp_ids = full_ids[-1:]
        n_prompt = len(full_ids) - 1

    if len(full_ids) > max_len:
        overflow = len(full_ids) - max_len
        if overflow < n_prompt:
            # drop from the front of the prompt, keep the whole completion
            p_ids = p_ids[overflow:]
            n_prompt = len(p_ids)
            input_ids = p_ids + comp_ids
        else:
            # completion itself is too long: keep the last max_len completion tokens
            comp_ids = comp_ids[-max_len:]
            p_ids = []
            n_prompt = 0
            input_ids = comp_ids
    else:
        input_ids = full_ids

    labels = [IGNORE] * n_prompt + list(comp_ids)
    # guard: labels and input_ids must align
    labels = labels[: len(input_ids)]
    return input_ids, labels


def ref_tool_name(row):
    """Reference tool name for Stream B (secondary tool-name match metric)."""
    if row.get("stream") != "B":
        return None
    return row["tool_call"]["name"]


def parse_emitted_tool_name(text):
    """Best-effort: extract the tool name from a model's greedy-decoded completion.
    Finds the first JSON object with a 'name' key. Returns None if unparseable."""
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                blob = text[start : i + 1]
                try:
                    obj = json.loads(blob)
                except json.JSONDecodeError:
                    start = -1
                    continue
                if isinstance(obj, dict) and "name" in obj:
                    return str(obj["name"])
                start = -1
    return None
