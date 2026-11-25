<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useAttrs, useTemplateRef, watch } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import { Extension, type JSONContent } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/vue-3'
import { exactFieldRef, formatFieldRef, replaceFieldRefs } from '../../../shared/workflow'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  id: string
  label: string
  fields: { id: string; label: string }[]
  readonly: boolean
  rows?: number
  maxlength?: number
  fieldPath?: boolean
  expandable?: boolean
}>()
const value = defineModel<string>({ required: true })
const attrs = useAttrs()
const toast = useToast()
const editorRef = useTemplateRef<{ editor?: Editor }>('editorRef')
const modalTarget = useTemplateRef<HTMLElement>('modalTarget')
const expanded = ref(false)
const labels = computed(() => new Map(props.fields.map(({ id, label }) => [id, label])))
const content = shallowRef(toDocument(value.value))
const appendMenu = () => (expanded.value && modalTarget.value?.closest<HTMLElement>('[role="dialog"]')) || document.body
const filterFields = ['label', 'id']
const suggestions = computed(() => ({
  allowedPrefixes: null,
  allow: ({ state, range }: { state: Editor['state']; range: { from: number; to: number } }) =>
    !props.fieldPath || (range.from === 1 && range.to === state.doc.content.size - 1)
}))

function mention(id: string): JSONContent {
  return { type: 'mention', attrs: { id, label: labels.value.get(id) ?? id } }
}

function toDocument(template: string): JSONContent {
  let line: JSONContent[] = []
  const paragraphs: JSONContent[] = [{ type: 'paragraph', content: line }]
  function appendText(text: string): void {
    for (const part of text.split(/(\r\n|\r|\n)/)) {
      if (part === '\r\n' || part === '\r' || part === '\n') {
        line = []
        paragraphs.push({ type: 'paragraph', attrs: { lineEnding: part }, content: line })
      } else if (part) line.push({ type: 'text', text: part })
    }
  }
  if (props.fieldPath) {
    if (labels.value.has(template)) line.push(mention(template))
    else appendText(template)
  } else {
    let cursor = 0
    replaceFieldRefs(template, (id, expression, offset) => {
      appendText(template.slice(cursor, offset))
      line.push(mention(id))
      cursor = offset + expression.length
      return expression
    })
    appendText(template.slice(cursor))
  }
  return { type: 'doc', content: paragraphs }
}

function toValue(doc: JSONContent): string {
  return (doc.content ?? [])
    .map((paragraph, index) => {
      const prefix = index ? (paragraph.attrs?.lineEnding ?? '\n') : ''
      return (
        prefix +
        (paragraph.content ?? [])
          .map((node) => {
            if (node.type === 'hardBreak') return '\n'
            if (node.type === 'mention') {
              const id = String(node.attrs?.id ?? '')
              return props.fieldPath ? id : formatFieldRef(id)
            }
            return node.text ?? ''
          })
          .join('')
      )
    })
    .join('')
}

const variableDocument = Extension.create({
  name: 'variableDocument',
  addGlobalAttributes() {
    // 段落保存原换行符，避免编辑文件内容时改写其他行。
    return [
      { types: ['paragraph'], attributes: { lineEnding: { default: null, rendered: false, keepOnSplit: false } } }
    ]
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction(transaction, state) {
          if (!transaction.docChanged || props.maxlength === undefined) return true
          const length = toValue(transaction.doc.toJSON()).length
          if (length <= props.maxlength || length < toValue(state.doc.toJSON()).length) return true
          toast.add({ title: props.label + '超过长度上限', color: 'error' })
          return false
        }
      })
    ]
  }
})
const extensions = [variableDocument]

const editorProps: NonNullable<Editor['options']['editorProps']> = {
  attributes: {
    id: props.id,
    role: 'textbox',
    'aria-label': props.label,
    'aria-multiline': String(Boolean(props.rows)),
    'aria-readonly': String(props.readonly),
    style: '--variable-rows: ' + (props.rows ?? 1)
  },
  handleDOMEvents: {
    blur() {
      content.value = toDocument(value.value)
      return false
    }
  },
  handleKeyDown(_view, event) {
    return !props.rows && event.key === 'Enter' && !event.isComposing
  },
  handlePaste(view, event) {
    const clipboard = event.clipboardData?.getData('text/plain')
    if (!clipboard) return Boolean(event.clipboardData)
    let pasted = props.rows ? clipboard : clipboard.replace(/[\r\n]/g, '')
    if (props.fieldPath) pasted = exactFieldRef(pasted) ?? pasted
    const doc = view.state.schema.nodeFromJSON(toDocument(pasted))
    view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 1, 1)).scrollIntoView())
    return true
  },
  clipboardTextSerializer(slice) {
    return toValue({ type: 'doc', content: slice.content.toJSON() ?? [] })
  }
}

watch(value, (updated) => {
  if (updated !== toValue(content.value)) content.value = toDocument(updated)
})
watch(labels, () => {
  content.value = toDocument(value.value)
})
watch([() => editorRef.value?.editor, () => props.readonly], ([editor, readonly]) => {
  if (!editor) return
  editor.setEditable(!readonly, false)
  editor.view.dom.setAttribute('aria-readonly', String(readonly))
})
watch(modalTarget, async (target) => {
  if (!target || props.readonly) return
  await nextTick()
  if (expanded.value) editorRef.value?.editor?.commands.focus(undefined, { scrollIntoView: false })
})

function edit(document: JSONContent): void {
  content.value = document
  value.value = toValue(document)
}
</script>

<template>
  <div v-if="expandable" class="section-row">
    <label @click="editorRef?.editor?.commands.focus()">{{ label }}</label>
    <UModal v-model:open="expanded" :title="label" :ui="{ content: 'sm:max-w-3xl' }">
      <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-maximize-2" :aria-label="'放大' + label" />
      <template #close="{ ui }">
        <UButton color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="'关闭' + label" :class="ui.close()" />
      </template>
      <template #body><div ref="modalTarget" /></template>
    </UModal>
  </div>
  <Teleport :to="modalTarget ?? 'body'" :disabled="!expanded || !modalTarget">
    <UEditor
      v-slot="{ editor }"
      ref="editorRef"
      :model-value="content"
      content-type="json"
      :starter-kit="false"
      :image="false"
      :extensions="extensions"
      :editable="!readonly"
      :mention="{ deleteTriggerWithBackspace: true }"
      :editor-props="editorProps"
      class="variable-input"
      :class="[attrs.class, { 'variable-input-single': !rows, 'variable-input-expanded': expanded && modalTarget }]"
      @update:model-value="edit"
    >
      <template v-if="!readonly && fields.length">
        <UEditorMentionMenu
          :editor="editor"
          :items="fields"
          :filter-fields="filterFields"
          :append-to="appendMenu"
          :suggestion="suggestions"
        />
        <UEditorMentionMenu
          :editor="editor"
          :items="fields"
          char="＠"
          plugin-key="fullwidthMentionMenu"
          :filter-fields="filterFields"
          :append-to="appendMenu"
          :suggestion="suggestions"
        />
      </template>
    </UEditor>
  </Teleport>
</template>
