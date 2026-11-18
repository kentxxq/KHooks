import { BlockList, isIPv4 } from 'node:net'
import { expect, it } from 'vitest'
import { probe } from '../src/main/network'
import { createSiteConfig, siteId, sites, type SiteConfig } from '../src/shared/workflow'

// 排除 IANA 标为不可全球到达的特殊用途网段、已废弃的中继网段及组播地址。
const nonPublicIpv4 = new BlockList()
const nonPublicSubnets = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const
for (const [address, prefix] of nonPublicSubnets) nonPublicIpv4.addSubnet(address, prefix)

const siteConfigs = siteId.options.flatMap((id) => {
  const site = sites[id]
  const configs: SiteConfig[] = []
  if ('text' in site) configs.push(createSiteConfig(id, 'text'))
  if ('json' in site) configs.push(createSiteConfig(id, 'json'))
  return configs.map((config) => ({ ...config, name: site.name }))
})

it.concurrent.each(siteConfigs)('$name（$mode）返回公网 IPv4', async ({ id, mode, path }) => {
  const { ip, error } = await probe({ id, mode, path })
  if (!ip || !isIPv4(ip)) throw new Error(error ?? '站点未返回有效 IPv4')

  // 这两个任播地址可全球到达，属于 192.0.0.0/24 的例外。
  const publiclyReachable = ip === '192.0.0.9' || ip === '192.0.0.10' || !nonPublicIpv4.check(ip)
  expect(publiclyReachable, `站点返回非公网 IPv4：${ip}`).toBe(true)
}, 10_000)
