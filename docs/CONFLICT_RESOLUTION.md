# Conflict Resolution — What Happens When You Tell It Something New

Say you tell the chatbot "I'm a developer" today, and three weeks from now you say "I'm actually
a backend developer at Microsoft now." What should happen to the *old* fact? This doc explains
exactly how the system decides, and what `supersedes` / `supersededBy` actually mean (those are
the two fields that were confusing).

## The two kinds of "new information"

When you say something new that touches on a fact the chatbot already has, there are really only
two things that can be going on:

1. **You're adding more detail to something still true.** "I'm a developer" → "I'm a *backend*
   developer *at Microsoft*." The first thing you said isn't wrong — it's just less specific
   than what you just added. We call this **refining**.
2. **You're replacing something that's no longer true.** "I live in Seattle" → "I just moved to
   Austin." The first thing you said is now **false**. We call this **contradicting**.

The system has to figure out which of these two is happening, every time, because the correct
thing to do is completely different for each one:

- **Refining** → there should still be exactly **one** fact about your job when this is done —
  just a better, more complete one. Nothing should look "crossed out."
- **Contradicting** → the old fact needs to be marked as no longer current (so the chatbot never
  accidentally brings it up again as if it's still true), and a new fact takes over.

## How it decides: one AI call, asked to pick a label

When you say something new, the system:

1. Quickly (no AI needed) checks: do I have any *existing* fact about the same kind of thing
   (same category, e.g. "job" facts only get compared to other "job" facts)? If not, there's
   nothing to compare against — the new fact just gets saved. Done.
2. If there *is* something to compare against, it asks the AI model one question: *"Here's a new
   fact, and here's an old fact about the same kind of thing — do these (a) say basically the
   same thing, (b) does the new one add detail without changing the old one (refines), (c) does
   the new one make the old one false (contradicts), or (d) are they actually about different
   things (unrelated)?"*

That's it — one AI call, asked to pick one of four labels. Not a chain of calls, not a voting
system between multiple models.

**The tricky part** — and the reason this needed a specific fix — is that "refines" and
"contradicts" can look similar to an AI model at first glance, because both are "a new statement
about something already known." The rule we gave the model, in plain words: ***if the old
statement is still true, just less complete, it's refining; only call it contradicting if the old
statement is now actually false.*** "Developer" → "backend developer at Microsoft" doesn't make
"I'm a developer" false, so it's refining. "Living with my partner" → "we broke up" makes the
first statement false, so it's contradicting.

## What actually happens to the data, for each label

### Refining (or "same," which is treated the same way)

The **existing** fact gets updated **in place** — same identity, just new/better content. No new
fact is created for that specific thing. Imagine erasing part of a sticky note and writing a more
detailed version in the same spot, rather than sticking a second note next to it.

*(One subtlety the eval testing actually caught: if your new sentence contains **two** facts —
like "I'm a backend developer at Microsoft" contains both a refined job title AND a brand-new
"employer" fact — the job title gets refined in place, AND a genuinely new "employer" fact gets
added alongside it. That's correct! It's not a bug that the total number of facts went up by one
— refining one fact doesn't forbid a different, new fact from also being learned in the same
sentence.)*

### Contradicting

This is where `supersedes` and `supersededBy` come in:

- A **brand-new** fact document gets created for the new, true information.
- The **old** fact gets marked `status: "superseded"` (meaning: "this used to be true, it's not
  anymore, don't use it to answer questions") — but it is **not deleted**. It stays in the
  database forever, for the history/audit trail.
- The old fact gets a field called **`supersededBy`** pointing to the *new* fact's ID — like a
  sticky note that says "crossed out — see the new note over there ➜."
- The new fact gets a field called **`supersedes`** pointing back to the *old* fact's ID — the
  same arrow, drawn from the other direction, so you can follow the chain either way ("what did
  this fact replace?" or "what replaced this fact?").

**Analogy:** imagine a whiteboard where instead of erasing old information, you draw a line
through it and write "→ see note #7" next to it, then on note #7 you write "← replaces note #3."
Nothing is erased, but everyone reading the board knows exactly which note is currently true and
exactly how it got that way.

Only `active` facts (never `superseded` ones) are ever handed to the chatbot when it's forming a
reply — so a superseded fact can never accidentally "leak" into a conversation and make the
chatbot say something the user already told it was no longer true.

## A worked example, start to finish

1. You say: *"My partner and I just moved in together."*
   → New fact created: `relationship_status = "living with partner"`, `status: active`.
2. Weeks later, you say: *"I broke up with my ex, it's over."*
   → The system finds the old relationship fact (same category), asks the AI to compare them,
     gets back **"contradicts."**
   → New fact created: `relationship_status = "broke up"`, `status: active`,
     `supersedes: <old fact's id>`.
   → Old fact updated: `status: superseded`, `supersededBy: <new fact's id>`.
3. You ask the chatbot something about your relationship.
   → Retrieval only ever looks at `active` facts, so it sees the "broke up" fact, not the old
     "living with partner" one. The chatbot's answer reflects reality, not stale history.
4. Curious what actually happened, historically? `npm run inspect-memory` still shows *both*
   facts, with the `superseded`/`active` status and the arrow between them — nothing was thrown
   away.

## How to see this yourself, live (no scripts needed)

- **Web UI:** the "Memory" panel's "Last turn" section shows a "Memory updates" list right after
  you say something that touches an existing fact — it labels the outcome (`refines`,
  `contradicts`, etc.) in real time.
- **CLI + `npm run inspect-memory`:** say something that contradicts an earlier statement, then
  run `npm run inspect-memory` in another terminal — you'll see the old fact marked `superseded`
  with a `-> superseded by <id>` note, and the new one `active`.
- **Turn logs:** `GET /api/turn-logs?sessionId=<id>` returns, for every turn, exactly what
  relation was decided and what changed — useful if you want to see the raw decision without
  guessing from the reply text.

## The technical version

`ARCHITECTURE.md` §5 has the exact prompt wording given to the AI model and the exact code path
(`MemoryService.reconcileOne` in `backend/src/modules/memory/memory.service.ts`).
`FIXES_REPORT.md` #10 has the real evaluation numbers (relation-classification accuracy,
supersession accuracy, consolidation accuracy) from actually running these scenarios.
