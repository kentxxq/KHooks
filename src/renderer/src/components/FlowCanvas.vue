<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import {
  Background, ControlButton, Controls, SelectionMode, VueFlow, type Connection, type Edge, type Node, type VueFlowInstance, type XYPosition
} from '@xyflow/vue'
import type { Run } from '../../../shared/ipc'
import type { FlowNode, Graph } from '../../../shared/workflow'
import FlowCard from './FlowCard.vue'
import { nodeDragType, useDesktop } from '../model'

type CanvasSelection = { nodes: string[]; edges: string[] }
const selection = defineModel<CanvasSelection>('selection', { required: true })
const props = defineProps<{
  graph: Graph; readonly?: boolean; run?: Run; draggedType?: FlowNode['type']; allowSaveComponent?: boolean
}>()
const emit = defineEmits<{
  connect: [connection: Connection]
  move: [positions: { id: string; x: number; y: number }[]]
  dropNode: [type: FlowNode['type'], position: XYPosition]
  paneClick: []
  removeSelection: [selection: CanvasSelection]
  saveComponent: [node: FlowNode]
}>()

const store = useDesktop()
const flowInstance = shallowRef<VueFlowInstance>()
const boxSelectionEnabled = ref(false)
const boxSelecting = computed(() => !props.readonly && boxSelectionEnabled.value)
const menuOpen = ref(false)
const contextSelection = shallowRef<CanvasSelection>()
const menuItems = computed<ContextMenuItem[]>(() => {
  const target = contextSelection.value
  if (!target || !(target.nodes.length || target.edges.length)) return []
  const items: ContextMenuItem[] = []
  if (!props.readonly) {
    items.push({
      label: '删除所选', icon: 'i-lucide-trash-2', color: 'error',
      onSelect: () => emit('removeSelection', target)
    })
  }
  if (props.allowSaveComponent && target.nodes.length === 1 && !target.edges.length) {
    const node = props.graph.nodes.find((item) => item.id === target.nodes[0])
    if (node) items.push({ label: '另存为组件', icon: 'i-lucide-bookmark-plus', onSelect: () => emit('saveComponent', node) })
  }
  return items
})
const fitInitially = props.graph.nodes.length > 0
type CanvasNode = Node<{ node: FlowNode; active: boolean; failed: boolean }>
const nodes = shallowRef<CanvasNode[]>([])
const edges = shallowRef<Edge[]>([])
watch(() => props.graph.nodes.map((node) => {
  const step = props.run?.steps.find((item) => item.nodeId === node.id)
  return {
    id: node.id, type: 'card', position: { x: node.x, y: node.y },
    data: { node, active: Boolean(step), failed: Boolean(step?.error) }
  }
}), (items) => {
  const previous = new Map(nodes.value.map((node) => [node.id, node.measured]))
  nodes.value = items.map((node) => ({
    ...node, measured: previous.get(node.id), selected: selection.value.nodes.includes(node.id)
  }))
}, { immediate: true })
watch(() => props.graph.edges.map((edge): Edge => ({
  id: edge.id, source: edge.from, target: edge.to, sourceHandle: edge.port, targetHandle: 'in',
  class: props.run?.edges.includes(edge.id) ? 'execution-edge' : '',
  type: 'smoothstep'
})), (items) => {
  edges.value = items.map((edge) => ({ ...edge, selected: selection.value.edges.includes(edge.id) }))
}, { immediate: true })

function syncSelection<T extends { id: string; selected?: boolean }>(items: T[], ids: string[]): T[] {
  const isSelected = (item: T) => ids.includes(item.id)
  if (items.every((item) => Boolean(item.selected) === isSelected(item))) return items
  return items.map((item) => ({ ...item, selected: isSelected(item) }))
}

watch(selection, (current) => {
  nodes.value = syncSelection(nodes.value, current.nodes)
  edges.value = syncSelection(edges.value, current.edges)
})

function select(items: { nodes: Node[]; edges: Edge[] }): void {
  selection.value = {
    nodes: items.nodes.map((node) => node.id),
    edges: items.edges.map((edge) => edge.id)
  }
}

function resetContextMenu(): void {
  menuOpen.value = false
  contextSelection.value = undefined
}

function changeContextMenu(open: boolean): void {
  if (open && menuItems.value.length) menuOpen.value = true
  else resetContextMenu()
}

function selectForContextMenu(kind: keyof CanvasSelection, id: string): void {
  if (props.readonly && !props.allowSaveComponent) return
  const current = selection.value
  if (current[kind].includes(id)) {
    contextSelection.value = current
    return
  }
  const target = { nodes: [], edges: [], [kind]: [id] }
  contextSelection.value = target
  selection.value = target
}

function moveNodes(moved: Node[]): void {
  emit('move', moved.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })))
}

function allowDrop(event: DragEvent): void {
  const transfer = event.dataTransfer
  if (props.readonly || !props.draggedType || !transfer?.types.includes(nodeDragType)) return
  event.preventDefault()
  transfer.dropEffect = 'copy'
}

let placingNode = false
async function dropNode(event: DragEvent): Promise<void> {
  const type = props.draggedType
  if (props.readonly || !type || !flowInstance.value || event.dataTransfer?.getData(nodeDragType) !== type) return
  event.preventDefault()
  const position = flowInstance.value.screenToFlowPosition({ x: event.clientX, y: event.clientY })
  placingNode = true
  emit('dropNode', type, position)
  await nextTick()
  placingNode = false
}

watch(() => nodes.value.length, async () => {
  if (placingNode) return
  await nextTick()
  void flowInstance.value?.fitView({ padding: 0.22, maxZoom: 1 })
})
</script>

<template>
  <UContextMenu :open="menuOpen && menuItems.length > 0" :items="menuItems" :disabled="readonly && !allowSaveComponent"
    @update:open="changeContextMenu">
    <div class="canvas" :class="{ 'canvas-box-selection': boxSelecting }" @contextmenu.capture="resetContextMenu"
      @dragover="allowDrop" @drop="dropNode">
      <VueFlow
        v-model:nodes="nodes" v-model:edges="edges" :force-color-mode="store.data?.settings.theme"
        :nodes-draggable="!readonly" :nodes-connectable="!readonly"
        :selection-on-drag="boxSelecting" :selection-mode="SelectionMode.Partial"
        :selection-key-code="null" :pan-activation-key-code="null" :pan-on-drag="readonly ? true : boxSelecting ? [1, 2] : [0, 1, 2]"
        :edges-reconnectable="false" :delete-key-code="null" :min-zoom="0.2" :max-zoom="2"
        :fit-view="fitInitially" :fit-view-options="{ padding: 0.22, maxZoom: 1 }"
        @init="flowInstance = $event" @connect="emit('connect', $event)"
        @selection-change="select"
        @node-context-menu="selectForContextMenu('nodes', $event.node.id)"
        @edge-context-menu="selectForContextMenu('edges', $event.edge.id)"
        @selection-context-menu="contextSelection = selection"
        @pane-click="emit('paneClick')"
        @node-drag-stop="moveNodes($event.nodes)"
      >
        <template #node-card="props"><FlowCard :data="props.data" :selected="props.selected" /></template>
        <Background :gap="22" :size="1.2" />
        <Controls position="bottom-left" :show-interactive="false" :fit-view-options="{ padding: 0.22, maxZoom: 1 }">
          <ControlButton v-if="!readonly" label="框选模式" :aria-pressed="boxSelecting" @click="boxSelectionEnabled = !boxSelectionEnabled">
            <UIcon name="i-lucide-square-dashed-mouse-pointer" mode="svg" />
          </ControlButton>
        </Controls>
      </VueFlow>
      <div v-if="!graph.nodes.length" class="canvas-empty">
        <span class="empty-icon"><UIcon name="i-lucide-workflow" /></span>
        从左侧添加触发器
      </div>
    </div>
  </UContextMenu>
</template>
