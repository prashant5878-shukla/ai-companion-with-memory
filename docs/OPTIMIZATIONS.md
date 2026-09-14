# Optimizations — What's Made Fast/Cheap, and How We Know It Works

Think of the chatbot like a person who has to do a bunch of little chores every time you say
something to them: read what you said, think about what they know about you, write a reply, and
remember anything new you told them. Every one of those chores costs a little time and a little
money (each call to the AI model, Gemini, costs both). "Optimization" just means: don't do a
chore twice if you don't have to, and don't do a chore at all if it's not needed.

Here is every optimization in the system, explained like you've never seen the code, plus exactly
how each one is checked so it's not just a claim.

---

## 1. "Don't ask the same question about the words twice" — one embedding per turn

**What it is.** Before the chatbot can find your memories, it has to turn your message into a
list of numbers (called an "embedding") that captures its *meaning*, not just its exact words.
This is one call to the AI model.

Early on, the system accidentally did this **three times** for the same message: once to search
your facts, once to search the chatbot's own facts, once to check the cache. That's three paid
calls to say the exact same thing three different times.

**The fix.** Compute the embedding **once** per turn, then reuse that same list of numbers for
all three lookups.

**Analogy:** imagine translating a sentence into French three separate times because three
different people need to read the French version — versus translating it once and photocopying
it for all three.

**Where:** `backend/src/modules/chat/chat.service.ts` — `const queryEmbedding = await this.llm.embed(userText)` is called exactly once, then passed into both memory searches and the cache lookup.

**How we check it:** `GET /api/metrics/summary` (or `/stats` in the CLI) shows an `embed` row
with a call count. Watch it while chatting — it goes up by exactly one per turn, not three.

---

## 2. "If you already answered this, just repeat yourself" — the semantic cache

**What it is.** If you say something that means basically the same thing as something you said a
minute ago in the same conversation (like "what's your favorite music?" then later "what kind of
music do you like again?"), there's no reason to make the chatbot think from scratch and pay for
a whole new AI reply. Just hand back the answer it already gave.

**How it decides "close enough":** it compares the *meaning* of your new message to meanings of
recent messages (using those number-lists from optimization #1) and only reuses an old answer if
they're extremely similar — not just "kind of similar." It also **only** reuses an answer if
nothing about what the chatbot remembers has changed since then (see the "safety catch" below) —
this is the part that got fixed, see [CONFLICT_RESOLUTION.md](./CONFLICT_RESOLUTION.md) for why
that mattered.

**Analogy:** if a teacher gets asked "what's 7 times 8?" and then two minutes later "what's eight
times seven?" — same question, different words — they don't need to redo the math, they can just
repeat the answer they already have written on the board. But if in between, someone corrected
something on the board, the teacher has to actually redo the math, not just repeat the old
(possibly now-wrong) answer.

**The safety catch:** the system is deliberately picky about reusing an answer — it will only do
it if (a) it's the exact same conversation, (b) the new message is *very* close in meaning
(96%+ similar), and (c) **the exact same memories, with the exact same content, are still true**.
Rule (c) is what stops the chatbot from confidently repeating an old, now-wrong answer.

**Where:** `backend/src/modules/cache/semantic-cache.service.ts`

**How we check it:**
- **Live, while chatting:** the CLI prints `(⚡ served from semantic cache)` under any reply
  that got reused instead of freshly generated. The web UI shows a little "⚡ cached" badge on
  the message bubble.
- **In numbers:** `GET /api/metrics/summary` reports a `cacheHitRate` — what fraction of turns
  got a free/instant reply instead of a fresh one.
- **Automated:** the eval harness's baseline suite and a manual test (documented in `README.md`
  under "Verified working end-to-end") both exercise a repeat-phrasing scenario and confirm
  `cacheHit: true` comes back, with no new AI call logged for that turn.

---

## 3. "Don't call in a second opinion unless there's actually a disagreement" — skip the compare-and-classify step when nothing to compare against

**What it is.** Whenever you say something the system thinks is worth remembering, it has to
check: is this brand new, or does it change something I already know? Checking "does this change
something I already know" is its own AI call (a second opinion, separate from the one that just
wrote the reply). That call isn't needed if there's *nothing existing to compare it against*.

**The fix:** first, do a **free**, instant database lookup (no AI call, just "do I have any
existing fact about this same kind of thing") to check if there's anything to even compare
against. Only if the answer is yes does the system spend an AI call asking "does this new thing
agree with, add detail to, or contradict the old thing?"

**Analogy:** if someone tells you their name for the very first time, you don't need to "check"
it against anything — you just write it down. You only need to stop and think when you already
had something written down that might now be wrong.

**Where:** `backend/src/modules/chat/chat.graph.ts` — `routeAfterExtract` — this is a plain
yes/no decision, not an AI call, that decides whether the pipeline needs the extra
"compare and classify" step at all.

**How we check it:** the eval harness's reconciliation suite (`run-reconciliation.ts`) has
scenarios where nothing existed before (should skip straight to "just remember it") and
scenarios where something did exist (should trigger the compare step) — both are exercised and
the harness confirms the right memories end up active/superseded either way. Cost-wise, you can
watch `classify`-type calls in `/api/metrics/summary` stay at zero during a plain, no-history
first message, and appear only once there's something to actually compare against.

---

## 4. "Old, unresolved short-term notes shouldn't sit there forever" — background cleanup

**What it is.** Some facts are naturally short-lived — "I'm stressed about a deadline this week."
If nothing ever explicitly says that's no longer true, it would otherwise sit in memory forever
at full strength, quietly cluttering up what the chatbot considers "relevant" every single turn.

**The fix:** once an hour, a background job looks for these short-lived facts that are older than
14 days and marks them `expired` — not deleted, just no longer eligible to be pulled into a
conversation. See [RETRIEVAL_AND_SCORING.md](./RETRIEVAL_AND_SCORING.md) for the full
`temporalType` explanation — this is one consequence of that system.

**Analogy:** a sticky note on your fridge that says "buy milk" is useful for a few days; if it's
still there six months later, it's not "still true," it's just clutter — someone should take it
down even if nobody explicitly says "I don't need milk anymore."

**Where:** `backend/src/server.ts` (the `setInterval` that calls `expireStaleTemporary`),
`backend/src/modules/memory/memory.repository.ts` (`expireStaleTemporary`).

**How we check it:** `npm run inspect-memory` prints every fact with its status, so an `expired`
fact is visible directly. The retrieval eval suite also confirms retrieval only ever returns
`active` facts, never `expired` or `superseded` ones.

---

## 5. "Don't compare against everything, just the relevant category" — narrowing before comparing

**What it is.** When checking whether a new fact contradicts an old one, the system doesn't
compare it against *every single thing it has ever stored about you*. That would be slow and
would also confuse the AI (comparing your job to your favorite color makes no sense).

**The fix:** first narrow down to "other facts about the same subject, in the same rough
category" (a cheap, instant database filter — job facts only get compared to other job facts,
not to your favorite weather), and only send *that* short list to the AI for the real comparison.

**Analogy:** if you're checking whether a new photo of your dog belongs in the "dog photos"
album, you don't compare it to every photo you've ever taken — you only look inside the "dog
photos" album first.

**Where:** `backend/src/modules/memory/memory.repository.ts` — `findActiveCandidates(subject,
category)`.

**How we check it:** this is implicitly proven by the reconciliation eval — scenarios about
unrelated categories (job vs. relationship vs. location) never cross-contaminate each other's
comparisons in the results.

---

## What is *not* a special optimization (clearing up "reranking")

If you've looked at the retrieval code and thought "this looks like it's re-sorting things,
isn't that reranking?" — see
[RETRIEVAL_AND_SCORING.md](./RETRIEVAL_AND_SCORING.md#is-there-a-reranking-step). Short answer:
no, there's one scoring pass, not a separate "retrieve a lot, then rerank with a second model"
step. That doc walks through exactly what does happen instead.

## The technical version

`ARCHITECTURE.md` §2 (request lifecycle), §4 (retrieval scoring), §10 (streaming and caching),
and §13 (evaluation harness) cover the same ground with exact code paths and formulas.
