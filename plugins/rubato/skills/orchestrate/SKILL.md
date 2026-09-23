---
name: orchestrate
description: Orchestrate a phased software workflow from a central agent that converges on a self-contained plan, then delegates the build. Use when the user asks to "plan", "orchestrate", "let's build X", or wants to design before implementing. Accepts a phase arg (discovery, design, draft, review, finalize, implement, cleanup) to enter or resume at a phase.
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

Seven phases in four groups, with three user checkpoints. A checkpoint is a hard
stop for user approval. Between checkpoints, phases flow without pausing.

Phases in order (`group`, then phase):

1. Discovery → **discovery**: Q&A and viability spikes. Interactive.
2. Design → **design**: concrete interface and code-shape decisions. Interactive.
3. Plan → **draft**: write the first plan file.
4. Plan → **review**: fan out multi-model reviews, triage findings with the user.
5. Plan → **finalize**: reorganize the plan into staged checklists.
6. Build → **implement**: delegate the build stage by stage.
7. Build → **cleanup**: delegate post-build review.

Checkpoints (each blocks until the user approves):

- **Checkpoint 1** — after `discovery`, before `design`. Ask: ready to move into
  design?
- **Checkpoint 2** — after `design`, before `draft`. Ask: ready for plan drafting?
  After this checkpoint the agent flows draft → review → finalize on its own with no
  pause.
- **Checkpoint 3** — after `finalize`, before `implement`. Tell the user the plan is
  ready and print the compact instruction. The user runs `/compact`, then
  invokes `implement`.

The compact runs between Checkpoint 3 and `implement`. There is no auto-advance past
any checkpoint.

### Model roster

The current models for delegation. Update this list as new models release.

- **Reviewers** (review and cleanup phases): Sonnet 5 and GLM 5.2. Run them in
  parallel for independent perspectives. No Opus at the review tier. Reviews are
  a fan-out read task, and Sonnet handles them well at lower cost.
- **Implementers** (build phase), routed by stage complexity:
  - **Very simple** work: GLM 5.2.
  - **Simple** work: Sonnet 5.
  - **Complex** work: Opus 4.8.

If a listed model isn't available in the current environment, fall back to the
nearest tier that is (for example, use Sonnet where GLM isn't configured).

### Delegating to subagents

Spawn every delegate with the `Agent` tool. Pick the model by tier:

- GLM 5.2: `subagent_type: "glm"`.
- Sonnet 5: `subagent_type: "claude"`, `model: "sonnet"`.
- Opus 4.8: `subagent_type: "claude"`, `model: "opus"`.

Run independent delegates concurrently: send their `Agent` calls in one message.
Each returns a short summary. For recon and reviews, have the subagent write
detail to a file under `./tmp/` and hand back only the path plus a summary, so
full output stays out of the central context.

When you enter a phase mid-flow (`/orchestrate review`, `/orchestrate
implement`), recover state first: read the plan file and see which stage items
are already checked off before acting.

### Recon subagent: GLM 5.2

Delegate codebase recon to the `glm` subagent (see delegation above). It runs on
a cheap local model, so use it as the high-volume recon layer instead of
spending Claude budget reading the tree.

Give it a **read-only brief**: look and report, don't edit. Ask it to report
back Task, Findings, Relevant files, Open questions. Dispatch in the background,
keep the Q&A moving, and read the report when the notification lands. Fan out a
batch in one message when a topic opens several questions.

Reach for it whenever you'd otherwise send a Claude `Explore` subagent to read
the tree: how a subsystem works, where a thing is defined and who calls it, what
pattern the repo uses, whether prior art exists. It grounds `AskUserQuestion`
options in real file and function anchors. Good briefs:

- "How does `<subsystem>` work today? Name the files and functions."
- "Where is `<thing>` defined and who calls it? What pattern does the repo use?"

Send a full Claude subagent instead when the work writes code (viability spikes)
or when recon feeds a load-bearing decision. GLM locates code well, but verify
its judgment calls before they land in the plan.

Each call is a fresh session with no memory of the last. Put the paths and
context the brief needs into the brief itself.

### Phase args

`/orchestrate` with no arg starts at **discovery**. Pass a phase name to enter
or resume:

- `/orchestrate` or `/orchestrate discovery` — Q&A and viability spikes.
- `/orchestrate design` — concrete interface and code-shape decisions.
- `/orchestrate draft` — write the first plan file.
- `/orchestrate review` — fan out multi-model reviews.
- `/orchestrate finalize` — reorganize into staged checklists.
- `/orchestrate implement` — delegate the build. Run this after `/compact`.
- `/orchestrate cleanup` — delegate post-build review.

### The compact boundary

A skill can't run `/compact` itself. At Checkpoint 3, tell the user to run it
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

Plan docs are read by humans. Write them tight, Hemingway register. Median 10-15
words a sentence. Lead each section with its point. Contractions welcome.

- **No em dashes or semicolons.** Use a comma, period, or parens. Two sentences.
- **No rule of three.** Two-item series are fine. More goes in a bullet list.
  Don't pad for rhythm, including triplet adjectives ("fast, scalable, reliable").
- **No throat-clearing or filler.** Cut "In order to", "It is worth noting", "not
  just X but Y". Start with the point.
- **No buzzwords.** delve, robust, comprehensive, leverage, utilize, seamless,
  streamline, paramount, vital, crucial, elevate, unlock. Name the mechanism.
- **Concrete over abstract.** Name the file, function, table, flag. Backtick
  every code identifier.
- **Bullets for lists** of steps or requirements. Paragraphs for reasoning.

Two-pass check before saving: scan for em dashes, semicolons, banned vocabulary,
and triplet phrasing. Cut them.

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

Lean on the `glm` recon subagent throughout this phase (see the recon
subagent). Fire recon briefs in the background to learn how the code works
before you ask the user about it. The Q&A gets sharper when your questions carry
file and function anchors instead of guesses.

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

- **Success criteria.** What does "done and working" look like in concrete,
  observable terms? Name the behavior or output that proves the feature works.
  This is the anchor for the plan's "What defines success" section. Distinct
  from verification: success criteria are what must be true, tests are how you
  check it.
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
on them. Do the homework first, then present a grounded decision. Fire the
`glm` recon subagent (see the recon subagent) to do that homework. It hands back
the file and function anchors every option needs.

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

### Checkpoint 1

Once the ambiguity surface is small and the risky assumptions are validated (or
the approach has pivoted), **ask the user if they're ready to move into
design.** Don't jump into design. This is the first of three approval checkpoints.

---

## Design phase

Interactive. Central agent and user. Discovery reduced conceptual ambiguity.
Design pins down the concrete shape of the code before any plan gets drafted.

Discovery answered "what and why." Design answers "what exactly does it look
like." The point: decide the real signatures, names, and layout with the user,
so the draft isn't guessing and you aren't reviewing abstractions.

**Ask the user directly about concrete shape.** Don't stay abstract, and don't
silently default to your own choices on decisions the user cares about. Use
`AskUserQuestion` with context briefs, same rules as discovery. Ground every
option in `glm` recon of the existing code so options carry real file and
function anchors.

Cover the concrete surface. Not every item applies to every task, but check each
one:

- **Function and method signatures.** Names, argument order, types, return
  shapes.
- **Names.** Modules, classes, functions, key variables. Naming is the user's
  call, not yours to guess.
- **File and module layout.** New files vs edits to existing ones. Where each
  piece lives.
- **Data shapes.** Schemas, records, event payloads, config keys.
- **Code structure and style.** Error-handling shape, nesting, existing patterns
  to mirror.
- **Public surface.** What callers see vs internal helpers.

Ground every option in existing code. Before offering a signature or naming
option, fire `glm` recon to find the closest existing pattern and cite it.
"Match `foo_bar()` in `path/x.py`" beats "pick a naming convention."

Record the decisions. They feed straight into the draft's named files, classes,
and functions section, so the implementer builds the exact shape the user chose.

### Checkpoint 2

Once the concrete shape is settled, **ask the user if they're ready for a draft
plan.** This is the second of three approval checkpoints.

---

## Plan phase

After Checkpoint 2, the central agent flows through draft → review → finalize without
pausing for approval. The review sub-step is interactive (you triage findings
with the user), but it isn't a go/no-go checkpoint.

### Draft

The draft is the first version of the plan file. Include everything from "What
the plan file should look like" except the staged checklists, which come at
finalize. So: context, the "What defines success" section, the Q&A and spike
record from discovery, the design-phase interface decisions, and the drafted
implementation approach as prose or outline.

After writing the draft, review your own plan. Look for weaknesses,
ambiguities, missed edge cases, unspecified interfaces. Raise new issues via
`AskUserQuestion` (with context briefs). Update the doc as decisions land.

### Review

Fan out independent reviews on multiple models, then triage with the user. A
fresh context with no bias from the debates catches gaps the central agent has
gone blind to.

- Launch the reviewers from the model roster in parallel (Sonnet 5 and GLM 5.2).
  Send them in one message so they run concurrently.
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

### Checkpoint 3

When the plan is final, tell the user it's ready to implement and print the
compact instruction (see "The compact boundary"). This is the third and last
approval checkpoint. Wait for the user to compact and invoke `/orchestrate
implement`.

---

## Build phase

After Checkpoint 3 and the compact, the central agent delegates the build. It reads
the plan file as the source of truth and hands each stage to a subagent.

### Implement

Delegate stage by stage. The plan is self-contained, so each subagent gets the
plan file path and its assigned stage.

- **Route by the stage's complexity tier**: see the model roster for the
  tier-to-model mapping and delegation for how to spawn each.
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
dead code, and inconsistency the stage-by-stage build missed. Fixes flow back
through the plan file as new stages, so the cleanup work uses the same delegate
and check-off loop as the implement phase.

**Step 1: Review.** Same fan-out as the review phase, but against the landed
changes instead of the plan. Launch Sonnet 5 and GLM 5.2 in parallel, each
writes findings to a file (for example `./tmp/cleanup-<model>.md`) and returns a
summary plus the path. Look for leftover scratch code, duplicated logic across
stages, dead branches, naming drift, and anything that doesn't match the plan's
intent.

**Step 2: Triage.** The central agent reads the findings files, dedupes, and
triages with the user via `AskUserQuestion`. Not every finding is valid.
Decide which ones become fix work.

**Step 3: Append follow-up stages.** For the findings the user accepts, add new
stages to the bottom of the plan file's stages section. Don't fix inline from
the central agent.

- Write each follow-up stage in the same format as an implement stage: a
  markdown to-do checklist of concrete steps, tagged with a complexity tier
  (very simple, simple, complex) for model routing.
- Group related findings into one stage. Don't make a stage per one-line fix.
- Label the group clearly (for example `## Stage F1: cleanup follow-ups`) so
  it's obvious these came from review, not the original plan.

**Step 4: Fix.** Delegate the follow-up stages exactly like the implement phase.

- Route by complexity tier (see the model roster), same as implement.
- Each subagent implements its stage, runs the relevant tests, and checks off
  its to-do items in the plan file. It returns a short summary.
- The central agent confirms each stage is done before dispatching the next.

Re-run Step 1 if a fix stage is large enough to warrant another look. Small
fixes don't need another review round.

---

## What the plan file should look like

- Context section up top: why this change, what problem it solves, intended
  outcome.
- "What defines success" section: the concrete, observable criteria that prove
  the feature works. Separate from the verification section, which lists the
  tests that check those criteria.
- Q&A record from discovery (and follow-up rounds), plus viability spike results.
- Concrete interface and code-shape decisions from the design phase: signatures,
  names, file layout, data shapes.
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
- Drafting the plan before Checkpoint 2.
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
