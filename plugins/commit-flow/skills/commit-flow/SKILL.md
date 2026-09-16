---
name: commit-flow
description: Review the working-tree diff, propose a table of commit groups, and stage them one group at a time so the user writes each message and commits. Use when the user asks to "commit-flow", "group my changes into commits", "help me commit this work", or wants to break a diff into clean commits.
---

# Commit Flow

Turn a pile of working-tree changes into a sequence of clean commits. The agent
reads the diff and proposes groups of files. Each group is one commit. The agent
stages one group at a time. The user reviews the staged files in their IDE,
writes the commit message, and commits.

This skill keeps the user's structural model of the repo sharp. Small commits
with clear boundaries tell the user which files hold which components and what
each module does.

## Roles

- **The agent stages.** It runs `git add` on the files for one group.
- **The user commits.** The user writes every commit message and runs the
  commit. The agent never writes a message and never commits.

## Steps

### Step 1: Read the diff

Look at the full working tree before proposing anything.

- `git status --porcelain` for the file list, including untracked, deleted, and
  renamed files.
- `git diff` for unstaged changes.
- `git diff --staged` for anything already staged.

If files are already staged, note it. Fold them into the group proposal instead
of ignoring them.

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
of the files, and a short description of the change. List each file on its own
bullet. Backtick every path so code files are easy to spot.

**Commit 1 — Stream the feature pipeline in batches**

- `src/delphi/features/pipeline.py`
- `src/delphi/features/transforms.py`
- `src/delphi/io/loader.py`

Rework the feature pipeline to stream batches from the loader instead of holding
the whole frame in memory. `transforms.py` moves to lazy column ops, and
`config.py` adds the `--batch-size` flag.

Rules for the proposal:

- **Group by intent.** Files that make one logical change go in one commit.
  Don't mix unrelated changes. Ask if unsure.
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

### Step 3: Stage the first group

On approval, stage only the first commit's files with `git add`. Nothing else.

Then tell the user the group is staged and name the files. Hand off:

> Commit 1 is staged: `src/delphi/features/pipeline.py`,
> `src/delphi/features/transforms.py`, `src/delphi/io/loader.py`. Review it in
> your IDE, write your message, and commit. Tell me when to stage the next
> group.

### Step 4: Stage the next group

When the user says to continue, first confirm the previous group is committed.
Run `git status --porcelain`. If the last group's files still show as staged or
modified, say so and wait. Don't stack two groups in the index.

Once the tree is clean of the last group, stage the next one and hand off again.
Repeat until every group is committed.

## Guidelines

- **One group in the index at a time.** Never stage ahead. The user commits
  before the next group is staged.
- **Stage exact paths.** Use explicit file paths with `git add`. Don't use
  `git add .` or `git add -A`.
- **Handle deletes and renames.** `git add` stages a deletion. A rename is the
  old path and the new path. Include both.
- **Re-read on drift.** If the working tree changed since the proposal (the user
  edited a file, a group turned out wrong), re-run `git status` and update the
  table before staging.
- **Don't commit.** Even if the user seems to want it, confirm before running
  `git commit`. The default is that the user commits.
