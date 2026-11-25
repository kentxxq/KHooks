<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@xyflow/vue'
import { isTrigger, nodeNames, type FlowNode } from '../../../shared/workflow'
import { nodeIcons } from '../model'

const props = defineProps<{ data: { node: FlowNode; active: boolean; failed: boolean }; selected?: boolean }>()
const name = computed(() => props.data.node.name?.trim())
const subtitle = computed(() => {
  const n = props.data.node
  if (n.type === 'ip') return `${n.sites.length} 个站点 · ${n.seconds} 秒`
  if (n.type === 'interval') return n.clock?.time ?? `每 ${n.seconds} 秒`
  if (n.type === 'http') return n.method
  return ''
})
</script>

<template>
  <div
    class="flow-card"
    :class="[data.node.type, { selected, executed: data.active, failed: data.failed, trigger: isTrigger(data.node) }]"
    :data-testid="'node-' + data.node.type"
  >
    <Handle v-if="!isTrigger(data.node)" id="in" type="target" :position="Position.Left" />
    <div class="flow-card-head">
      <span class="node-icon" :class="data.node.type"><UIcon :name="nodeIcons[data.node.type]" mode="svg" /></span>
      <span class="node-titles">
        <span :title="name">{{ name || nodeNames[data.node.type] }}</span>
        <small>{{ name ? nodeNames[data.node.type] : isTrigger(data.node) ? '触发器' : '执行节点' }}</small>
      </span>
      <UIcon v-if="data.active" class="step-mark" :name="data.failed ? 'i-lucide-circle-x' : 'i-lucide-circle-check'" />
    </div>
    <div v-if="subtitle" class="flow-card-meta">{{ subtitle }}</div>
    <Handle v-if="isTrigger(data.node)" id="next" type="source" :position="Position.Right" />
    <div v-else class="flow-card-branches">
      <!-- 条件节点运行期只按「是/否」出口调度,没有失败出口。 -->
      <template v-if="data.node.type === 'condition'">
        <span class="branch-port"><span>是</span><Handle id="yes" type="source" :position="Position.Right" /></span>
        <span class="branch-port"><span>否</span><Handle id="no" type="source" :position="Position.Right" /></span>
      </template>
      <template v-else>
        <span class="branch-port"><span>成功</span><Handle id="next" type="source" :position="Position.Right" /></span>
        <span class="branch-port"><span>失败</span><Handle id="error" type="source" :position="Position.Right" /></span>
      </template>
    </div>
  </div>
</template>
