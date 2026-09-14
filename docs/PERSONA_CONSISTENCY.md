# Persona Consistency — Keeping the Chatbot "In Character"

The chatbot has a personality — a name (Wren), a backstory (grew up near the coast), opinions
(loves jazz, mildly skeptical of astrology, likes rainy days). The risk, over a long
conversation, is the same risk a human actor has in a long play: eventually saying something that
doesn't match the character. Maybe 40 turns in, it casually says it "hates jazz" — directly
contradicting something it said as fact on turn 3.

This doc explains the three separate things that work together to prevent that, and — the part
you specifically asked about — **how to actually watch this happen while using the app**, not
just in a test script.

## Layer 1: A written character sheet, always in view

Every single time the chatbot is about to reply — no matter what you're talking about — it's
handed a fixed block of text describing who it is: name, backstory, personality, opinions, and
explicit rules like "never say 'as an AI'." This isn't retrieved or searched for, it's just
*always there*, like an actor who keeps their character notes taped to the mirror and glances at
them before every scene.

**Why this alone isn't enough:** it tells the model what it *should* say, but doesn't check what
it *actually* said. A model can be given perfect instructions and still slip.

**Where:** `backend/src/modules/persona/persona.data.ts` — `PERSONA_SYSTEM_PROMPT`.

## Layer 2: A growing memory of its own past statements

Separately from remembering things about *you*, the system also remembers things the chatbot has
said about *itself* — using the exact same fact-storage mechanism described in
[CONFLICT_RESOLUTION.md](./CONFLICT_RESOLUTION.md), just pointed at the chatbot's own words
instead of yours. When something relevant comes up, those self-facts get pulled into the prompt
too: *"Relevant things you've said about yourself before: you love jazz, you grew up near the
coast, ..."*

**One important safety rule here:** these self-facts can **only** come from things the chatbot
*itself* said, never from things you said about it. If you say "you're such a nerd," that must
never accidentally become a stored "fact" about the chatbot's personality. The system enforces
this by literally only showing the fact-extraction step the chatbot's own reply text — the rest
of the conversation isn't even visible to that step, so there's no way for your words to sneak in
as if they were the chatbot's self-description.

**Why this alone isn't enough either:** it's still just more *instructions* handed to the model
before it writes a reply — it biases the model toward consistency but can't force it. And it only
gets pulled in when the current topic seems related to a past self-statement; a reply that
*happens* to touch on an established trait, without the conversation obviously being "about" that
trait, might not trigger retrieval at all.

**Where:** `backend/src/modules/chat/chat.graph.ts` — the `extractFacts` step, and
`backend/src/modules/persona/persona.service.ts` — `buildSystemPrompt`.

## Layer 3: A proofreader that checks the answer *after* it's written

This is the new piece, added specifically because layers 1 and 2 only ever *reduce the chance* of
a slip — they can't guarantee one never happens. So there's a third step: **after** the chatbot
writes its reply, a *second, independent* AI call reads that reply and checks it against a fixed
list of the chatbot's core traits (plus whatever self-facts were relevant this turn), and asks
simply: *does this reply actually contradict any of these?*

**Analogy:** imagine an actor delivers a line, and a script supervisor standing just off-stage,
holding the character notes, quietly checks whether what was just said actually matches the
character — completely separately from whatever the actor was thinking while they said it.

**If it finds a real contradiction:** the system doesn't erase what was already said (in a live,
streaming conversation, the words may already be on your screen by the time the check finishes —
you can't un-send them). Instead, it generates a short, natural, in-character correction and adds
it right after — the way a person catches themselves mid-conversation and says "wait, actually,
scratch that." For example, if it slipped and said it hates jazz, the correction might be
something like *"Actually, wait — I don't hate jazz at all, I love it, don't know where that came
from."* That correction becomes part of the saved reply, so if this exact reply ever gets reused
from the cache later (see [OPTIMIZATIONS.md](./OPTIMIZATIONS.md)), the corrected version is what
gets reused, not the original slip.

**Where:** `backend/src/modules/llm/gemini.client.ts` — `checkPersonaConsistency` (the check) and
`generateCorrection` (the fix), called from `backend/src/modules/chat/chat.service.ts` —
`runPersonaCheck`.

## How to see this yourself, live (no scripts needed)

This is the part that doesn't require running any eval script — every one of these is visible
just by talking to the chatbot normally:

- **CLI (`npm run cli`):** if a correction fires on a turn, you'll see an extra line printed right
  under the reply: `(persona check caught a contradiction with "..." and self-corrected)`.
- **Web UI (`cd frontend && npm run dev`):** the "Memory" panel's "Last turn" section always shows
  a line like `Mode: full · persona check: consistent`, or, if something was caught,
  `persona check: caught & corrected (...)`. You can watch this update after every single message.
- **Turn logs (`GET /api/turn-logs?sessionId=<id>`):** every turn's full `personaCheck` result is
  saved — whether it was checked, whether it was consistent, what fact it conflicted with if not,
  and whether a correction was generated. This is the same detail the eval harness reads to
  report failures, available for any real conversation, not just test runs.
- **Try to trigger it on purpose:** ask the chatbot directly about one of its stated opinions
  (e.g. "do you like jazz?"), then much later in the same conversation, ask a leading question
  that nudges toward the opposite ("you don't really care for jazz, right?") — then watch the
  Memory panel or CLI output for that turn.

## How this gets measured, not just observed

Watching it live tells you it's *working*, but not *how often* it works. For that, the
[evaluation harness](../README.md#automated-evaluation) runs a dedicated persona-consistency
suite: a long, multi-topic conversation (50 turns by default) run several times independently,
each one asking the chatbot direct questions about its established traits at scattered points
between ordinary small talk (not back-to-back interrogation, which wouldn't really test drift the
way a real conversation does). It reports:

- **Contradiction rate** — out of all those direct questions, across all the runs, how often did
  the answer actually conflict with an established trait.
- **How much that varies run to run** (since each run starts the chatbot's self-memory fresh, so
  one run's answers can't bias the next).
- **How often Layer 3 (the proofreader) caught and fixed a contradiction that would otherwise have
  gone out uncorrected** — this is the number that specifically tells you whether the "third
  safety net" is pulling its weight, separately from layers 1 and 2.

See `FIXES_REPORT.md` #2 and #6 for the actual numbers from a real run, and `ARCHITECTURE.md` §13
for exactly how the test conversation is built.

## The technical version

`ARCHITECTURE.md` §6 (persona consistency) has the exact prompts and code paths for all three
layers. `FIXES_REPORT.md` #6 and #7 explain the specific bugs each layer's design closes.
