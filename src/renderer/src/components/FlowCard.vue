<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@xyflow/vue'
import { isTrigger, nodeNames, type FlowNode } from '../../../shared/workflow'
import { nodeIcons } from '../model'

const props = defineProps<{ data: { node: FlowNode; active: boolean; failed: boolean }; selected?: boolean }>()
const name = computed(() => props.data.node.name?.trim())
</script>

<template>
  <div class="flow-card" :class="[data.node.type, { selected, executed: data.active, failed: data.failed }]"
    :data-testid="'node-' + data.node.type">
    <Handle v-if="!isTrigger(data.node)" id="in" type="target" :position="Position.Left" />
    <div class="flow-card-title">
      <span class="node-icon" :class="data.node.type"><UIcon :name="nodeIcons[data.node.type]" mode="svg" /></span>
      <span class="node-titles">
        <span :title="name">{{ name || nodeNames[data.node.type] }}</span>
        <small v-if="name">{{ nodeNames[data.node.type] }}</small>
      </span>
      <UIcon v-if="data.active" class="step-mark" :name="data.failed ? 'i-lucide-circle-x' : 'i-lucide-circle-check'" />
    </div>
    <template v-if="isTrigger(data.node)">
      <div v-if="data.node.type === 'ip'" class="node-detail">{{ data.node.sites.length }} 个站点 · {{ data.node.seconds }} 秒</div>
      <div v-if="data.node.type === 'interval'" class="node-detail">{{ data.node.clock?.time ?? '每 ' + data.node.seconds + ' 秒' }}</div>
      <Handle id="next" type="source" :position="Position.Right" />
    </template>
    <template v-else>
      <div v-if="data.node.type === 'http'" class="node-detail">{{ data.node.method }}</div>
      <div class="branch-labels">
        <!-- 条件节点运行期只按「是/否」出口调度,没有失败出口。 -->
        <template v-if="data.node.type === 'condition'">
          <span class="branch-port">是<Handle id="yes" type="source" :position="Position.Right" /></span>
          <span class="branch-port">否<Handle id="no" type="source" :position="Position.Right" /></span>
        </template>
        <template v-else>
          <span class="branch-port">成功<Handle id="next" type="source" :position="Position.Right" /></span>
          <span class="branch-port">失败<Handle id="error" type="source" :position="Position.Right" /></span>
        </template>
      </div>
    </template>
  </div>
</template>
