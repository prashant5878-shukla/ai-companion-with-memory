# Architecture

How Companion-AI actually works, end to end. Read `README.md` first if you just want to run it.

## 1. The problem this solves

Companion products fail at two things over long conversations: they forget things the user told
them, and their persona drifts into a generic assistant voice or contradicts its own earlier
statements. Both failures come from the same root cause — treating "memory" as *the last N
messages in the context window*. That degrades in two ways: it's unbounded (you either truncate
and lose old facts, or you stuff everything in and pay for/dilute the context every turn), and it
has no concept of a fact being *updated* — an old and a new statement just sit side by side and
the model picks whichever it happens to attend to.

This system instead treats memory as a **small database of discrete facts**, separate from the
raw transcript, with explicit extraction, retrieval, and reconciliation stages. The transcript is
still stored (for audit/replay), but it is not the memory mechanism.

## 2. Request lifecycle (one turn, start to finish)

```
CLI or frontend
  │  POST /api/message/stream { sessionId, message }   (SSE; /api/message is the non-streaming twin)
  ▼
Express → ChatController.sendMessageStream
  │
  ▼
ChatService.sendMessage(sessionId, userText, onToken)
  1. fetch last ~8 raw messages for this session (Mongo)
  2. save the user's message (Mongo) → sourceMessageId
  3. embed(userText) ONCE — reused for both fact retrieval and the cache lookup below
  4. retrieve top-K active user facts AND persona facts in parallel (cosine + recency + confidence)
  5. hash the retrieved fact ids → contextHash; look up the semantic cache (Redis, session-scoped)
     - HIT:  reply = cached text, emitted to the caller in one chunk (see §10)
     - MISS: stream the reply from Gemini token-by-token via onToken, then cache it
  6. save the assistant's reply (Mongo)
  7. invoke the LangGraph pipeline with { userMessage, reply, sourceMessageId } — extraction and
     reconciliation only; retrieval/generation already happened above
  8. return { reply, retrievedFacts, newFacts, reconciliation, cacheHit }
```

Steps 3-6 are plain sequential method calls, not graph nodes — see §10 for why. Only step 7 runs
through LangGraph (`modules/chat/chat.graph.ts`):

```
START
  │
  ▼
extractFacts            Gemini structured-JSON call over "User: ...\nWren: ..." → candidate
  │                      facts, run separately for the user's turn and the persona's own turn
  ▼
routeAfterExtract?      does ANY extracted fact have an existing active fact with the same
  │                     (subject, category)? (a plain Mongo query, no LLM call)
  ├─ no candidates ──────────────► insertFactsDirectly (bulk insert, no extra LLM call) ──┐
  └─ yes, some candidates exist ─► reconcileWithClassification                             │
         batched Gemini call comparing new fact vs each candidate:                         │
         same / refines / contradicts / unrelated → update, update, supersede, or insert ──┤
                                                                                             ▼
                                                                                            END
```

Why the branch matters: most turns ("I had a rough day at work") don't touch anything already in
memory, so there's nothing to reconcile against — skipping straight to insert saves an LLM call.
Only when a plausible duplicate/conflict exists ("I broke up with my ex", when a relationship fact
already exists) does the pipeline pay for the classification call. This is the one meaningful
conditional edge in the graph, and the reason LangGraph is scoped to just this half of the turn —
see §10 for the streaming-driven reasoning behind that split.

## 3. Data model

Four Mongo collections (`modules/memory/fact.model.ts`, `modules/session/message.model.ts`):

| Collection | Purpose |
|---|---|
| `sessions` | `{ startedAt }` — one per CLI run (or resumed) |
| `messages` | `{ sessionId, role, content, createdAt }` — full raw transcript, audit/replay only |
| `facts` | user memory (see below) |
| `persona_facts` | the companion's own backstory/opinions — identical shape, same pipeline |

Fact shape:

```ts
{
  subject: string;        // "user" or "companion"
  predicate: string;      // short_snake_case, e.g. "relationship_status", "job_title"
  object: string;         // the value, e.g. "living with partner"
  category: "relationship" | "work" | "preference" | "plan" | "opinion" | "event" | "trait" | "other";
  confidence: number;     // 0-1, from the extraction call
  status: "active" | "superseded";
  supersededBy: ObjectId | null;
  sourceMessageId: ObjectId | null;
  embedding: number[];    // gemini-embedding-001, 3072 dims, over "subject predicate object"
  createdAt, updatedAt: Date;
}
```

**Why hybrid (structured fields + embedding) instead of one or the other:** contradiction
detection needs to compare *like with like* — you can't sensibly ask "does this contradict
anything?" over an unstructured pile of text chunks; you need to first narrow to "other facts
about this subject, in this category" (a cheap indexed Mongo query on `subject`+`category`), *then*
let the LLM judge the relationship. That narrowing step is what the structured fields buy you.
The embedding buys you the fuzzy side: retrieval at chat time has to work even when the user's
current message doesn't share vocabulary with how the fact was originally phrased (asks about
"work stuff" when the stored fact says `job_title: nurse`).

**Why no vector database:** at prototype scale (tens to a few hundred facts per user), brute-force
cosine similarity over an array fetched from Mongo (`common/vector.ts`) is sub-millisecond and
avoids provisioning a second piece of infra. MongoDB does have a vector-search path
(`$vectorSearch`, Atlas or the `mongodb/mongodb-atlas-local` Docker image), which is the natural
next step if fact counts grew into the thousands — noted here rather than built, to keep local
setup to a single `docker compose up`.

## 4. Retrieval scoring

`MemoryService.retrieve()` (`modules/memory/memory.service.ts`) takes a precomputed query
embedding rather than embedding the query text itself — `ChatService` embeds the user's message
once per turn and passes that same vector into both the user-fact and persona-fact retrieval
calls (and into the cache lookup in §10). Earlier this method embedded the query internally, so
the same text was embedded three times per turn; now it's one Gemini embedding call, period.

```
score = 0.65 * cosine_similarity(query, fact)
      + 0.20 * exp(-ln2 * age_days / 30)      // recency half-life: 30 days
      + 0.15 * fact.confidence
```

Facts below a similarity floor (0.45) are dropped entirely before scoring — the recency/confidence
terms only break ties among facts that are already topically relevant; they don't pull in
unrelated-but-recent facts. Top-K (default 6) survive per query, run separately for user facts and
persona facts, so a topic-shift doesn't get crowded out by a flood of one-sided matches.

This directly targets the brief's requirement: not dumping everything into context, and not
missing something clearly relevant just because it's old.

## 5. Contradiction / update handling

Given a newly extracted fact and its same-subject/same-category candidates, one batched Gemini
call (`GeminiClient.classifyRelations`) returns a relation per candidate:

- **`contradicts`** → insert the new fact as `active`; mark the old one `status: superseded`,
  `supersededBy: <new fact id>`. The old fact is never deleted — it stays for audit — but
  `retrieve()` only ever queries `status: "active"`, so it can't leak into a future reply.
- **`same` / `refines`** → update the existing document's `object`/`confidence`/`updatedAt`
  in place, rather than inserting a duplicate. ("I'm a nurse" then later "I'm a nurse at St.
  Mary's" refines, it doesn't contradict.)
- **`unrelated`** → the candidate wasn't actually about the same thing; the new fact gets
  inserted as a fresh, independent fact.

Worked example, matching the brief's own scenario:

1. Turn 12: *"My partner and I just moved in together."* → extracted fact
   `(user, relationship_status, "living with partner", relationship, active)`.
2. Turn 40: *"I broke up with my ex."* → extraction produces
   `(user, relationship_status, "broke up", relationship)`. Candidate lookup finds the turn-12
   fact (same subject+category). Classification returns `contradicts`. Turn-12 fact flips to
   `superseded`; the new fact becomes `active`.
3. Turn 41: user asks something that would previously have retrieved the relationship fact.
   `retrieve()` only sees the active "broke up" fact — the reply is grounded in the current state,
   not the stale one. Run `npm run inspect-memory` after a turn like this to see the flip directly.

The same mechanism runs over the **persona's own statements** (`persona_facts`), which is what
keeps a 50+-turn conversation from letting the companion improvise a new opinion in turn 30 that
quietly conflicts with something it said in turn 5 — it goes through the identical
extract → candidate-lookup → classify → reconcile path, just with `subject: "companion"`.

## 6. Persona consistency

Two mechanisms, deliberately redundant:

1. **A fixed system-prompt block** (`modules/persona/persona.data.ts`), injected on *every* call
   to `streamReply` regardless of topic — identity, backstory, voice rules, and explicit "don't
   drift into assistant-speak" instructions. This is the primary defense against tone flattening:
   it doesn't depend on retrieval finding the right thing at the right time, it's just always
   there.
2. **Seeded + reconciled `persona_facts`**, retrieved the same way user facts are and appended to
   the prompt as "things you've said about yourself before." This catches the slower failure mode
   — self-contradiction across many turns on specifics (e.g., stating a hobby once, then a
   conflicting one 40 turns later) that a static prompt block alone wouldn't catch, since the
   static block only encodes what was decided up front, not what the model improvises later.

## 7. Module map (Express, class-based, module-per-domain)

```
backend/src/
  config/            env.ts (typed env loader), database.ts (Mongoose connection singleton)
  common/            types.ts, logger.ts, vector.ts (cosine similarity)
  modules/
    llm/             GeminiClient — streamReply / extractFacts / classifyRelations / embed;
                      every LLM call except streamReply is wrapped in try/catch so a bad JSON
                      response or API hiccup degrades to "skip this turn's memory update"
                      rather than crashing the chat loop; every call (including streamReply,
                      via try/catch/finally) times itself and reports to MetricsService — see §12
    cache/           RedisCache (connection singleton, returns null instead of throwing if
                      Redis isn't reachable at boot — caching disables itself rather than
                      blocking startup), SemanticCacheService (RediSearch HNSW index: ensureIndex
                      / lookup / store, plus the static hashContext helper) — see §10
    observability/   llm-call.model.ts (Mongoose schema for `llm_calls`), MetricsRepository
                      (record + aggregate via a Mongo `$group` pipeline), MetricsService (thin,
                      never-throws wrapper), MetricsController + metrics.routes.ts
                      (GET /api/metrics/summary) — see §12
    memory/          fact.model.ts (Mongoose schema, shared by facts + persona_facts),
                      MemoryRepository (generic CRUD, constructed once per collection),
                      MemoryService (retrieval scoring, extraction, reconciliation — the
                      class instantiated twice in server.ts, once per collection, so user-fact
                      and persona-fact logic is identical code, not a parallel copy),
                      MemoryController + memory.routes.ts (GET /api/memory/facts — read-only
                      dump of active+superseded facts, minus embeddings, for the frontend's
                      memory panel; not part of the turn pipeline itself)
    persona/         fixed prompt block + seed facts (persona.data.ts), PersonaService
                      (seeds persona_facts on first boot, builds the composed system prompt)
    session/         message.model.ts, SessionRepository, SessionService (resume/create session,
                      append messages, fetch recent window)
    chat/             chat.graph.ts (LangGraph state + ChatGraphNodes + buildChatGraph — extract/
                      reconcile only, see §2 and §10), ChatService (retrieval, cache lookup,
                      streaming generation, then invokes the graph — the actual per-turn
                      orchestrator; also records the cache_hit metric directly, since that's the
                      one event GeminiClient never sees), ChatController (sendMessage: buffered
                      JSON; sendMessageStream: SSE), chat.routes.ts
  server.ts          composition root — constructs every class above and wires them together;
                      the only place that knows the full dependency graph
  cli/chat-cli.ts     REPL client — talks to the Express API over plain fetch, no shared code
                      with the server beyond the persona name for display
scripts/
  inspect-memory.ts   dumps every fact (active + superseded) with supersede links, for
                      debugging and for demoing the contradiction flow
```

`ChatGraphNodes` methods are bound class methods, not free functions — LangGraph's node API wants
plain `(state) => partialState` functions, so the class exists to hold its constructor-injected
services (`MemoryService` × 2 — user facts and persona facts) and each node is `this.method`
rather than a closure capturing loose variables. It no longer depends on `PersonaService` or
`GeminiClient` directly — those moved to `ChatService` along with retrieval and generation (§10).

## 8. Interfaces: CLI and React frontend

Both are thin clients over the exact same Express API — neither has any memory/persona logic of
its own, and both work against the same session (`POST /session/resume` always returns the most
recently created session, so whichever interface you open second picks up where the other left
off).

- **CLI** (`backend/src/cli/chat-cli.ts`): a Node `readline` REPL. Consumes
  `POST /api/message/stream` directly via `fetch`, hand-parsing SSE frames (no library — it's ~15
  lines, see `parseSseFrame`) and writing each `token` event straight to stdout as it arrives, so
  the reply visibly types itself in the terminal. Prints `(⚡ served from semantic cache)` when
  `cacheHit` comes back true on the final `done` event. Typing `/stats` instead of a message calls
  `GET /api/metrics/summary` and prints the same totals/by-type breakdown the frontend shows (§12).
  This is the reference interface — it's what the brief actually asks for ("no UI required"), so
  it's the one that has to work with nothing else running except the backend.
- **Frontend** (`frontend/`, Vite + React + TypeScript): a two-pane layout — chat on the left, a
  tabbed "Memory" / "Observability" panel on the right (`rightTab` state in `App.tsx`). The chat
  pane renders the same SSE stream as a live-growing message bubble (`streamingText` state,
  appended to on every `token` event) with a "⚡ cached" badge on any bubble whose turn came back
  `cacheHit: true`. The Memory tab shows, per turn, exactly what was retrieved into context and
  what the reconciliation step did with the newly extracted facts (including the relation label —
  `contradicts`, `refines`, etc.), plus a standing list of every active/superseded fact via
  `GET /api/memory/facts`. The Observability tab (`MetricsPanel.tsx`) shows the same summary the
  CLI's `/stats` prints, refreshed after every turn. This exists to make the memory system's (and
  now the cost/latency) internals visible while demoing — the CLI proves the loop works, the
  frontend makes it legible without reading Mongo directly.
  - `api/companionApi.ts`: a small `CompanionApiClient` class — the same SSE-parsing logic as the
    CLI's `sendStreaming`, duplicated rather than shared (no shared package between the two
    projects; it's small enough that the duplication is cheaper than the plumbing to avoid it).
  - `components/ChatPanel.tsx` / `components/MemoryPanel.tsx` / `components/MetricsPanel.tsx`:
    presentational, all state lives in `App.tsx` (session id, message list, in-flight streaming
    text, last turn's result, fact lists, metrics summary).
  - CORS is enabled on the Express app (`cors()` in `server.ts`) specifically so the Vite dev
    server (`localhost:5173`) can call the backend (`localhost:4000`) directly — no proxy.

## 9. Deliberate non-choices

- **No LangGraph checkpointer for session state.** LangGraph ships its own persistence
  (`MongoDBSaver` and friends) that could store conversation state per thread. Not used here,
  because it would duplicate the `sessions`/`messages` collections that already exist — Mongo via
  the repository classes is the single source of truth for everything, including within a turn's
  graph execution. LangGraph is scoped strictly to orchestrating the extract/reconcile half of a
  turn (§10 covers why retrieval and generation aren't graph nodes at all).
- **No `$vectorSearch` / Atlas Local for fact retrieval.** See §3. (The semantic *response* cache
  does use a real vector index — RediSearch HNSW — see §10; the two decisions look inconsistent
  until you notice fact retrieval runs over at most a few hundred rows while the cache is checked
  on every single turn.)
- **Per-fact reconciliation, not a single big "diff my memory" call.** Slightly more Gemini calls,
  but each one is small, single-purpose, and easy to reason about/debug in isolation — a bad
  extraction on one fact doesn't affect the others.
- **No frontend state management library.** The UI is one screen with maybe a dozen pieces of
  state — `useState`/`useEffect` in `App.tsx` is simpler and more legible than introducing Redux/
  Zustand/React Query for something this small.

## 10. Streaming and semantic caching

**Streaming.** Gemini replies are generated via `chatModel.stream()` (`GeminiClient.streamReply`),
not `.invoke()`. This is the direct reason retrieval and reply generation live in `ChatService` as
plain sequential calls instead of LangGraph nodes: a LangGraph node's contract is "run, then return
a state update" — there's no clean way for a node mid-execution to push partial output to an HTTP
response as it's produced, short of routing through LangGraph's lower-level `streamEvents` API and
filtering for token-level events by node name. That's real complexity for a part of the pipeline
that has no branching logic to begin with, so it was simpler and more honest to just not put it in
the graph. `ChatController.sendMessageStream` sets up an SSE response and passes `onToken` straight
through `ChatService.sendMessage` to `GeminiClient.streamReply`, which forwards each chunk as it
arrives from the Gemini stream. `POST /api/message` (JSON, non-streaming) is kept alongside it,
calling the exact same `ChatService.sendMessage` with no `onToken` — one implementation, two
transports.

**Semantic caching.** Backed by Redis Stack's RediSearch module (`modules/cache/`), specifically
its HNSW vector index — a proper approximate-nearest-neighbor index, unlike the brute-force cosine
used for fact retrieval (see §9 for why that inconsistency is intentional). `SemanticCacheService`:

- `ensureIndex()`: creates a RediSearch index (`FT.CREATE`) over a `cache:*` hash prefix with
  `sessionId` and `contextHash` as `TAG` fields and `embedding` as an `HNSW`/`COSINE` `VECTOR`
  field (dimension 3072, matching `gemini-embedding-001`, confirmed empirically against a live
  stored fact rather than assumed from docs). Runs once at boot; a "already exists" error is
  swallowed (idempotent across restarts).
- `lookup(sessionId, contextHash, queryEmbedding)`: one `FT.SEARCH` combining an exact `TAG` filter
  on `(sessionId, contextHash)` with a `KNN 1` vector clause — Redis returns the single closest
  cached entry *within that filtered set*, with its cosine distance. A hit requires distance
  `<= 0.04` (i.e. cosine similarity `>= 0.96`).
- `store(...)`: writes a new `cache:<uuid>` hash with a 6-hour TTL (`EXPIRE`) — this is a cache,
  entries are meant to fall out on their own, not be managed forever.
- `hashContext(userFacts, personaFacts)`: a static helper — sorts and concatenates every retrieved
  fact's id (both collections) and SHA-1 hashes it. This is what makes the cache safe to use in a
  personalization-sensitive system: **the tag filter means a lookup can only ever match an entry
  cached under an identical set of retrieved fact ids.** If the user's memory state is different in
  any way that changes what got retrieved this turn, the contextHash changes, the tag filter
  excludes every old entry, and it's a guaranteed miss — no stale personalized reply can leak
  through. Combined with the 0.96 similarity floor and per-session scoping, this cache only ever
  fires on genuine near-duplicates (repeated greetings, "thanks", "haha", filler) — see the
  worked example below.
- Both `RedisCache.connect()` and every `SemanticCacheService` method fail soft: if Redis isn't
  reachable at boot, `connect()` returns `null` (logged once) instead of throwing, `server.ts`
  substitutes `SemanticCacheService.disabled()`, and every method on it is a no-op — the chat loop
  runs exactly as before, just without the cache. Same philosophy as `GeminiClient`'s handling of
  a missing/invalid `GEMINI_API_KEY` (a placeholder key keeps client construction from throwing;
  real calls fail with a clear logged error instead of taking the process down) and persona
  seeding's try/catch in `server.ts` — an optional or not-yet-configured dependency should degrade
  the relevant feature, not crash the whole server. See the README's "what was tried and
  abandoned" section for how that pattern was arrived at.

Worked example: user says "hey, what's your favorite kind of music?", gets a reply about jazz
records. A few turns later (same session, memory state unchanged) they ask "quick one — what is
your favorite kind of music?" — different phrasing, same intent. The embeddings are similar enough
to clear 0.96 cosine, the contextHash matches because nothing about the retrieved facts changed
in between, so `lookup` returns the earlier reply verbatim, `ChatService` emits it as a single SSE
`token` event (it really was instant — no fake typing delay), and `cacheHit: true` comes back on
the `done` event. A follow-up asking something substantively different ("do you believe in
ghosts?") correctly misses and generates fresh, verified in the same manual test pass as the
persistence/contradiction checks in §5.

## 11. Observability

Every Gemini call goes through `GeminiClient`, so that's where instrumentation lives: each of
`streamReply` / `extractFacts` / `classifyRelations` / `embed` times itself (`Date.now()` around
the call, in a `try/catch/finally` so a failure is still recorded, tagged `ok: false`) and reports
one row to `MetricsService.record()` → the `llm_calls` Mongo collection
(`modules/observability/llm-call.model.ts`):

```ts
{ type: "chat"|"extract"|"classify"|"embed"|"cache_hit", model, sessionId, promptTokens,
  completionTokens, totalTokens, latencyMs, ok, createdAt }
```

`cache_hit` is the one row type `GeminiClient` never writes — `ChatService` records it directly
when `SemanticCacheService.lookup` returns a hit, since that's precisely the case where Gemini was
never called at all. Recording it as a zero-token row in the same collection (rather than a
separate counter) is what makes `cacheHitRate` a simple query over one table:
`cache_hit count / (chat count + cache_hit count)`.

`MetricsService.record()` never throws — same fail-soft philosophy as everywhere else in this
codebase (§10): a metrics write failing should never take down a chat turn. `MetricsRepository`
exposes `summary()` (one Mongo `$group` aggregation by `type`, computing per-type call count,
token sums, average latency, and error count, then totals across types) and `recentCalls(limit)`
for a raw feed. `GET /api/metrics/summary` returns both together — that's the entire API surface;
there's no per-session or time-windowed breakdown yet (see §12).

**Token counts are exact for `extractFacts`/`classifyRelations`, best-effort for `streamReply`.**
The former two use `withStructuredOutput(schema, { includeRaw: true })`, which returns
`{ raw, parsed }` instead of just the parsed object — `raw.usage_metadata` is the real, complete
usage for that call. Streaming is a different story: `chatModel.stream()` yields multiple chunks,
each carrying its own `usage_metadata`, and empirically those numbers are **not** simple cumulative
running totals for this model — one real captured sequence read
`{input:675, output:13, total:1117}` then `{input:0, output:6, total:6}` then
`{input:0, output:13, total:13}`, which is neither monotonic nor internally consistent
(`input+output ≠ total` on the first one). Rather than guess at the exact semantics, `streamReply`
takes whichever chunk reported the highest `total_tokens` as its estimate — a documented heuristic,
not a guarantee. This was found by literally logging every chunk's `usage_metadata` during a real
call and reading the output, not by reasoning about it in the abstract — see the README's "what
was tried and abandoned" for the debugging trail.

**Embedding calls report latency and call count, no tokens** — `GoogleGenerativeAIEmbeddings`'s
`embedQuery` doesn't surface usage data through this SDK, so `embed`'s metrics row always has
`promptTokens: 0`. Noted rather than worked around (would need dropping to a lower-level API call).

## 12. Known gaps (see README for the full list)

- No automated eval harness yet (brief §3, explicit stretch goal).
- Retrieval and generation are two Gemini calls; extraction/reconciliation add one or two more on
  a cache miss — one Gemini call (embedding only) on a cache hit. No cross-turn batching.
- Brute-force cosine similarity for fact retrieval doesn't scale past a few thousand facts per
  user (see §3) — the semantic response cache already avoids this by using RediSearch HNSW.
- The cache's contextHash is built from retrieved fact *ids*, not their content, so a fact updated
  in place (`same`/`refines`, same id) doesn't bust the cache the way a superseded fact (new id)
  does — see the README's "Known limitations" for the precise failure window.
- Streamed chat-reply token counts are a heuristic, not exact (see §11). `llm_calls` also has no
  retention/rotation policy — it grows unbounded with usage, same tradeoff as `messages`/`facts`.
- No per-session or time-windowed metrics breakdown — `GET /api/metrics/summary` is all-time,
  across every session. Fine for a single-user prototype; a real multi-user deployment would need
  to scope this (which is itself out of scope per the brief).
