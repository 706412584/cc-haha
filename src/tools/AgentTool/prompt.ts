import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { isTeammate } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const FORK_DONT_PEEK_RULE = "**Don't peek.** The tool result includes an `output_file` path — do not Read or tail it while the fork is running. You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking."

const BACKGROUND_FORK_EXAMPLE = [
  'user: "Audit this branch for release blockers, and meanwhile run the independent formatting check."',
  "assistant: <thinking>The release audit and formatting check are independent. I'll fork the audit in the background, then continue the executable formatting work in this turn.</thinking>",
  `${AGENT_TOOL_NAME}({`,
  '  name: "ship-audit",',
  '  description: "Branch ship-readiness audit",',
  '  prompt: "Audit what\'s left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list — done vs. missing. Under 200 words.",',
  '  run_in_background: true',
  '})',
  "assistant: The ship-readiness audit is running; I'm continuing the independent formatting check.",
  'assistant: Uses the Bash tool to run the formatting check, then handles any actionable result without waiting for the audit.',
  "assistant: The formatting check is complete. There is no other unblocked work, so I'm waiting for the audit result.",
  '<commentary>',
  'The turn ends here only after the independent work is complete and all remaining work depends on the audit result. The coordinator knows nothing about the findings yet. What follows is a SEPARATE turn — the notification arrives from outside, as a user-role message. It is not something the coordinator writes.',
  '</commentary>',
  '[later turn — notification arrives as user message]',
  "assistant: Audit's back. Three blockers: no tests for the new prompt path, GrowthBook gate wired but not in build_flags.yaml, and one uncommitted file.",
].join('\n')

const PRIMARY_AGENT_OWNERSHIP_RULE = [
  '## Primary-agent ownership — default rule',
  '',
  'The primary agent owns understanding, implementation, and the decision about verification depth. Do not delegate simple lookups, planning, local edits, or ordinary test execution.',
  '',
  'Match checks to risk and cost, and always inspect the final diff for unintended scope or leftovers. Simple, localized, low-risk changes can otherwise stop after LSP diagnostics, type checks, or the lightest relevant static check. When behavior changes and a cheap relevant test exists, decide whether to run the narrowest test yourself. Do not require a focused test after every small feature, task, file, or logical chunk.',
  '',
  'Use a subagent only when its separate context or independence repays the coordination cost: user-requested independent review or verification, complex bug isolation, or genuinely parallel implementation with non-overlapping file ownership. Do not launch a verification agent unless the user explicitly requests independent verification. A bug report, high-risk change, cross-boundary change, broad refactor, PR-ready status, file count, task count, or completed implementation is not authorization. The primary agent owns reproduction, testing, and validation. If the approved task or plan has no verification step, do not add one at the end. The explicit Solo Pipeline TEST stage is the only mode-level exception because enabling Solo selects that workflow. When implementation agents run in parallel, the primary agent must retain and continue at least one executable task.',
].join('\n')

const HYBRID_PARALLEL_KICKOFF_RULE = [
  '## Hybrid parallel kickoff contract',
  '',
  "Parallel kickoff requires at least two unblocked tasks with non-overlapping file ownership and the tasks do not need each other's results before they can start.",
  '',
  'small changes, same-file work, or chain dependencies are not a reason to fan out; keep them with the primary agent or run them sequentially.',
  '',
  "For approved complex work, first create the full task list, assign owners and dependencies, and confirm Wave 1 is unblocked. Use owner='main-agent' for main-owned tasks; for agent-owned tasks, owner must exactly match the unique Agent name used at launch and resume. Launch named background agents together in one assistant message. In that same assistant turn, the primary agent keeps the critical-path task and immediately performs its own first real non-Agent tool action instead of waiting or merely restating the plan.",
].join('\n')

const BACKGROUND_ORCHESTRATION_RULE = [
  '## Background orchestration — hard rule',
  '',
  "Before launching an agent, classify the remaining work by dependency: which tasks require the agent's result, and which are independent. Use background agents only for genuinely independent, parallel work. Use a foreground agent when you must have its result before you can proceed.",
  '',
  `After launching a background agent, continue in the same turn with the lowest-ordered or currently executable unblocked work. Do not end your turn merely because a background agent is running. If unblocked work exists, briefly tell the user which agent is running and what you are continuing, then actually perform that work in the same turn — for example, "The release audit is running; I'm continuing the independent formatting check." Only say that you are waiting when every remaining task depends on the background result, requires user input, or is complete.`,
  '',
  'A pending, unblocked task owned by `main-agent` is executable work; ownership reserves it for the primary agent and does not make it unavailable. This rule applies on every turn, not only the turn that launched an agent. Before ending any turn, inspect the task list. If such a task exists, mark the lowest-ID one in_progress and immediately perform a real non-Task tool action for it in the same turn. A status update, plan restatement, or promise to continue does not count as executing that work.',
  '',
  "Do not poll healthy background agents, sleep awaiting them, or read an agent's `output_file` while it is making progress. Wait for the automatic completion notification while doing other executable work.",
  '',
  'If a stalled-agent notification arrives, reconcile that Agent once before waiting again: inspect the runtime task with a non-blocking status check. If it is still running, report the stall and wait without continuous polling. If it is terminal, consume its result. If the runtime task no longer exists, return its linked task-list item to pending, clear or replace the stale owner, and continue the now-unblocked work.',
  '',
  'When a terminal Agent notification corresponds to a TaskCreate item assigned to that Agent, reconcile the task-list state in the same turn. Only mark the linked item completed when the Agent reports that its assigned work is fully complete; otherwise return it to pending with the remaining scope recorded.',
  '',
  'When a completion notification shows `no file edits` / `file_edits=0` but the task was expected to modify files, do not mark the TaskCreate item completed — return it to pending and re-delegate or verify. Treat `status=completed` as lifecycle completion only, not proof of workspace mutation.',
  '',
  'After an agent completes, fails, stops, is killed, or is cancelled, keep it terminal by default. Synthesize its result and launch a fresh agent for follow-up work when delegation is still warranted. Only use SendMessage to resume a terminal agent when the current user message explicitly asks to resume that specific agent.',
].join('\n')

const BACKGROUND_USAGE_NOTES = [
  '- You can optionally run agents in the background using the run_in_background parameter. Background orchestration follows the hard rule above.',
  "- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed. Use background only when you have genuinely independent work to do in parallel.",
].join('\n')

export const AGENT_TOOL_ORCHESTRATION_GUIDANCE = {
  forkImplementation: '**Implementation**: fork only when isolating implementation output or context will repay the handoff cost; edit count alone is not a trigger. Do research before jumping to implementation.',
  testRunnerDescription: '"test-runner": use this agent only when the user explicitly requests independent test execution or a separate verification pass',
  independentTestRunner: 'The user explicitly requested independent verification for a high-risk cross-boundary change, so finish the implementation scope, run only any immediate checks needed to proceed safely, then use the independent test-runner the user requested as the final verification pass.',
} as const

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // Both defined: filter allowlist by denylist to match runtime behavior
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // Allowlist only: show the specific tools available
    return tools.join(', ')
  } else if (hasDenylist) {
    // Denylist only: show "All tools except X, Y, Z"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // No restrictions
  return 'All tools'
}

/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description. When true, getPrompt() returns a static
 * description and attachments.ts emits an agent_listing_delta attachment.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 *
 * Override with CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false for testing.
 */
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // Filter agents by allowed types when Agent(x,y) restricts which agents can be spawned
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // Fork subagent feature: when enabled, insert the "When to fork" section
  // (fork semantics, directive-style prompts) and swap in fork-aware examples.
  const forkEnabled = isForkSubagentEnabled()

  const whenToForkSection = forkEnabled
    ? `

## When to fork

Fork yourself (omit \`subagent_type\`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative \u2014 "will I need this output again" \u2014 not task size.
- **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this \u2014 it inherits context and shares your cache.
- ${AGENT_TOOL_ORCHESTRATION_GUIDANCE.forkImplementation}

Forks are cheap because they share your prompt cache. Don't set \`model\` on a fork \u2014 a different model can't reuse the parent's cache. Pass a short \`name\` (one or two words, lowercase) so the user can see the fork in the teams panel and steer it mid-run.

${FORK_DONT_PEEK_RULE}

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running — give status, not a guess.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.
`
    : ''

  const writingThePromptSection = `

## Writing the prompt

${forkEnabled ? 'When spawning a fresh agent (with a `subagent_type`), it starts with zero context. ' : ''}Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

${forkEnabled ? 'For fresh agents, terse' : 'Terse'} command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
`

  const forkExamples = `Example usage:

<example>
${BACKGROUND_FORK_EXAMPLE}
</example>

<example>
user: "so is the gate wired up or not"
<commentary>
User asks mid-wait. The audit fork was launched to answer exactly this, and it hasn't returned. The coordinator does not have this answer. Give status, not a fabricated result.
</commentary>
assistant: Still waiting on the audit \u2014 that's one of the things it's checking. Should land shortly.
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read.</thinking>
<commentary>
A subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The briefing explains what to assess and why.
</commentary>
${AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
`

  const currentExamples = `Example usage:

<example_agent_descriptions>
${AGENT_TOOL_ORCHESTRATION_GUIDANCE.testRunnerDescription}
"greeting-responder": use this agent to respond to user greetings with a friendly joke
</example_agent_descriptions>

<example>
user: "This migration touches authentication and session persistence. Please implement it, then have a separate agent run the integration tests."
<commentary>
${AGENT_TOOL_ORCHESTRATION_GUIDANCE.independentTestRunner}
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the test-runner agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the greeting-responder agent"
</example>
`

  // When the gate is on, the agent list lives in an agent_listing_delta
  // attachment (see attachments.ts) instead of inline here. This keeps the
  // tool description static across MCP/plugin/permission changes so the
  // tools-block prompt cache doesn't bust every time an agent loads.
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  const ownershipRule = isCoordinator ? '' : PRIMARY_AGENT_OWNERSHIP_RULE

  // Shared core prompt used by both coordinator and non-coordinator modes
  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

${
  forkEnabled
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself — a fork inherits your full conversation context.`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`
}

${ownershipRule}

${HYBRID_PARALLEL_KICKOFF_RULE}

${BACKGROUND_ORCHESTRATION_RULE}`

  // Coordinator mode gets the slim prompt -- the coordinator system prompt
  // already covers usage notes, examples, and when-not-to-use guidance.
  if (isCoordinator) {
    return shared
  }

  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find via Bash instead.
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // The "class Foo" example is about content search. Non-embedded stays Glob
  // (original intent: find-the-file-containing). Embedded gets grep because
  // find -name doesn't look at file contents.
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use ${contentSearchHint} instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`

  // When listing via attachment, the "launch multiple agents" note is in the
  // attachment message (conditioned on subscription there). When inline, keep
  // the existing per-call getSubscriptionType() check.
  const concurrencyNote =
    !listViaAttachment && getSubscriptionType() !== 'pro'
      ? `
- Launch multiple agents concurrently only for genuinely independent work with non-overlapping ownership; keep one executable task with the primary agent. Use a single message with multiple tool uses.`
      : ''

  // Non-coordinator gets the full prompt with all sections
  return `${shared}
${whenNotToUseSection}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do${concurrencyNote}
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.${
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammate() &&
    !forkEnabled
      ? `\n${BACKGROUND_USAGE_NOTES}`
      : ''
  }
- Use ${SEND_MESSAGE_TOOL_NAME} to message a running agent by ID or name. For a terminal agent, use it only when the current user message explicitly asks to resume that specific agent. ${forkEnabled ? 'Each fresh Agent invocation with a subagent_type starts without context — provide a complete task description.' : 'Each Agent invocation starts fresh — provide a complete task description.'}
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkEnabled ? '' : ", since it is not aware of the user's intent"}
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.${
    process.env.USER_TYPE === 'ant'
      ? `\n- You can set \`isolation: "remote"\` to run the agent in a remote CCR environment. This is always a background task; you'll be notified when it completes. Use for long-running tasks that need a fresh sandbox.`
      : ''
  }${
    isInProcessTeammate()
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammate()
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${whenToForkSection}${writingThePromptSection}

${forkEnabled ? forkExamples : currentExamples}`
}
