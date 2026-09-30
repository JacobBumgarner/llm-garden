---
name: orchestrate
description: Orchestrate a phased software workflow in which agents design and build while the user acts as tech lead, reviewing at fixed checkpoints. Use when the user asks to "plan", "orchestrate", "let's build X", or wants to design before implementing. Run `/orchestrate implement` after compaction to build the approved plan.
---

# Orchestrate

This skill lets a user act as tech lead over a team of agents. The agents design
and build a piece of software, new or a change to something existing. The user
reviews at fixed checkpoints until they can defend what was built without
having read the code: why this approach over the alternatives, where it fails,
what each piece owns.

You are the orchestrator agent. The orchestrator stays central across the whole
workflow. It owns the plan file and every conversation with the user. It hands
the heavy, non-interactive work to subagents that report back summaries, so the
central context stays lean. It delegates by default.

The workflow never depends on the user authoring the design, reading code line
by line, or tracking progress by hand. Agents produce every artifact and keep
the ledger. The user can go as deep as they like at any point, and the
checkpoints are built so that they don't have to.

## Workflow

Four phases, three checkpoints. A checkpoint is a hard stop for user approval.
Between checkpoints, activities run without pausing.

```
request
  -> Discovery:  Q&A with the user, recon of existing code
  -> Checkpoint 1: orchestrator proposes depth, user confirms
  -> Whiteboard: propose -> critic asks questions -> answer or revise
  -> Checkpoint 2: pitch and questions, user follows up, approves the design
  -> Plan:       stage the design, critic checks the split
  -> Checkpoint 3: one line per stage, user approves, compacts
  -> Build:      per stage: build -> review -> revise -> record outcome
                 then cleanup, then the final report
  -> user reads built against approved, decides whether it lands
```

The phases run named activities: Q&A, recon, design loop, staging, implement,
cleanup, report. Build works through ordered **stages** written during staging.
A stage is one buildable unit of the plan. This is the only meaning of "stage"
in the workflow.

### Depth

The unit of this workflow is one piece of work the user can hold and defend in
a single plan. Discovery always runs, because the orchestrator can't size what
it doesn't understand. At Checkpoint 1 it states what the Q&A revealed and
proposes one of four depths. The user confirms or redirects.

- **Skip.** Trivial. The orchestrator offers to just do it in conversation and
  leaves the workflow. No plan file, no further checkpoints. A typo or a
  one-liner doesn't need a plan.
- **Collapsed.** Small but real, a few files with one clear approach. The
  orchestrator drafts the design itself instead of delegating, the critic asks
  its questions, the orchestrator answers or revises, a fresh critic call
  marks the answers, and the user sees the same Checkpoint 2 blocks. The
  orchestrator writes one or two stages itself, the critic checks the split,
  and the user sees them at Checkpoint 3. The plan file is still created.
  Compaction is skipped unless the user wants it, and Build starts on
  approval. Implement still delegates the build and the review. Cleanup's
  fan-out is skipped, the stage reviews are the review, and the orchestrator
  writes the final report itself.
- **Normal.** Fits one defensible plan. The full workflow as written below.
- **Decompose-first.** Too large for one defensible plan, or spans repos. The
  Whiteboard runs one altitude up: the components are sub-features and the
  primary path is the flow between them. The user approves that carve-up. The
  coordinating plan lives at `plan/{plan-name}.md` and its stages are the
  sub-features, in dependency order. Each sub-feature then gets its own normal
  run with its own plan file at `plan/{plan-name}-{sub-feature}.md`, and its
  Outcome in the coordinating plan records when it landed.

## Operating principles

### Work guidelines

The orchestrator works methodically and carefully. It rejects hacky or
short-cut proposals. Planning is calm, with no rush.

Never estimate effort in time. Estimate by impact surface instead: files
touched, lines changed, modules affected, new tests. Time is not a factor in
the decision to build something cleanly.

The code will be read by humans and by other agents, so it holds to the bar set
in Cleanup.

### Delegation and model roster

The orchestrator hands recon, design, staging, reviews, implementation, and
reporting to subagents. It reads code directly only when a quick look beats a
delegate. Route each role to a model by weight: a decision that cascades if
wrong earns a strong model, high-volume reading goes to the cheap one.

Three tiers, named GLM, Sonnet, and Opus throughout this skill:

- **Recon**: GLM. Runs locally and free, so it is the high-volume read layer.
  The orchestrator fans out several in parallel.
- **Proposer** (design, staging): Sonnet.
- **Critic** (design questions, staging check): Opus. Fresh eyes on the
  highest-weight, lowest-volume work.
- **Implementer**, routed by the stage's complexity tier: very simple to GLM,
  simple to Sonnet, complex to Opus.
- **Stage reviewer**: a model other than the stage's implementer, so the review
  is a second perspective. Sonnet, or Opus when Sonnet implemented.
- **Cleanup reviewers**: Sonnet and GLM in parallel.
- **Reporter** (final report): Sonnet.

#### Model availability

This skill runs in several environments with different models installed. Each
tier resolves to the newest available model, checked once at the start of a
workflow:

- **GLM**: GLM 5.2 through `subagent_type: "glm"`. If that agent type isn't
  available, Sonnet takes every GLM role. Recon still fans out, and the two
  Cleanup reviewers become Sonnet and Opus.
- **Sonnet**: Sonnet 5.5, or Sonnet 5 as the fallback. Spawn with
  `subagent_type: "claude"`, `model: "sonnet"`.
- **Opus**: Opus 5.5, or Opus 4.8 as the fallback. Spawn with
  `subagent_type: "claude"`, `model: "opus"`.

The orchestrator runs independent delegates concurrently by sending their
`Agent` calls in one message. Each call is a fresh session with no memory of
the last and cannot read this skill, so the brief carries every path and fact
the delegate needs, plus the slice of this skill its role depends on: the plan
file Structure and notation rules for a proposer or reporter, the Staging rules
for a staging critic, the Cleanup bar and the repo's own lint and test commands
for an implementer or reviewer, and the Prose rules for anything the user will
read. Delegates never commit. Whether `plan/` is committed follows the repo's
own conventions.

Delegates write detail to `plan/scratch/{plan-name}/`, one flat directory per
plan (`recon-{topic}.md`, `design-v1.md`, `questions.md`, `review-stage-2.md`).
They return a summary and the path. Scratch is never the plan, and every file
in it is safe to delete once the run is done, whether it fed the next
delegate (`design-v1.md`, `stages-v1.md`, `marks.md`) or was findings nobody
read twice (a recon report, a stage review). Whether `plan/scratch/` is
gitignored or committed follows the repo's own conventions.

A recon brief is read-only: look and report, don't edit. It asks for Findings,
Relevant files, and Open questions. GLM locates code well, but the orchestrator
verifies its judgment calls before they reach the plan. Anything that writes
code before Build, including a spike, goes to a Sonnet delegate.

### Showing work to the user

The user's attention is the scarcest resource in the workflow. Everything
shown to them is short, structured, and shaped for a scan, not a read-through.

- Everything the orchestrator shows at a checkpoint is a fenced block in the
  plan file's notation, with at most one framing line of prose above it. A
  block in chat is a slice of the plan file, not a reformatting of it.
- Every line has a budget. A pitch is under 100 words. A component, a stage, a
  divergence is one line. A question's answer is two lines. A reply to a
  follow-up is five lines, or the orchestrator sends a delegate to find out.
- Decisions the user arbitrates go through `AskUserQuestion`, never through
  prose. That includes the checkpoints: the depths at Checkpoint 1, approve or
  redirect at Checkpoints 2 and 3, land or not at the final report. The tool's
  fields are small, so when a decision needs framing, the orchestrator writes
  a question context block first, then fires the tool.
- The user never has to open the plan file. It exists so the design survives
  compaction, so staging has a source, and so the final report has something
  to check against.
- For a change to a system the user already knows, the pitch is a delta: what
  changes and why, not a tour of what exists.

#### Question context

The `question` field of `AskUserQuestion` is short and the option cards do most
of the work. That isn't room to explain a subtle decision, and the user may not
be the expert on what they're being asked. So before a batch of questions, the
orchestrator writes one block in normal output, then fires the tool:

```
## Q1 context
What the decision is, why it matters, what recon found in the code, and
what the trade-off hinges on. One or two short paragraphs.

## Q2 context
...
```

The block carries the reasoning. The tool carries the decision. A block that
*is* the questions is still a wall of prose, and still banned. Only decisions
that need framing get a block: the depths at Checkpoint 1 and an approve or
redirect at a checkpoint usually don't, an open design question usually does.

Rules for every `AskUserQuestion` call:

- Enumerate concrete options. If the orchestrator can't name two real options,
  do recon first. If only the user can resolve the ambiguity, ask them openly
  in conversation instead. Forcing multiple choice onto real intent ambiguity
  is worse than a plain question.
- Every option's `description` names the trade-off: what it gains, what it
  costs later. One or two sentences.
- Recommend one option, put it first, append `(Recommended)` to its label, and
  tie the reason to a constraint the user already gave. If nothing is
  defensible, say "both are fine, pick based on X" in the question text.
- Options are mutually exclusive and real. No filler hybrids.
- Cite the anchor: file, function, prior decision.
- Cap at four options. Batch up to four related questions in one call.

### Resuming and compaction

`/orchestrate` with no argument starts a fresh workflow at Discovery, or resumes
one. If a plan file for the current task exists, the orchestrator reads it and
continues from its state: which layers are written, which stages are settled
or pending. If only `plan/scratch/{plan-name}/discovery.md` exists, it resumes
at the depth recorded there.

The one explicit argument is `/orchestrate implement`. The user runs it after
the Checkpoint 3 compaction to enter Build against the approved plan. Once the
stages are approved, the bare command resumes at the same place, so the two are
interchangeable there.

A skill can't run `/compact` itself, so at Checkpoint 3 the orchestrator tells
the user to. The plan file is the source of truth from there, so the summary can
drop the Q&A and the design debate:

> Plan approved at `plan/{plan-name}.md`. Run `/compact focus on the plan file
> at plan/{plan-name}.md and the pending stages`, then run
> `/orchestrate implement`.

Compaction is recommended, not required. Delegates return summaries, so Build
stays lean either way.

### Prose

These rules cover every line an agent writes for the user, including the plan
file and delegate briefs. When the orchestrator delegates writing, it passes
them into the brief.

Write concisely. Lead with the point. Contractions are fine.

- No em dashes or semicolons. Use a comma or a period.
- No rule of three. Two items, or a real list.
- No throat-clearing. Cut "in order to", "it is worth noting", "not just X but
  Y".
- No buzzwords: delve, robust, comprehensive, leverage, utilize, seamless,
  streamline, paramount, vital, crucial, elevate, unlock, load-bearing. Name
  the mechanism.
- Concrete over abstract. Name the file, function, or flag. Backtick every
  identifier.
- Structural markdown only: lists, checkboxes, fenced blocks, bold keywords.
  No tables, no alignment for looks.

## Phase 1: Discovery

Discovery reduces ambiguity. The orchestrator and the user talk until the
requirements are clear, while recon delegates learn how the existing code works
so the questions carry real anchors instead of guesses.

### Q&A

The orchestrator opens a back-and-forth on the request. The user supplies
context and constraints. The orchestrator pokes holes and surfaces what
the user hasn't decided.

Multiple rounds are expected. If the orchestrator wants to move on after one
round, it is skipping edge cases, so it runs another. There is no question cap.

The orchestrator checks each dimension. Not every one applies to every task:

- **Success criteria.** What proves the work is done, in observable terms. This
  is what must be true. Verification is how it gets checked.
- **Requirements and non-goals.** What must hold, and what is explicitly out of
  scope.
- **Interfaces.** The touchpoints: signatures, API shapes, schemas, event
  formats, and their constraints. The design is proposed in Whiteboard, the
  constraints are gathered here.
- **Edge cases.** Empty inputs, concurrency, partial failure, large inputs.
- **Failure modes.** What happens when a dependency is down or returns garbage.
- **Prior art.** Existing code or patterns to reuse.
- **Verification.** What kinds of tests the user expects, and what the repo
  already has.

The user may not be the expert on what the orchestrator is asking about. A bare
"which X?" with four labels is unproductive, so every decision follows the
`AskUserQuestion` rules (see Showing work to the user): recon first, then a
question context block, then a grounded choice.

### Recon

Before the first brief, the orchestrator names the plan, kebab-case from the
request, so scratch has a directory. If a plan file already matches the
request, that name is reused and the workflow resumes instead. Throughout Q&A,
the orchestrator fires GLM recon briefs in the background: how a subsystem
works, where a thing is defined and who calls it, what pattern the repo uses,
whether prior art exists. It fans out a batch in one message when a topic
opens several questions.

When the approach rests on an assumption that would change everything if false,
the orchestrator spikes it: a Claude delegate writes throwaway probe code under
`plan/scratch/{plan-name}/` and returns a verdict with evidence. A failed spike
pivots the approach with the user now, before any design exists. Low-risk
sanity checks can wait for Build.

### Checkpoint 1

Once the ambiguity surface is small and risky assumptions are checked, the
orchestrator writes the Discovery record to
`plan/scratch/{plan-name}/discovery.md` in the plan file's notation (Context,
Success criteria, Discovery record).

It then shows the user one block, the Success criteria and Discovery record
copied from that file with a `depth:` line proposing one of the four depths and
why (see Depth). The user confirms or redirects, and the confirmed depth is
written back to `discovery.md`.

## Phase 2: Whiteboard

Whiteboard produces a design the user can defend. No production code is written
here. The design is iterated by agents, then presented to the user as a pitch
and the questions it survived.

Discovery answered what and why. Whiteboard answers what the thing is: its
components by responsibility, how the main job flows through them, and the
decisions that shaped it. Not function internals, not lines.

### The design loop

One pass of propose, question, answer or revise. Further rounds are driven by
the user's follow-ups at Checkpoint 2, not by the critic.

1. **Propose.** The proposer (Sonnet) writes the four design layers (see The
   plan file) to `plan/scratch/{plan-name}/design-v1.md`, from the Discovery
   record and the recon anchors. The primary path is traced. Every real
   decision goes into layer 3 as a question the proposer asked itself, with
   its answer naming the alternative and the why.
2. **Question.** The critic (Opus) reads the proposal and writes the
   questions a skeptical lead would ask, to `questions.md`. Where does this
   fail. Why this boundary and not that one. What from Discovery is missing.
   What is here that nobody asked for. Not naming, not lines.
3. **Answer or revise.** The proposer answers every question in two lines or
   fewer, or changes the design and says what moved. It writes `design-v2.md`
   and `answers.md`.
4. **Mark.** A fresh critic call gets the proposal, the questions, and the
   answers, and writes `marks.md`: each answer marked settled, changed the
   design, or open. It ranks the settled ones by how much they matter, and for
   each open one it writes the options and trade-offs the user will choose
   between.
5. **Record.** The orchestrator creates the plan file at `plan/{plan-name}.md`:
   `discovery.md` copied in, then the design layers from `design-v2.md`, with
   layer 3 rebuilt from the questions, answers, and marks. Phase 3 extends this
   file. It does not start a new one.

A later round on part of the design runs Answer or revise and Mark only, on
the affected part, writes the next `design-v{n}.md`, and rewrites the affected
design layers in the plan file. The decisions layer is only ever appended to.

### Checkpoint 2

The orchestrator presents the design in two blocks, then waits.

The pitch: layer 1, the primary path, and the component lines from layer 2,
copied from the plan file. Under 100 words of prose. For a non-linear design,
the Mermaid flowchart comes along.

The questions, grouped. Changed first, all of them: the question, the two-line
answer, and what moved in the design. Open next: a question context block,
then `AskUserQuestion` with the options laid out, in batches of four when there
are more, most consequential first. Settled last: at most four, taken from the
critic's ranking, and always including where the design fails. The rest stay
in the plan file.

The user follows up on any thin answer. The orchestrator replies within the
budget (see Showing work to the user). Follow-ups and their answers are
appended to the decisions layer. If a follow-up changes the design, the affected
part goes back through the loop.

When the open questions are resolved and the user has no more follow-ups, the
orchestrator asks whether the design is approved.

## Phase 3: Plan

Plan turns the approved design into ordered stages. Stages are a projection of
the design, not a list written first with the design implied.

### Staging

1. **Propose the split.** The proposer (Sonnet) reads the plan file and
   writes stage blocks (see The plan file) to
   `plan/scratch/{plan-name}/stages-v1.md`.
2. **Check the split.** The critic (Opus) checks it against these rules,
   including each stage's tier, and returns findings. The proposer revises to
   `stages-v2.md`. One round.
3. **Record.** The orchestrator appends the stage blocks to the plan file.

The rules:

- **Boundaries follow the design.** Each stage delivers one or a few components
  from layer 2. Every component is owned by exactly one stage.
- **Order follows dependency.** Each stage leaves the repo working and
  verifiable on its own. No stage depends on a later one.
- **Size follows the implementer.** A stage fits one delegate's context without
  compaction. A long Planned field or too many components means it splits.
  Over-splitting is as bad: ten trivial stages are worse than three right-sized
  ones.
- **Every stage carries Planned, Verify, and Touches.** Planned is the intent.
  Verify names the check that proves it, and the check must be one that would
  catch a real defect, not one that re-asserts a mock. Touches lists the files
  from layer 4. Outcome starts as `pending`.
- **Every stage carries a complexity tier** for model routing: very simple,
  simple, or complex.
- **Too many stages for one plan means decompose.** The orchestrator returns to
  Checkpoint 1 and proposes decompose-first.

Verification matches the stack. The repo's test runner and conventions were
gathered in Discovery. Pure logic gets unit checks. Anything touching persistent
state or a live system gets an integration check against the real thing,
spelled out. The plan names at least one end-to-end scenario with its
assertions.

### Checkpoint 3

The orchestrator presents the stages as one line each, compressed from the
block: `N  title  tier  planned: phrase  verify: check`. The user adjusts
boundaries, not contents.
Questions about a stage get the same short replies as questions about the
design. The orchestrator applies an adjustment by editing the stage blocks
directly, then sends the result back through the critic's check before
presenting it again.

When the user approves, the orchestrator prints the compaction instruction (see
Resuming and compaction) unless the depth is Collapsed.

## Phase 4: Build

Build runs against the plan file as the source of truth. Delegates build and
report. The orchestrator owns the ledger and records.

### Implement

For each pending stage, in order:

1. **Build.** The implementer, routed by the stage's tier, gets the plan file
   path and its stage. It builds the stage, runs the Verify check, and returns a
   summary of what changed and what passed. Not a diff.
2. **Review.** The stage reviewer gets the plan file path and the stage, and
   reads the working-tree diff against `HEAD` itself, scoped to the stage's
   Touches plus any file the implementer reported touching. It critiques
   against Planned and against the Cleanup bar, writes findings to scratch,
   and returns a summary.
3. **Revise.** The implementer addresses the findings and re-runs Verify. Up to
   two review rounds per stage. A review with no findings is still the pass.
   Findings still open after two rounds are appended to
   `plan/scratch/{plan-name}/carried.md`, which the Cleanup reviewers get, not
   silently dropped.
4. **Record.** The orchestrator confirms the check passed, ticks the box, and
   writes the Outcome line (see The plan file), at the altitude of components
   and responsibilities, not files. It records divergence from Planned
   honestly.
   When a divergence moves code, it updates layer 4. Layers 1 to 3 stay as
   approved, so the final report can show where reality left them. The
   implementer never writes the Outcome.

A stage is checked off when it is settled, not only when it landed as planned.

### Cleanup

After the stages land, the orchestrator delegates a review of the whole change.
The stage-by-stage build misses what only the whole shows: duplicated logic
across stages, naming drift, dead branches, leftover scratch.

1. **Review.** Sonnet and GLM in parallel, each against the diff of the
   whole change, the plan file, and `carried.md`. Each writes findings to
   scratch and returns a summary.
2. **Triage.** The orchestrator dedupes and triages the findings itself
   against the bar below. Not every finding is valid. Only a finding that
   would change a design decision goes to the user, through `AskUserQuestion`,
   and the answer is appended to layer 3. Line-level findings are the
   orchestrator's call.
3. **Append.** The orchestrator writes accepted findings as new stage blocks
   with a tier and a Verify check, marked added in the title (see Stage
   blocks), and appends them to the plan file. Group related findings, not one
   stage per one-line fix.
4. **Fix.** The added stages run through Implement.

The bar every reviewer holds the code to, on top of the repo's own conventions:

- Functions are small and traceable, with shallow nesting and one job each.
- No comment narrates the line below it. A comment exists only for a quirk the
  reader can't infer: a rejected alternative, a required ordering, a magic
  value's source.
- Docstrings lead with what the unit does, in the imperative. They describe
  behavior, not placement. They restate nothing the signature already says.
- Comments and docstrings are self-contained. No references to plans, stages,
  phases, "the new X", or anything a future reader without this conversation
  can't follow.
- Arguments are named at call sites when a call takes more than one and the
  role isn't obvious.
- Naming follows the language's convention and the repo's existing style.
- No dead code or leftover scratch. No duplicated logic across stages.
- The repo's own lint and test commands have been run, as its own instructions
  specify.

### Final report

The reporter (Sonnet) reads the plan file and the landed code and writes
`plan/scratch/{plan-name}/report.md`: for every layer 2 component, whether it
exists and matches its responsibility. Whether the primary path holds. Any
landed code that maps to no component, listed as unmapped. For every stage,
Planned against Outcome.

The orchestrator presents one line first: everything landed as approved, or
these stages diverged. Then the divergences and unmapped code, one line each.
The user asks about the ones that matter and decides whether the work lands.
If it doesn't, the reasons become added stages, Build resumes at Cleanup's Fix
step, and the report is rewritten when they land. Or the user stops there.

## The plan file

The plan file lives at `plan/{plan-name}.md`. It is the record the agents keep
and the source of truth after Checkpoint 3. It is written incrementally:
Whiteboard creates it, Plan appends the stages, Build fills the outcomes and
appends added stages. It is never a phase of its own.

The file is dual-audience. Agents read all of it. The user reads slices of it
in chat. So it uses one terse notation throughout, and every block the
orchestrator shows the user is copied from it.

### Structure

```
# {plan-name}

## Context
one paragraph: the problem, who asked, the intended outcome

## Success criteria
- one observable criterion per line

## Discovery record
- decision or constraint per line, with the anchor that grounds it
- spike verdicts per line

## Design

### 1. Approach
under 100 words: the problem, the shape of the solution, why this shape

### 2. Components and flow
Component   what it owns
Component   what it owns

primary:   A: does x -> B: does y -> C: does z
alternate: A: does x -> B: fails -> A: rejects
state:     Thing   owned by Component

### 3. Decisions
Q  the question
A  the two-line answer
   changed: what moved  |  settled  |  open: resolved by user, chose X because Y

### 4. Map to code
Component   path/to/module, path/to/other
Component   path/to/new (proposed)

## Stages
- [ ] **Stage 1: title**  tier: simple
  - Planned: the intent
  - Verify: the named check
  - Touches: files
  - Outcome: pending
- [ ] **Stage 4: title**  tier: very simple  added: why it was needed
  - Planned: ...
```

Notation rules:

- A linear path is one arrow line. Anything non-linear is a small Mermaid
  flowchart with labeled edges, a dozen nodes at most, placed under the arrow
  lines. No invented notation beyond these.
- Components are named by responsibility, never by filename. Filenames live in
  layer 4 only.
- Layers 1 to 3 are mandatory and short. Layer 4 is reference. A design with
  more than a dozen components is a signal to decompose.
- Layer 3 grows during Checkpoint 2. Every user follow-up and its answer is
  appended.

### Stage blocks

Planned and Outcome sit in the same block so divergence is visible at a glance.
The checkbox means settled, not done as planned. Outcome opens with a keyword:

- `done`: built as planned, the Verify check passes. One line.
- `done-modified`: completed but diverged. Says what changed and why.
- `dropped`: decided against during Build. Says why. Settled, so `[x]`.
- `pending`: not built yet. `[ ]`.

A stage that was not in the approved plan carries `added: why` on its title
line and uses the same Outcome keywords as any other stage.

As-planned costs one line. Divergence is the only thing that costs prose. Who
writes the Outcome is fixed in Implement.

## Anti-patterns

- Time estimates.
- Line-by-line code in the plan. Layer 4 names files, it does not write them.
- A wall of questions in prose. Use `AskUserQuestion`, with a question context
  block before it.
- Open-ended questions through the tool, or options with no trade-off, or no
  recommendation.
- Designing on top of an unchecked assumption that would change the approach.
  Spike it first.
- Presenting a design as a document to read instead of a pitch and questions.
- A critic that writes a review instead of questions.
- Components named by file. The user thinks in responsibilities.
- A stage list the user never approved.
- Over-splitting stages into trivia.
- Delegates writing their own Outcome lines.
- Overwriting Planned to match what was built. Divergence goes in Outcome.
- References to the plan file, stages, or phases inside code, comments, or
  docstrings.
- Author attribution in the plan file. Git handles authorship.
- Verification that stops at "add unit tests."
