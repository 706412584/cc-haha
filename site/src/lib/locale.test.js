import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeStoredLocale, prefersChinese, resolveRootRedirect } from './locale.js'

describe('prefersChinese', () => {
  it('认所有中文变体', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh-Hant-TW', 'ZH-cn']) {
      assert.equal(prefersChinese([tag]), true, tag)
    }
  })

  it('不把 zh 开头的其他语言当中文', () => {
    // zhuang（壮语）真实存在于 BCP-47，前缀匹配写松了会误判。
    assert.equal(prefersChinese(['zha']), false)
    assert.equal(prefersChinese(['zhuang']), false)
  })

  it('列表里任意一项是中文就算中文', () => {
    assert.equal(prefersChinese(['en-US', 'zh-CN']), true)
    assert.equal(prefersChinese(['en-US', 'ja', 'ko']), false)
  })

  it('输入不是数组或含脏值时不炸', () => {
    assert.equal(prefersChinese(undefined), false)
    assert.equal(prefersChinese(null), false)
    assert.equal(prefersChinese([]), false)
    assert.equal(prefersChinese([null, undefined, 42, ' zh-CN ']), true)
  })
})

describe('normalizeStoredLocale', () => {
  it('只接受 zh / en', () => {
    assert.equal(normalizeStoredLocale('zh'), 'zh')
    assert.equal(normalizeStoredLocale('en'), 'en')
    assert.equal(normalizeStoredLocale('fr'), null)
    assert.equal(normalizeStoredLocale(''), null)
    assert.equal(normalizeStoredLocale(null), null)
  })
})

describe('resolveRootRedirect', () => {
  it('中文浏览器留在中文站', () => {
    assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname: '/' }), null)
  })

  it('非中文浏览器跳英文站', () => {
    assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname: '/' }), '/en')
    assert.equal(resolveRootRedirect({ languages: ['ja-JP'], pathname: '/' }), '/en')
  })

  it('拿不到浏览器语言时按英文兜底', () => {
    assert.equal(resolveRootRedirect({ languages: [], pathname: '/' }), '/en')
    assert.equal(resolveRootRedirect({ pathname: '/' }), '/en')
  })

  it('根路径的尾斜杠和空串都算根', () => {
    for (const pathname of ['/', '', '//']) {
      assert.equal(resolveRootRedirect({ languages: ['en'], pathname }), '/en', JSON.stringify(pathname))
    }
  })

  it('只动根路径，带前缀的地址一概不碰', () => {
    // 这是整个功能的安全边界：英文用户点开中文文档不该被踢走，反之亦然。
    const cases = ['/en', '/en/', '/start', '/en/start', '/desktop/pets', '/internals']
    for (const pathname of cases) {
      assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname }), null, pathname)
      assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname }), null, pathname)
    }
  })

  it('记住的偏好优先于浏览器语言', () => {
    // 中文浏览器手动切到英文后，回首页不该被弹回中文，否则切换器等于没用。
    assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname: '/', stored: 'en' }), '/en')
    assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname: '/', stored: 'zh' }), null)
  })

  it('偏好是脏值时退回浏览器语言', () => {
    assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname: '/', stored: 'garbage' }), null)
    assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname: '/', stored: '' }), '/en')
  })
})
