import type { UIMessage } from '../types/chat'

export type TurnCompletion = {
  /** 这一轮最后一条消息的时间，也就是「这轮到此结束」的时刻。 */
  completedAt: number
  /** 用户提示词发出到该轮结束的耗时；起止时间不可信时缺省。 */
  durationMs?: number
}

/**
 * 超过一天的「耗时」不是真实等待：历史里跨天的轮次多半是会话中断后
 * 又接上的，把 18 小时当成模型跑了 18 小时会误导人。
 */
const MAX_PLAUSIBLE_TURN_MS = 24 * 60 * 60 * 1000

type OpenTurn = {
  startedAt: number
  completedAt: number
  lastAssistantTextId: string | null
  /** 最后一条助手文本之后是否还有实质内容（有的话这轮不是以回复收尾的）。 */
  hasWorkAfterLastReply: boolean
}

function isTurnStart(message: UIMessage): boolean {
  // pending 是队友会话的占位、optimisticQueued 是还没轮到发送的排队消息：
  // 两者都还没开始跑，把它们当轮次起点会让上一轮被提前判定成「已完成」。
  return (
    message.type === 'user_text' &&
    message.pending !== true &&
    message.optimisticQueued !== true
  )
}

/**
 * 这两种是挂在回合尾巴上的附加卡片，不是回合本身的进展：任务小结由下一次
 * 发送时补写，后台任务是脱离主回合跑的。它们跟在最终回复后面不妨碍这一轮
 * 已经答完。
 */
function isTrailingCard(message: UIMessage): boolean {
  return message.type === 'task_summary' || message.type === 'background_task'
}

/**
 * 算出每一轮的结束时刻，挂到该轮收尾的那条助手回复上。
 *
 * 一轮 = 一条用户提示词到下一条用户提示词之间的全部消息。只有以助手回复收尾
 * 的轮次才算完成 —— 如果最后那条回复后面还跟着工具调用，说明助手说完话又接着
 * 干活了，「完成」两个字挂在半路上的一句过渡语下面既不对也很怪。
 *
 * `turnActive` 为真时最后一轮不产出：它还在跑，此刻的「完成时间」是假的。
 */
export function buildTurnCompletionByMessageId(
  messages: UIMessage[],
  options: { turnActive?: boolean } = {},
): Map<string, TurnCompletion> {
  const completions = new Map<string, TurnCompletion>()
  const turns: OpenTurn[] = []
  let current: OpenTurn | null = null

  for (const message of messages) {
    if (isTurnStart(message)) {
      const startedAt = Number.isFinite(message.timestamp) ? message.timestamp : Number.NaN
      current = {
        startedAt,
        completedAt: startedAt,
        lastAssistantTextId: null,
        hasWorkAfterLastReply: false,
      }
      turns.push(current)
      continue
    }

    // 首条用户提示词之前的消息不属于任何一轮，没有起点也就没有耗时。
    if (!current) continue
    if (isTrailingCard(message)) continue

    if (Number.isFinite(message.timestamp)) {
      current.completedAt = Number.isFinite(current.completedAt)
        ? Math.max(current.completedAt, message.timestamp)
        : message.timestamp
    }
    if (message.type === 'assistant_text') {
      current.lastAssistantTextId = message.id
      current.hasWorkAfterLastReply = false
    } else {
      current.hasWorkAfterLastReply = true
    }
  }

  const lastTurnIndex = turns.length - 1
  turns.forEach((turn, index) => {
    if (options.turnActive === true && index === lastTurnIndex) return
    if (!turn.lastAssistantTextId || turn.hasWorkAfterLastReply) return
    if (!Number.isFinite(turn.completedAt)) return

    const durationMs = turn.completedAt - turn.startedAt
    const plausible = Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= MAX_PLAUSIBLE_TURN_MS
    completions.set(turn.lastAssistantTextId, {
      completedAt: turn.completedAt,
      ...(plausible ? { durationMs } : {}),
    })
  })

  return completions
}
