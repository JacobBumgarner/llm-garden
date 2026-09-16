---
name: orchestrate
description: Orchestrate a phased software workflow from a central agent that converges on a self-contained plan, then delegates the build. Use when the user asks to "plan", "orchestrate", "let's build X", or wants to design before implementing. Accepts a phase arg (discovery, draft, review, finalize, implement, cleanup) to enter or resume at a phase.
---

# Orchestrate

Drive a phased workflow that ends in a self-contained plan file, then delegate
the build stage-by-stage. The agent implementing the plan should not have to
guess about implementation details. Your job in the planning phases is to reduce
ambiguity, not to write production code.

One agent (the session the user is typing into) stays central across the whole
flow. It owns the plan file and every conversation with the user. It hands the
heavy, non-interactive work (viability spikes, reviews, implementation, cleanup)
to subagents that report back short summaries, so the central context stays
lean.

## How this skill runs

Six phases in three groups, gated by two user approvals.

```
Discovery          Plan                         Build
  Q&A         ──▶   draft ──▶ review ──▶     ──▶  implement ──▶ cleanup
  viability spikes  finalize
        │                          │                  │
     [Gate 1]                  [Gate 2]           (compact runs
   "ready to draft?"      "ready to implement?"    between Gate 2
                          then user runs /compact   and implement)
```

- **Gate 1**: after discovery, the agent asks the user if they're ready for
  plan drafting. Nothing else in the Discovery or Plan group pauses for
  approval. The agent flows draft → review → finalize on its own.
- **Gate 2**: after finalize, the agent tells the user the plan is ready to
  implement and prints the compact instruction. The user runs `/compact`, then
  invokes the implement phase.

There is no auto-advance past these two gates. Everything between them flows.

### Model roster

The current models for delegation. Update this list as new models release.

- **Reviewers** (review phase): Sonnet 5, Opus 4.8, GLM 5.2. Run them in
  parallel for independent perspectives.
- **Implementers** (build phase), routed by stage complexity:
  - **Very simple** work: GLM 5.2.
  - **Simple** work: Sonnet 5.
  - **Complex** work: Opus 5.

If a listed model isn't available in the current environment, fall back to the
nearest tier that is (for example, use Sonnet where GLM isn't configured).

### Phase args

`/orchestrate` with no arg starts at **discovery**. Pass a phase name to enter
or resume:

- `/orchestrate` or `/orchestrate discovery` — Q&A and viability spikes.
- `/orchestrate draft` — write the first plan file.
- `/orchestrate review` — fan out multi-model reviews.
- `/orchestrate finalize` — reorganize into staged checklists.
- `/orchestrate implement` — delegate the build. Run this after `/compact`.
- `/orchestrate cleanup` — delegate post-build review.

### The compact boundary

A skill can't run `/compact` itself. At Gate 2, tell the user to run it
manually. The plan file is the source of truth from here, so the summary can
drop the Q&A debate:

> Plan is final at `path/to/plan.md`. Run `/compact focus on the plan file at
> path/to/plan.md and the remaining implementation stages`, then invoke
> `/orchestrate implement`.

Compaction is optional, not load-bearing. Subagents hand back only a summary, so
the implement phase stays lean even without it. Compaction mostly clears the
now-redundant discovery transcript and keeps the single-thread feel.

## Plan file goal

- One self-contained, fully encapsulated plan file. A second agent should be
  able to pick it up and implement without back-and-forth (small clarifications
  during dev are fine, but the ambiguity surface should be minimal).
- No line-by-line code chunks. Do outline the source files, classes, and
  functions that will be created or edited, with clear requirements for each.
  Skeleton code outlines are good, as long as they are short and clear. Provide
  enough context for the implementer to understand the intent and requirements
  of each function or class.

## Prose style

Plan docs are read by humans. Write them so the user can rapidly read and
understand, not wade through dense and verbose LLM texture. Think: Hemingway.

- **No em dashes.** Not `—`, not `--`. Use a comma, period, or parens.
- **No semicolons.** Two sentences.
- **No rule of three.** Two-item series are fine. Three-or-more goes in a
  bulleted list. Don't pad to three for rhythm.
- **No triplet adjectives.** "fast, scalable, and reliable" is marketing prose.
  Pick the one that matters.
- **No "not just X but Y" / "more than just X".** Say Y.
- **No throat-clearing openers.** "In order to", "When it comes to", "It is
  worth noting that". Delete them and start with the point.
- **No buzzwords.** delve, robust, comprehensive, leverage, utilize, seamless,
  streamline, cutting-edge, paramount, plethora, vital, crucial, elevate,
  unlock. If a property matters, name the concrete mechanism.
- **Short sentences.** Hemingway register. Median 10-15 words. Long sentences
  only when the structure earns them, surrounded by short ones.
- **Lead with the point.** First sentence of each section says what the section
  is about.
- **Concrete over abstract.** Name the file, function, table, flag.
- **Contractions welcome.** "it's", "don't", "won't".
- **Bullets over paragraphs** for lists of steps, requirements, or decisions.
  Paragraphs are for context and reasoning.
- **Backtick every code identifier.** Paths, functions, env vars, CLI commands.

Two-pass check before saving the plan file: scan for em dashes, semicolons,
banned vocabulary, and triplet phrasing. Cut them.

## Work guidelines

- Methodical, clean, careful. No patched, short-work, or hacky proposals.
- We are not in a rush. Planning is calm and smooth. Effective beats hasty,
  half-baked ideas.
- **Never estimate in temporal units.** No "1-2 days", no "a few hours".
  Estimate by *impact surface*: files touched, LoC changed, new tests, modules
  affected. Time is not a factor in the decision to build something cleanly.
- A human and other agents will read this code. Best practices, shallow nesting,
  low cyclomatic complexity, well-organized.

---

## Discovery phase

Interactive. Central agent and user. Two jobs run here: deep Q&A to reduce
ambiguity, and viability spikes to validate risky assumptions before any plan
gets written.

### Deep Q&A

Start with a natural-language back-and-forth on the topic. The user supplies
context, ideas, questions, and drafted details. You poke holes and surface what
they haven't decided.

- **Iterate. Multiple rounds are expected.** One round is almost never enough.
  Keep going until the ambiguity surface is genuinely small.
- **Don't converge early.** If you find yourself wanting to draft after one
  round, you're probably skipping edge cases. Do another round first.
- Ask as many questions as you need. There's no maximum. The goal is a clear
  plan, not a short session.

Cover these dimensions before you consider discovery done. Not every dimension
applies to every task, but you should have consciously checked each one:

- **Requirements.** What must be true when this is done? What's explicitly out
  of scope?
- **Interfaces.** Function signatures, API shapes, data schemas, event formats.
- **Edge cases.** Empty inputs, concurrency, partial failure, large inputs.
- **Failure modes.** What happens when a dependency is down or returns garbage?
- **Non-goals.** What are we deliberately not building or handling?
- **Prior art.** What existing code, utility, or pattern should this reuse?
- **Verification.** See the verification section. Ask about tests here, not at
  finalize.

### Ask questions the user can actually answer

The user may not be the domain expert on the thing you're asking about. A bare
"which X strategy?" with four option labels and no context puts the burden back
on them. Do the homework first, then present a grounded decision.

**Give context before the questions, then ask.** The `question` field of
`AskUserQuestion` is short, and the option cards do most of the work. That's not
enough room to explain a subtle decision. So before a batch of questions, write
a plain-text brief in normal output, then fire the tool. Format:

```
## Q1 context
<one or two paragraphs framing what this decision is, why it matters, what
you found in the code, what the trade-off hinges on>

## Q2 context
<...>
```

Then call `AskUserQuestion` with the questions. The brief carries the
reasoning. The tool carries the decision. This is the one place a prose block is
correct. A prose block that *is* the questions is still banned.

Every `AskUserQuestion` call must follow these rules:

- **Never ask an open-ended "what should we do?"** Enumerate concrete options.
  If you can't name two real options, the question isn't ready. Go read the code
  or the docs first.
- **Every option needs a `description` that names the trade-off.** What you
  gain, what you give up, what it costs later. One or two sentences.
- **Recommend one option.** Put it first and append `(Recommended)` to its
  `label`. State why in its `description`, tied to constraints the user already
  gave you (project conventions, existing patterns, prior answers).
- **Options must be mutually exclusive and real.** No "Option A" / "Option B" /
  "hybrid" / "something else" filler. If a hybrid is right, make it its own
  option with its own trade-off.
- **Cite the concrete anchor.** File path, existing function, library version,
  prior decision in this session. Options that reference `path/to/thing`
  beat options that reference "the session layer".
- **Cap it at four options.** If you have more, you haven't narrowed enough.
  Prune to the top candidates and say in the question text what you dropped.

If a question genuinely has no defensible recommendation, say so in the question
text: "Both are fine. Pick based on X." Don't fake a recommendation.

### Viability spikes (Stage 0)

Validate the plan's load-bearing assumptions before drafting. A plan built on an
unproven assumption is wasted if the assumption turns out false.

During Q&A, name the assumptions the plan depends on. A load-bearing assumption
is one where, if it's false, the whole approach changes. Examples:

- "Library X actually supports streaming responses."
- "This API returns the field we need."
- "This query is fast enough at production row counts."
- "These two systems can share a transaction."

For each risky assumption, run a **spike**: throwaway probe code in `./tmp/`
that answers viable or not-viable with evidence. Delegate the spike to a
subagent so the probe's file reads and debugging stay out of the central
context. The subagent returns a short verdict plus the evidence.

- If the spike holds, note it and move on.
- If the spike fails, pivot the approach with the user *now*, before any plan
  exists. This is the whole point. A failed spike costs a scratch file, not a
  full plan doc.

Only leave viability checks for implementation time if they're low-risk sanity
checks, not approach-deciding ones. Anything approach-deciding gets spiked here.

### Gate 1

Once the ambiguity surface is small and the risky assumptions are validated (or
the approach has pivoted), **ask the user if they're ready for a draft plan.**
Don't jump into drafting. This is the first of two approval gates.

---

## Plan phase

After Gate 1, the central agent flows through draft → review → finalize without
pausing for approval. The review sub-step is interactive (you triage findings
with the user), but it isn't a go/no-go gate.

### Draft

The first draft plan contains:

1. A concise explanation of the request or feature.
2. A clear, concise record of the Q&A and spike results from discovery.
3. The drafted implementation plan.

After writing the draft, review your own plan. Look for weaknesses,
ambiguities, missed edge cases, unspecified interfaces. Raise new issues via
`AskUserQuestion` (with context briefs). Update the doc as decisions land.

### Review

Fan out independent reviews on multiple models, then triage with the user. A
fresh context with no bias from the debates catches gaps the central agent has
gone blind to.

- Launch the reviewers from the model roster in parallel (Sonnet 5, Opus 4.8,
  GLM 5.2). Send them in one message so they run concurrently.
- Each reviewer gets the plan file path and a critical, non-sycophantic brief:
  find gaps, ambiguities, unspecified interfaces, missing edge cases, and
  anything that would block a second agent from implementing without questions.
- **Each reviewer writes its findings to a file** (for example
  `./tmp/review-<model>.md`) and returns a short summary plus the path. This
  keeps full critiques out of the central context.
- The central agent reads the findings files, dedupes, and triages with the
  user via `AskUserQuestion`. Not every finding is valid. Discuss, decide, and
  edit the plan.

### Finalize

Once the doc is stable, reorganize the implementation section into markdown
to-do stages.

- Stages are the actual implementation, ordered so each builds on the last.
  Each stage is a markdown to-do list of concrete steps.
- Size each stage so an Opus-grade agent can implement it independently within
  one context window. **Don't over-split.** One bloated stage is bad, ten tiny
  stages is worse than three right-sized ones.
- Tag each stage with a complexity tier so the implement phase can route it to
  the right model (see the model roster): **very simple**, **simple**, or
  **complex**.

Any remaining low-risk validation code can be an early stage. The
approach-deciding viability checks already happened in discovery.

#### Verification and tests

Every plan ends with a verification section. Not an afterthought, not one line
saying "add tests". This section is what the second agent uses to decide whether
the change is done.

The bar: **would this test have caught the bug in production?** If the answer is
"no, because the test only re-checks the mock", the test isn't earning its
place.

The examples below are illustrative and skew toward one kind of project. Map
them to the actual stack. Read the repo first: match its test runner, its
directory layout, and its existing test style. A CLI, a library, and a web
service each verify differently.

Every plan must include:

- **Unit tests** for pure logic. Adapters, translators, parsing, schema
  round-tripping. Fine to mock at module boundaries.
- **Integration tests** that exercise the change against a real, running system.
  Different projects need different integration tests. If one hasn't been set up
  yet, the plan should propose it as a discussion point. Prefer a local stack
  that drives the same path the real client hits: real datastore, real API, real
  transport.
- **A named end-to-end scenario.** Not "test happy path". Spell out the concrete
  flow. Example: "POST to the messages endpoint with a query that triggers tool
  X, assert the stream contains a `tool_result` event for X followed by a
  `message` event, then re-fetch the session and assert the block sequence
  matches."

Ask about verification in discovery, not here. Sample questions:

- What's the single scenario that proves this feature works?
- Which existing test file is the closest neighbor? Extend it or make a new one?
- Does this touch persistent state, streaming, or auth? If yes, an integration
  test against local endpoints is required, not optional. Search or ask for
  these local testing endpoints.
- Any manual verification the human wants to run (curl, REPL, MCP client)?

Record the answers in the plan's Q&A and inline the resulting test list into the
verification section. Name the test files, the fixtures, and the assertions.

Anti-patterns that must not ship in the plan:

- Unit tests only, when the change touches persistent state, streaming, auth, or
  the agent loop.
- Tests that mock the thing under test. If the change is in the session store,
  don't mock the session store.
- Assertions that only check "no exception raised" for behavior with an
  observable output.
- "Add tests" as a bullet with no scenario named.

### Gate 2

When the plan is final, tell the user it's ready to implement and print the
compact instruction (see "The compact boundary"). This is the second and last
approval gate. Wait for the user to compact and invoke `/orchestrate
implement`.

---

## Build phase

After Gate 2 and the compact, the central agent delegates the build. It reads
the plan file as the source of truth and hands each stage to a subagent.

### Implement

Delegate stage by stage. The plan is self-contained, so each subagent gets the
plan file path and its assigned stage.

- **Route by the stage's complexity tier** (see the model roster): GLM 5.2 for
  very simple, Sonnet 5 for simple, Opus 5 for complex.
- Run stages in dependency order. A stage that depends on an earlier one waits
  for it.
- Each subagent implements its stage, runs the stage's tests, and **checks off
  its to-do items in the plan file** as they land. It returns a short summary of
  what changed and what passed, not a full diff.
- The central agent reads the summary, confirms the stage is done, and dispatches
  the next.

Put a progress-tracking line near the top of the plan's stages section so the
implementing agents know to check off items: "Check off each item in this file
as you complete it."

### Cleanup

After the stages land, delegate a review of the actual work. Catch refactoring,
dead code, and inconsistency the stage-by-stage build missed.

- Launch Sonnet subagents to review the landed changes against the plan.
- Each writes findings to a file (for example `./tmp/cleanup-<n>.md`) and
  returns a summary.
- Look for: leftover scratch code, duplicated logic across stages, dead
  branches, naming drift, and anything that doesn't match the plan's intent.
- The central agent triages the findings with the user and dispatches fixes.

---

## What the plan file should look like

- Context section up top: why this change, what problem it solves, intended
  outcome.
- Q&A record from discovery (and follow-up rounds), plus viability spike results.
- Named files, classes, functions to be touched or created, with requirements
  per unit.
- Reused utilities and functions called out with paths so the implementer
  doesn't reinvent them.
- Verification section: unit tests, integration tests against a live local
  endpoint, and the named end-to-end scenario. See "Verification and tests".
- Progress-tracking instruction near the top of the stages section.
- Stages as markdown checklists at the bottom, each tagged with a complexity
  tier (very simple, simple, or complex) for model routing.

## What to avoid

- Time estimates. Ever.
- Line-by-line code in the plan.
- Dumping a wall of questions in prose. Use the tool, with a context brief
  before it.
- Asking open-ended questions with no options, or options with no trade-off
  `description`, or no recommended option. See the discovery phase.
- Drafting the plan before Gate 1.
- Writing the full plan on top of an unvalidated load-bearing assumption. Spike
  it first.
- Over-splitting stages into trivia.
- References to other plan files inside the code itself. If context matters,
  inline it when writing the code later.
- Author attribution. Don't put the user's name, "by X", or an "Author:" line
  anywhere in the plan file. Git handles authorship.
- Verification sections that stop at "add unit tests". Anything touching
  persistent state, streaming, auth, or the loop needs an integration test
  spelled out.
