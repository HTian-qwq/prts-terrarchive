import test from 'node:test'
import assert from 'node:assert/strict'
import { mountWebGuidance, webFailureGuidance } from '../src/web-guidance.js'
import { originalQuotation } from '../src/investigation-validation.js'

const failed = text => Object.freeze({isError:true, content:Object.freeze([{type:'text', text}])})

test('new structured and legacy text web errors provide distinct, secret-free recovery', () => {
  const legacy = webFailureGuidance('web_search', failed('DeepSeek search has no API key for "DEEPSEEK_API_KEY"'))
  const modern = webFailureGuidance('web_search', {isError:true, error:{info:{code:'WEB_PROVIDER_CREDENTIAL_MISSING'}}, content:[]})
  assert.deepEqual(modern, legacy)
  assert.match(legacy.guidance, /独立于桌面账号登录/)
  const fetch = webFailureGuidance('web_fetch', failed('web fetch failed: TypeError: fetch failed secret=never-copy'))
  assert.match(fetch.guidance, /单个站点连接失败不能推断整个网络不可用/)
  assert.doesNotMatch(JSON.stringify(fetch), /never-copy/)
  assert.equal(webFailureGuidance('web_fetch', failed('web fetch aborted')), null)
  assert.equal(webFailureGuidance('corpus_read', failed('web fetch failed')), null)
  assert.equal(webFailureGuidance('web_fetch', {isError:false}), null)
})

test('network context is per agent and recovers per origin without mutating official results', () => {
  const hooks = {}, prompts = [], a = {}, b = {}
  mountWebGuidance({on:(name, fn) => {hooks[name] = fn}, systemPrompt:{context:c => prompts.push(c)}})
  const context = agent => prompts[0].text({scope:agent})
  const emit = (agent, url, result) => hooks['tools/result']({agent, name:'web_fetch', arguments:{url}}, result)
  const error = failed('web fetch failed')
  emit(a, 'https://one.example/private?token=never-copy', error)
  emit(a, 'https://two.example/page', error)
  assert.match(context(a), /one.example/)
  assert.doesNotMatch(context(a), /private|never-copy/)
  assert.equal(context(b), '')
  emit(a, 'https://two.example/recovered', {isError:false})
  assert.match(context(a), /one.example/)
  assert.doesNotMatch(context(a), /two.example/)
  emit(a, 'https://one.example/recovered', {isError:false})
  assert.equal(context(a), '')
})

test('NFKC quote equivalence never matches part of an expanded character or removes wording', () => {
  assert.equal(originalQuotation('Ａ，Ⅲ。', 'A,III。'), 'Ａ，Ⅲ。')
  assert.equal(originalQuotation('Ⅲ', 'I'), null)
  assert.equal(originalQuotation('尚未证实', '已证实'), null)
  assert.equal(originalQuotation('天然快子', '天然【快子】'), null)
})


test('network hints remain optional on hosts without dynamic prompt hooks', () => {
  assert.equal(mountWebGuidance({}), false)
  assert.equal(mountWebGuidance({on() {}}), false)
  assert.equal(webFailureGuidance('web_fetch', {isError:true, error:{info:{code:'WEB_PROVIDER_ERROR'}},
    content:[{type:'text', text:'redirect response without Location'}]}), null)
})
