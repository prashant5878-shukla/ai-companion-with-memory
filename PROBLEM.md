# Problem Statement

Two different, related problems get solved in this repository. This doc separates them clearly,
because they were solved at different times and it's easy to conflate "the project" with "the
fixes."

1. **The original assignment problem** — build an AI companion whose memory and personality
   actually work over a long conversation, not just a chatbot with a system prompt.
2. **The review-fix problem** — an external review of the finished submission found that the
   *architecture* for #1 was sound but *unproven*, and identified 12 specific gaps. This repo now
   also fixes all 12. See [`FIXES_REPORT.md`](./FIXES_REPORT.md) for exactly what changed and the
   real evaluation numbers behind each fix — this doc is about *what problem* each fix addresses,
   not the *how*.

---

## 1. The original problem: memory and persona that actually hold up

A companion chatbot that only has "the last N messages" as memory fails in two specific,
well-known ways over a long conversation:

- **It forgets things.** Either you truncate old messages and lose facts permanently, or you keep
  stuffing everything into the prompt forever and pay (in cost and in the model's attention) for
  an ever-growing pile of raw text.
- **It contradicts itself.** An old statement and a new, conflicting one just sit side by side in
  the raw history. Nothing tells the model which one is current. The model picks whichever it
  happens to weight more, which is not reliable, and definitely isn't "the correct one."

The core design decision this project makes is: **treat memory as a small database of discrete,
structured facts, separate from the raw transcript** — with explicit stages for extracting facts,
retrieving only the relevant ones, and reconciling new statements against old ones (rather than
letting the model silently referee contradictions on its own). The raw transcript is still kept,
but only for audit — it's not what the model reasons over when it needs to remember something.

The same mechanism is applied to the chatbot's own personality, not just facts about the user —
because "the persona contradicts itself after 40 turns" is the exact same underlying problem
("forgot what it said, or let two conflicting statements coexist") wearing a different hat.

See `ARCHITECTURE.md` for the full design of this part — it was already in place before the
review; the review problem (#2 below) is about whether it actually works, not about redesigning
it.

## 2. The review-fix problem: unproven claims → measured evidence

The first version of this project had a real architecture but no real proof it worked under the
assignment's actual conditions. An external review identified twelve specific instances of this
gap. Each one below is a distinct problem — not a restatement of #1 — with its own fix and,
where applicable, its own number from a real evaluation run.

| # | Problem | One-line fix | Details |
|---|---|---|---|
| 1 | No automated evaluation existed — only manual, anecdotal testing. | Built a black-box eval harness (`npm run eval`) that runs against the real backend and produces real metrics. | `FIXES_REPORT.md` #1 |
| 2 | 50+ turn persona consistency was claimed, never actually run. | Automated a 50-turn × 3-run persona probe suite with contradiction-rate and variance reporting. | `FIXES_REPORT.md` #2 |
| 3 | Retrieval quality (does it find the *right* memory, not just *a* memory) was never measured. | Built retrieval scenarios with same-category distractors; measured Recall@K, Precision@K, MRR. | `FIXES_REPORT.md` #3 |
| 4 | The extraction prompt said "extract durable facts" with no concrete boundary — invites over- or under-extraction. | Rewrote it as an explicit store/never-store policy with examples. | `FIXES_REPORT.md` #4 |
| 5 | One fixed 30-day recency decay was applied to every fact, conflating "old" with "no longer true." | Added `temporalType` (permanent/ongoing/temporary/event) with a decay half-life per type, plus hard expiry for stale temporary facts. | `FIXES_REPORT.md` #5 |
| 6 | The persona could still contradict itself even with a good prompt — prompt compliance isn't a guarantee. | Added a second, independent post-generation consistency check that can trigger an in-character self-correction. | `FIXES_REPORT.md` #6 |
| 7 | A user's statement *about* the companion could, in principle, get absorbed as the companion's own persona fact. | Persona-fact extraction now only ever sees the companion's own reply text — structurally, not just by instruction. | `FIXES_REPORT.md` #7 |
| 8 | The response cache could replay a reply generated *before* a fact was refined in place, because the cache key only tracked fact IDs, not content. | Cache key now includes each fact's content, not just its ID. | `FIXES_REPORT.md` #8 |
| 9 | Risk of over-engineering infrastructure instead of the actual memory problem. | Audited: every fix above is a field, a prompt, a formula, or a script — no new infrastructure added. | `FIXES_REPORT.md` #9 |
| 10 | "Refining" a fact (adding detail) and "contradicting" a fact (replacing it) could be confused by the classifier — they look similar. | Gave the classification prompt an explicit rule and worked examples distinguishing the two; verified with dedicated eval scenarios. | `FIXES_REPORT.md` #10 |
| 11 | When something went wrong, there was no way to see *why* — only the final reply. | Added per-turn structured logging (`turn_logs`) capturing everything: retrieved facts, scores, reconciliation outcome, persona-check result. | `FIXES_REPORT.md` #11 |
| 12 | No comparison existed against a plain recent-history/system-prompt baseline, so "the memory system helps" was an assertion, not a measurement. | Added a `baseline` mode and a suite that runs identical scenarios through both, with topic gaps that only defeat the baseline. | `FIXES_REPORT.md` #12 |

### The one-sentence version of the review-fix problem

> The submission argued "here is a sophisticated memory architecture." The review's real ask was
> "prove it, with numbers, including the cases where it fails." This repo now does that — see
> `FIXES_REPORT.md` for the numbers and `docs/` for a plain-language explanation of the mechanisms
> those numbers are measuring.
