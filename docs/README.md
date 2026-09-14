# Plain-Language Docs

These four docs explain the trickiest parts of the memory system in plain, simple language —
no jargon without a definition, lots of everyday comparisons. They exist because
`ARCHITECTURE.md` and `FIXES_REPORT.md` are written for someone already fluent in the codebase;
these are written for someone meeting it for the first time.

- **[OPTIMIZATIONS.md](./OPTIMIZATIONS.md)** — every place the system tries to be fast or cheap
  (caching, reusing work, skipping unnecessary steps), and exactly how each one is checked.
- **[RETRIEVAL_AND_SCORING.md](./RETRIEVAL_AND_SCORING.md)** — how the system picks *which*
  memories to hand the chatbot each turn. Covers `temporalType`, `recencyScore`, and clears up
  the "reranking" question — there isn't a separate reranking step, and this explains what's
  there instead.
- **[RETRIEVAL_EVAL_METRICS.md](./RETRIEVAL_EVAL_METRICS.md)** — exactly how Recall@K,
  Precision@K, and MRR get computed for this system, walked through with real numbers from an
  actual run (not made-up examples), including why they're broken down by query kind.
- **[CONFLICT_RESOLUTION.md](./CONFLICT_RESOLUTION.md)** — what happens when you tell the
  chatbot something that changes or replaces an older fact. Covers `supersedes` /
  `supersededBy` and the difference between "refining" a fact and "contradicting" one.
- **[PERSONA_CONSISTENCY.md](./PERSONA_CONSISTENCY.md)** — how the system tries to keep the
  chatbot's personality from contradicting itself, and — importantly — how you can watch this
  happen live in the CLI or the web UI, not just in a test script.

Each doc ends with a "the technical version" pointer into `ARCHITECTURE.md` for exact code
references.
