---
name: code-review
description: "Turn a branch of agent stage commits into a series of semantic commits a person can read, then talk through the user's review of it. Two parts: organize, and the review conversation. Use when the user says code-review, organize, regroup, or review about such a branch, or runs /code-review."
---

# Code Review

A branch built by agents holds one commit per stage. Those commits are the
agents' record, not a series a person can read. This skill has two parts.
`organize` rewrites the branch into commits that each hold one idea. The
review conversation takes the user's comments from `tuicr` and writes down
what to do about them.

The agent never pushes and never rewrites history itself. A script does the
git work. The user rewords in `lazygit` and pushes on their own.

The script sits at `scripts/semantic_commits.py` beside this file. A delegate
loads a brief and not this skill, so whoever sends the organizer puts the
script's absolute path in the task. It is stdlib-only Python and runs as
`python3 <abs path>/semantic_commits.py`.

## Organize

Starts when a stage group ends, or when the user runs `/code-review organize`.
The agent in the room spawns the delegates through the subagent tool. Inside
an orchestrate build that is the orchestrator. Otherwise it is the session
where the user ran the command. The user never runs the organizer directly.
The base is the plan file's `base:` entry for the group, or the one the user
gives.

1. Find the lint command in the repo's `AGENTS.md`, in check mode, such as
   `uvx ruff check .` or `npm run lint`. Never use a command that rewrites
   files. With none, the organizer builds with `lint: skipped`.
2. Run `python3 <script> --repo . list --base <base>` and read the unit
   count.
3. Size guard. Above about 300 units, call `ask` with the count and three
   choices: organize in two passes (coarse ideas from the stage log, then
   hunks within each), split the branch first, or go ahead in one pass. Below
   that, go on.
4. Send the organizer: a delegate with brief `orchestration/organizer`. The
   task is the inputs, one per line: repo path, base ref, the script's
   absolute path, the lint command if any, the plan file path if any, and an
   optional `regroup: ...` or `fold`.
5. Send the series reviewer: a delegate on another model with brief
   `orchestration/series-reviewer`. The task is the repo path, the base ref,
   and the plan file path if any.
6. Send its report to the organizer. It fixes what the report names, runs
   `list` again, and rebuilds. No `--force`: the guard ref equals the tip. One
   round. What the second build still gets wrong reaches the user in `tuicr`.
7. Tell the user: `Series ready on {branch}: [c1]..[cN]. Read in tuicr, then
   /code-review in a fresh session.` The organizer's old-to-new map and the
   path of the PR body draft go with it. The user rewrites the draft before
   they push.

The old commits stay on a backup ref, `refs/backup/code-review/<branch>/<time>`,
so stage Outcome hashes still resolve.

## Review conversation

Starts when the user runs `/code-review` in a fresh pi session, in the repo,
with the plan file path or the base ref as the argument. The session runs in
the checkout the orchestrator built in, worktree or main, so the plan path
and `plan/scratch/` resolve.

1. Run `tuicr review list --repo .` and keep the sessions on this branch.
2. For each, run `tuicr review comments --session <slug> --repo .`.
3. Read the plan when one is given.
4. Talk with the user. Answer questions about the code, discuss a comment,
   and take decisions.

**Regroup.** When the user says `regroup: <instruction>`, send an organizer
with that instruction and `--force`, then the user reads again in `tuicr`.
When `tuicr` sessions with comments exist on the branch, say the rewrite
orphans them, and regroup only after the user confirms.

**Review file.** When the user says done, write
`plan/scratch/{plan-name}/review-{g}.md`, where `{g}` is the stage group
number. With no plan, write `<git-dir>/code-review/<branch>/review.md`, where
`<git-dir>` is the output of `git rev-parse --git-dir`. One entry per comment:

```
- file:line
  comment: what the user wrote
  decision: fix | declined | answered, with one line of reason
  target: [cN]
```

Then run `tuicr review clearc --session <slug> --repo .` for each session.
Tell the user to bring the file to the orchestrator. Never edit code and
never touch history in this part.

A review with no comments needs no session and no file. The user tells the
orchestrator the series is approved as it stands and goes on to `lazygit`.

## Fold

After review, a fix is a new commit titled `[cN] fix: what it does`, where
`cN` is the commit it belongs to. Once review is done and before the user
opens `lazygit`, send the organizer with the task `fold`. When the review
file has no `fix` entry, or there is no review file, skip the fold: the
series is already `[c1]..[cN]`. It folds each fix
into its commit, drops a commit a fix fully reverted, and writes the PR body
draft again. The series ends as `[c1]..[cN]` with no gaps and no fix commits.

## Prose

The organizer and series-reviewer briefs carry the Prose rules of the
`orchestrate` skill. Anything this skill writes for the user, the review file
included, follows the same rules.
