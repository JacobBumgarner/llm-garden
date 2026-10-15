---
name: commit-flow
description: "The user's pass over a branch that agents built, in four stages the orchestrator announces and never advances on its own: handover, review, proofing, publish. Use when the user says commit-flow, handover, review, proofing, or publish about such a branch, or runs /commit-flow <stage>."
---

# Commit Flow

The branch holds one agent commit per stage. Titles read `[s3] store: add
export table`. Bodies carry the technical description, a `---` line, then
the plain description. Fix and cleanup commits have the same form. The plan file's
Review record is where this skill writes.

Two roles. The user reads in `tuicr`, then squashes and writes in
`lazygit`. The agent never amends, squashes, rewords, or pushes, and never
writes a title, body, or description. Each stage below is also a command,
`/commit-flow <stage>`, so the pass works days later in a fresh session. The
base is the plan file's `base:` line, or the one the user gives.

## Handover

Starts when the build is done, or the user says "handover".

1. Run `git log --reverse <base>..HEAD` and read the plan's Stages.
2. Write one short block per intended commit: what it does in plain words,
   the entities changed, and what Verify showed.
3. Do not paste the diff. The user opens it when a block raises a question.
4. Editor pass on the blocks before they are shown: a fresh delegate reads
   `../orchestrate/references/editor.md` relative to this skill and edits the blocks
   for reading. Facts stay as they are.

Close with: `Review when ready.`

## Review

Starts when the user says "review" after reading in `tuicr`.

1. Run `tuicr review list --repo .` and keep the sessions on this branch.
2. For each, run `tuicr review comments --session <slug> --repo .`. Skip a
   session with no comments.
3. Per comment, make one fix stage. Fix the code, run that stage's Verify,
   and make a new commit titled with the stage it fixes, such as
   `[s3] fix: ...`. Never amend.
4. Copy comment, reply, and commit hash into the Review record under User.
   With no plan file, put the list in your reply.
5. Only after step 4, run `tuicr review clearc --session <slug> --repo .`.
6. Rerun Verify and the gates. Report the result.

Close with: `N fixes landed. Review again, or proofing.`

## Proofing

Starts when the user has squashed and written in `lazygit` and says
"proofing".

1. Start a fresh agent through the subagent tool. Not the builder.
2. Its task is `../orchestrate/references/proofing.md` relative to this
   skill, the plan file path, and the base ref. The brief holds the two
   questions it answers per commit and the form of its output.
3. Relay the output as is, and copy it into the Review record under
   Delegates.

Close with: `Amend what you want, then proofing again, or publish.`

## Publish

Starts when the user says "publish" with a description file.

1. Ask for the file path if you lack it. Never draft or edit the file.
2. Run the Proofing steps on the description, with the file added to the
   brief. Relay the output as is.
3. If anything is flagged, stop. The user edits, then says "publish" again.
4. If it holds, say so and wait. The user says "push". This is the first
   thing to leave the machine.
5. Run `git push -u origin <branch>`, then `gh pr create --title <title>
   --body-file <file>` with the title the user supplies.
6. Copy the proofing output and the PR URL into the Review record under
   Delegates.

Close with: `PR created: <url>.`

## If asked how to group

Answer from the log and the plan. Never run the squash.

- A group is a contiguous run of stage commits that make one intent, with
  its own code, tests, and docs.
- Docs or tests get a separate commit only when they are their own intent.
- The plan file commit goes last, alone.
- A fix that cannot be reordered without conflict stays its own commit, with
  the user's message.
- The test: the user can write the group's title from the plan and the
  commit bodies before reading the diff.
