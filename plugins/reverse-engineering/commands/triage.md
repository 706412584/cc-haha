---
description: One-shot triage on a sample — identifies file type, packing, and routes to the right RE skill
argument-hint: <path-to-sample>
---

Run a triage pass on the sample at `$ARGUMENTS`.

Steps:

1. Use the `triage` skill on the file.
2. Compute SHA-256 and use the first 12 hex chars as the sample id.
3. Write the triage record to
   `${user_config.ARTIFACT_DIR:-artifacts/re-runs}/<sample-id>/triage.md`.
4. Output a one-line verdict and the recommended next skill.

Do NOT run the sample. Do NOT upload it anywhere.
