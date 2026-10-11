import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamingFallbackMessage,
} from "../../types/message.js";
import { logForDebugging } from "../../utils/debug.js";
import { errorMessage } from "../../utils/errors.js";
import {
  createSystemAPIErrorMessage,
  createSystemStreamingFallbackMessage,
} from "../../utils/messages.js";
import { sleep } from "../../utils/sleep.js";
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from "../analytics/index.js";
import { getAssistantMessageFromError } from "./errors.js";
import {
  getMaxStreamRetries,
  getRetryDelay,
  getStreamTransientRetryBudgetMs,
  RetriableStreamError,
} from "./withRetry.js";

/** Messages a streaming query attempt can emit. Mirrors queryModel's yield type. */
type StreamQueryMessage =
  | StreamEvent
  | AssistantMessage
  | SystemAPIErrorMessage
  | SystemStreamingFallbackMessage;

type StreamRetryOptions = {
  /** Cancels the backoff wait; the caller then handles the interrupt. */
  signal?: AbortSignal;
  /** Injectable for tests. Must resolve (not reject) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * Wrap a single streaming query attempt with mid-stream retries.
 *
 * Mid-stream failures — a socket reset, a proxy-reported truncation, a clean
 * EOF before message_stop, a watchdog stall, or an upstream api_error /
 * overloaded_error SSE event — arrive inside the 200 SSE body, so they never
 * reach withRetry (which only guards stream creation). queryModel() classifies
 * them (getStreamRetryKind) and throws RetriableStreamError; here we catch it
 * and re-run the whole attempt by re-invoking the generator factory. Re-running
 * queryModel() is a clean re-send: every per-request value is a fresh local, so
 * there is nothing to reset by hand. Each attempt arms its own watchdog timers,
 * so the backoff never counts against an attempt's idle or max-duration budget.
 *
 * Re-sends back off like withRetry (getRetryDelay) within the budget of the
 * failure's kind (getMaxStreamRetries), then surface the original error.
 *
 * Safe against the double-tool-execution hazard (#766 / inc-4258): queryModel
 * holds completed blocks — local tool_use included — until the response
 * completes, and only throws RetriableStreamError while nothing was committed
 * and no server-side tool work began. As a backstop, an attempt that already
 * yielded an assistant message is never replayed.
 *
 * A failed attempt may already have yielded raw stream_event partials. Before
 * retrying, emit a bounded recovery signal so streaming consumers discard that
 * attempt instead of appending the next attempt to stale text/tool JSON, then a
 * retry status for the backoff wait.
 */
export async function* withStreamRetry(
  attempt: () => AsyncGenerator<StreamQueryMessage, void>,
  model: string,
  messages: Message[],
  { signal, sleep: wait = sleep }: StreamRetryOptions = {},
): AsyncGenerator<StreamQueryMessage, void> {
  // Wall-clock ceiling for the whole loop (fork customization): the retry
  // count bounds fast-failing transients, but a provider that accepts the
  // request then hangs ~30s before returning an empty stream turns "4
  // retries" into minutes of dead-silent UI. Defaults to 60s; 0 disables.
  const budgetMs = getStreamTransientRetryBudgetMs();
  const startedAt = Date.now();
  for (let retries = 0; ; retries++) {
    let committedOutput = false;
    try {
      for await (const message of attempt()) {
        if (message.type === "assistant") committedOutput = true;
        yield message;
      }
      return;
    } catch (error) {
      if (!(error instanceof RetriableStreamError)) {
        throw error;
      }
      const maxRetries = getMaxStreamRetries(error.kind);
      // Stop when the retry count is spent OR the wall-clock budget is used
      // up, so a slow-failing upstream surfaces its error in bounded time.
      const elapsedMs = Date.now() - startedAt;
      const overBudget = budgetMs > 0 && elapsedMs >= budgetMs;
      if (committedOutput || retries >= maxRetries || overBudget) {
        // Surface the original error as an assistant message, matching
        // queryModel's normal terminal-error behavior.
        logForDebugging(
          committedOutput
            ? `Mid-stream ${error.kind} error after the attempt committed output; not replaying: ${errorMessage(
                error.originalError,
              )}`
            : overBudget
              ? `Mid-stream ${error.kind} error: retry budget ${budgetMs}ms exhausted after ${retries + 1} attempt(s), ${elapsedMs}ms elapsed: ${errorMessage(
                  error.originalError,
                )}`
              : `Mid-stream ${error.kind} error: retries exhausted after ${maxRetries} attempt(s): ${errorMessage(
                  error.originalError,
                )}`,
          { level: "error" },
        );
        logEvent("tengu_stream_transient_retry_exhausted", {
          attempts: retries,
          model:
            model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          kind:
            error.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        for (const bufferedMessage of error.bufferedMessages) {
          yield bufferedMessage;
        }
        yield getAssistantMessageFromError(error.originalError, model, {
          messages,
          streamRetries: retries,
        });
        return;
      }
      const retryAttempt = retries + 1;
      let delayMs = getRetryDelay(retryAttempt);
      // Don't sleep past the wall-clock budget: a full backoff here would just
      // burn the remaining time on a wait whose next attempt we'd immediately
      // abandon at the top of the loop. Clamp so the final attempt still runs.
      if (budgetMs > 0) {
        const remainingMs = budgetMs - (Date.now() - startedAt);
        delayMs = Math.max(0, Math.min(delayMs, remainingMs));
      }
      logForDebugging(
        `Mid-stream ${error.kind} error, retrying in ${Math.round(delayMs)}ms (attempt ${retryAttempt}/${maxRetries}): ${errorMessage(
          error.originalError,
        )}`,
        { level: "warn" },
      );
      logEvent("tengu_stream_transient_retry", {
        attempt: retryAttempt,
        delayMs,
        model:
          model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        kind:
          error.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      // Raw deltas from the failed attempt may already be visible. Consumers
      // use this bounded retry signal to discard only that in-flight attempt.
      yield createSystemStreamingFallbackMessage("stream_retry");
      yield createSystemAPIErrorMessage(
        toRetryStatusError(error.originalError),
        delayMs,
        retryAttempt,
        maxRetries,
      );
      await wait(delayMs, signal);
      // An interrupt during the wait is the user's, not a stream fault: stop
      // quietly and let the caller handle it, as queryModel does for aborts.
      if (signal?.aborted) return;
    }
  }
}

/** Retry status messages carry an APIError; transport faults are bare Errors. */
function toRetryStatusError(error: unknown): APIError {
  if (error instanceof APIError) return error;
  return new APIConnectionError({
    message: errorMessage(error),
    cause: error instanceof Error ? error : undefined,
  });
}
