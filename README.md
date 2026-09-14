# Companion-AI Core Loop

A companion chatbot backend with a real memory architecture: structured + embedding-based
retrieval, temporal-aware decay, LLM-driven fact extraction with an explicit memory policy, and
contradiction/refinement reconciliation — not a chatbot with a system prompt. See
[`PROBLEM.md`](./PROBLEM.md) for exactly what problem this solves (both the original assignment
problem and the 12 specific gaps an external review later found), [`ARCHITECTURE.md`](./ARCHITECTURE.md)
for the full design writeup (data flow, module map, decisions, limitations), and
[`FIXES_REPORT.md`](./FIXES_REPORT.md) for what changed and the real evaluation numbers behind
each fix. This file is just setup/run instructions.

**New here and the architecture doc feels dense?** [`docs/`](./docs/README.md) has four
plain-language explainers — optimizations, retrieval scoring, conflict resolution, and persona
consistency — each written for someone seeing this codebase for the first time, with a "how to
see this yourself, live" section for every mechanism.

Built with: Express + TypeScript (module-based, class-based), MongoDB (Docker) for durable
memory, Redis Stack (Docker) for a semantic response cache, LangGraph for the extract/reconcile
half of each turn, Gemini for chat/extraction/embeddings — replies stream token-by-token, and
every LLM call is logged with token usage and latency for basic observability. The CLI
(`backend/src/cli`) is the reference interface — the brief puts UI out of scope, so it's what
proves the core loop works. `frontend/` is a small React + Vite chat UI added on top of the same
API, mainly to make the memory system's behavior (retrieval, supersession, cache hits, token
usage) visible while demoing.

## Prerequisites

- Node.js 20+
- Docker (for local MongoDB + Redis Stack)
- A Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey))

## Setup

```bash
cd backend
npm install
cp .env.example .env   # already done in this repo; edit .env and set GEMINI_API_KEY
docker compose up -d   # starts MongoDB (27017) and Redis Stack (6379)

cd ../frontend
npm install             # only needed if you'll use the React UI
```

## Run

**Backend (required):**

```bash
cd backend
npm run server   # Express + LangGraph backend on http://localhost:4000
```

**Then either interface (or both):**

```bash
npm run cli                    # from backend/ — REPL chat client over HTTP
```

```bash
cd frontend && npm run dev     # chat UI + live memory panel at http://localhost:5173
```

Both talk to the same backend and the same session/memory store — messages sent from one show up
in the other's session history. Restart `npm run server` at any point: the most recent session and
everything it remembers persists across the restart, in both interfaces.

Both interfaces stream the reply token-by-token as it's generated (SSE under the hood — see
`POST /api/message/stream` in `ARCHITECTURE.md`). If a near-duplicate message hits the semantic
cache, the whole reply arrives in one shot instead of token-by-token (it really was instant) — the
CLI prints `(⚡ served from semantic cache)` and the frontend shows a matching badge on the bubble.

### Observability

Every Gemini call (chat, fact extraction, contradiction classification, embedding) is logged to
Mongo's `llm_calls` collection with token counts, latency, and success/failure — plus one row per
cache hit (zero tokens, since Gemini wasn't called). `GET /api/metrics/summary` aggregates it:
totals, a breakdown by call type, cache hit rate, and the 20 most recent calls.
- **CLI**: type `/stats` at the prompt instead of a message.
- **Frontend**: the right panel has an "Observability" tab alongside "Memory", refreshed after
  every turn.

### Inspecting memory directly

```bash
npm run inspect-memory
```

Dumps every stored fact (user + persona), active/superseded/expired, with ids and supersede
links — useful for confirming a contradiction actually flipped the old fact's status rather than
just adding a duplicate.

### Automated evaluation

```bash
npm run eval                       # full run: persistence, retrieval, contradiction/refinement,
                                    # baseline comparison, 50-turn x 3-run persona consistency
npm run eval -- --turns 20 --runs 2   # faster smoke run
```

Runs a black-box eval suite against the real running backend (spawns/manages the server itself if
one isn't already up) and writes a full JSON report to `backend/eval-results/`. See
`ARCHITECTURE.md` §13 for what each suite measures and `FIXES_REPORT.md` #1 for a real run's
numbers. This replaces the "no automated eval harness" gap the original submission had.

## What was tried and abandoned

- **SQLite instead of MongoDB** was the original plan (simpler, zero-infra) before the stack was
  set to Mongo + Docker; the fact/embedding data model carried over unchanged, only the storage
  layer swapped.
- **MongoDB Atlas Local / `$vectorSearch`** was considered for native vector search, but it needs
  the `mongodb/mongodb-atlas-local` image (not plain `mongo`) and adds index-provisioning
  complexity for no real benefit at this scale — brute-force cosine similarity in Node over a few
  hundred facts is effectively instant. Documented in `ARCHITECTURE.md` as the scale-up path.
- **LangGraph's built-in checkpointer** for session persistence was considered and rejected —
  it would duplicate the Mongo `sessions`/`messages` collections that already exist as the single
  source of truth. LangGraph here is scoped to orchestrating one turn's pipeline, not to owning
  conversation state.
- **`text-embedding-004`** was the first embedding model tried; the API key in use returned a 404
  for it (deprecated on this API version), so it was swapped for `gemini-embedding-001`. Similarly
  `gemini-2.0-flash` returned a 404 telling us to switch to `gemini-3.6-flash`. Both model names
  live in one place (`modules/llm/gemini.client.ts`) — if your key hits the same errors, that's
  the only file to touch, and the client no longer throws at construction time on a bad/missing
  key (only real calls fail), so the server stays up and logs a clear warning instead of crashing.
- **Retrieval and reply generation used to be LangGraph nodes.** Moved out to plain sequential
  calls in `ChatService` when streaming was added — a graph node returns a state update once it
  finishes, which doesn't fit token-level streaming, and retrieval/generation don't have any
  branching logic that would benefit from being graph nodes anyway. LangGraph now covers only the
  extract → reconcile half of a turn, which does have a real conditional branch. See
  `ARCHITECTURE.md` §2 for the reasoning.
- **Semantic cache in Mongo** (reusing the same brute-force-cosine approach as fact retrieval) was
  considered instead of Redis, but rejected: the cache is checked on *every* turn (unlike fact
  retrieval, bounded to a few hundred rows), so a real vector index (RediSearch's HNSW, via Redis
  Stack) is worth the extra container. It also keeps the durable-memory/ephemeral-cache split
  clean — Mongo only ever holds things that must survive, Redis only ever holds things that don't
  need to.
- **Token accounting for streamed chat replies turned out to be non-obvious.** The first
  implementation kept only the *last* chunk's `usage_metadata` on the assumption it would be the
  cumulative total (the usual LangChain convention). Logging every chunk's `usage_metadata`
  during a real call showed that assumption doesn't hold for this model/SDK combination — chunks
  carried inconsistent, non-monotonic numbers (e.g. one chunk read `input=675, output=13,
  total=1117`, a later one read `input=0, output=6, total=6`). Switched to taking whichever chunk
  reported the highest `total_tokens` as the best estimate. This is a heuristic, not a guarantee —
  see "Known limitations" below. `extractFacts`/`classifyRelations` don't have this problem: they're
  non-streaming, and switching `withStructuredOutput` to `{ includeRaw: true }` gets the exact
  `usage_metadata` straight off the raw response.

## Verified working end-to-end

Manually exercised against real Gemini (not just typechecked): stated an occupation and workplace
fact, confirmed it was retrieved unprompted several unrelated turns later; stated a relationship
fact, then contradicted it ("we broke up... I moved out") and confirmed via `inspect-memory` that
the old fact flipped to `superseded` with `supersededBy` set and the new one is `active`; killed
and restarted the server mid-session and confirmed the resumed session's replies reflected the
post-breakup state, not the stale one — proving Mongo persistence, not in-context history. Persona
self-consistency (seeded opinions surfaced naturally, one seed fact got refined in place rather
than duplicated when the persona restated something similar) also confirmed in the same run.
Streaming and the semantic cache were verified directly against the SSE endpoint and the CLI: a
message streamed token-by-token as expected, a paraphrased repeat ("what's" → "what is") in the
same session correctly hit the cache (`cacheHit: true`, full reply in one shot, no Gemini call),
and a genuinely new message in the same session correctly missed and generated fresh. Observability
was verified the same way: `GET /api/metrics/summary` and the CLI's `/stats` correctly reflect
calls made during testing, broken down by type, with plausible token counts and latencies (one
real discrepancy found and fixed — see "what was tried and abandoned" above).

**A longer 50-turn x 3-run persona drift check, a retrieval-quality eval, a contradiction/
refinement eval, and a full-system-vs-baseline comparison are now automated** — `npm run eval` —
rather than manual/anecdotal. See `FIXES_REPORT.md` #1-#3 and #12 for the actual numbers from a
real run and how each suite is constructed.

## Known limitations

- Token counts for **streamed chat replies** are a best-effort heuristic (max-`total_tokens` chunk
  seen), not a guaranteed-exact figure — see "what was tried and abandoned" above for why. Extract
  and classify calls (non-streaming) get exact counts. Embedding calls aren't token-counted at all
  (call count and latency only) — the SDK doesn't surface usage for `embedContent` cleanly through
  this integration.
- Retrieval and reply generation are two Gemini calls (embedding + chat); extraction and
  reconciliation add one or two more when there's something to reconcile — so 2-4 Gemini calls per
  turn on a cache miss, one Gemini call (embedding only) on a cache hit. No cross-turn batching.
- Vector search over facts is brute-force cosine similarity over every active fact — correct but
  O(n) per query; would move to Atlas Search / pgvector / a dedicated vector store past a few
  thousand facts. (The semantic *response* cache, by contrast, already uses a real vector index —
  RediSearch HNSW — since it's checked every turn.)
- The semantic cache is scoped per-session and requires an *exact* match on the set of retrieved
  fact ids, by design (see `ARCHITECTURE.md` §10) — this avoids ever serving a stale personalized
  reply, but also means it only helps with near-duplicate turns (greetings, acknowledgements,
  filler), not general cost reduction. It also depends on Redis being reachable at boot; if it
  isn't, caching silently disables itself (logged once) rather than breaking the chat loop — see
  `RedisCache.connect()`.
- ~~The context hash keys on retrieved fact ids, not their content...~~ **Fixed** — the hash now
  includes each retrieved fact's `object` alongside its id, so a fact refined in place busts the
  cache the same way a superseded one does. See `FIXES_REPORT.md` #8.
- Contradiction detection is per-candidate LLM classification, not a learned/calibrated model —
  it's only as good as Gemini's judgment on a single batched prompt, and has no human-in-the-loop
  correction path if it misclassifies. The `classifyRelations` prompt now gives explicit
  refine-vs-contradict worked examples (`FIXES_REPORT.md` #10) to reduce the most common confusion,
  measured by `npm run eval`'s reconciliation suite, but it's still a single LLM call's judgment.
- The persona post-generation consistency check (`FIXES_REPORT.md` #6) adds one Gemini call to
  every non-cached turn (and, on a flag, one more for the correction) — it hasn't been tuned for
  false-positive rate beyond what the eval harness's persona suite reports.
- The eval harness's relevance/contradiction judgments are keyword/substring-based, not an LLM
  judge — deterministic and reproducible, but a correct answer phrased without the expected
  substring scores as a miss. See `ARCHITECTURE.md` §13.
- Single-user, single companion persona, no auth — all explicitly out of scope per the brief.
