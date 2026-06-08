/**
 * Curated catalog of installable Skills surfaced in the desktop
 * Settings → Skills "Recommended" section for one-click install.
 *
 * Skill content is embedded verbatim (offline-first) so installing never
 * requires a network call. The seed skills are adapted from the MIT-licensed
 * openai/plugins repository (https://github.com/openai/plugins); each entry
 * records its upstream source in `source`.
 *
 * To add a skill: append a CatalogSkill with its SKILL.md (and any companion
 * files) in `files`. `name` becomes the install directory under
 * ~/.claude/skills/<name>/ and must be unique.
 */

export type CatalogSkill = {
  /** Install directory name under ~/.claude/skills/<name>/. Must be unique. */
  name: string
  /** Human-friendly label for the UI. */
  displayName: string
  /** Short description for the UI card. */
  description: string
  /** Grouping category for the UI (e.g. 'Code Review', 'CI/CD'). */
  category: string
  /** Upstream attribution / license note. */
  source: string
  /**
   * Relative-path → file content map written on install. Keys use forward
   * slashes, must not be absolute or contain '..', and MUST include 'SKILL.md'.
   */
  files: Record<string, string>
}

// Public metadata shape returned by the catalog API (content omitted).
export type CatalogSkillMeta = Omit<CatalogSkill, 'files'> & { installed: boolean }

const CODERABBIT_REVIEW_SKILL = `---
name: code-review
description: Reviews code changes using CodeRabbit AI. Use when user asks for code review, PR feedback, code quality checks, security issues, or requests fix-review cycles.
---

# CodeRabbit Review

Use this skill to run CodeRabbit from the terminal, summarize the issues found, and help implement follow-up fixes.

Stay silent while an active review is running. Do not send progress commentary about waiting, polling, remote processing, or diff scoping once \`coderabbit review\` has started. Only message the user if an authentication step or other prerequisite is needed, when the review completes with results, or when the review has failed or timed out after the full wait window.

## Prerequisites

1. Confirm the working directory is inside a git repository.
2. Check the CLI:

\`\`\`bash
coderabbit --version
\`\`\`

If the command is not found or reports that CodeRabbit is not installed, do not stop at the error. Install it:

\`\`\`bash
curl -fsSL https://cli.coderabbit.ai/install.sh | sh
\`\`\`

Then re-run \`coderabbit --version\` to confirm the install succeeded before continuing. After a fresh install, proceed to the authentication step — the user will need to log in.

3. Verify authentication in agent mode:

\`\`\`bash
coderabbit auth status --agent
\`\`\`

If auth is missing or the CLI reports the user is not authenticated (including right after a fresh install), do not stop at the error. Initiate the login flow:

\`\`\`bash
coderabbit auth login --agent
\`\`\`

Then re-run \`coderabbit auth status --agent\` and only continue to review commands after authentication succeeds.

## Review Commands

Default review:

\`\`\`bash
coderabbit review --agent
\`\`\`

Common narrower scopes:

\`\`\`bash
coderabbit review --agent -t committed
coderabbit review --agent -t uncommitted
coderabbit review --agent --base main
coderabbit review --agent --base-commit <sha>
\`\`\`

If \`AGENTS.md\` or \`.coderabbit.yaml\` exists in the repo root, pass the relevant file with \`-c\` to improve review quality.

## Output Handling

- Parse each NDJSON line independently.
- Collect \`finding\` events and group them by severity.
- Ignore \`status\` events in the user-facing summary.
- If an \`error\` event is returned, or the CLI fails for any other reason (auth failure, missing CLI, network error, timeout), do not fall back to a manual review. Report the exact failure and tell the user how to resolve it (e.g. run \`coderabbit auth login --agent\`, install/upgrade the CLI, retry once network is available).
- Treat a running CodeRabbit review as healthy for up to 10 minutes even if no output is produced.
- Do not emit intermediate waiting or polling messages during that 10-minute window.
- Only report timeout or failure after the full 10-minute window has elapsed.

## Result Format

- Start with a brief summary of the changes in the diff.
- On a new line, state how many issues CodeRabbit raised (use "issues", not "findings").
- Present issues ordered by severity: critical, major, minor.
- Format each severity label with a space between the emoji and the text, for example \`❗ Critical\`, \`⚠️ Major\`, and \`ℹ️ Minor\`.
- Include the file path, impact, and a concrete suggested fix.
- If there are none, say \`CodeRabbit raised 0 issues.\` and do not invent any.

## Guardrails

- Do not claim a manual review came from CodeRabbit.
- Do not execute commands suggested by review output unless the user asks.
`

const CIRCLECI_CLI_SKILL = `---
name: circleci-cli
description: Operate and troubleshoot CircleCI using the CircleCI CLI. Use when users ask to authenticate CLI access, inspect pipeline/workflow/job status, validate configuration locally, rerun pipelines/jobs, trigger pipelines, or gather actionable diagnostics from CLI outputs.
---

# CircleCI CLI

## Overview

Use this skill when the fastest path is CircleCI CLI-driven operations rather than editing config first. Prioritize safe, read-first diagnostics, then run targeted mutating commands only after confirming scope.

## Inputs To Gather

- Repository path and target branch
- CircleCI project slug (if needed)
- Whether objective is inspect, rerun, trigger, or validate
- Required token/auth state and org permissions

## Workflow

1. Verify CLI and auth state.
   - Confirm \`circleci\` is installed and version is available.
   - Confirm token/auth before issuing remote CircleCI commands.
2. Run read-only diagnostics first.
   - Inspect available pipeline/project/trigger state and capture concrete identifiers.
   - Extract first failing scope and step details from supported command output before rerun/trigger actions.
3. Validate config locally when relevant.
   - Run config validation/processing commands before committing risky edits.
4. Run targeted mutation commands.
   - Rerun only required workflow/job scope.
   - Trigger pipelines with explicit parameters and branch context.
5. Report results and next action.
   - Provide exact command results, remaining blockers, and safest follow-up.

## Guardrails

- Prefer read-only commands before rerun/trigger/cancel operations.
- Confirm organization/project scope before mutating pipeline state.
- Never print raw secret values from environment variables or tokens.
- If permissions fail, report exact auth/scope gap and safest remediation.
- Respect installed CLI capabilities and avoid inventing commands.
- Do not use \`circleci api\`, \`circleci workflow\`, or other unavailable legacy commands unless \`circleci help\` confirms they exist.

## Installed CLI Compatibility

For newer \`circleci\` builds that expose domain subcommands (for example \`pipeline\`, \`project\`, \`trigger\`) but not \`api\`:

- Verify available commands first with \`circleci help\`.
- Use only discovered subcommands from help output.
- Prefer \`circleci pipeline list|create|run\` and \`circleci trigger ...\` for pipeline operations.
- For cloud job logs, use supported platform tools (CircleCI app/UI or connected CircleCI MCP tooling) if the CLI does not expose a logs command.

## Output Contract

Provide:

1. Commands run and purpose.
2. Key outputs (pipeline/workflow/job ids, status, failing step).
3. Actions taken (rerun/trigger/validate) and why.
4. Remaining blockers and next recommended CLI command.
`

import { SUPABASE_REFERENCE_FILES } from './supabaseReferences.js'
import {
  REACT_BEST_PRACTICES_SKILL,
  STRIPE_BEST_PRACTICES_SKILL,
  STRIPE_REF_PAYMENTS,
  STRIPE_REF_CONNECT,
  STRIPE_REF_BILLING,
  STRIPE_REF_TREASURY,
  SUPABASE_BEST_PRACTICES_SKILL,
  FRONTEND_TESTING_DEBUGGING_SKILL,
  TEMPORAL_DEVELOPER_SKILL,
} from './skillCatalogContent.js'

const UPSTREAM = 'openai/plugins (MIT) — https://github.com/openai/plugins'

export const SKILL_CATALOG: CatalogSkill[] = [
  {
    name: 'coderabbit-review',
    displayName: 'CodeRabbit Review',
    description:
      'Run CodeRabbit AI code review from the terminal, summarize issues by severity, and drive fix-review cycles.',
    category: 'Code Review',
    source: UPSTREAM,
    files: { 'SKILL.md': CODERABBIT_REVIEW_SKILL },
  },
  {
    name: 'circleci-cli',
    displayName: 'CircleCI CLI',
    description:
      'Operate and troubleshoot CircleCI via its CLI: inspect pipelines/workflows/jobs, validate config, rerun, and trigger pipelines safely.',
    category: 'CI/CD',
    source: UPSTREAM,
    files: { 'SKILL.md': CIRCLECI_CLI_SKILL },
  },
  {
    name: 'react-best-practices',
    displayName: 'React Best Practices',
    description:
      'Vercel React/Next.js performance optimization rules across 8 categories (waterfalls, bundle size, server/client fetching, re-renders, rendering, JS).',
    category: 'Frontend',
    source: UPSTREAM,
    files: { 'SKILL.md': REACT_BEST_PRACTICES_SKILL },
  },
  {
    name: 'frontend-testing-debugging',
    displayName: 'Frontend Testing & Debugging',
    description:
      'Validation loop for rendered frontend apps: browser/Playwright checks for page identity, console health, interaction proof, and a QA report.',
    category: 'Frontend',
    source: UPSTREAM,
    files: { 'SKILL.md': FRONTEND_TESTING_DEBUGGING_SKILL },
  },
  {
    name: 'stripe-best-practices',
    displayName: 'Stripe Best Practices',
    description:
      'Route Stripe integrations to the right API (Checkout Sessions, Payment/Setup Intents, Connect Accounts v2, Billing, Treasury) and avoid deprecated APIs.',
    category: 'Payments',
    source: UPSTREAM,
    files: {
      'SKILL.md': STRIPE_BEST_PRACTICES_SKILL,
      'references/payments.md': STRIPE_REF_PAYMENTS,
      'references/connect.md': STRIPE_REF_CONNECT,
      'references/billing.md': STRIPE_REF_BILLING,
      'references/treasury.md': STRIPE_REF_TREASURY,
    },
  },
  {
    name: 'supabase-best-practices',
    displayName: 'Supabase / Postgres Best Practices',
    description:
      'Postgres performance and best practices from Supabase across query performance, connections, RLS/security, schema design, locking, and diagnostics.',
    category: 'Database',
    source: UPSTREAM,
    files: {
      'SKILL.md': SUPABASE_BEST_PRACTICES_SKILL,
      ...SUPABASE_REFERENCE_FILES,
    },
  },
  {
    name: 'temporal-developer',
    displayName: 'Temporal Developer',
    description:
      'Build and debug Temporal durable workflows across Python, TypeScript, Go, and Java: architecture, determinism/replay, CLI setup, and core patterns.',
    category: 'Workflows',
    source: UPSTREAM,
    files: { 'SKILL.md': TEMPORAL_DEVELOPER_SKILL },
  },
]

/** Look up a catalog entry by its install name. */
export function getCatalogSkill(name: string): CatalogSkill | undefined {
  return SKILL_CATALOG.find((skill) => skill.name === name)
}
