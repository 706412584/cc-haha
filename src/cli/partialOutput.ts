import type { SDKMessage } from 'src/entrypoints/agentSdkTypes.js'
import { extractTextContent } from 'src/utils/messages.js'

export class PrintPartialOutputTracker {
  private responseId: string | undefined
  private responseText = ''
  private responseIsKnownError = false
  private previousResponseText = ''
  private previousResponseIsKnownError = false

  observe(message: SDKMessage): void {
    if (
      (message.type === 'system' &&
        message.subtype === 'compact_boundary') ||
      (message.type === 'user' && message.parent_tool_use_id === null)
    ) {
      this.reset()
      return
    }
    if (
      message.type !== 'assistant' ||
      message.parent_tool_use_id !== null
    ) {
      return
    }

    const text = extractTextContent(message.message.content)
    if (this.responseId !== message.message.id) {
      this.previousResponseText = this.responseText
      this.previousResponseIsKnownError = this.responseIsKnownError
      this.responseId = message.message.id
      this.responseText = ''
      this.responseIsKnownError = false
    }
    this.responseText += text
    this.responseIsKnownError ||=
      message.error !== undefined || text.startsWith('API Error:')
  }

  formatResult(result: string, isError: boolean): string {
    if (!isError) {
      return result
    }

    const partial =
      this.responseText === result &&
      !this.previousResponseIsKnownError &&
      this.previousResponseText &&
      this.previousResponseText !== result
        ? this.previousResponseText
        : ''
    return partial ? `${partial}\n${result}` : result
  }

  formatResultLine(result: string, isError: boolean): string {
    const formatted = this.formatResult(result, isError)
    return formatted.endsWith('\n') ? formatted : `${formatted}\n`
  }

  private reset(): void {
    this.responseId = undefined
    this.responseText = ''
    this.responseIsKnownError = false
    this.previousResponseText = ''
    this.previousResponseIsKnownError = false
  }
}
