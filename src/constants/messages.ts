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

// AskUserQuestion's "chat about this" is the third denial shape: the user isn't
// rejecting the tool, they want to talk the questions over before answering.
// Both of the messages above send the wrong instruction here — REJECT_MESSAGE
// tells the model to stop and wait, PLAN_REJECTION tells it to revise a plan —
// so the model has to be told to open the conversation itself. Without that,
// the button hands the user a silent turn and they have to prompt twice.
// The wording is shared with the CLI's AskUserQuestionPermissionRequest so both
// surfaces put the same instruction in front of the model.
export const ASK_USER_QUESTION_CLARIFY_MESSAGE = `The user wants to clarify these questions.
    This means they may have additional information, context or questions for you.
    Take their response into account and then reformulate the questions if appropriate.
    Start by asking them what they would like to clarify.`
// Suffixed with the questions asked so far (and any answers already filled in),
// so switching to a conversation doesn't throw away the partial answers.
export const ASK_USER_QUESTION_CLARIFY_WITH_QUESTIONS_PREFIX = `${ASK_USER_QUESTION_CLARIFY_MESSAGE}

    Questions asked:\n`
