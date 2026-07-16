import { afterEach, describe, expect, it } from 'bun:test'
import {
  buildClientVersion,
  createWechatGetUpdatesErrorHandler,
  extractWechatText,
  isWechatSessionTimeout,
  sendWechatText,
  sendWechatTyping,
} from '../protocol.js'
import { collectWechatMediaCandidates } from '../media.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('WeChat protocol helpers', () => {
  it('classifies getupdates session timeout ret and errcode values', () => {
    expect(isWechatSessionTimeout({ ret: -14 })).toBe(true)
    expect(isWechatSessionTimeout({ errcode: -14 })).toBe(true)
    expect(isWechatSessionTimeout({ ret: 500 })).toBe(false)
    expect(isWechatSessionTimeout({ errcode: 500 })).toBe(false)
  })

  it('emits getupdates session timeout status once and stops retrying', async () => {
    const statuses: unknown[] = []
    let destroyed = 0
    let slept = 0
    const handleError = createWechatGetUpdatesErrorHandler({
      emitStatus: (status) => statuses.push(status),
      destroyTyping: () => { destroyed += 1 },
      sleep: async () => { slept += 1 },
    })

    expect(await handleError({ ret: -14, errmsg: 'session timeout' })).toBe('stop')
    expect(await handleError({ errcode: -14, errmsg: 'session timeout again' })).toBe('stop')

    expect(statuses).toEqual([{ type: 'adapter_status', adapter: 'wechat', status: 'session_timeout', code: -14 }])
    expect(destroyed).toBe(1)
    expect(slept).toBe(0)
  })

  it('keeps retrying ordinary getupdates errors after the existing delay', async () => {
    const statuses: unknown[] = []
    let destroyed = 0
    let slept = 0
    const handleError = createWechatGetUpdatesErrorHandler({
      emitStatus: (status) => statuses.push(status),
      destroyTyping: () => { destroyed += 1 },
      sleep: async (ms) => {
        expect(ms).toBe(3000)
        slept += 1
      },
    })

    expect(await handleError({ ret: 500, errmsg: 'temporary' })).toBe('retry')

    expect(statuses).toEqual([])
    expect(destroyed).toBe(0)
    expect(slept).toBe(1)
  })

  it('encodes iLink client versions like the OpenClaw Weixin plugin', () => {
    expect(buildClientVersion('2.1.7')).toBe((2 << 16) | (1 << 8) | 7)
    expect(buildClientVersion('1.0.11')).toBe(65547)
  })

  it('extracts plain text from WeChat message items', () => {
    expect(extractWechatText([
      { type: 1, text_item: { text: 'hello' } },
    ])).toBe('hello')
  })

  it('extracts voice transcription when text items are absent', () => {
    expect(extractWechatText([
      { type: 3, voice_item: { text: 'voice text' } },
    ])).toBe('voice text')
  })

  it('preserves quoted text context', () => {
    expect(extractWechatText([
      {
        type: 1,
        text_item: { text: 'reply' },
        ref_msg: {
          title: 'quote title',
          message_item: { type: 1, text_item: { text: 'quoted body' } },
        },
      },
    ])).toBe('[引用: quote title | quoted body]\nreply')
  })

  it('collects image and file media candidates from message items', () => {
    expect(collectWechatMediaCandidates([
      {
        type: 2,
        msg_id: 'img-1',
        image_item: {
          aeskey: '00112233445566778899aabbccddeeff',
          media: {
            full_url: 'https://cdn.example.com/image',
            encrypt_query_param: 'enc=1',
          },
        },
      },
      {
        type: 4,
        msg_id: 'file-1',
        file_item: {
          file_name: 'report.pdf',
          media: {
            full_url: 'https://cdn.example.com/file',
            aes_key: Buffer.from('00112233445566778899aabbccddeeff').toString('base64'),
          },
        },
      },
    ])).toMatchObject([
      {
        kind: 'image',
        name: 'wechat-image-img-1.jpg',
        url: 'https://cdn.example.com/image',
      },
      {
        kind: 'file',
        name: 'report.pdf',
        url: 'https://cdn.example.com/file',
        mimeType: 'application/pdf',
      },
    ])
  })

  it('throws when sendmessage returns a non-zero WeChat ret code', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ret: 40001, errmsg: 'bad context_token' }), { status: 200 })) as unknown as typeof fetch

    await expect(sendWechatText({
      baseUrl: 'https://api.example.com',
      token: 'token',
      to: 'user',
      text: 'hello',
      contextToken: 'stale-context',
    })).rejects.toThrow('wechatSendMessage returned 40001: bad context_token')
  })

  it('allows successful sendmessage responses', async () => {
    const requests: string[] = []
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    await sendWechatText({
      baseUrl: 'https://api.example.com',
      token: 'token',
      to: 'user',
      text: 'hello',
      contextToken: 'ctx',
    })

    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!).msg.context_token).toBe('ctx')
  })

  it('throws when sendtyping returns a non-zero WeChat ret code', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ret: 42001, errmsg: 'typing ticket expired' }), { status: 200 })) as unknown as typeof fetch

    await expect(sendWechatTyping({
      baseUrl: 'https://api.example.com',
      token: 'token',
      ilinkUserId: 'user',
      typingTicket: 'ticket',
      status: 'typing',
    })).rejects.toThrow('wechatSendTyping returned 42001: typing ticket expired')
  })
})
