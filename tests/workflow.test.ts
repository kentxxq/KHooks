import { describe, expect, it } from 'vitest'
import {
  createNode, evaluate, graphSchema, readField, renderJson, validateConnections, validateWorkflow, zodMessage,
  type Graph, type SiteConfig
} from '../src/shared/workflow'
import { parseIp, tally } from '../src/main/network'

const text: SiteConfig = { id: 'ipify', mode: 'text', path: '' }
const json: SiteConfig = { ...text, mode: 'json', path: '$.data.ip' }

describe('公网 IPv4 解析和投票', () => {
  it('纯文本和 JSONPath 提取同一个有效 IPv4', () => {
    expect(parseIp(' 203.0.113.10\n', text)).toBe('203.0.113.10')
    expect(parseIp('{"data":{"ip":"203.0.113.10"}}', json)).toBe('203.0.113.10')
  })

  it('拒绝 IPv6、多匹配、无匹配及非字符串结果', () => {
    expect(() => parseIp('2001:db8::1', text)).toThrow('有效 IPv4')
    expect(() => parseIp('{"ips":["203.0.113.10","203.0.113.11"]}', { ...json, path: '$.ips[*]' })).toThrow('匹配一个值')
    expect(() => parseIp('{}', json)).toThrow('匹配一个值')
    expect(() => parseIp('{"data":{"ip":123}}', json)).toThrow('有效 IPv4')
    expect(() => parseIp('["203.0.113.10"]', { ...json, path: '$[?(@.length)]' })).toThrow()
  })

  it('采信唯一最高票和单个成功站点，明确区分平票和全失败', () => {
    const first = { id: 'ipify', ip: '203.0.113.10' } as const
    const second = { id: 'aws', ip: '203.0.113.11' } as const
    const third = { id: 'icanhazip', ip: first.ip } as const
    const error = { id: 'aws', error: '超时' } as const
    expect(tally([first, second, third], null, 'time')).toMatchObject({
      results: [first, second, third], distinctIpCount: 2, winnerIp: first.ip, winnerVotes: 2,
      votes: { [first.ip]: 2, [second.ip]: 1 }, previousIp: null
    })
    expect(tally([first, error], second.ip, 'time')).toMatchObject({ winnerIp: first.ip, previousIp: second.ip })
    expect(tally([first, second], first.ip, 'time')).toMatchObject({ winnerIp: null, winnerVotes: 1, previousIp: first.ip })
    expect(tally([error], first.ip, 'time')).toMatchObject({ winnerIp: null, winnerVotes: 0, distinctIpCount: 0 })
  })
})

describe('图校验和字段求值', () => {
  const graph: Graph = {
    name: '条件验证',
    nodes: [
      createNode('manual', 'start', 0, 0),
      { ...createNode('condition', 'condition', 220, 0), type: 'condition', field: 'start.triggeredAt', operator: 'exists', value: '' },
      { ...createNode('http', 'send', 440, 0), type: 'http', method: 'GET', url: 'https://fake_url', headers: [], body: '' }
    ],
    edges: [{ id: 'a', from: 'start', to: 'condition', port: 'next' }, { id: 'b', from: 'condition', to: 'send', port: 'yes' }]
  }

  it('接受合法连线，拒绝汇合、环路和非上游字段', () => {
    expect(validateWorkflow(graph)).toBeUndefined()
    expect(validateConnections({ ...graph, edges: [...graph.edges, { id: 'c', from: 'condition', to: 'send', port: 'no' }] })).toMatch(/一个入口/)
    expect(validateConnections({ ...graph, edges: [...graph.edges.slice(1), { id: 'c', from: 'send', to: 'condition', port: 'next' }] })).toMatch(/环路/)
    const nodes = graph.nodes.map((node) => node.type === 'condition' ? { ...node, field: 'send.status' } : node)
    expect(validateWorkflow({ ...graph, nodes })).toMatch(/上游字段/)
  })

  it('按类型比较并保留 JSON 模板引用的原值类型', () => {
    const node = { id: 'check', type: 'condition', x: 0, y: 0, field: 'start.distinctIpCount', operator: 'gte', value: '2' } as const
    expect(evaluate(node, 2)).toBe(true)
    expect(evaluate(node, 1)).toBe(false)
    expect(evaluate(node, '2')).toBe(false)
    const values = { start: { distinctIpCount: 2, results: [{ ip: '203.0.113.11' }] } }
    expect(readField(values, 'start.constructor')).toBeUndefined()
    expect(renderJson({ count: '{{start.distinctIpCount}}', hint: 'IP {{start.results.0.ip}}' }, values))
      .toEqual({ count: 2, hint: 'IP 203.0.113.11' })
  })
})

describe('配置错误摘要', () => {
  function parse(nodes: unknown[], edges: unknown[] = []): string {
    const result = graphSchema.safeParse({ name: '校验', nodes, edges })
    if (result.success) throw new Error('应当校验失败')
    return zodMessage(result.error)
  }

  it('把首个 schema 问题转成中文路径摘要', () => {
    expect(parse([
      { id: 'start', type: 'manual', x: 0, y: 0 },
      { id: 'timer', type: 'interval', x: 220, y: 0, seconds: 0 }
    ])).toBe('nodes[1].seconds 不能小于 1')
    expect(parse([
      { id: 'start', type: 'manual', x: 0, y: 0 },
      { id: 'save', type: 'fileWrite', x: 220, y: 0, path: 'D:\\tmp\\a.txt', format: 'text', content: 'x'.repeat(262145) }
    ])).toBe('nodes[1].content 不能大于 262144')
    expect(parse([{ id: 1, type: 'manual', x: 0, y: 0 }])).toBe('nodes[0].id 类型无效')
    expect(parse([{ id: '!!', type: 'manual', x: 0, y: 0 }])).toBe('nodes[0].id 格式无效')
    expect(parse([{ id: 'start', type: 'manual', x: 0, y: 0, extra: 1 }])).toContain('包含不支持的字段')
    expect(zodMessage(new Error('boom'))).toBe('格式不正确')
  })
})

describe('运行配置校验', () => {
  const start = createNode('manual', 'start', 0, 0)

  it('拒绝条件节点的失败出口', () => {
    const nodes = [
      start,
      { ...createNode('condition', 'gate', 220, 0), type: 'condition' as const, field: 'start.triggeredAt', operator: 'exists' as const, value: '' },
      { ...createNode('data', 'first', 440, 0), type: 'data' as const, value: '1' },
      { ...createNode('data', 'second', 440, 100), type: 'data' as const, value: '2' }
    ]
    const graph: Graph = {
      name: '条件出口', nodes,
      edges: [
        { id: 'a', from: 'start', to: 'gate', port: 'next' },
        { id: 'yes', from: 'gate', to: 'first', port: 'yes' },
        { id: 'fail', from: 'gate', to: 'second', port: 'error' }
      ]
    }
    expect(validateConnections(graph)).toBe('条件节点没有失败出口')
  })

  it('拒绝含点号的映射字段名', () => {
    const graph: Graph = {
      name: '映射字段',
      nodes: [start, {
        ...createNode('data', 'set', 220, 0), type: 'data' as const, value: 'null',
        mapping: [{ key: 'a.b', value: '1', convert: 'text' as const }]
      }],
      edges: [{ id: 'a', from: 'start', to: 'set', port: 'next' }]
    }
    expect(validateWorkflow(graph)).toBe('映射字段名称不能为空、重复或包含点号')
  })

  it('按 UTF-8 字节拒绝超过 256 KB 的写入内容', () => {
    const graph: Graph = {
      name: '写入限制',
      nodes: [start, {
        ...createNode('fileWrite', 'save', 220, 0), type: 'fileWrite' as const, path: 'D:\\tmp\\a.txt', format: 'json' as const,
        content: '{"text":"' + '中'.repeat(90000) + '"}'
      }],
      edges: [{ id: 'a', from: 'start', to: 'save', port: 'next' }]
    }
    expect(validateWorkflow(graph)).toBe('写入内容超过 256 KB')
  })

  it('拒绝 JSON 格式写入的非法内容', () => {
    const graph: Graph = {
      name: 'JSON 内容',
      nodes: [start, {
        ...createNode('fileWrite', 'save', 220, 0), type: 'fileWrite' as const, path: 'D:\\tmp\\a.json', format: 'json' as const,
        content: 'not json'
      }],
      edges: [{ id: 'a', from: 'start', to: 'save', port: 'next' }]
    }
    expect(validateWorkflow(graph)).toBe('写入文件需要有效的 JSON')
  })
})
