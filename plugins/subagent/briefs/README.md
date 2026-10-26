# Briefs

A brief is standing instructions for one delegate job, appended to the
delegate's system prompt when a `subagent start` names it in `brief`. The
name is the path under this directory without `.md`, so
`briefs/orchestration/critic.md` is `brief: "orchestration/critic"`. Files
under `~/.pi/agent/briefs/` are discovered the same way and win on a name
collision.

Each file starts with frontmatter holding `name` and `description`. The
description is what the tool shows the calling agent, so it says what the job
is and which skill uses it.

`orchestration/` holds the briefs the `orchestrate` and `code-review` skills
send. They are not for general use: each assumes the plan file layout and the
scratch directory those skills define.
