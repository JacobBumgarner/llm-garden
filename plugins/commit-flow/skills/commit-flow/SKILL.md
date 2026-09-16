---
name: commit-flow
description: Read the working-tree diff and the plan doc, propose a draft plan of commit groups, and stage them one group at a time so the user writes each message and commits. Re-syncs the plan when the user revises code mid-flow. Use when the user asks to "commit-flow", "group my changes into commits", "help me commit this work", or wants to break a diff into clean commits.
---

# Commit Flow

Turn a pile of working-tree changes into a sequence of clean commits. The agent
reads the diff, reads the plan doc behind the work, and proposes groups of
files. Each group is one commit, and each carries a ready `git add` line. The
user runs the line, reviews the staged files in their IDE, writes the commit
message, and commits, then moves to the next group.

This skill keeps the user's structural model of the repo sharp. Small commits
with clear boundaries tell the user which files hold which components and what
each module does.

The first proposal is a draft. The user often reviews the diff, asks agents to
make changes, then comes back. The work happens in one session, so the agent
already holds the draft plan in context. On return, the agent re-reads the tree
and re-syncs the plan against it. No plan file is written to disk.

## Roles

- **Staging.** Each commit section carries a `git add` line. The user runs it,
  or asks the agent to stage that group. One group at a time.
- **The user commits.** The user writes every commit message and runs the
  commit. The agent never writes a message and never commits.

## Steps

### Step 1: Read the diff and the plan

Look at the full working tree before proposing anything.

- `git status --porcelain` for the file list, including untracked, deleted, and
  renamed files.
- `git diff` for unstaged changes.
- `git diff --staged` for anything already staged.

If files are already staged, note it. Fold them into the group proposal instead
of ignoring them.

Then read the plan doc behind the work. Most changes here start from a plan
file. It carries the intent the raw diff can't show: why these files changed
together, which change belongs to which task, what's a follow-up. Use it to
group by intent and to write sharper descriptions.

- Look for the plan doc first. Check `plan/`, `plans/`, and `tmp/` for a recent
  markdown plan, and check this session's context in case the plan was written
  here.
- If one plan doc is the obvious match, read it.
- If none turns up, or several could match, ask the user to point at the plan
  doc. If there's genuinely no plan, say so and group from the diff alone.

### Step 2: Propose commit groups

The proposal has two parts: a summary table and a section per commit.

First, a summary table. Two columns: commit number and a one-line summary. This
is the at-a-glance index. Order the rows in the sequence the user should commit
them, dependencies first. Source and docs come first. Tests come last.

| Commit | Summary |
| --- | --- |
| 1 | Stream the feature pipeline in batches |
| 2 | Document the batch-size flag |
| 3 | Unit tests for the batch iterator |

Then, one section per commit. Each section has a bold heading, a bulleted list
of the files, a short description of the change, and a `git add` line that stages
exactly those files. List each file on its own bullet. Backtick every path so
code files are easy to spot.

**Commit 1 — Stream the feature pipeline in batches**

- `src/delphi/features/pipeline.py`
- `src/delphi/features/transforms.py`
- `src/delphi/io/loader.py`

Rework the feature pipeline to stream batches from the loader instead of holding
the whole frame in memory. `transforms.py` moves to lazy column ops, and
`loader.py` yields batches the pipeline pulls on demand.

```
git add src/delphi/features/pipeline.py src/delphi/features/transforms.py src/delphi/io/loader.py
```

Rules for the proposal:

- **Group by intent.** Files that make one logical change go in one commit.
  Don't mix unrelated changes. Ask if unsure.
- **End each section with a `git add` line.** List that commit's exact paths in a
  fenced code block so the user can copy and run it. Same paths as the bullets,
  no more, no less.
- **Tests commit last, in their own commits.** Source and docs commit first.
  Then the tests, never mixed with the source they cover.
- **Split tests by type.** Unit, integration, and nightly tests each get their
  own commit. Never batch two test types into one commit. Drop a type if the
  diff has none of it.
- **One file per bullet.** List each path on its own bullet. Don't run files
  together with commas. Don't use a table cell for the file list, and don't use
  `<br>`, `<ul>`, or `<li>` tags. Claude Code's terminal renderer can't render
  them.
- **Backtick every path.** Every file path is a code identifier.
- **List every changed file.** Every path from `git status` lands in exactly one
  commit. Don't drop files.
- **Keep the summary and description short.** The summary is one line. The
  description is a sentence or two on what changed and why.

After the proposal, stop and wait. The user may merge commits, split them, or
reorder. Adjust until they approve.

### Step 3: Hand off the first group

On approval, point the user at the first commit's `git add` line. They run it,
review the staged files in their IDE, write the message, and commit. If the user
would rather the agent stage, run `git add` on that commit's exact paths. Either
way, stage only one group at a time.

> Commit 1 is ready. Run its `git add` line, review in your IDE, write your
> message, and commit. Tell me when you're on to the next group.

### Step 4: Move to the next group

When the user says to continue, first confirm the previous group is committed.
Run `git status --porcelain`. If the last group's files still show as staged or
modified, say so and wait. Don't stack two groups in the index.

Once the tree is clean of the last group, point the user at the next commit's
`git add` line (or stage it on request) and hand off again. Repeat until every
group is committed.

### Step 5: Re-sync the plan after revisions

The user often reviews the draft, asks agents to change the code, then returns
to keep committing. The tree has moved since the draft. Re-sync before staging
anything more.

The draft plan is already in the session context, so this is a file-set
reconciliation, not a fresh start. Re-run `git status --porcelain` and
`git diff`, then compare the current changed files against the draft:

- **Still changed, already grouped** → keep it in its commit.
- **Changed now, not in the plan** → new file. Propose a commit for it, or add
  it to a fitting group. Flag it as new.
- **In the plan, no longer changed** → already committed, or reverted. Mark it
  done or drop it.

Refresh the descriptions from the current `git diff`, and re-read the plan doc
if the work grew past it. Re-present the updated plan, calling out what changed
since the draft. Then continue staging.

## Guidelines

- **One group in the index at a time.** Never stage ahead. The user commits
  before the next group is staged.
- **Stage exact paths.** Use explicit file paths with `git add`. Don't use
  `git add .` or `git add -A`.
- **Handle deletes and renames.** `git add` stages a deletion. A rename is the
  old path and the new path. Include both.
- **Re-sync on drift.** If the tree changed since the proposal, the user edited
  a file, or a group turned out wrong, re-sync the plan per Step 5 before
  staging.
- **Don't commit.** Even if the user seems to want it, confirm before running
  `git commit`. The default is that the user commits.
