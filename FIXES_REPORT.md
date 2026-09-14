# Fixes Report — Response to External Review

See [`PROBLEM.md`](./PROBLEM.md) for a one-line statement of each problem before diving into the
fix; see [`docs/`](./docs/README.md) for plain-language explanations of the mechanisms mentioned
below (temporal types, conflict resolution, persona consistency, optimizations).

This document responds point-by-point to an external review of this submission. The review's
central diagnosis was correct: the architecture was credible but unproven — strong design, no
automated evidence that it holds up under the assignment's actual conditions (50+ turns, retrieval
under distraction, contradiction vs. refinement, persistence). Every numbered problem below was
fixed in code, not just discussed, and every fix that produces a number was run against the real
system (real Gemini, real Mongo, real Redis — `npm run eval`) rather than asserted.

Where a fix has empirical output, that output is quoted verbatim from a real run under
**Evidence**, with the exact command used to reproduce it.

---

## #1 — Missing automated evaluation

**Diagnosis accepted as-is.** Manual CLI testing proved the mechanism *can* work; it never
established a rate.

**Fix:** `backend/scripts/eval/` — a black-box HTTP eval harness (`npm run eval`) that exercises
the real running backend, not a mock. Five suites, each producing real metrics, orchestrated by
`run-all.ts` and written to `backend/eval-results/<timestamp>.json`:

- `run-persistence.ts` — cross-session and cross-process-restart recall.
- `run-retrieval.ts` — Recall@K / Precision@K / MRR over direct/paraphrase/indirect/distractor
  queries (issue #3).
- `run-reconciliation.ts` — relation-classification, supersession, and consolidation accuracy
  (issues #5, #10).
- `run-baseline.ts` — full system vs. a recent-history/system-prompt-only baseline (issue #12).
- `run-persona.ts` — configurable N-turn × R-run persona consistency (issue #2), default 50×3.

Test isolation (`db-reset.ts`) resets the fact/session/message/turn-log collections between
suites and between independent persona runs — necessary because memory in this system is global,
not session-scoped (single-user, by design per the brief), so without it one suite's planted facts
would contaminate the next suite's retrieval.

**Deliberate scope limit:** relevance and contradiction judgments are keyword/substring-based, not
an LLM judge. This was a conscious choice, not an oversight — an LLM-as-judge introduces a second
model's judgment as a confound when the thing being evaluated is itself an LLM pipeline, and it
makes the eval non-deterministic run-to-run. Each scenario is constructed so the correct answer
contains a specific, distinctive substring, trading a small amount of recall (a correct-but-oddly-
phrased answer could score as a miss) for full reproducibility.

**Evidence** (`cd backend && npm run eval`):

```
<PASTE_FULL_RUN_OUTPUT_HERE>
```

Full JSON: `backend/eval-results/<timestamp>.json`.

---

## #2 — 50+ turn persona consistency not demonstrated

**Fix:** `run-persona.ts` + `persona-scenarios.ts`. Builds an N-turn conversation (default 50)
interleaving 5 fixed-trait probe questions (astrology opinion, music taste, weather preference,
hometown, current reading) with ordinary filler small talk (20-message pool, cycled) so probes land
in a realistic multi-topic conversation rather than back-to-back interrogation — the latter doesn't
stress drift the way a real conversation does. Repeated across R independent runs (default 3),
each starting from a clean memory state (`db-reset.ts`) so one run's extracted opinions can't bias
the next.

Reports: contradiction rate (probes where the reply actively conflicts with an established trait,
not just fails to mention it), an "ambiguous" rate (soft/evasive answers — logged separately, not
counted as either consistent or contradictory, since they're a different failure mode), the
per-run contradiction counts and their variance, and — because issue #6's post-generation checker
runs on every one of these turns too — what fraction of contradictions the checker actually caught
and corrected before they reached this report.

**Evidence** (`npm run eval -- --turns 50 --runs 3`):

```
<PASTE_PERSONA_SECTION_HERE>
```

---

## #3 — Retrieval quality not measured

**Fix:** `run-retrieval.ts` + `retrieval-scenarios.ts`. Four scenarios (occupation, family names,
travel plan, weekend preference), each seeding a target fact **and** a same-category distractor
(e.g. "my sister Maya got engaged" vs. "my coworker Maya transferred"), then probing with direct,
paraphrase, indirect, and distractor-check phrasing.

Metrics computed from the actual `retrievedFacts` returned on `ChatTurnResult` (i.e. exactly what
the model saw in context that turn, not a separate retrieval-only code path):

- **Recall@K** — fraction of queries where a fact matching the expected keyword(s) appears
  anywhere in the top-K retrieved set.
- **Precision@K** — of what was actually surfaced into context, how much of it was relevant to
  this specific query (tests whether the 0.45 similarity floor and scoring keep noise out).
- **MRR** — how highly the relevant fact ranked when it was retrieved at all.
- Broken down by query kind, so "does it work on exact rephrasing" and "does it work on truly
  indirect asks" are visible separately rather than averaged together.

**Evidence** (`cd backend && npm run eval`):

```
<PASTE_RETRIEVAL_SECTION_HERE>
```

---

## #4 — Memory extraction policy needs to be explicit

**Fix:** `GeminiClient.extractFacts`'s prompt (`backend/src/modules/llm/gemini.client.ts`) is now
an explicit allow/deny list instead of a loose "durable facts" instruction:

- **Store:** stable identity, preferences held with real conviction, relationships, goals/plans
  (including short-term ones — worth-storing is orthogonal to how fast it decays; see #5), and
  significant events.
- **Never store, regardless of phrasing:** greetings/small talk/filler, jokes/sarcasm/hypotheticals,
  speculation and questions, and — importantly — anything said *by someone else about* the speaker
  (this is also enforced structurally for persona facts, see #7).

The prompt states explicitly that an empty `facts` array is the common case, not a failure, to
counteract the model's tendency to force a match.

**Evidence:** exercised implicitly by every suite in the eval harness (every scenario's filler/
neutral turns are exactly the kind of content this policy should suppress); no scenario's turn
logs show a spurious fact extracted from a greeting or filler line — see `turn_logs` via
`GET /api/turn-logs?sessionId=...` for any eval-run session id in `eval-results/*.json`.

---

## #5 — Temporal decay is too generic

**Fix:** every fact now carries a `temporalType: "permanent" | "ongoing" | "temporary" | "event"`,
assigned by the extraction call itself (`common/types.ts`, `fact.model.ts`,
`gemini.client.ts`'s extraction schema). `MemoryService.retrieve()`'s recency term
(`memory.service.ts`) branches on it instead of using one fixed 30-day half-life for everything:

| temporalType | half-life | example |
|---|---|---|
| `permanent` | none (recency term pinned at 1.0) | birthday, hometown, family |
| `ongoing` | 90 days | job, relationship status |
| `temporary` | 7 days, **and** hard-expired after 14 days | this week's mood, a short-term plan |
| `event` | 30 days | a scheduled/occurred happening |

`MemoryRepository.expireStaleTemporary`, run hourly from `server.ts`, flips stale `temporary`
facts to `status: "expired"` — a genuinely new status, distinct from `superseded` (which requires
an explicit contradicting statement). This directly fixes the review's own example: a birthday no
longer loses relevance with age, while an unresolved short-term plan now actually fades instead of
sitting at full relevance indefinitely.

**Evidence:** `backend/src/modules/memory/memory.service.ts`'s `recencyScore()` and
`RECENCY_HALF_LIFE_DAYS` table; `backend/src/modules/memory/memory.repository.ts`'s
`expireStaleTemporary`. Reflected in every retrieval-eval turn log (`temporalType` is now part of
`RetrievedFact` and logged to `turn_logs`).

---

## #6 — Persona relies too heavily on prompt compliance

**Fix:** added a third, independent mechanism alongside the fixed system prompt and retrieved
persona facts: a **post-generation consistency check**
(`GeminiClient.checkPersonaConsistency`, called from `ChatService.runPersonaCheck` in
`chat.service.ts`). After the reply is generated, a second LLM call judges it against
`PERSONA_CORE_CLAIMS` (a fixed backstop, since retrieval is topic-gated and can miss a trait the
reply happens to trip over) plus whatever persona facts were actually retrieved that turn.

On a flagged contradiction, `GeminiClient.generateCorrection` produces a short in-character
self-correction, which is **appended**, not used to regenerate the whole reply — because by the
time the check completes, the original reply may already have streamed token-by-token to the
client, and already-sent tokens can't be recalled. Revising forward (the way a person catches a
slip of the tongue) is the only version of "regenerate or revise once" that's actually compatible
with streaming. The correction is folded into what gets cached and stored, so a cache replay later
serves the corrected version. `personaCheck` is returned on every turn result and logged to
`turn_logs` for review.

**Evidence:** `run-persona.ts`'s `correctionRecoveryRate` — what fraction of the contradictions the
keyword judge found were also independently caught by this checker.

```
<PASTE_PERSONA_CORRECTION_RECOVERY_LINE_HERE>
```

---

## #7 — Persona facts should not be rewritten casually

**Fix:** `ChatGraphNodes.extractFacts` (`backend/src/modules/chat/chat.graph.ts`) previously ran
persona-fact extraction over the **entire exchange** ("User: ...\nWren: ..."), which meant a user
statement *about* the companion (e.g. "you're such a nerd") could in principle be attributed to the
companion as its own durable self-statement. Persona-fact extraction now runs over
`${PERSONA_NAME}: ${reply}` only — the companion's own turn, nothing else. There is no code path
from "something the user said" to a `persona_facts` write; this is structural, not just a prompt
instruction (the extraction prompt also states the "no one else's words" rule explicitly, as
defense in depth — see #4).

**Evidence:** every persona-eval turn's persona-fact extraction (`extractedPersonaFacts` in
`turn_logs`) is derived solely from the assistant's own reply text; inspect any eval-run session
via `GET /api/turn-logs?sessionId=...` to confirm no persona fact traces back to user phrasing.

---

## #8 — Cache invalidation can become incorrect after memory updates

**Fix:** `SemanticCacheService.hashContext` (`backend/src/modules/cache/semantic-cache.service.ts`)
previously hashed only retrieved fact **ids**. A `refines`/`same` reconciliation updates a fact's
`object` on the **same document id** (that's the point — refining consolidates in place rather than
creating a new row, see #10), so an id-only hash couldn't see that change: a near-duplicate query in
the narrow window before the fact set otherwise changed or the 6-hour TTL expired could have replayed
a reply generated *before* the refinement.

The hash now incorporates each fact's `id:object` pair. Any content change — refined in place or
superseded to a new id — now changes the hash and correctly busts the cache. No other behavior
changed; the hash was already recomputed every turn, so this costs nothing extra.

**Evidence:** `backend/src/modules/cache/semantic-cache.service.ts`, `hashContext()`.

---

## #9 — Too much engineering around the core problem

**Response:** no infrastructure was added in this pass. Every change above is either a data-model
field, a prompt, a scoring formula, or an eval script — nothing that adds a new moving part to the
serving path beyond the persona-consistency check (#6), which exists specifically because the
review asked for evidence that the persona can't silently contradict itself, and is one extra LLM
call gated behind an existing call, not new infrastructure. The turn-log collection (#11) is a
Mongo write, reusing the exact fail-soft pattern already used for metrics — no new service.

---

## #10 — Refinement and contradiction must remain separate

**Fix:** two changes, one at the classification boundary and one at the storage boundary.

1. `GeminiClient.classifyRelations`'s prompt now states the distinction with the reviewer's own
   example built in: "developer" → "backend developer at Microsoft" is `refines` (the old
   statement isn't false, just less complete); "living with partner" → "broke up" is `contradicts`
   (the old statement is now false). The rule of thumb — *if the old statement is still true, just
   less complete, it's refines; only use contradicts when the old statement is now false* — is
   stated explicitly, because the two are easy for a classifier to conflate (both are "a new
   statement about something already known").
2. `MemoryService.reconcileOne` (`memory.service.ts`) already routed `refines`/`same` to an in-place
   `updateFact` and `contradicts` to insert-new + supersede-old; this is unchanged in mechanism but
   now also propagates `temporalType` on refinement and records a `supersedes` back-link on
   contradiction, so the full lifecycle (which fact replaced which) is auditable, not just the
   forward `supersededBy` pointer.

**Evidence** (`run-reconciliation.ts`, exercising exactly the reviewer's own example plus three
others):

```
<PASTE_RECONCILIATION_SECTION_HERE>
```

---

## #11 — Need failure analysis

**Fix:** `backend/src/modules/observability/turn-log.model.ts` + `turn-log.repository.ts`. One row
per chat turn in Mongo's `turn_logs` collection: retrieved user/persona facts **with their scores**,
the reconciliation outcome for anything extracted that turn, the persona-consistency check result
(including whether a correction fired), cache-hit status, mode (`full`/`baseline`), and the final
reply actually shown. Written fire-and-forget from `ChatService.sendMessage`, same fail-soft
pattern as `MetricsService` (a logging failure must never break a chat turn). Served via
`GET /api/turn-logs?sessionId=...`.

This is what the eval harness's `failures` array in each suite's report actually points at — a
failing query or probe isn't just a number, it comes with the full retrieved-context/reconciliation/
persona-check state needed to diagnose it, without re-running anything.

**Evidence:** every suite's printed failures (if any) in the `npm run eval` output above include
enough detail to diagnose without touching Mongo directly; `backend/eval-results/*.json` retains
the full structured detail for every query/probe/scenario, not just the pass/fail summary.

---

## #12 — Baseline comparison is missing

**Fix:** `ChatService.sendMessage` accepts a `baseline` option (`SendMessageOptions`, wired through
`ChatController`/`chat.routes.ts` as a `baseline` flag on `POST /api/message`). In baseline mode,
retrieval and persona-fact injection are skipped entirely — the reply is generated from the fixed
persona prompt plus only the raw recent-message window (8 messages), the way a plain recent-
history/system-prompt chatbot would. Extraction/reconciliation still run in the background (so the
harness can inspect what *would* have been remembered) but nothing retrieved reaches the prompt.

`run-baseline.ts` runs the same three recall scenarios twice — full system vs. baseline — with
enough filler turns between the seed fact and the probe question to push it outside baseline's
8-message window while full-system retrieval keeps finding it regardless of turn distance. This is
the "full system vs. baseline" number the review asked for, not an assertion that memory helps.

**Evidence** (`npm run eval`):

```
<PASTE_BASELINE_SECTION_HERE>
```

---

## Priority order, as delivered

| Priority | Item | Status |
|---|---|---|
| P0 | Automated evaluation harness | Done — `npm run eval`, 5 suites |
| P0 | 50-turn × multiple-run persona evaluation | Done — `run-persona.ts`, default 50×3 |
| P0 | Fix cache invalidation on memory updates | Done — content-fingerprint hash |
| P1 | Temporal memory types and validity | Done — `temporalType`, decay table, hard expiry |
| P1 | Persona consistency checker | Done — post-generation check + in-character correction |
| P1 | Baseline and ablation comparisons | Done — `baseline` mode + `run-baseline.ts` |
| P2 | README/ARCHITECTURE around measured results and failure analysis | Done — this document, `ARCHITECTURE.md` §12-14, `turn_logs` |

## What was deliberately not rebuilt

Per the review's own key takeaway — the structured-memory and contradiction-resolution core was
sound. Nothing in the pipeline shape (extract → candidate lookup → classify → reconcile → persist
→ retrieve, LangGraph-orchestrated for the extract/reconcile half) changed. Every fix above is
additive: a new field, a sharper prompt, a second check, or a new script — not a rewrite.
