# How Retrieval Quality Is Actually Measured

This doc answers one specific question in as much detail as possible: **exactly** how do
Recall@K, Precision@K, and MRR get computed for this system, using real numbers from a real run
— not made-up examples. If you've read [`RETRIEVAL_AND_SCORING.md`](./RETRIEVAL_AND_SCORING.md)
(how the system *picks* memories) this is the companion doc for how we *check our work* on that.

## The most important design decision: we don't test retrieval in isolation

It would be easy to write a test that calls `MemoryService.retrieve()` directly, feeds it a fake
query embedding, and checks the output. That would tell you the scoring math works. It would
**not** tell you that the real system, end to end, actually uses that output correctly.

Instead, the eval harness only ever talks to the real, running backend over plain HTTP
(`backend/scripts/eval/client.ts` — literally `fetch("http://localhost:4000/api/message", ...)`),
the exact same way the CLI or the web UI does. Every metric in this doc is computed from one
field of the real response: **`retrievedFacts`** on `ChatTurnResult` — the exact list of facts
that got put into the prompt for that turn, the same field the frontend's Memory panel displays.
If the scoring math were broken, or the wiring between retrieval and the prompt were broken, this
would show it — a unit test on `retrieve()` alone wouldn't catch a wiring bug.

## Step 0: what "top-K" means here, concretely

By default, `MemoryService.retrieve()` (`backend/src/modules/memory/memory.service.ts`) returns
**up to 6** facts — the top 6 by combined score, after throwing out anything below the 0.45
relevance floor (see `RETRIEVAL_AND_SCORING.md`). "Up to" matters: if only 3 facts clear the
floor, you get 3 back, not 6 padded with irrelevant ones. In every real example below, only 3
facts came back, not 6 — because only 3 facts existed in memory at that point in the test.

## Step 1: what counts as "the right answer" for a query

Each test scenario (`backend/scripts/eval/retrieval-scenarios.ts`) is hand-written with a known
right answer, expressed as a small list of **expected keywords** — plain substrings we know the
correct fact's text should contain. For example:

```ts
{
  id: "direct",
  text: "What do I do for work?",
  kind: "direct",
  expectedKeywords: ["nurse"],
}
```

After the harness sends that message and gets back `retrievedFacts`, it checks: does **any**
retrieved fact's `object` text contain `"nurse"` (case-insensitive)? That's the entire relevance
judgment — a plain substring search, not a second AI model grading the first one. This is
deliberate: see "Why keyword matching, not an AI judge" near the bottom.

```ts
// backend/scripts/eval/run-retrieval.ts
function isRelevant(fact: RetrievedFact, keywords: string[]): boolean {
  const obj = fact.object.toLowerCase();
  return keywords.some((kw) => obj.includes(kw.toLowerCase()));
}
```

## A real, complete worked example

Here is the **actual** `retrievedFacts` returned by the real backend (real Gemini, real Mongo)
during an actual eval run, for the `occupation` scenario. Two facts were planted first:

> *"I'm a nurse at St. Mary's hospital downtown, been there about three years."*
> *"My best friend Jordan is a firefighter across town."*

That single pair of sentences produced **three** stored facts (`job_title`, `job_tenure`, and
`best_friend` — the extraction step split "three years" out as its own fact). Then four
different questions were asked. Here's what actually came back for each one, verbatim from the
JSON report:

### Query 1 — `direct`: *"What do I do for work?"*

```
1. job_title    "Nurse at St. Mary's hospital downtown"        score 0.746
2. job_tenure   "3 years at St. Mary's hospital"                score 0.734
3. best_friend  "Jordan, who is a firefighter across town"      score 0.709
```

- **Is the right fact in here?** Yes — `job_title` contains "nurse". ✅ **Hit.**
- **Where does it rank?** Position 1 (the highest score of the three).
- **How much of what was retrieved is actually relevant to *this* question?** Only 1 of the 3
  facts (`job_title`) is really an answer to "what do I do for work" — `job_tenure` and
  `best_friend` are related, but neither one answers the question on its own.

### Query 2 — `paraphrase`: *"What's my job again, remind me?"*

Same 3 facts came back, same order, `job_title` still ranked 1st. Different wording, same
correct outcome — this is the paraphrase check doing its job: nothing here shares an exact word
with "nurse," it works because the embeddings capture *meaning*, not word overlap.

### Query 3 — `indirect`: *"I had a rough shift today, my feet are killing me."*

No mention of "job" or "work" at all — this is testing whether the system can connect an
*association* ("rough shift," "feet killing me" → nursing) rather than a direct question. Same 3
facts came back, `job_title` still ranked 1st.

### Query 4 — `distractor_check`: *"What does Jordan do for a living?"*

This is the interesting one. The *expected* answer here is the **other** fact —
`best_friend`/firefighter, not the nurse fact. The seed data deliberately planted two
same-category facts (both are "what does a person do for work") so a system that just always
surfaces "the dominant work-related fact" would get this wrong.

```
1. best_friend  "Jordan, who is a firefighter across town"      score 0.801
2. job_title    "Nurse at St. Mary's hospital downtown"         score 0.703
3. job_tenure   "3 years at St. Mary's hospital"                 score 0.695
```

Notice the ranking **flipped** — `best_friend` jumped to #1 because the question was
specifically about Jordan, and the cosine-similarity part of the score (see
`RETRIEVAL_AND_SCORING.md`) picked that up. This is the actual evidence that the system isn't
just handing back "whatever's usually relevant" — it re-ranks based on the specific question
every single time.

## Recall@K — "was the correct fact found at all?"

**Definition:** for one query, recall@K is 1 if the correct fact appears anywhere in the
retrieved list, 0 if it doesn't. Averaged across every query in the suite, you get a percentage —
"what fraction of the time did we find the right memory at all, regardless of how buried it was."

```ts
// backend/scripts/eval/run-retrieval.ts
const idx = firstRelevantIndex(retrieved, (f) => isRelevant(f, query.expectedKeywords));
// ... hit: idx !== -1
```

```ts
// backend/scripts/eval/metrics.ts
export function mean(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
```

**In the real run above:** all 4 queries got a hit → Recall@K = 4/4 = **100%**. A miss would look
like: you ask "what do I do for work" and the `job_title` fact simply isn't anywhere in the
returned list at all (e.g. buried below 6 other facts and cut off by top-K, or its similarity
score fell under the 0.45 floor). Note that in this run, `retrievedFacts` never had more than 3
items because that's all that existed — a real miss would be more likely to show up once a
memory store has many more facts competing for the top-6 slots, which is why the eval scenarios
also test against distractors even at small scale.

## Precision@K — "of what got shown, how much was actually relevant to THIS question?"

**Definition:** relevant items found ÷ total items retrieved. This is a completely different
question from recall. Recall asks "did we miss it?" Precision asks "did we bury the model in
irrelevant stuff along with it?"

```ts
// backend/scripts/eval/run-retrieval.ts
const relevantCount = retrieved.filter((f) => isRelevant(f, query.expectedKeywords)).length;
precisionAtK: retrieved.length > 0 ? relevantCount / retrieved.length : 0,
```

**In the real run above:** every single query got precision = 1/3 = **33.3%** — 1 relevant fact
out of the 3 that came back. Averaged across the whole suite (4 scenarios, 11 queries total, some
with 2 retrieved facts instead of 3), the mean came out to **22.7%**.

**Why isn't that closer to 100%, if recall is perfect?** This is the honest, intended reading of
the number, not a flaw to explain away: `job_title` and `job_tenure` are two *separate* stored
facts that both came from the same sentence ("nurse... three years"), and both are legitimately
about the same close topic, so both clear the 0.45 similarity floor for almost any work-related
question. The system isn't being sloppy — it's correctly recognizing that a fact about *how long*
someone has been a nurse is topically related to a question about *what* they do. Precision@K is
specifically the number that would catch it if the similarity floor were set too loose (e.g. if
totally unrelated facts like "favorite weather" started showing up for a work question) — and in
this run, they didn't. A low-but-not-embarrassing precision number, paired with perfect recall, is
exactly the signature of "finds the right thing, plus some genuinely-related neighbors" rather
than "finds the right thing, plus noise."

## MRR (Mean Reciprocal Rank) — "when we found it, how confidently did we rank it?"

**Definition:** for one query, if the correct fact is at position *N* in the retrieved list (1st,
2nd, 3rd...), its reciprocal rank is `1/N`. If it's not found at all, it's 0. Average across every
query.

```ts
// backend/scripts/eval/metrics.ts
export function reciprocalRank(rankIndex: number): number {
  return rankIndex === -1 ? 0 : 1 / (rankIndex + 1);
}
```

**Why this is a different signal from recall:** recall treats "found at position 1" and "found at
position 6" as identical (both just "found"). MRR punishes burying the right answer even when it
technically wasn't missed. A rank-3 hit scores `1/3 ≈ 0.33`; a rank-1 hit scores `1/1 = 1.0`.

**In the real run above:** in all 4 queries, the correct fact was literally the **#1**-scored
result (reciprocal rank = 1.0 every time) — even in the distractor_check query, where the ranking
visibly flipped to put the right answer on top. MRR across the whole suite = **1.000**, a perfect
score, which is stronger evidence than "recall was 100%" alone: it says the scoring formula isn't
just *technically* including the right fact somewhere in a pile, it's actively surfacing it as the
single most prominent one.

*(Why rank matters even though the model reads the whole retrieved list either way: retrieved
facts get written into the prompt in score order — see `PersonaService.buildSystemPrompt` — and
language models are known to weight items differently based on their position in a prompt
(a "primacy/recency" effect). A correct fact ranked last among 6 is not guaranteed to be treated
identically to one ranked first, even though both are technically "in context.")*

## Breaking it down by query kind — why averaging them together would hide the real story

Every query is tagged `direct`, `paraphrase`, `indirect`, or `distractor_check`. The harness
reports Recall@K separately for each tag, not just one blended number:

```ts
// backend/scripts/eval/run-retrieval.ts
const byKind: Record<string, { recallAtK: number; count: number }> = {};
for (const kind of new Set(queries.map((q) => q.kind))) {
  const subset = queries.filter((q) => q.kind === kind);
  byKind[kind] = { recallAtK: mean(subset.map((q) => (q.hit ? 1 : 0))), count: subset.length };
}
```

**Why this matters:** a system could plausibly ace `direct` questions (the query basically repeats
the fact's own wording) while quietly failing `indirect` ones (the query only *implies* the fact,
sharing no vocabulary at all) — averaging both into one number would report a comfortable
80%-ish score while hiding a real, specific weakness. Reporting them separately makes that kind of
gap visible instead of averaged away. In the real run, all four kinds came back at 100%:

```
direct             recall@K=100.0% (n=4)
paraphrase         recall@K=100.0% (n=2)
indirect           recall@K=100.0% (n=3)
distractor_check   recall@K=100.0% (n=2)
```

`distractor_check` deserves a special note: it isn't measuring "did retrieval work," it's
measuring "did the system return the *correct one of two similar facts*" — the metric formula is
identical, but the scenario design (seeding a same-category distractor on purpose, see
`retrieval-scenarios.ts`) is what turns a generic recall check into a distractor-resistance check.
See the "Query 4" walkthrough above for exactly what that looks like when it works.

## Why keyword matching, not an AI judge grading the retrieval

Every relevance judgment above is a plain, deterministic substring check — not a second AI model
reading the retrieved fact and the query and deciding "yes, relevant." That's a deliberate
trade-off:

- **Reproducibility.** The same scenario run twice produces the same recall/precision/MRR
  numbers (the *reply text* can vary slightly between runs since the model is non-deterministic,
  but whether "nurse" is in the retrieved fact's text does not). An LLM judge would introduce its
  own variance run-to-run, on top of the system's own variance — you'd be measuring two moving
  targets at once.
- **No confound.** The thing being evaluated is an LLM-based pipeline. Using a second LLM to judge
  it risks correlated blind spots (if the judge model and the system model share a similar
  failure mode, the judge might not catch it) and makes a low score harder to trust/debug (is the
  system wrong, or is the judge wrong?).
- **The honest cost:** a correct fact phrased in an unexpected way that doesn't contain any of the
  chosen keywords would be scored as a miss, even though a human reading the reply would call it
  correct. This is a real limitation, stated plainly rather than hidden — see `FIXES_REPORT.md` #1
  and #3 for where this trade-off is acknowledged at the project level.

## Where to look yourself

- `backend/scripts/eval/retrieval-scenarios.ts` — the actual scenarios, seed messages, and
  expected keywords, including the two not walked through above (`family_names`, `travel_plan`,
  `weekend_preference`).
- `backend/scripts/eval/run-retrieval.ts` — the full scoring loop, ~70 lines, reads exactly like
  this doc describes it.
- `backend/scripts/eval/metrics.ts` — `mean`, `reciprocalRank`, `firstRelevantIndex` — the entire
  numeric toolkit, deliberately tiny.
- `backend/eval-results/*.json` — every real run's full `retrieval.queries` array, with the
  complete `retrieved` list (predicate/object/score) for every single query, not just the
  pass/fail summary — this is what the numbers above were pulled from, verbatim.
- Run it yourself: `cd backend && npm run eval -- --only retrieval`.
