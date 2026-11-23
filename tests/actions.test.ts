import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeAction } from '../src/main/actions'
import { HttpError, contentLimit } from '../src/main/network'
import type { Rule } from '../src/shared/workflow'
import { cleanupResources, jsonResponse, llmResponse, stubFetch, tempDir } from './helpers'

afterEach(cleanupResources)

type Services = Parameters<typeof executeAction>[3]
type Trace = Parameters<typeof executeAction>[4]
const signal = new AbortController().signal

function services(patch: Partial<Services> = {}): Services {
  return {
    fetcher: patch.fetcher ?? (async () => new Response('')),
    ai: patch.ai ?? (() => { throw new Error('请先配置 AI 服务') }),
    notify: patch.notify ?? (() => {})
  }
}

const outputs = { start: { n: 5, text: 'hello world', flag: true, obj: { a: 1 }, none: null } }

describe('条件节点', () => {
  it('覆盖字符串、数值、存在性与文本运算符', async () => {
    const cases: { field: string; operator: Rule['operator']; value: string; expected: boolean }[] = [
      { field: 'start.text', operator: 'eq', value: '"hello world"', expected: true },
      { field: 'start.text', operator: 'ne', value: '"other"', expected: true },
      { field: 'start.n', operator: 'gt', value: '4', expected: true },
      { field: 'start.n', operator: 'gte', value: '5', expected: true },
      { field: 'start.n', operator: 'lt', value: '5', expected: false },
      { field: 'start.n', operator: 'lte', value: '5', expected: true },
      { field: 'start.flag', operator: 'exists', value: '', expected: true },
      { field: 'start.none', operator: 'exists', value: '', expected: false },
      { field: 'start.text', operator: 'contains', value: '"world"', expected: true },
      { field: 'start.text', operator: 'startsWith', value: '"hello"', expected: true },
      { field: 'start.text', operator: 'endsWith', value: '"world"', expected: true },
      // 数值比较要求两侧都是数字，字符串不会隐式转换。
      { field: 'start.text', operator: 'gt', value: '1', expected: false }
    ]
    for (const item of cases) {
      const result = await executeAction({
        id: 'if', type: 'condition', x: 0, y: 0, field: item.field, operator: item.operator, value: item.value
      }, outputs, signal, services(), {})
      expect(result, `${item.operator} ${item.field}`).toEqual({ matched: item.expected })
    }
  })

  it('按 all 和 any 组合多条规则', async () => {
    const ruleSet = {
      group: {
        match: 'any' as const,
        rules: [
          { field: 'start.n', operator: 'gt' as const, value: '9' },
          { field: 'start.flag', operator: 'eq' as const, value: 'true' }
        ]
      }
    }
    const base = { id: 'if', type: 'condition' as const, x: 0, y: 0, field: '', operator: 'eq' as const, value: '' }
    await expect(executeAction({ ...base, group: ruleSet.group }, outputs, signal, services(), {}))
      .resolves.toEqual({ matched: true })
    await expect(executeAction({
      ...base, group: { match: 'all', rules: ruleSet.group.rules }
    }, outputs, signal, services(), {})).resolves.toEqual({ matched: false })
  })
})

describe('数据节点', () => {
  it('渲染 JSON 模板并保留原值类型', async () => {
    const value = await executeAction({
      id: 'set', type: 'data', x: 0, y: 0, value: '{"n":"{{start.n}}","label":"IP {{start.text}}"}'
    }, outputs, signal, services(), {})
    expect(value).toEqual({ value: { n: 5, label: 'IP hello world' } })
  })

  it('按 keep/text/number/boolean 转换映射字段', async () => {
    const value = await executeAction({
      id: 'set', type: 'data', x: 0, y: 0, value: 'null',
      mapping: [
        { key: 'n', value: '{{start.n}}', convert: 'number' },
        { key: 'text', value: '{{start.obj}}', convert: 'text' },
        { key: 'flag', value: '1', convert: 'boolean' },
        { key: 'keep', value: '{{start.obj}}', convert: 'keep' }
      ]
    }, outputs, signal, services(), {})
    expect(value).toEqual({ value: { n: 5, text: '{"a":1}', flag: true, keep: { a: 1 } } })
  })

  it('拒绝无效 JSON、缺失字段和无法转换的值', async () => {
    await expect(executeAction({ id: 'set', type: 'data', x: 0, y: 0, value: 'not json' }, outputs, signal, services(), {}))
      .rejects.toThrow()
    await expect(executeAction({
      id: 'set', type: 'data', x: 0, y: 0, value: '{"n":"{{start.missing}}"}'
    }, outputs, signal, services(), {})).rejects.toThrow('上游字段不存在')
    await expect(executeAction({
      id: 'set', type: 'data', x: 0, y: 0, value: 'null',
      mapping: [{ key: 'n', value: '"abc"', convert: 'number' }]
    }, outputs, signal, services(), {})).rejects.toThrow('无法转换为数字')
    await expect(executeAction({
      id: 'set', type: 'data', x: 0, y: 0, value: 'null',
      mapping: [{ key: 'b', value: '"maybe"', convert: 'boolean' }]
    }, outputs, signal, services(), {})).rejects.toThrow('无法转换为布尔值')
  })
})

describe('延时节点', () => {
  it('等待后返回秒数', async () => {
    const started = Date.now()
    await expect(executeAction({ id: 'wait', type: 'delay', x: 0, y: 0, seconds: 1 }, {}, signal, services(), {}))
      .resolves.toEqual({ seconds: 1 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('收到中断信号立即结束', async () => {
    const controller = new AbortController()
    const pending = executeAction({ id: 'wait', type: 'delay', x: 0, y: 0, seconds: 86400 }, {}, controller.signal, services(), {})
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})

describe('HTTP 节点', () => {
  it('渲染地址、请求头和 JSON 正文并限制响应头', async () => {
    const fetcher = stubFetch(() => jsonResponse({ ok: true }, {
      headers: { 'set-cookie': 'fake_secret', 'x-trace': '1' }
    }))
    const trace: Trace = {}
    const result = await executeAction({
      id: 'send', type: 'http', x: 0, y: 0, method: 'POST',
      url: '{{start.base}}/call?n={{start.n}}',
      headers: [{ name: 'X-Test', value: '{{start.text}}' }],
      body: '{"n":"{{start.n}}","text":"{{start.text}}"}'
    }, { ...outputs, start: { ...outputs.start, base: 'https://fake_url' } }, signal, services({ fetcher }), trace)
    expect(result).toMatchObject({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-trace': '1' },
      body: { ok: true }
    })
    expect(fetcher.calls[0].url.pathname).toBe('/call')
    expect(fetcher.calls[0].url.search).toBe('?n=5')
    expect(fetcher.calls[0].init.method).toBe('POST')
    expect(fetcher.calls[0].init.body).toBe('{"n":5,"text":"hello world"}')
    expect((fetcher.calls[0].init.headers as Headers).get('X-Test')).toBe('hello world')
    expect((fetcher.calls[0].init.headers as Headers).get('Content-Type')).toBe('application/json')
    expect(trace.details).toEqual({ method: 'POST', host: 'fake_url', status: 200 })
  })

  it('记录失败状态并抛出 HttpError', async () => {
    const fetcher = stubFetch(() => new Response(null, { status: 503 }))
    const trace: Trace = {}
    await expect(executeAction({
      id: 'send', type: 'http', x: 0, y: 0, method: 'GET', url: 'https://fake_url/fail', headers: [], body: ''
    }, outputs, signal, services({ fetcher }), trace)).rejects.toBeInstanceOf(HttpError)
    expect(trace.details).toEqual({ method: 'GET', host: 'fake_url', status: 503 })
  })

  it('HEAD 与 204 响应的空正文记录为 null', async () => {
    const head = stubFetch(() => new Response(null, { status: 200 }))
    await expect(executeAction({
      id: 'send', type: 'http', x: 0, y: 0, method: 'HEAD', url: 'https://fake_url/head', headers: [], body: ''
    }, outputs, signal, services({ fetcher: head }), {})).resolves.toMatchObject({ body: null })
    const empty = stubFetch(() => new Response(null, { status: 204 }))
    await expect(executeAction({
      id: 'send', type: 'http', x: 0, y: 0, method: 'GET', url: 'https://fake_url/empty', headers: [], body: ''
    }, outputs, signal, services({ fetcher: empty }), {})).resolves.toMatchObject({ status: 204, body: null })
  })

  it('拒绝超过 256 KB 的响应和无效 JSON 响应', async () => {
    const big = stubFetch(() => new Response('x'.repeat(contentLimit + 1)))
    await expect(executeAction({
      id: 'send', type: 'http', x: 0, y: 0, method: 'GET', url: 'https://fake_url/big', headers: [], body: ''
    }, outputs, signal, services({ fetcher: big }), {})).rejects.toThrow('响应内容过大')
    const broken = stubFetch(() => new Response('not json', { headers: { 'content-type': 'application/json' } }))
    await expect(executeAction({
      id: 'send', type: 'http', x: 0, y: 0, method: 'GET', url: 'https://fake_url/json', headers: [], body: ''
    }, outputs, signal, services({ fetcher: broken }), {})).rejects.toThrow('HTTP 响应不是有效的 JSON')
  })
})

describe('通知节点', () => {
  it('渲染标题和正文并写入运行记录', async () => {
    const notify = vi.fn()
    const trace: Trace = {}
    await expect(executeAction({
      id: 'notify', type: 'notification', x: 0, y: 0, title: 'IP {{start.text}}', body: '数量 {{start.n}}'
    }, outputs, signal, services({ notify }), trace)).resolves.toEqual({ sent: true })
    expect(notify).toHaveBeenCalledWith('IP hello world', '数量 5')
    expect(trace.notification).toEqual({ title: 'IP hello world', body: '数量 5' })
  })

  it('标题为空时失败且不记录通知内容', async () => {
    const trace: Trace = { notification: { title: '旧', body: '旧' } }
    await expect(executeAction({
      id: 'notify', type: 'notification', x: 0, y: 0, title: '  ', body: ''
    }, outputs, signal, services(), trace)).rejects.toThrow('通知标题为空')
    expect(trace.notification).toBeUndefined()
  })
})

describe('文件节点', () => {
  it('读取文本和带 BOM 的 JSON 文件', async () => {
    const dir = await tempDir('node-')
    await writeFile(join(dir, 'a.txt'), 'hello')
    await writeFile(join(dir, 'a.json'), '\uFEFF{"n":1}')
    await expect(executeAction({
      id: 'read', type: 'fileRead', x: 0, y: 0, path: join(dir, 'a.txt'), format: 'text'
    }, {}, signal, services(), {})).resolves.toEqual({ path: join(dir, 'a.txt'), content: 'hello' })
    await expect(executeAction({
      id: 'read', type: 'fileRead', x: 0, y: 0, path: join(dir, 'a.json'), format: 'json'
    }, {}, signal, services(), {})).resolves.toEqual({ path: join(dir, 'a.json'), content: { n: 1 } })
  })

  it('拒绝目录、相对路径、超大文件和缺失文件', async () => {
    const dir = await tempDir('node-')
    await writeFile(join(dir, 'big.txt'), Buffer.alloc(contentLimit + 1, 97))
    await expect(executeAction({
      id: 'read', type: 'fileRead', x: 0, y: 0, path: dir, format: 'text'
    }, {}, signal, services(), {})).rejects.toThrow('请选择普通文件')
    await expect(executeAction({
      id: 'read', type: 'fileRead', x: 0, y: 0, path: 'relative.txt', format: 'text'
    }, {}, signal, services(), {})).rejects.toThrow('文件路径无效')
    await expect(executeAction({
      id: 'read', type: 'fileRead', x: 0, y: 0, path: join(dir, 'big.txt'), format: 'text'
    }, {}, signal, services(), {})).rejects.toThrow('文件内容超过 256 KB')
    await expect(executeAction({
      id: 'read', type: 'fileRead', x: 0, y: 0, path: join(dir, 'missing.txt'), format: 'text'
    }, {}, signal, services(), {})).rejects.toThrow()
  })

  it('写入文本和 JSON，并记录路径与字节数', async () => {
    const dir = await tempDir('node-')
    const textPath = join(dir, 'out.txt')
    const textTrace: Trace = {}
    const bytes = Buffer.byteLength('数量 5')
    await expect(executeAction({
      id: 'save', type: 'fileWrite', x: 0, y: 0, path: textPath, format: 'text', content: '数量 {{start.n}}'
    }, outputs, signal, services(), textTrace)).resolves.toEqual({ path: textPath, bytes })
    expect(await readFile(textPath, 'utf8')).toBe('数量 5')
    expect(textTrace.details).toEqual({ format: 'text', path: textPath })

    const jsonPath = join(dir, 'out.json')
    await executeAction({
      id: 'save', type: 'fileWrite', x: 0, y: 0, path: jsonPath, format: 'json', content: '{"n":"{{start.n}}"}'
    }, outputs, signal, services(), {})
    expect(await readFile(jsonPath, 'utf8')).toBe('{"n":5}')
  })

  it('拒绝无效 JSON 内容与超大写入', async () => {
    const dir = await tempDir('node-')
    await expect(executeAction({
      id: 'save', type: 'fileWrite', x: 0, y: 0, path: join(dir, 'a.json'), format: 'json', content: 'not json'
    }, outputs, signal, services(), {})).rejects.toThrow('文件内容不是有效的 JSON')
    await expect(executeAction({
      id: 'save', type: 'fileWrite', x: 0, y: 0, path: join(dir, 'big.txt'), format: 'text',
      content: 'x'.repeat(contentLimit + 1)
    }, outputs, signal, services(), {})).rejects.toThrow('文件内容超过 256 KB')
  })
})

describe('大模型节点', () => {
  const ai = () => ({ url: 'https://fake_url/v1', model: 'fake_info', key: 'fake_key' })

  it('按 text 和 json 格式返回模型输出', async () => {
    const text = stubFetch(() => llmResponse('hello'))
    const textTrace: Trace = {}
    await expect(executeAction({
      id: 'llm', type: 'llm', x: 0, y: 0, system: 'sys', prompt: '问 {{start.n}}', format: 'text'
    }, outputs, signal, services({ fetcher: text, ai }), textTrace)).resolves.toEqual({ value: 'hello' })
    expect(textTrace.details).toEqual({ format: 'text', model: 'fake_info' })
    expect(text.calls[0].url.pathname).toBe('/v1/chat/completions')
    expect(JSON.parse(String(text.calls[0].init.body))).toMatchObject({
      model: 'fake_info',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '问 5' }]
    })

    const json = stubFetch(() => llmResponse('{"answer":5}'))
    await expect(executeAction({
      id: 'llm', type: 'llm', x: 0, y: 0, system: '', prompt: '给个 JSON', format: 'json'
    }, outputs, signal, services({ fetcher: json, ai }), {})).resolves.toEqual({ value: { answer: 5 } })
    expect(JSON.parse(String(json.calls[0].init.body)).messages).toEqual([
      { role: 'system', content: '只返回一个有效的 JSON 值。' },
      { role: 'user', content: '给个 JSON' }
    ])
  })

  it('拒绝非 JSON 输出、未配置 AI 和空提示', async () => {
    const broken = stubFetch(() => llmResponse('not json'))
    await expect(executeAction({
      id: 'llm', type: 'llm', x: 0, y: 0, system: '', prompt: '给个 JSON', format: 'json'
    }, outputs, signal, services({ fetcher: broken, ai }), {})).rejects.toThrow('模型输出不是有效的 JSON')
    await expect(executeAction({
      id: 'llm', type: 'llm', x: 0, y: 0, system: '', prompt: 'hello', format: 'text'
    }, outputs, signal, services(), {})).rejects.toThrow('请先配置 AI 服务')
    const trace: Trace = {}
    await expect(executeAction({
      id: 'llm', type: 'llm', x: 0, y: 0, system: '', prompt: '  ', format: 'text'
    }, outputs, signal, services({ ai }), trace)).rejects.toThrow('用户提示为空')
    expect(trace.details).toEqual({ format: 'text' })
  })
})
