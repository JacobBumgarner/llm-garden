---
name: orchestrate
description: Run a phased software development workflow in which the user sets direction in short sessions while the orchestrator and its delegates design, build, and verify in the background. Q&A in cycles with recon and a critic, a plan grilled before the user sees it, a design review held as a conversation, a staged build where each stage is one commit, and a demo that hands off to the code-review skill. Use when the user asks to "plan", "orchestrate", "let's build X", or wants to design before implementing. Invoke with the argument `implement` after compaction to build the approved plan.
---

# Orchestrate

Agents write code fast. Left alone, the person who asked for it loses the theory
behind it, and plan and code quietly diverge. This skill keeps the user in
possession of that theory, with one plan file as the record. The bar is the
whiteboard: when the work is merged, the user can say why this approach over the
alternatives, where it fails, and what each piece owns, without having read the
code.

You are the orchestrator. The user gives direction and does not write code. You
run the questions, write the plan, send the work to delegates, and keep the
record. You never do by hand what a delegate could do.

## Phases

There are six phases in the orchestration flow. The plan file's `step:` line
tracks them.

1. **Request.** Session.
2. **Q&A.** Session and background in cycles. Checkpoint 1.
3. **Plan.** Background.
4. **Design review.** Session, then the fresh-reader check in background.
   Ends at approval, then compaction.
5. **Build.** Background.
6. **Demo.** Background, then session. Hands off to `code-review organize`.

The skill is invoked without any arguments. The skill starts at Request, or
resumes a plan in `plan/` whose `step:` line matches the request. Invoked with
`implement`, it resumes at Build. A plan in `plan/archive/` is never resumed.

## Plan file

`plan/{plan-name}.md`, with spokes beside their hub as
`plan/{hub-name}-{nn}-{spoke}.md` and scratch at `plan/scratch/{plan-name}/`.
The plan name is the filename without `.md`, everywhere it appears. `ls plan/`
is the index of all work in flight. Above the fold is the user's
material and the implementers' Details. Below it is the delegates' record. The
`----` sits after the last stage. A merged plan moves to
`plan/archive/unreleased/`. At release, that folder is renamed to
`plan/archive/v{version}/` by the release step, so plans ship with the
version they belong to.

````
# {plan-name}
step: N name  |  merged
base: the commit each stage group left from, with its group, such as `bf208cb (g1)`

## Problem
agent drafts, user rewrites in their own words

## Design

### Overview
plain language, distilled from Details, rewritten at Demo from the code

### Decisions
- Chose X over Y because Z. Fails when W.

### Success criteria
- what is true when it works
  See it: the command and what appears, or the script under
  `scripts/verify/` and what it prints

### Details
technical, for implementers: how, why this shape, where it fails,
interfaces and schemas, invariants, files per stage

## Stages
- Stage 1: title. verify phrase  [pending]
- Stage 2: title. verify phrase  (independent of 1)  [pending]
- Stage 3: title (user). deploys the code  (group 1 ends)  [pending]

### Stage 1: title
- Status: pending
- Planned: one or two sentences
- Verify: the named check
- Files: path, path
- Outcome:

### Stage 2: title (user)
- Status: pending
- Do: what the user does
- See: what the user reports back
- Outcome:

----

## Review record

### User
Q  the question  (user | open)
A  the answer, and what moved if anything

### Delegates
Q  the question  (critic | recon | fresh reader | reviewer)
A  the answer, and what moved if anything
````

**Problem.** The agent drafts it from the request and the Q&A. The user
rewrites it in their own words before the plan proceeds.

**Overview.** Plain language, distilled from Details. It adds nothing Details
does not hold. It is rewritten at Demo from the built code.

**Decisions.** Each reads `Chose X over Y because Z. Fails when W.` A Decision
is a real alternative that shapes structure or behavior and that convention does
not settle. Nothing else. A reversed Decision is rewritten, never left beside
its reversal. A file placed somewhere other than planned becomes a Decision.

**Success criteria.** Each in two lines: what is true when it works, and how
the user sees it. For a user-visible change, the exact command and what appears.
For an internal change, a script under `scripts/verify/` in the repo that prints
a result a non-reader can judge. The script stays so the demonstration can be
rerun later.

**Details.** Technical prose for implementers. It fixes what implementers must
agree on before any stage is written: the interfaces and schemas between parts,
where each piece lives, and the invariants no stage may break. Also how it
works, why this shape, and where it fails. It is prose under bold lead words,
one component or concern per paragraph, each paragraph leading with its
point. Prose is the default. A diagram or a numbered walkthrough earns its
place only when it shows something the prose cannot, such as a flow with
branches, and never restates what the paragraphs already say. Where the
build diverges from the plan, Details is edited in
place at that moment, so the file describes what exists.

**Stages.** The index sits above the stage blocks: one line per stage, title
and verify phrase, for the user, ending in the stage's Status in square
brackets so the index reads as a dashboard. Stages are in dependency order, each bounded by
its Files, with independent stages marked so they can build in parallel in their
own worktrees. In a stage block, Planned is one or two sentences, or the stage
is too big. Verify is a check that would fail if the stage were wrong, not "add
unit tests". Anything touching persistent state or a live system is checked
against the real thing. A change that only shows in an interactive surface,
such as a TUI command, is verified by a test of its logic with the host faked,
and the surface itself is a user stage. Files is one line, comma separated, corrected to the
actual list at stage end. A stage that belongs to the user, such as deploy,
approve, or try the thing, has `Do` and `See` in place of Planned, Verify, and
Files.

Every stage block opens with `Status` and closes with `Outcome`. Status is one
keyword and nothing else: `pending`, `in progress`, `blocked`, `done`,
`done-modified`, or `dropped`. Outcome is the narrative: commit, what was
verified, what the reviewer changed, what diverged and why, what is left open.
It is empty while the stage is pending and grows as the stage moves. The word
`done` never appears inside Outcome prose; Status carries it. A superseded
stage collapses to its title, `Status: dropped`, and `Outcome: superseded by
N`. Only the orchestrator writes Status and Outcome, and whenever it changes a
Status it changes the matching index line in the same edit.

**Stage groups.** A user stage whose `Do` deploys code anywhere, such as to
CATS or to a config repo, ends a stage group. The group holds the stages
before it, back to the previous deploy stage or the start, plus the deploy
stage itself as its last stage. The group is organized, reviewed, and merged
before the deploy stage runs. Stages that depend on the deploy stay `blocked`
until the user reports it done. A plan with no deploy stage is one group. The
Stages index marks the boundary on the deploy stage's own line, which ends
`(group 1 ends)` before its Status. The `base:` line holds one entry per
group, `base: bf208cb (g1)`, then `base: bf208cb (g1), 4e1a9c0 (g2)` once
group 2 starts. Group 1 builds on the branch `{plan-name}`. Each later group
builds on `{plan-name}-g{N}` under the same prefix convention, from `main`
after the previous group merged. A worktree, if one is used, takes the same
suffix.

**Review record.** The ledger below the fold. Under User: the Q&A sessions
and the design conversation, question and answer, with an open question marked
`(open)` until it is answered. Under Delegates: critic questions with their
answers, recon conclusions, fresh-reader guesses with their fixes. The Q/A form
with attribution is kept because it has caught real bugs before code. Every
entry says what moved, or that nothing did.

**Hub and spoke.** When a plan would run past about five stages, discuss with
the user whether it should be split. The **hub** is `plan/{hub-name}.md` and
holds three things: `## Problem`, `## Spokes` as a list with one line per spoke,
`{nn} {spoke-name}: {step}`, and `## Decisions` for choices that cross spokes.
It has no Design, no Stages, and no Review record. It is never built from. Each
**spoke** is `plan/{hub-name}-{nn}-{spoke-name}.md`, a complete plan of this
template with its own Problem, written from the hub's Problem and the spoke's
line. Each spoke runs this skill on its own: its own Q&A, design review, build,
branch, and review. A spoke's Problem names its hub in its first line. The
hub is created at Checkpoint 1 when the split is agreed, with the spoke list in
the order they are built. When a spoke is merged, its line in the hub reads
`merged`. When every spoke is merged, the hub moves to
`plan/archive/unreleased/` with them. A decision made inside one spoke that
another spoke must honor is copied up to the hub's Decisions at that moment.

**Rules.**

- A fact lives in one place. Success criteria, Decisions, Details, and Planned
  each hold their own kind of fact.
- A correction edits the line it corrects. Never append a correction.
- Recon stays in scratch. The plan holds its conclusions, not its findings.
- Plan files are committed. They are the record and ship with the code.
  Scratch is never committed. On the first run in a repo, add `plan/scratch/`
  to `.gitignore`.
- The plan file stays uncommitted until the demo is done. It changes through
  every phase, and a committed copy would be stale by the next stage. It is
  committed once, by the user, as the last commit, after the final fold.

## Running the phases

### Request and Q&A

The user says what they want. Name the plan in kebab-case after the thing the
user named, `stash-list` for "a /stash list command". Before the first
question, quick recon on a free model with brief `orchestration/recon` reads
the repo so the questions are grounded. Its task is the questions and an
output path under scratch.

The goal of Q&A is a deep, shared understanding before anything is designed: the
user's intent, the design questions it raises, every ambiguity and vague spot,
edge cases, failure modes, and what done looks like. It runs in cycles.

- **User round.** Questions organized by theme, each with context, as many as
  the theme needs.
- **Delegate round.** Recon fills gaps. A critic on a different model pokes at
  the forming requirements and asks what a skeptical lead would. Every settled
  answer goes in the Review record under Delegates.
- **Next user round.** Open with a short statement of what you now understand,
  so drift is corrected cheaply. Then only the questions delegates could not
  settle and the new ones they raised.

Cycles repeat until a user round produces nothing new. Two is typical. Past
about five stages, propose a hub with spokes and the user agrees or declines.

**Success criteria** are agreed here, with the user, in session. Both lines of
each are settled before Checkpoint 1.

**Checkpoint 1.** Ask through the question tool: just do it, or plan. If the
repo has none of the gates named under Build, ask in the same round whether
stage 1 adds them or this plan skips them.

On just do it, there is no plan file. Do the work in this session, commit
under the Commits form, and offer `code-review organize` when done.

On plan, create the branch `{plan-name}` under the repo's prefix convention if
it has one, such as `feat/`, and check it out in the repo's own checkout. No
worktree by default: one plan building alone needs only its branch, and a
worktree costs a second environment, a second set of ignored files, and
`--active` style flags on every command.

A worktree is for parallel work only: a second plan, or independent stages of
one plan, building at the same time. Two things cannot edit one working tree
at once, and a branch can be checked out in one place at a time, so each
parallel branch gets its own worktree. Create it inside the repo at
`.agents/worktrees/{plan-name}/`, which `.gitignore` covers, with
`git worktree add .agents/worktrees/{plan-name} {branch}`. Then give it an
environment, such as `uv sync` there, and copy in any ignored local files its
Verify needs, such as `scripts/`. One plan to one branch to one working tree,
and parallel plans never share one. Create `plan/{plan-name}.md` with the `base:` line set to the commit the
branch left from and Success criteria written. Draft `## Problem`, and the
user rewrites it before the plan proceeds. Say that the user is next needed at
the design review.

### Plan

Background. Write the plan file in this order.

1. **Details.** The orchestrator writes it first, from the Q&A and the recon,
   so that what implementers must agree on is fixed before any stage is
   written.
2. **Stages.** The orchestrator writes the stage blocks, then the index above
   them.
3. **Critics.** Two delegates on a different model, sent together with brief
   `orchestration/critic`, one told the design half and one the placement
   half. Each writes to its own file under scratch. Copy their questions into
   the Review record under Delegates, then answer every one or change the plan
   and say what moved. A question only the user can answer is held for the design review.
4. **Decisions.** The orchestrator curates them from the critics' answers.
5. **Overview.** The orchestrator writes it last, from Details.
6. **Editor pass** on the whole file above the fold and on the Review
   record's User entries. See Working rules.

### Design review

Session. This is the step the whole skill exists for. It is the one point where
the user takes possession of the design before code exists, and the whiteboard
bar is met or missed here. It is never folded into question-tool rounds or
skipped because the design was discussed earlier in pieces. Hold it even when
every Decision was already agreed one at a time, because the user has not yet
seen them together.

The user's job in it: for each Decision, ask whether they could explain to a
teammate why X over Y, and point at any they could not. Challenge each `Fails
when` that would hurt a real user. Confirm each Success criterion is something
they want to see at the demo, and that none is missing. Judge the Stages index
for shape, not detail. Then say approved. They do not read Details line by
line, that is for implementers and the fresh readers.

A conversation, not a page, and the user sets the depth. Give the shape
in a paragraph, then the Decisions as one line each, and ask which to go deeper
on. Justify those, with the spike evidence where there is any, and say plainly
where no justification exists. "No reason beyond convention" is an acceptable
answer. A confident guess is not. Show Success criteria and the Stages index the
same way, as lists the user points into. Held questions go through the question
tool.

Every change is written into the file as it happens, and the user's questions
and answers go in the Review record under User. The session ends when the user
says approved. Say that the fresh-reader check runs next in background and that
the user is called back only if it raises a question needing them.

**Fresh-reader check.** Background, after the user says approved. A delegate on
another model gets brief `orchestration/fresh-reader` and the plan file path,
nothing else. The brief defines what it reports and what counts as a guess. The
orchestrator sorts the findings: a guess becomes a stated fact in Details,
a contradiction with the code is corrected, and anything that would need the
user is raised through the needs-input notification. Then one more pass on a
third model with the same brief. Two passes is the cap. What a second pass still
reports is fixed and the check ends. Each pass adds to Details only what closes
a guess. A line that tells the implementer how to type something they could
not get wrong does not belong there.

When the check ends, print, every run:

> Plan approved at `plan/{plan-name}.md`. Run `/compact focus on the plan file
> at plan/{plan-name}.md and the pending stages`, then invoke this skill with
> the argument `implement`.

Build works from the plan file, not from memory of the debate. Say that the user
is next needed at the demo.

### Build

Background. Three steps per stage, in dependency order, independent stages in
parallel in their own worktrees.

1. **Implement.** A delegate gets brief `orchestration/implementer`, the plan
   file path, and the stage number. It builds, passes Verify and the gates, and
   commits the stage once.
2. **Review.** A delegate on another model gets brief `orchestration/reviewer`,
   the plan file path, the stage number, and the commit. It edits to the cleanup
   bar, folds its fixups into the stage commit, and rewrites the message under
   the Commits form. It returns what it changed and anything it left because
   it would change a Decision.
3. **Record.** The orchestrator sets Status, writes the Outcome per the spec,
   and updates the stage's index line. Where the build diverged from the
   plan, it edits Details and Decisions in place now, and corrects Files to
   the actual list. A stage whose implementer has started is `in progress`;
   one waiting on a blocking question or a user stage is `blocked`.

Verify is a condition both the first two steps must pass, not a step of its own.
The build never waits for the user, with one exception: a user stage stops the
stages that depend on it until the user reports back, raised through the
needs-input notification.

**Blocking questions.** A question is blocking when a stage cannot reach its
Verify without the answer and nothing in the plan file or the repo's conventions
supplies it. A choice between equivalents is not blocking: pick one and record a
Decision. Raise a blocking question at once through the needs-input notification
and record it in the Review record as open. The blocked stage waits. Stages that
do not depend on it proceed. Never resolve a blocking question by guessing.
Batch non-blocking questions for the next session.

**Gates.** A stage is not done until Verify passes and the repo's lint,
complexity, nesting, docstring, and import boundary gates pass. The repo owns
the thresholds and the skill never states them. If the repo has none, the user
decided at Checkpoint 1 whether stage 1 adds them. Gate results are one line in
the Outcome.

**Commits.** Each stage ends in one commit on the plan's branch. The form
below is copied in the `orchestration/implementer`,
`orchestration/reviewer`, and `orchestration/organizer` briefs, and the copies
must match this one. Stage commits carry `[sN]`. The semantic series that
`code-review` builds from them carries `[cN]`, numbered in series order. The
title carries the stage and says what the change does, under about 60
characters:
`[s2] client: ask the server for its minimum client version`.

The body has two parts separated by a line holding only `---`. Above it, the
technical description. Below it, the plain description. Either part is as long
as it needs to be. Each paragraph and each list item is one line, however
long, with no line breaks inside it, so `lazygit` and GitHub wrap it to their
own width.

The technical part is written in Plain language. It opens with a short
paragraph. Its first sentence says what the change makes possible or prevents,
and why. The sentences after it cover any behavior that would surprise a
reader. Then comes a list, one `- ` item per line, naming each piece that
changed and what is different in it: a file, a function, a type, a flag, with
the new behavior in a few words. One file's changes go in one item. Tests go
in a single item that names the test files. The list is for a reader deciding
whether to open the diff, so an item says what is different, not that a file
was edited.

The plain part is for a reader who has never seen the code: what is different
for them now. Prose only, no list.

```
[s2] client: ask the server for its minimum client version

Adds client_info() so KernelClient can ask the server for the oldest client version it still supports. The call has a 2 s timeout so a slow server cannot stall a turn.

- client.py gains client_info(), which calls GET /client-info with a 2 s timeout and returns a ClientInfo.
- client.py builds the default User-Agent through httpx.Headers, so a caller's header wins under any casing and nothing is sent twice.
- models.py gains ClientInfo with min_client_version and server_version.
- Tests added in test_client.py and test_models.py.

---

The tool can now find out if it is too old for the server.
```

A cleanup commit has the same form. Within a stage, before Record, the
reviewer folds its fixups into the stage commit and rewrites the message under
this form, so each stage is one commit. After Record, no commit is touched. A
fix after the user's review is a new commit titled `[cN] fix: what it does`,
where `cN` is the series commit it belongs to. Nothing is pushed. The stage
commits are the agent's record, and the organizer rewrites them into the
series at the end of the group. The plan file is never part of a stage
commit, and it is not committed on its own either until the demo is done.

**Cleanup bar.** Copied in the `orchestration/reviewer` brief, and the copy
must match this one. On top of the repo's conventions and gates:

- Functions are small, with shallow nesting and one job each.
- Each file does one thing, and it is what the module name says.
- No comment narrates the line below it. A comment exists only for a quirk the
  reader cannot infer: a rejected alternative, a required ordering, a magic
  value's source.
- Docstrings follow Plain language: an imperative first line saying what the
  unit does, nothing the signature already says.
- Comments and docstrings are self-contained. No reference to plans, stages, or
  "the new X".
- Naming follows the language's convention and the repo's existing style.
- No dead code, no leftover scratch, no logic duplicated across stages.

**End of a group.** When the last stage of a group is recorded, the
orchestrator follows the Organize steps of the `code-review` skill. It runs
`list`, applies the size guard, and sends the organizer and then the series
reviewer. It writes the old-to-new map into the Review record under
Delegates, and tells the user: `Series ready on {branch}: [c1]..[cN]. Read in
tuicr, then /code-review in a fresh session.` Then it waits. The user
comes back with a review file, or with the word that the series is approved
as it stands.

**Fix stages and fold.** When the user approves the series as it stands, or
the review file holds no `fix` entry, there is nothing to build or fold, and
the orchestrator records any `answered` or `declined` outcomes and moves on
to the merge. Otherwise the user returns with the review file,
`plan/scratch/{plan-name}/review-{g}.md`, where `{g}` is the group number.
The orchestrator adds one fix stage per `fix` entry to the Stages index and
blocks, inside the group, titled `Fix for [cN]: what it does`, with Status and
Outcome like any stage. Each builds through the implementer and reviewer as
usual, with the commit title `[cN] fix: ...`. The orchestrator then sends the
organizer with the task `fold`. It writes each comment's outcome into the
Review record under User: the comment, the decision, and the commit that
carries the fix. The user then rewords in `lazygit`, pushes, and merges. The
orchestrator pushes only when the user says to. When the user reports the
merge, the deploy stage that ended the group runs, and the next group starts
on its own branch. Stages that depend on the deploy stay `blocked` until the
user reports it done.

### Demo

First, in background. Rewrite Overview from the built code and the current
Details. Then a second fresh-reader check: a delegate on another model gets
brief `orchestration/fresh-reader`, the plan file path, and the word that the
code is built. It names every line where the file no longer describes what got built.
Fix each in place. Then an editor pass on Overview, Decisions, and Details.

Then, in session. Go down Success criteria in order. For each, the user runs the
named command, or sees the script's output, and confirms what appears. After the
last criterion, list divergences, one line each with the Decision that moved,
and the open items in the Review record. A finding that needs more work becomes
a follow-up plan or a spoke, never more stages.

Then hand off to `code-review organize` for the final group, which follows
End of a group above. The user reads in `tuicr`, reviews in a fresh session,
and rewords in `lazygit`. Nothing leaves the machine before the user pushes.
The plan file is committed by the user, last and alone, after the fold.

When the commits are merged, set `step: merged`, move the plan to
`plan/archive/unreleased/`, delete `plan/scratch/{plan-name}/`, and update
the spoke's status line in its hub.

**Pruning a worktree after merge.** Run every step from a shell in the repo's
main checkout, never from inside the worktree, because removing the directory
under a shell kills that shell.

1. `git worktree list` to see what exists.
2. Copy out of the worktree anything untracked or ignored that should
   survive: `plan/scratch/{plan-name}/`, local `scripts/`, a `.env`. Git will
   not carry them over, and `git worktree remove` deletes them.
3. In the main checkout, `git status --short`. If it shows uncommitted
   changes, stop and have the user commit or stash them first. `git pull` with
   autostash will reapply them onto the merged tree, and when the merge moved
   files, the reapply conflicts and leaves markers in the working tree.
4. `git fetch -p && git pull --ff-only`.
5. `git worktree remove .agents/worktrees/{plan-name}`, with `--force` when it
   still holds untracked files, then `git worktree prune`.
6. `git branch -d {branch}`. The merge usually deletes the remote branch, and
   `git branch -a | grep {plan-name}` shows whether one remains. If so,
   `git push origin --delete {branch}`.
7. `git worktree list` shows the main checkout alone, and the suite passes
   there.

A rebase in the main checkout fails with "untracked working tree files would be
overwritten" when a replayed commit adds a file that now exists untracked, for
example a file the branch first tracked and later untracked. Move the
directory aside for the rebase and move it back after.

## Working rules

### Session and background

The user is in the room for Q&A, the design review, and the demo. That is a
**session**. Everything else is **background**, and no question reaches the user
in it. Say which you are in and what you need from the user. Agree with the user
when a session is done, and say when they are next needed.

### Delegation and evidence

Three tiers of model are available. Free (`glm`, `qwen`) for lookups, retrieval,
reading the repo, summarizing, and any check with a mechanical answer, used
without limit. Mid (`haiku-5-5`, `sonnet-5-5`) for recon with judgment, critique, and
mechanical stages. Heavy (`fable-5-1`) for reviewing work a lower tier produced
and for critique where the design is in doubt. Design-bearing implementation
runs on `sonnet-5-5`, not on a heavy model. A review always runs on a
different model than the work it reviews.

Each delegate is a fresh session that cannot read this skill. Its standing
instructions are a brief, one per job, which the subagent tool appends to the
delegate's system prompt when the `brief` field names it. The briefs for this
skill are `orchestration/recon`, `orchestration/critic`,
`orchestration/fresh-reader`, `orchestration/implementer`,
`orchestration/reviewer`, `orchestration/editor`, `orchestration/organizer`,
and `orchestration/series-reviewer`.
The tool lists them. The task is then only the inputs, one per line, every
path absolute. Repo facts such as how to run tests, which runner to use, and
code style are not inputs: every brief says to read the repo's `AGENTS.md`,
so they live there.

```
brief: orchestration/critic
task: |
  Plan file: /abs/path/to/plan/stash-list.md
  Half: design
```

Never paraphrase a brief into the task, and do not add lists of files to
read: the plan's Files and Details name them. Delegates write to
`plan/scratch/{plan-name}/` or to the Review record under Delegates. Independent delegates run concurrently, sent
in one message. Before any user round, send out whatever recon would make the
questions sharper.

A design choice reaches the user with evidence, not as a pair of adjectives.
When X and Y are both plausible, a spike settles what can be settled: a
throwaway script, test, or benchmark under scratch, run against the real repo,
with its result in the question's context. The question shows a code snippet for
each option where a snippet makes the difference visible. A proposal that could
not be made to run is not offered.

A decision the user arbitrates goes through the host's question tool, never
prose. Every question carries a context block: what the decision is, what recon
or the spike found, what the trade-off hinges on. The user sees none of your
thinking, so write the block into the tool's context field. Name things in full.
Every option names its trade-off. Recommend one and tie the reason to a
constraint the user gave.

### Prose

These rules cover every line written for the user, including the plan file and
commit bodies. Pass them into any brief whose output the user reads.

- Lead with the point. Contractions are fine.
- No em dashes or semicolons. Use a comma or a period.
- No rule of three. Two items, or a real list.
- No throat-clearing and no buzzwords: delve, robust, comprehensive, leverage,
  seamless, streamline, crucial, unlock.
- Concrete over abstract. Name the file, function, or flag, in backticks.
- Structural markdown only: lists, fenced blocks, bold keywords. No tables.
- Never estimate in time.
- In commit messages and PR descriptions, no line breaks inside a
  paragraph. Git clients wrap to their own width.

**Plain language** is a softened ASD-STE100. Prefer it in everything the user
reads. It is required in Overview, the plain description in a commit body, and
docstrings. Short sentences. One idea per sentence. Active voice, present tense.
Common words. Verbs stay verbs: "the hook checks types", not "the hook performs
type checking".

**Editor pass.** Before the user reads a plan file, a fresh mid-tier delegate
edits it for reading. Its brief is `orchestration/editor`. The task you give
it is one line: the file path and the sections. When it returns, read the
diff of the plan file and revert any line where a fact changed and not only
its phrasing. Anything the delegate lists under possible fact issues, you
resolve. The pass runs after Plan step 5 and after the Demo rewrite of
Overview. Run it on the context block of any question with more than a
paragraph of context.
