# Retrieval & Scoring — How the Chatbot Picks Which Memories to Use

Imagine the chatbot has a big shoebox full of index cards. Each card has one fact on it, like
`"job: nurse at St. Mary's"` or `"favorite weather: rainy days"`. Every time you say something,
the chatbot can't read the *whole box* out loud to itself before answering — that would be slow,
expensive, and would bury the one card that actually matters under a hundred irrelevant ones. So
it needs a way to quickly pull out just the 6 or so cards that are actually useful for what you
just said.

This doc explains exactly how it picks those cards.

## Is there a "reranking" step?

**No — and this is worth being explicit about, because the code can look like it, at a glance.**

"Reranking" (in the way search engines usually use the word) means: do a cheap, rough search
first to grab a big pile of candidates, then run a *second*, more expensive/smarter model over
just that pile to re-sort it more carefully. That's a two-stage process with two different
scoring mechanisms.

This system does **one stage, one formula**. For every fact in the box:

1. Compute one number: *how relevant is this fact to what you just said* (see step 1 below).
2. Combine that with two more numbers (*how fresh is it*, *how confident are we in it*) into a
   **single combined score**.
3. Sort all the cards by that one combined score, throw away everything except the top 6.

There's no second AI model re-judging the top results afterward. It's one weighted score,
computed once per card, then a plain sort. If you want the exact code: `MemoryService.retrieve()`
in `backend/src/modules/memory/memory.service.ts` — it's about 20 lines, and it's literally
`.map(...).filter(...).sort(...).slice(0, topK)` — a map, a filter, a sort, done.

## Step 1: "How relevant is this?" (cosine similarity)

Every fact, when it's stored, gets turned into a long list of numbers (an "embedding") that
captures its *meaning* — this is done by the AI model, not hand-written rules. Your message, when
you send it, also gets turned into the same kind of list of numbers.

"How relevant is this fact to what you just said" = how close those two lists of numbers are to
each other. Two lists that are very close together mean "these two pieces of text mean similar
things," even if they don't share a single actual word. That's how the chatbot can match "what do
you do for work?" to a stored fact that says "job: nurse" — no shared words, but very similar
*meaning*.

This closeness score is a number between roughly -1 and 1, and in this system anything below
**0.45** is thrown out immediately — the fact isn't even in the running. This is what stops
totally unrelated facts (your favorite color, when you asked about work) from ever getting a
chance.

## Step 2: "How fresh/important is this right now?" (recency + confidence)

Among the facts that *did* clear the relevance bar, three things get combined into one final
score:

```
score = 0.65 × (relevance from step 1)
      + 0.20 × (a "freshness" number, explained below)
      + 0.15 × (how confident the extraction was that this fact is real)
```

Relevance is weighted the heaviest (65%) on purpose — a fact that's a perfect topical match but a
little old should usually still beat a fact that's brand new but only loosely related.

## `temporalType` and `recencyScore` — the "freshness" number, explained

Here's the part that was confusing: **being old and being wrong are two different things**, and
the freshness number needs to know which kind of fact it's looking at before it can decide how
much "being old" should count against it.

Think about three different kinds of sticky notes:

- **"My birthday is June 3rd."** This is true forever. It doesn't get less true because the
  sticky note is a year old. Call this **`permanent`**.
- **"I work as a nurse at St. Mary's."** This is true *until you tell the chatbot otherwise* —
  it doesn't fade with time, but it's not eternal either; one day you might change jobs. Call
  this **`ongoing`**.
- **"I'm stressed about a deadline this week."** This is only really true for a little while.
  Even if you never explicitly say "I'm not stressed anymore," it stops being useful/relevant
  after a week or two. Call this **`temporary`**.
- **"My trip to Portugal is next spring."** A specific thing that happens on/around a date. Call
  this **`event`**.

Every fact gets stamped with one of these four labels when it's first extracted (the AI model
decides the label at the same time it decides the fact itself). Then, the "freshness" number is
computed differently depending on the stamp:

| Stamp | How fast it fades | In plain words |
|---|---|---|
| `permanent` | **Never** — freshness is always the maximum (1.0) | Age doesn't count against it at all |
| `ongoing` | Slowly — loses half its "freshness" every **90 days** | Stays useful for a long time |
| `temporary` | Fast — loses half its "freshness" every **7 days**, and gets hard-deleted-from-consideration (`expired`) after **14 days** no matter what | Fades out on its own, like a sticky note curling up and falling off the fridge |
| `event` | Medium — loses half its "freshness" every **30 days** | Fades at a middle pace |

*("Loses half every N days" is the technical idea of a "half-life," same concept as in
chemistry — after N days it's at 50% freshness, after 2×N days it's at 25%, and so on. It never
hits exactly zero, it just keeps fading.)*

**Why this matters, concretely:** before this was added, *every* fact used the exact same
30-day fade-out, no matter what kind of fact it was. That meant your birthday would slowly look
"less important" to the retrieval system the longer you'd had the chatbot, purely because time
had passed — which makes no sense, a birthday doesn't get less true. And on the other side, a
"feeling stressed this week" note would sit at full strength forever unless you specifically told
the chatbot you weren't stressed anymore, cluttering up retrieval indefinitely.

**Where in the code:** `backend/src/modules/memory/memory.service.ts`, look for
`RECENCY_HALF_LIFE_DAYS` (the table above, as code) and `recencyScore()` (the function that turns
"how old is this, and what stamp does it have" into the actual freshness number using that
half-life math).

**How to see it yourself, live (no scripts needed):**
- Open the web UI (`cd frontend && npm run dev`), say something to the chatbot, then look at the
  "Memory" panel on the right — every fact now shows a little tag (e.g. `ongoing`, `permanent`)
  next to its category tag.
- Run `npm run inspect-memory` from `backend/` — it prints every stored fact; each one shows its
  temporal stamp.
- Wait 14+ days without mentioning a `temporary` fact again, then run `npm run inspect-memory` —
  you'll see its status flip to `expired` (this is the background cleanup job from
  [OPTIMIZATIONS.md](./OPTIMIZATIONS.md#4-old-unresolved-short-term-notes-shouldnt-sit-there-forever)).

## The technical version

`ARCHITECTURE.md` §4 has the exact formula, the exact half-life table, and the reasoning for the
0.45 similarity floor and top-6 cutoff, with code references.
