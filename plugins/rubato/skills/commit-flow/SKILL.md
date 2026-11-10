---
name: commit-flow
description: "Turn a branch of agent commits into a series of semantic commits a person can read, draft the PR body, and tell the user it is ready. Handles the user's comments in chat as fix commits folded back into the series. Use when the user says commit-flow, organize, or regroup about such a branch, or runs /commit-flow."
---

# Commit Flow

A branch built by agents holds commits that are the agents' record, not a
series a person can read. This skill rewrites the branch into commits that
each hold one idea, drafts the PR body, and tells the user the series is
ready. When the user has comments, they give them in chat, and this skill
turns them into fix commits and folds them in.

The agent never pushes and never rewrites history itself. A script does the
git work. The user pushes and merges on their own, with whatever tools they
like. How the user reads the series is not this skill's business.

The script sits at `scripts/semantic_commits.py` beside this file. A delegate
loads a brief and not this skill, so whoever sends the organizer puts the
script's absolute path in the task. It is stdlib-only Python and runs as
`python3 <abs path>/semantic_commits.py`.

## Organize

Starts when an orchestrate stage group ends, or when the user runs
`/commit-flow organize` on any branch of agent commits, with or without a
plan. The agent in the room spawns the delegates through the subagent tool.
Inside an orchestrate build that is the orchestrator. Otherwise it is the
session where the user ran the command. The user never runs the organizer
directly. The base is the plan file's `base:` entry for the group, or the one
the user gives, or `main` when neither is named.

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
   absolute path, the lint command if any, the plan file path if any, the PR
   body output path, and an optional `regroup: ...` or `fold`.
5. Send the series reviewer: a delegate on another model with brief
   `orchestration/series-reviewer`. The task is the repo path, the base ref,
   and the plan file path if any.
6. Send its report to the organizer. It fixes what the report names, runs
   `list` again, and rebuilds. No `--force`: the guard ref equals the tip. One
   round. What the second build still gets wrong reaches the user in the
   series.
7. Tell the user: `Series ready on {branch}: [c1]..[cN]. PR body at {path}.`
   The organizer's old-to-new map goes with it. The user rewrites the PR body
   before they push.

**PR body path.** With a plan, `scratch/{plan-name}-pr-body-{g}.md`
beside the plan file, where `{g}` is the stage group number. The plan name in
the filename is so the user can find it in a file manager. Without a plan,
`<git-dir>/code-review/<branch>/pr-body.md`, where `<git-dir>` is the output
of `git rev-parse --git-dir`.

The old commits stay on a backup ref, `refs/backup/code-review/<branch>/<time>`,
so stage Outcome hashes still resolve.

## Comments

The user reads the series however they like and comes back to the same
session. Most of the time they say the series stands, and the skill is done.
Otherwise they give comments in chat, each naming a commit or a file and
what should change. Each comment gets one of three outcomes, said back to the
user in one line: `fix`, `answered` when the code is right and the user
needed the reason, or `declined` with the reason.

**Fix.** A fix is a new commit titled `[cN] fix: what it does`, where `cN` is
the commit it belongs to. Inside an orchestrate build the orchestrator adds a
fix stage and builds it through the implementer and reviewer. Outside one,
the agent in the room makes the change and commits it under the Commits form
in the `orchestration/implementer` brief. Once every fix is committed, send
the organizer with the task `fold`. It folds each fix into its commit, drops a
commit a fix fully reverted, and writes the PR body again. The series ends as
`[c1]..[cN]` with no gaps and no fix commits. Then say ready again.

**Regroup.** When the user says `regroup: <instruction>`, send an organizer
with that instruction and `--force`, then say ready again.

## Prose

The organizer and series-reviewer briefs carry the Prose rules of the
`orchestrate` skill. Anything this skill writes for the user follows the same
rules.
