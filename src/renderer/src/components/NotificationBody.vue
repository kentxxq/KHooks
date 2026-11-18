<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import { Extension, type JSONContent } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'
import { replaceFieldRefs } from '../../../shared/workflow'

const props = defineProps<{ fields: { id: string; label: string }[]; readonly: boolean }>()
const body = defineModel<string>({ required: true })
const toast = useToast()
const editorRef = useTemplateRef<{ editor?: Editor }>('editorRef')
const modalTarget = useTemplateRef<HTMLElement>('modalTarget')
const expanded = ref(false)
const labels = computed(() => new Map(props.fields.map(({ id, label }) => [id, label])))
const content = shallowRef(toDocument(body.value))
const appendMentionMenu = () => (expanded.value && modalTarget.value?.closest<HTMLElement>('[role="dialog"]')) || document.body

function mention(id: string, label: string): JSONContent {
  return { type: 'mention', attrs: { id, label, mentionSuggestionChar: '@' } }
}

function toDocument(template: string): JSONContent {
  let line: JSONContent[] = []
  const paragraphs: JSONContent[] = [{ type: 'paragraph', content: line }]
  function appendText(text: string): void {
    text.split(/\r\n|\r|\n/).forEach((part, index) => {
      if (index > 0) {
        line = []
        paragraphs.push({ type: 'paragraph', content: line })
      }
      if (part) line.push({ type: 'text', text: part })
    })
  }
  let cursor = 0
  replaceFieldRefs(template, (id, expression, offset) => {
    appendText(template.slice(cursor, offset))
    line.push(mention(id, labels.value.get(id) ?? '不可用的上游字段'))
    cursor = offset + expression.length
    return expression
  })
  appendText(template.slice(cursor))
  return { type: 'doc', content: paragraphs }
}

function toTemplate(doc: JSONContent): string {
  return (doc.content ?? []).map((paragraph) => (paragraph.content ?? []).map((node) => {
    if (node.type === 'hardBreak') return '\n'
    if (node.type === 'mention') {
      const id: unknown = node.attrs?.id
      if (typeof id === 'string' && /^[\w-]+(?:\.[\w-]+)+$/.test(id)) return '{{' + id + '}}'
      return typeof node.attrs?.label === 'string' ? '@' + node.attrs.label : ''
    }
    return node.text ?? ''
  }).join('')).join('\n')
}

const lengthLimit = Extension.create({
  name: 'notificationBodyLength',
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction(transaction) {
        if (!transaction.docChanged || toTemplate(transaction.doc.toJSON()).length <= 1000) return true
        toast.add({ title: '通知正文超过长度上限', color: 'error' })
        return false
      }
    })]
  }
})
const extensions = [lengthLimit]

watch(body, (value) => {
  if (value !== toTemplate(content.value)) content.value = toDocument(value)
})
watch(() => JSON.stringify(props.fields), () => { content.value = toDocument(body.value) })
watch([() => editorRef.value?.editor, () => props.readonly], ([editor, readonly]) => {
  editor?.setEditable(!readonly, false)
})
watch(modalTarget, async (target) => {
  if (!target || props.readonly) return
  await nextTick()
  if (expanded.value) editorRef.value?.editor?.commands.focus(undefined, { scrollIntoView: false })
})

function edit(value: JSONContent): void {
  content.value = value
  body.value = toTemplate(value)
}

function insertReference(id: string): void {
  const label = labels.value.get(id)
  if (label && !props.readonly) editorRef.value?.editor?.chain().focus().insertContent(mention(id, label)).run()
}

defineExpose({ insertReference })
</script>

<template>
  <div class="section-row">
    <label>通知正文</label>
    <UModal v-model:open="expanded" title="通知正文" :ui="{ content: 'sm:max-w-3xl' }">
      <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-maximize-2" aria-label="放大通知正文" />
      <template #close="{ ui }">
        <UButton color="neutral" variant="ghost" icon="i-lucide-x" aria-label="关闭通知正文" :class="ui.close()" />
      </template>
      <template #body>
        <div ref="modalTarget" />
      </template>
    </UModal>
  </div>
  <Teleport :to="modalTarget ?? 'body'" :disabled="!expanded || !modalTarget">
    <UEditor v-slot="{ editor }" ref="editorRef" :model-value="content" content-type="json"
      :starter-kit="false" :image="false" :extensions="extensions" :editable="!readonly"
      :mention="{ deleteTriggerWithBackspace: true }"
      :editor-props="{ attributes: { id: 'notification-body', role: 'textbox', 'aria-multiline': 'true', 'aria-label': '通知正文' } }"
      class="notification-body" :class="{ 'notification-body-expanded': expanded && modalTarget }" @update:model-value="edit">
      <template v-if="!readonly && fields.length">
        <UEditorMentionMenu :editor="editor" :items="fields" :append-to="appendMentionMenu" :suggestion="{ allowedPrefixes: null }" />
        <UEditorMentionMenu :editor="editor" :items="fields" char="＠" plugin-key="fullwidthMentionMenu"
          :append-to="appendMentionMenu" :suggestion="{ allowedPrefixes: null }" />
      </template>
    </UEditor>
  </Teleport>
</template>
