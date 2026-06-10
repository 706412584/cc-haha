---
description: Aggregate triage / static / dynamic artefacts into a final report.md for an RE engagement
argument-hint: <sample-id>
---

Use the `re-report` skill to produce
`${user_config.ARTIFACT_DIR:-artifacts/re-runs}/$ARGUMENTS/report.md`.

If `$ARGUMENTS` is empty, list existing sample-ids under the artefact directory
and ask the user to pick one.
