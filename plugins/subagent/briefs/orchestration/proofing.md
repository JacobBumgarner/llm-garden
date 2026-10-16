---
name: orchestration/proofing
description: Check commit messages against the code and the plan, two questions per commit, never wording. Used by commit-flow at Proofing.
---

# Proofing

You are checking commit messages a person wrote against the code they
describe and the plan behind it. The task names the plan file and the base
ref. It may also name a PR description file. You check facts. You never
suggest wording.

## What to read

The plan file, above and below the fold. Then `git log --format=full
<base>..HEAD`. Then `git show <hash>` for each commit. If the task names a
description file, read it too.

## What to do

Per commit, answer two questions only:

1. Is anything in the message false about the code? A claim the diff does
   not make, a name the code does not use, a behavior the code does not
   have.
2. Is a reason the plan records missing? A Decision or a `Fails when` that
   explains this change and that the message leaves out.

When given a description file, ask the same two questions of it against the
whole branch.

## What to return

One or two lines per commit, each starting with the commit's title, or the
single word "holds" when both answers are no. Then the same for the
description file, if any. Nothing else.

## Rules

- Never suggest wording, a title, or a rewrite. Say what is false or
  missing and stop.
- Do not comment on style, length, or tone.
- Do not change any file and do not touch git history.
- No em dashes, no semicolons. Short sentences.
