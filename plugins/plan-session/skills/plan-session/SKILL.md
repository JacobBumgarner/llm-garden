---
name: plan-session
description: Run a structured planning session that converges on a self-contained implementation plan a second agent can execute. Use when the user asks to "plan", "start a planning session", "let's plan X", or otherwise wants to design before implementing.
---

# Plan Session

Drive a planning session that ends in a self-contained plan file. The agent
implementing the plan should not have to guess about implementation details.
Your job here is to reduce ambiguity of a goal and plan, not to write code.

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
- We are not in a rush, planning is calm and smooth. Effective and robust beats
  hasty, half-baked ideas.
- **Never estimate in temporal units.** No "1-2 days", no "a few hours".
  Estimate by *impact surface*: files touched, LoC changed, new tests, modules
  affected. Time is not a factor in the decision to build something cleanly.
- A human and other agents will read this code. Best practices, shallow nesting,
  low cyclomatic complexity, Pythonic and well-organized.

## Planning Steps
### Step 1: Opening discussion

Start with a natural-language back-and-forth on the topic. The user supplies
context, ideas, questions, and drafted implementation details. Your job is to
clarify ambiguities.

- **Use question tools, not prose walls.** Pose questions with
  `AskUserQuestion`.
- Group questions. Three sets of four questions across three tool calls beats
  one prose block of twelve questions.
- Iterate. Poke holes. Surface weaknesses. Multiple rounds are expected.
- Ask as many questions as you need to reduce ambiguity, surface edge cases, and
  clarify requirements. There is no maximum or minimum number of questions, but
  the goal is to converge on a clear plan.

#### Ask questions the user can actually answer

The user may not be the domain expert on the thing you're asking about. A bare
"which X strategy?" with four option labels and no context puts the burden back
on them. Do the homework first, then present a grounded decision, not a research
task.

Every `AskUserQuestion` call must follow these rules:

- **Never ask an open-ended "what should we do?"** Enumerate concrete options.
  If you can't name two real options, the question isn't ready. Go read the code
  or the docs first.
- **Every option needs a `description` that names the trade-off.** What you
  gain, what you give up, what it costs later. One or two sentences. Not
  marketing copy.
- **Recommend one option.** Put it first in the `options` array and append
  `(Recommended)` to its `label`. State *why* it's the recommendation in its
  `description`, tied to the constraints the user has already given you (project
  conventions, existing patterns, prior answers).
- **Options must be mutually exclusive and real.** No "Option A" / "Option B" /
  "hybrid" / "something else" filler. If a hybrid is the right answer, make it
  its own option with its own trade-off.
- **When the choice hinges on a design proposal**, the option `description` is
  where the pros/cons live. Format: one line on what it does, one line on the
  win, one line on the cost. The user should be able to decide from the option
  card alone without asking a follow-up.
- **Cite the concrete anchor.** File path, existing function, library version,
  prior decision in this session. Options that reference
  `./example/file/here.py` beat options that reference "the session layer".
- **Cap it at four options.** If you have more, you haven't narrowed enough.
  Prune to the top candidates and say in the question text what you dropped and
  why.

If a question genuinely has no defensible recommendation (two options are truly
equivalent given current constraints), say so in the question text: "Both are
fine. Pick based on X." Don't fake a recommendation for the sake of the rule.

Once the ambiguity surface feels small, **ask the user if they're ready for a
draft plan doc.** Don't jump into drafting.

### Step 2: first draft

The first draft plan contains:

1. A concise explanation of the request or feature.
2. A clear, concise record of the Q&A from step 1.
3. The drafted implementation plan.

### Step 3: middle iterations

After the draft, review your own plan. Look for weaknesses, ambiguities, missed
edge cases, unspecified interfaces. Raise new issues via `AskUserQuestion`.
Update the doc as decisions land.

Repeat until the plan converges.

After the plan has converged, the user will review the plan, and open a fresh
session with a new agent for additional rounds of review and feedback, which use
step 4 guidelines.

### Step 4: Independent review and critique

In this step, a new agent with a fresh context window and no bias of previous
debates or decisions will review the plan.

The goal of this step is to provide a critical, pragmatic, and non-sycophantic
review of the plan. The user and future agents will benefit from a fresh set of
eyes and perspective. The reviewer should be able to identify any gaps,
ambiguities, or potential issues that may have been overlooked in the previous
steps.

As with previous steps, the reviewer agent should ask questions using the
`AskUserQuestion` tool and previous guidelines.

The goal is to ensure that the plan is robust, clear, and actionable. Make edits
to the plan as needed after discussion with the user.

### Step 5: final plan

Once the doc is stable, reorganize the implementation section into markdown
to-do stages.

- **Stage 0** (optional): temporary validation code in `./tmp/` to confirm a
  PoC, reproduce a bug, or sanity-check an assumption. Skip if not needed.
- **Stage 1+**: the actual implementation.
  - Each stage is a markdown to-do list of concrete steps.
  - Size each stage so an Opus-grade agent can implement it independently within
    one context window. **Don't over-split.** One bloated stage is worse than
    needed, but ten tiny stages is worse than three right-sized ones.

#### Verification and tests

Every plan ends with a verification section. Not an afterthought, not one line
saying "add tests". This section is what the second agent uses to decide whether
the change is done.

The bar: **would this test have caught the bug in production?** If the answer is
"no, because the test only re-checks the mock", the test isn't earning its
place.

Every plan must include:

- **Unit tests** for pure logic. Adapters, translators, parsing, schema
  round-tripping. Fine to mock at module boundaries.
- **Integration tests** that exercise the change against a real, running system.
  Different projects will require different types of integration tests. If one
  hasn't been set up yet, the plan should propose this as a discussion point.
  Prefer a local stack that drives the same path the real client hits: real
  datastore, real API, real transport.
- **A named end-to-end scenario.** Not "test happy path". Spell out the concrete
  flow. Example: "POST to the messages endpoint with a query that triggers tool
  X, assert the stream contains a `tool_result` event for X followed by a
  `message` event, then re-fetch the session and assert the block sequence
  matches."

Ask about verification in step 1. Don't leave it for step 5. Sample questions:

- What's the single scenario that proves this feature works?
- Which existing test file is the closest neighbor? Extend it or make a new one?
- Does this touch persistent state, streaming, or auth? If yes, an integration
  test against local endpoints designed for agent testing is required, not
  optional. Search *or ask* for these local testing endpoints.
- Any manual verification the human wants to run (curl, REPL, MCP client)
  alongside the automated tests?

Record the answers in the plan's Q&A and inline the resulting test list into the
verification section. Name the test files, the fixtures, and the assertions.

Anti-patterns that must not ship in the plan:

- Unit tests only, when the change touches persistent state, streaming, auth, or
  the agent loop.
- Tests that mock the thing under test. If the change is in the session store,
  don't mock the session store.
- Assertions that only check "no exception raised" for behavior that has an
  observable output.
- "Add tests" as a bullet with no scenario named.

## What the plan file should look like

- Context section up top: why this change, what problem it solves, intended
  outcome.
- Q&A record from step 1 (and any follow-up rounds).
- Named files, classes, functions to be touched or created, with requirements
  per unit.
- Reused utilities and functions called out with paths so the implementer
  doesn't reinvent them.
- Verification section: unit tests, integration tests against a live local
  testing endpoint, and the named end-to-end scenario. See "Verification and
  tests" above for the bar.
- Progress-tracking instruction near the top of the stages section: a single
  line telling the implementing agent to check off each to-do item in this file
  as it lands. One sentence, no ceremony. Example: "Check off each item in this
  file as you complete it."
- Stages as markdown checklists at the bottom.

## What to avoid

- Time estimates. Ever.
- Line-by-line code in the plan.
- Dumping a wall of questions in prose. Use the tool.
- Asking open-ended questions with no options, or options with no trade-off
  `description`, or no recommended option. See step 1.
- Drafting the plan before the user says they're ready.
- Over-splitting stages into trivia.
- References to other plan files inside the code itself. If context matters,
  inline it when writing the code later.
- Author attribution. Don't put the user's name, "by X", or an "Author:" line
  anywhere in the plan file. Git handles authorship.
- Verification sections that stop at "add unit tests". Anything touching
  persistent state, streaming, auth, or the loop needs an integration test
  spelled out.
