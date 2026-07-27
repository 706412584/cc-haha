export const NO_CONTENT_MESSAGE = '(no content)'

// Tool-denial copy handed to the model as tool_result content. Kept in this
// dependency-free module so the server (sidecar) can reuse the exact wording
// the CLI uses without pulling in utils/messages.ts and its analytics deps.
// utils/messages.ts re-exports both for existing callers.
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
export const REJECT_MESSAGE_WITH_REASON_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"

// Plan rejection is the one denial that must NOT tell the model to stop:
// rejecting a plan means "keep planning". Deliberately not PLAN_REJECTION_PREFIX
// from utils/messages.ts — that one's contract is prefix + the full plan text,
// and neither renderer needs it (the CLI's renderToolUseRejectedMessage and the
// desktop's extractPlanPreview both read the plan from the tool input), so it
// would only echo the model's own plan back into context.
export const PLAN_REJECTION_MESSAGE =
  'The user rejected this plan and chose to stay in plan mode. Do not start implementing. Revise the plan and present it again for approval.'
export const PLAN_REJECTION_WITH_REASON_PREFIX =
  'The user rejected this plan and chose to stay in plan mode. Do not start implementing. Revise the plan to address this feedback and present it again for approval. The user said:\n'
