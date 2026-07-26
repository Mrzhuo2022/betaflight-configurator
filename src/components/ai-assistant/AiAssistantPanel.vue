<template>
    <USlideover
        v-model:open="open"
        side="right"
        :title="$t('tabAiAssistant')"
        :dismissible="true"
        :ui="{ content: 'sm:max-w-xl w-full' }"
    >
        <template #body>
            <AiAssistantContent ref="contentRef" />
        </template>
    </USlideover>
</template>

<script setup>
import { computed, ref, watch, nextTick } from "vue";
import AiAssistantContent from "./AiAssistantContent.vue";

const props = defineProps({
    modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue"]);

const open = computed({
    get: () => props.modelValue,
    set: (v) => emit("update:modelValue", v),
});

const contentRef = ref(null);

// The panel mounts once and re-opens repeatedly: re-sync settings + scroll to bottom
// on each open so values changed in OptionsDialog since last open take effect.
watch(open, (isOpen) => {
    if (isOpen) {
        nextTick(() => {
            contentRef.value?.syncSettings?.();
            contentRef.value?.scrollToBottom?.();
        });
    }
});
</script>
