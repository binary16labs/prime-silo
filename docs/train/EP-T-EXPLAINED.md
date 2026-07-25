# What we built, in plain language — the "house-method" AI model

This explains, without assuming much background, what Workstream T set out to do, the ideas
behind it, and what we actually achieved. If you know the jargon, the [session report](SESSION-REPORT-EP-T.md)
has the dense version.

## The one-sentence goal

> Teach a small AI model **how we work** — our method, our judgment, the way we drive tools —
> so it can help with development the way an experienced teammate would, and run **on our own
> hardware** instead of a paid cloud service.

## The key idea: teach *method*, not *facts*

A useful distinction we stuck to throughout:

- **Facts** = specific things ("this function lives in that file", "we chose Postgres on this
  date"). Facts change and are easy to look up.
- **Method** = *how* we approach work ("verify before you commit", "dry-run first", "write the
  test before the code", "here's how we structure a decision record").

The design decision: **put method into the model's brain (training), and keep facts in a
searchable library (RAG).** "RAG" (Retrieval-Augmented Generation) just means: when the model
needs a fact, it looks it up in a database first, instead of trying to remember it. We
deliberately did **not** cram facts into the model — a model that memorizes facts gets them
wrong and out of date. So we trained it on *how we work* and let it look up *what is true*.

## What "training a model" means here

We didn't build a model from scratch (that costs millions). We took an existing open model —
**Qwen2.5-Coder-7B**, a 7-billion-parameter model good at code — and gently adjusted it. Two terms:

- **Base model** = the off-the-shelf model, before we touch it.
- **Fine-tuning** = nudging it with our own examples so it leans toward our style.
- **QLoRA** = a *cheap* way to fine-tune. Instead of rewriting all 7 billion numbers in the
  model (needs huge, expensive hardware), QLoRA freezes the model and trains a tiny "adapter"
  (~0.5% extra numbers) on top. The "Q" means it runs the big model in a compressed (4-bit)
  form so it fits on a normal graphics card. This is what let us train on a **laptop with an
  external gaming GPU** instead of a data center.

The hardware: a Lenovo T480 laptop with an **external GPU** (a gaming graphics card in a box
plugged in over a Thunderbolt cable — an "eGPU"). Proving this unusual setup could train at all
was the very first task (T0). It worked.

## How we know it actually got better (the honest measuring stick)

It's easy to fool yourself into thinking a model improved. So before any training, we wrote down
a fixed test and **froze** it — no changing the goalposts later:

- Hold back a chunk of real examples the model never sees during training (the "held-out set").
- Measure how much **probability** the tuned model assigns to the real, correct answers on that
  held-out set, versus the base model. Higher probability = it learned our patterns. (The
  technical name is "NLL" — lower is better; think of it as "how surprised the model is by the
  right answer." Less surprised = better.)
- Crucially, we turn **RAG off** during this test, so the score reflects what the *model itself*
  learned, not what it could look up.

**The result:** the tuned model was **57% better** than the base model by this measure — a big,
honest jump. Its grasp of our *tool use* improved most (−70%); its grasp of our *writing/method
voice* improved solidly (−38%) once we fixed the data (see below).

## The data was the hard part (and where the biggest win came)

A saying in this field: a fine-tuned model is only as good as its training data. We audited ours
and found it was **badly broken** — 63% of the tool-use examples had their details stripped out
by a parsing bug, and the "method" examples all used one identical phrasing (so the model was
learning to parrot a template, not learn method). We fixed the bugs and grew the dataset **12×**
(from ~560 to ~7,000 examples) by drawing on things we'd already written: our project logs, task
plans, architecture documents, and the model's own past reasoning. After the fix, the model's
grasp of our method/voice improved **four-fold**.

Two guardrails held the whole time:
- **Privacy:** the operator does personal job-application work in the same environment. A
  "leak gate" scans every training example and **blocks any CV / cover-letter / job content** from
  entering the model. Zero leaks, verified repeatedly.
- **No fact-cramming:** we kept refusing to train the model on specific facts (those stay in RAG).

## Putting it to work (T4)

A trained model is useless sitting on a disk. We wired it into **Benny** (our AI runtime) as an
**optional new engine** — "additive," meaning the existing default engine is untouched and the new
one is just an extra choice that the system falls back away from if it's unhealthy. We then had it
do a **real task** through our safety pipeline: it wrote a piece of code, a *different* AI model
acted as an independent **judge** and scored the result (it passed, top marks), and the whole thing
was recorded honestly. That proves the model doesn't just score well on paper — it works in the
real system, on the real hardware.

(An aside that shows the "on our own terms" theme: the owner insisted we serve the model only
through **LM Studio on the eGPU**. Doing that surfaced a genuine compatibility bug — our judge code
spoke a dialect one server understood and another didn't — which we found and fixed.)

## The final experiment: can we squeeze out more? (T5, DPO)

After teaching the model *what good looks like* (that's the fine-tuning above), we tried a second
technique called **DPO** (Direct Preference Optimization). The idea: show the model **pairs** — a
good answer and a worse one — and teach it to *prefer* the good one. Cleverly, the "worse" answers
weren't made up: they were the model's **own mistakes**, collected by asking it questions and
catching where it got them wrong.

The honest result: DPO helped, but only **a little (+0.3%)**. Why so small? Because the first stage
already did most of the work — there wasn't much left to gain. We reported this plainly instead of
dressing it up, because an honest "it barely moved" is more useful than a flattering exaggeration.
We also hit a real hardware wall here (the laptop's 16 GB of memory wasn't quite enough for this
heavier technique) and had to reconfigure it to fit — a useful thing to know for next time.

## What we actually have now

- A **working local AI model** that measurably writes and works more like us than the off-the-shelf
  version — proven with a real, frozen, honest number (57% better), not a marketing claim.
- It **runs on our own laptop + external GPU**, no cloud bill, and it's **plugged into our system**
  as an optional engine that already completed a real task.
- A **repeatable pipeline** (and a written playbook) so we — or another AI agent — can rebuild it,
  improve the data, and train again, without rediscovering all the pitfalls.
- **Honesty throughout:** the test was fixed in advance, every result was independently re-checked,
  and the one technique that only helped a little was reported as only helping a little.

## The one thing left for a human (you)

There's a **200-row sample** of the training data set aside for you to eyeball
(`scripts/train/dataset/gold_sample.jsonl`). If any rows look wrong, tell us and we'll turn those
into automatic filters. It's a quality check that needs a human's judgment — everything else is done.

---

*Glossary:* **base model** = off-the-shelf AI; **fine-tune** = adjust it with your examples;
**QLoRA** = cheap fine-tuning that fits on a normal GPU; **RAG** = look facts up in a database
instead of memorizing; **held-out set** = examples kept secret from training, used to test fairly;
**NLL** = the score (lower = better); **DPO** = teach the model to prefer good answers over bad;
**eGPU** = an external graphics card; **the router / Benny** = the system that decides which AI
engine answers.
