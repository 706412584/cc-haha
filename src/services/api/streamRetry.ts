import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamingFallbackMessage,
} from "../../types/message.js";
import { logForDebugging } from "../../utils/debug.js";
import { errorMessage } from "../../utils/errors.js";
import { createSystemStreamingFallbackMessage } from "../../utils/messages.js";
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from "../analytics/index.js";
import { getAssistantMessageFromError } from "./errors.js";
import {
  getMaxStreamTransientRetries,
  RetriableStreamError,
} from "./withRetry.js";

/** Messages a streaming query attempt can emit. Mirrors queryModel's yield type. */
type StreamQueryMessage =
  | StreamEvent
  | AssistantMessage
  | SystemAPIErrorMessage
  | SystemStreamingFallbackMessage;

/**
 * Wrap a single streaming query attempt with transient mid-stream retries.
 *
 * Mid-stream transient errors — a malformed tool_call a local provider rejects,
 * or an upstream api_error/overloaded_error SSE event — arrive inside the 200
 * SSE body, so they never reach withRetry (which only guards stream creation).
 * queryModel() detects them via isRetryableStreamError and throws
 * RetriableStreamError; here we catch it and re-run the whole attempt by
 * re-invoking the generator factory. Re-running queryModel() is a clean re-send:
 * every per-request value is a fresh local, so there is nothing to reset by hand.
 *
 * Safe against the double-tool-execution hazard (#766 / inc-4258): queryModel
 * buffers completed thinking/text and only throws RetriableStreamError before a
 * local tool block completes or server-side tool activity starts.
 *
 * A failed attempt may already have yielded raw stream_event partials. Before
 * retrying, emit a bounded recovery signal so streaming consumers discard that
 * attempt instead of appending the next attempt to stale text/tool JSON.
 */
export async function* withStreamRetry(
  attempt: () => AsyncGenerator<StreamQueryMessage, void>,
  model: string,
  messages: Message[],
): AsyncGenerator<StreamQueryMessage, void> {
  const maxRetries = getMaxStreamTransientRetries();
  for (let i = 0; ; i++) {
    try {
      yield* attempt();
      return;
    } catch (error) {
      if (!(error instanceof RetriableStreamError)) {
        throw error;
      }
      if (i >= maxRetries) {
        // Retries exhausted — surface the original error as an assistant
        // message, matching queryModel's normal terminal-error behavior.
        logForDebugging(
          `Transient mid-stream error: retries exhausted after ${maxRetries} attempt(s): ${errorMessage(
            error.originalError,
          )}`,
          { level: "error" },
        );
        logEvent("tengu_stream_transient_retry_exhausted", {
          attempts: maxRetries,
          model:
            model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        yield getAssistantMessageFromError(error.originalError, model, {
          messages,
        });
        return;
      }
      logForDebugging(
        `Transient mid-stream error, retrying (attempt ${i + 1}/${maxRetries}): ${errorMessage(
          error.originalError,
        )}`,
        { level: "warn" },
      );
      logEvent("tengu_stream_transient_retry", {
        attempt: i + 1,
        model:
          model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      // Raw deltas from the failed attempt may already be visible. Consumers
      // use this bounded retry signal to discard only that in-flight attempt.
      yield createSystemStreamingFallbackMessage("stream_retry");
    }
  }
}
