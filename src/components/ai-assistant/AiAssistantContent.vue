<template>
    <div class="flex flex-col flex-1 min-h-0 gap-2 p-3">
        <div
            v-if="!isConfigured || !isEnabled"
            class="text-xs text-warning bg-warning/10 px-2 py-1 rounded"
            v-html="sanitizedSetupHint"
        ></div>
        <div v-else-if="!isConnected" class="text-xs text-dimmed bg-default/30 px-2 py-1 rounded">
            {{ $t("aiDisconnectedHint") }}
        </div>

        <!-- FC data terminal: shows what the AI actually read from the flight controller -->
        <div class="relative rounded-lg border border-neutral-500/30 flex flex-col shrink-0 mt-2">
            <div class="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-neutral-500/20">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="text-xs font-semibold uppercase tracking-wide text-dimmed">{{
                        $t("aiFcTerminalTitle")
                    }}</span>
                    <UBadge size="xs" variant="subtle" :color="fcStatusColor" :label="fcStatusLabel" />
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <UButton
                        :label="$t('aiFcRefresh')"
                        icon="i-lucide-refresh-cw"
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        :loading="fcFetchStatus === 'loading'"
                        :disabled="!isConnected || fcFetchStatus === 'loading'"
                        @click="onRefreshFc"
                    />
                    <UButton
                        :icon="fcTerminalOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        square
                        :aria-label="fcTerminalOpen ? $t('aiFcCollapse') : $t('aiFcExpand')"
                        @click="fcTerminalOpen = !fcTerminalOpen"
                    />
                </div>
            </div>
            <div
                v-show="fcTerminalOpen"
                ref="fcTerminalRef"
                class="ai-fc-terminal font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words overflow-y-auto px-3 py-2 bg-black/80 text-emerald-300/95 dark:bg-black/60"
            >
                <template v-if="fcFetchStatus === 'loading'">{{ $t("aiFcLoading") }}</template>
                <template v-else-if="fcFetchStatus === 'disconnected'">{{ $t("aiFcDisconnected") }}</template>
                <template v-else-if="fcFetchStatus === 'error'"
                    >{{ $t("aiFcError") }}: {{ fcFetchError || $t("aiFcUnknownError") }}</template
                >
                <template v-else-if="fcFetchStatus === 'empty'">
                    {{ $t("aiFcEmpty") }}
                    {{ fcFetchError ? `${$t("aiFcDetail")}: ${fcFetchError}` : "" }}
                    {{ lastFcSummary || "" }}
                </template>
                <template v-else-if="lastFcSummary">{{ lastFcSummary }}</template>
                <template v-else>{{ $t("aiFcIdle") }}</template>
            </div>
        </div>

        <!-- Blackbox analysis terminal: shows the parsed digest JSON the AI actually saw.
             Mirrors the FC terminal styling so the two readouts sit side by side visually. -->
        <div v-if="lastBlackboxDigest" class="relative rounded-lg border border-neutral-500/30 flex flex-col shrink-0">
            <div class="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-neutral-500/20">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="text-xs font-semibold uppercase tracking-wide text-dimmed">{{
                        $t("aiBlackboxTerminalTitle")
                    }}</span>
                    <UBadge size="xs" variant="subtle" color="success" :label="$t(blackboxStatusKey)" />
                    <UBadge
                        v-if="blackboxAxesLabel"
                        size="xs"
                        variant="subtle"
                        color="neutral"
                        :label="blackboxAxesLabel"
                    />
                    <UBadge
                        v-if="lastBlackboxDigest.sample_rate_hz"
                        size="xs"
                        variant="subtle"
                        color="neutral"
                        :label="`${lastBlackboxDigest.sample_rate_hz}Hz`"
                    />
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <UButton
                        :icon="blackboxTerminalOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        square
                        :aria-label="blackboxTerminalOpen ? $t('aiBlackboxCollapse') : $t('aiBlackboxExpand')"
                        @click="blackboxTerminalOpen = !blackboxTerminalOpen"
                    />
                </div>
            </div>
            <div
                v-show="blackboxTerminalOpen"
                ref="blackboxTerminalRef"
                class="ai-fc-terminal font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words overflow-y-auto px-3 py-2 bg-black/80 text-emerald-300/95 dark:bg-black/60"
            >
                {{ blackboxDigestText }}
            </div>
        </div>

        <div class="relative rounded-lg border-2 border-neutral-500/30 flex flex-col flex-1 min-h-0 mt-3">
            <div
                class="flex gap-2 items-center w-fit p-1 px-3 rounded-full text-[13px] font-semibold absolute top-0 left-4 -translate-y-1/2 bg-primary text-black"
            >
                {{ $t("aiConversationTitle") }}
            </div>
            <div
                ref="logRef"
                class="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto p-3 pt-6 pr-1"
                @scroll.passive="onLogScroll"
            >
                <p v-if="!isHistoryLoaded" class="text-sm text-dimmed">{{ $t("aiHistoryLoading") }}</p>
                <p v-else-if="!messages.length" class="text-sm text-dimmed">{{ $t("aiEmptyConversation") }}</p>
                <template v-for="(m, i) in messages" :key="i">
                    <!-- Chain-of-thought sits ABOVE the answer for every assistant turn that has one. -->
                    <div
                        v-if="m.role === 'assistant' && m.reasoning"
                        class="self-start w-full rounded-lg p-0 shrink-0 border border-primary/30 bg-primary/5"
                    >
                        <button
                            type="button"
                            class="flex items-center gap-2 w-full px-2 py-1.5 text-xs font-semibold text-primary"
                            @click="toggleThinking(i)"
                        >
                            <span class="i-lucide-brain"></span>
                            <span>{{ $t("aiThinkingProcess") }}</span>
                            <span class="ml-auto">{{ isThinkingOpen(i) ? "▾" : "▸" }}</span>
                        </button>
                        <div
                            v-show="isThinkingOpen(i)"
                            class="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-3 pb-2 pt-0 max-h-64 overflow-y-auto text-dimmed"
                        >
                            {{ m.reasoning }}
                        </div>
                    </div>
                    <div
                        v-if="m.suggestion && m.suggestion.kind === 'diagnosis'"
                        class="self-start w-full rounded-lg p-2 bg-default/40 shrink-0"
                    >
                        <DiagnosisCard :suggestion="m.suggestion" />
                    </div>
                    <div
                        v-else
                        class="text-sm rounded-lg p-2 max-w-[85%] shrink-0"
                        :class="m.role === 'user' ? 'self-end bg-primary/15' : 'self-start bg-default/40'"
                    >
                        <span class="font-semibold text-xs uppercase text-dimmed">
                            {{ m.role === "user" ? $t("aiRoleUser") : $t("aiRoleAssistant") }}
                        </span>
                        <div class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ m.content }}</div>
                    </div>
                </template>
                <!-- Live reasoning while streaming — always above the live answer bubble. -->
                <div
                    v-if="isBusy && streamingReasoning"
                    class="self-start w-full rounded-lg p-0 shrink-0 border border-primary/30 bg-primary/5"
                >
                    <button
                        type="button"
                        class="flex items-center gap-2 w-full px-2 py-1.5 text-xs font-semibold text-primary"
                        :aria-expanded="thinkingPanelOpen"
                        @click="thinkingPanelOpen = !thinkingPanelOpen"
                    >
                        <span class="i-lucide-brain"></span>
                        <span>{{ $t("aiThinkingProcess") }}</span>
                        <UBadge
                            v-if="!streamingContent"
                            size="xs"
                            variant="subtle"
                            color="primary"
                            :label="$t('aiThinkingInProgress')"
                        />
                        <span class="ml-auto">{{ thinkingPanelOpen ? "▾" : "▸" }}</span>
                    </button>
                    <div
                        v-show="thinkingPanelOpen"
                        class="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-3 pb-2 pt-0 max-h-64 overflow-y-auto text-dimmed"
                    >
                        {{ streamingReasoning }}
                    </div>
                </div>
                <div
                    v-if="isBusy && streamingContent"
                    class="text-sm rounded-lg p-2 max-w-[85%] self-start bg-default/40 shrink-0"
                >
                    <span class="font-semibold text-xs uppercase text-dimmed">{{ $t("aiRoleAssistant") }}</span>
                    <div class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{{ streamingContent }}</div>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 p-3 pt-0 shrink-0">
                <UButton
                    v-if="viewerHasLog && !lastBlackboxDigest"
                    :label="$t('aiBlackboxReadViewer')"
                    icon="i-lucide-book-open-check"
                    :loading="isDigesting"
                    :disabled="isBusy"
                    variant="soft"
                    size="sm"
                    @click="onReadFromViewer"
                />
                <UButton
                    v-else-if="isConnected && dataflashAvailable && !lastBlackboxDigest"
                    :label="isPulling ? `${Math.round(pullProgress)}%` : $t('aiBlackboxReadFC')"
                    icon="i-lucide-download"
                    :loading="isPulling"
                    :disabled="isBusy || isDigesting"
                    variant="outline"
                    size="sm"
                    @click="onReadFromFC"
                />
                <UButton
                    :label="lastBlackboxDigest ? $t('aiBlackboxLoaded') : $t('aiBlackboxUpload')"
                    :icon="lastBlackboxDigest ? 'i-lucide-check-circle' : 'i-lucide-upload'"
                    :loading="isDigesting"
                    :disabled="isBusy || isPulling"
                    :variant="lastBlackboxDigest ? 'soft' : 'outline'"
                    :color="lastBlackboxDigest ? 'success' : 'neutral'"
                    size="sm"
                    @click="onUploadBblClick"
                />
                <UButton
                    v-if="lastBlackboxDigest"
                    icon="i-lucide-trash-2"
                    :aria-label="$t('aiBlackboxClear')"
                    size="sm"
                    variant="ghost"
                    color="neutral"
                    :disabled="isBusy || isDigesting"
                    @click="clearBlackboxDigest"
                />
                <input
                    ref="bblFileInput"
                    type="file"
                    style="display: none"
                    :accept="bblAccept"
                    @change="onBblFileSelected"
                />
                <UButton
                    :label="$t('aiDiagnose')"
                    icon="i-lucide-stethoscope"
                    :loading="isBusy"
                    :disabled="!isConfigured || !isEnabled"
                    variant="soft"
                    size="sm"
                    @click="onDiagnose"
                />
                <UDropdownMenu
                    :items="reasoningEffortItems"
                    :content="{ align: 'start', side: 'top' }"
                    :ui="{ content: 'max-h-72 z-[2100]' }"
                >
                    <UButton
                        :label="reasoningEffortLabel"
                        icon="i-lucide-brain"
                        :color="reasoningEffortColor"
                        :variant="reasoningEffortVariant"
                        :aria-label="$t('aiThinkingEffort')"
                        :disabled="!isConfigured || !isEnabled"
                        size="sm"
                    />
                </UDropdownMenu>
                <UInput
                    v-model="input"
                    :placeholder="$t('aiInputPlaceholder')"
                    :disabled="isBusy"
                    class="flex-1 min-w-[8rem]"
                    size="sm"
                    @keydown.enter.prevent="send"
                />
                <UButton
                    v-if="isConnected"
                    :label="cliMode ? 'CLI ON' : 'CLI'"
                    :icon="cliMode ? 'i-lucide-terminal' : 'i-lucide-terminal-square'"
                    :variant="cliMode ? 'soft' : 'ghost'"
                    :color="cliMode ? 'primary' : 'neutral'"
                    :disabled="isBusy"
                    size="sm"
                    @click="cliMode = !cliMode"
                />
                <UButton
                    :label="$t('aiSend')"
                    :loading="isBusy && !isStreaming"
                    :disabled="!canSend"
                    icon="i-lucide-send"
                    size="sm"
                    @click="send"
                />
                <UButton
                    v-if="isStreaming"
                    :label="$t('aiStop')"
                    icon="i-lucide-octagon-x"
                    color="error"
                    size="sm"
                    @click="cancelStreaming"
                />
                <UButton
                    :label="$t('aiClear')"
                    variant="soft"
                    icon="i-lucide-eraser"
                    :disabled="isBusy || !messages.length"
                    size="sm"
                    @click="resetConversation"
                />
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useTranslation } from "i18next-vue";
import DiagnosisCard from "./DiagnosisCard.vue";
import { useAiAssistant } from "@/composables/ai/useAiAssistant";
import { useBlackboxDigest } from "@/composables/ai/digestBlackbox";
import { useDataflashPull } from "@/composables/useDataflashPull";
import { useDialog } from "@/composables/useDialog";
import { useLogStore } from "@/blackbox-viewer/stores/log";
import bvPinia from "@/blackbox-viewer/pinia_instance";
import { gui_log } from "@/js/gui_log";
import FC from "@/js/fc";

const { t } = useTranslation();

const {
    messages,
    isHistoryLoaded,
    isBusy,
    isStreaming,
    streamingContent,
    streamingReasoning,
    isConnected,
    isConfigured,
    isEnabled,
    lastFcSummary,
    fcFetchStatus,
    fcFetchError,
    lastBlackboxDigest,
    reasoningEffort,
    setReasoningEffort,
    ask,
    cliAsk,
    diagnose,
    cancelStreaming,
    resetConversation,
    refreshFcSnapshot,
    syncSettings,
    setBlackboxDigest,
    clearBlackboxDigest,
} = useAiAssistant();
const { isProcessing: isDigesting, error: digestError, digest, digestBlackboxData } = useBlackboxDigest();
const { pulling: isPulling, progress: pullProgress, available: dataflashAvailable, pull } = useDataflashPull();
const logStore = useLogStore(bvPinia);
const dialog = useDialog();

const viewerHasLog = computed(() => !!logStore.hasLog && logStore.flightLogDataArray instanceof Uint8Array);
const input = ref("");
const logRef = ref(null);
const fcTerminalRef = ref(null);
const blackboxTerminalRef = ref(null);
const fcTerminalOpen = ref(true);
const blackboxTerminalOpen = ref(true);
const thinkingPanelOpen = ref(false); // live stream: collapsed by default, click to expand
// Per-message open state for finished turns. Default collapsed so the conversation reads
// cleanly; expand to inspect the chain-of-thought.
const thinkingOpenMap = ref({});
function isThinkingOpen(i) {
    return thinkingOpenMap.value[i] === true;
}
function toggleThinking(i) {
    thinkingOpenMap.value = { ...thinkingOpenMap.value, [i]: !isThinkingOpen(i) };
}
const bblFileInput = ref(null);
const cliMode = ref(false);
const BBL_EXTENSIONS = [".bbl", ".bfl", ".cfl", ".log", ".txt"];
const bblAccept = BBL_EXTENSIONS.flatMap((e) => [e, e.toUpperCase()]).join(",");
const canSend = computed(() => isEnabled.value && isConfigured.value && !!input.value.trim() && !isBusy.value);

// Sanitize the setup hint: the i18n string contains <b> for emphasis, but locale files are
// contributor-supplied, so strip everything except <b></b> to prevent injected HTML/scripts.
const sanitizedSetupHint = computed(() => {
    const raw = t("aiSetupHint") || "";
    // Decode-then-re-encode: escape everything, then re-allow only <b> and </b>.
    const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return escaped
        .replace(/&lt;b&gt;/g, "<b>")
        .replace(/&lt;\/b&gt;/g, "</b>")
        .replace(/&lt;u&gt;/g, "<u>")
        .replace(/&lt;\/u&gt;/g, "</u>");
});

// Reasoning-effort quick toggle in the conversation footer. Saves a trip to Options when
// the pilot wants to flip between fast (off) and deep (high) thinking per question.
const REASONING_LABEL_KEYS = {
    off: "aiReasoningOff",
    low: "aiReasoningLow",
    medium: "aiReasoningMedium",
    high: "aiReasoningHigh",
};
const reasoningEffortItems = computed(() =>
    ["off", "low", "medium", "high"].map((value) => ({
        label: t(REASONING_LABEL_KEYS[value]),
        icon: reasoningEffort.value === value ? "i-lucide-check" : "i-lucide-circle",
        onSelect: () => setReasoningEffort(value),
    })),
);
const reasoningEffortLabel = computed(() => t(REASONING_LABEL_KEYS[reasoningEffort.value] || "aiReasoningOff"));
// Visual emphasis grows with effort so the button reflects how "deep" the current mode is.
const reasoningEffortColor = computed(() => {
    switch (reasoningEffort.value) {
        case "high":
            return "primary";
        case "medium":
            return "primary";
        case "low":
            return "info";
        default:
            return "neutral";
    }
});
const reasoningEffortVariant = computed(() => (reasoningEffort.value === "off" ? "ghost" : "soft"));

// Pretty-printed digest JSON for the collapsible blackbox terminal.
const blackboxDigestText = computed(() => {
    const d = lastBlackboxDigest.value;
    if (!d) return "";
    try {
        return JSON.stringify(d, null, 2);
    } catch {
        return String(d);
    }
});
const blackboxAxesLabel = computed(() => {
    const d = lastBlackboxDigest.value;
    return d?.axes ? Object.keys(d.axes).join(", ") : "";
});
const blackboxStatusKey = computed(() => {
    const logType = lastBlackboxDigest.value?.log_type;
    return logType === "chirp" ? "aiBlackboxStatusChirp" : "aiBlackboxStatusRegular";
});

const fcStatusColor = computed(() => {
    switch (fcFetchStatus.value) {
        case "ready":
            return "success";
        case "loading":
            return "info";
        case "empty":
        case "error":
            return "warning";
        case "disconnected":
            return "neutral";
        default:
            return "neutral";
    }
});

const fcStatusLabel = computed(() => {
    switch (fcFetchStatus.value) {
        case "ready":
            return t("aiFcStatusReady");
        case "loading":
            return t("aiFcStatusLoading");
        case "empty":
            return t("aiFcStatusEmpty");
        case "error":
            return t("aiFcStatusError");
        case "disconnected":
            return t("aiFcStatusDisconnected");
        default:
            return t("aiFcStatusIdle");
    }
});

async function scrollToBottom() {
    await nextTick();
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight;
}

async function scrollFcTerminalTop() {
    await nextTick();
    if (fcTerminalRef.value) fcTerminalRef.value.scrollTop = 0;
}

async function scrollBlackboxTop() {
    await nextTick();
    if (blackboxTerminalRef.value) blackboxTerminalRef.value.scrollTop = 0;
}

async function onRefreshFc() {
    try {
        await refreshFcSnapshot();
        await scrollFcTerminalTop();
    } catch (e) {
        dialog.openInfo("Error", e.message || String(e));
    }
}

async function send() {
    if (isBusy.value) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
        if (cliMode.value && isConnected.value) {
            await cliAsk(text);
        } else {
            await ask(text);
        }
        await scrollToBottom();
        await scrollFcTerminalTop();
    } catch (e) {
        if (e.name !== "AbortError") dialog.openInfo("Error", e.message || String(e));
    }
}

function onUploadBblClick() {
    bblFileInput.value?.click();
}

async function onBblFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    gui_log(`AI: reading file "${file.name}" (${(file.size / 1024).toFixed(0)} KB)...`);
    try {
        const buf = await file.arrayBuffer();
        const data = new Uint8Array(buf);
        const summary = await digest(data, FC.CONFIG?.apiVersion);
        if (summary) {
            setBlackboxDigest(summary);
            gui_log(
                `AI: blackbox digest OK, log_type=${summary.log_type}, axes=${Object.keys(summary.axes || {}).join(",")}`,
            );
        } else {
            gui_log(`AI: digest returned null. Error: ${digestError.value || "unknown"}`);
            dialog.openInfo("No flight data found", digestError.value || "No usable gyro data in this log.");
        }
    } catch (e) {
        gui_log(`AI: digest exception: ${e.message || e}`);
        dialog.openInfo("Error", e.message || String(e));
    }
}

async function onReadFromFC() {
    try {
        const summary = await digestBlackboxData(await pull(), FC.CONFIG?.apiVersion);
        if (summary) {
            setBlackboxDigest(summary);
            gui_log("Blackbox log loaded.");
        } else dialog.openInfo("No flight data found", digestError.value || "No usable gyro data in dataflash.");
    } catch (e) {
        dialog.openInfo("Error", e.message || String(e));
    }
}

async function onReadFromViewer() {
    const data = logStore.flightLogDataArray;
    if (!data) return;
    try {
        const summary = await digest(data, FC.CONFIG?.apiVersion);
        if (summary) {
            setBlackboxDigest(summary);
            gui_log("Blackbox log loaded.");
        } else dialog.openInfo("No flight data found", digestError.value || "Unable to extract from viewer log.");
    } catch (e) {
        dialog.openInfo("Error", e.message || String(e));
    }
}

async function onDiagnose() {
    try {
        // Keep the digest after diagnosing: a pilot often wants to re-run with a different
        // temperature / model, or follow up with a chat question about the same log. The digest
        // stays in the store until they upload a new one or clear it explicitly.
        await diagnose(lastBlackboxDigest.value || undefined);
        await scrollToBottom();
        await scrollFcTerminalTop();
    } catch (e) {
        dialog.openInfo("Error", e.message || String(e));
    }
}

defineExpose({ syncSettings, scrollToBottom, refreshFcSnapshot });

// Auto-refresh FC snapshot when connected and panel opens / connection appears.
onMounted(() => {
    if (isConnected.value) {
        refreshFcSnapshot().catch(() => {});
    }
});
watch(isConnected, (connected) => {
    if (connected) {
        refreshFcSnapshot().catch(() => {});
    }
});
watch(lastFcSummary, () => {
    scrollFcTerminalTop();
});
watch(blackboxDigestText, () => {
    scrollBlackboxTop();
});

// During streaming, auto-scroll only if the user is already at the bottom
let _autoScroll = true;
function onLogScroll() {
    const el = logRef.value;
    if (!el) return;
    // If user scrolled up >50px from bottom, disable auto-follow
    _autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
}
watch(streamingContent, () => {
    if (_autoScroll && logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight;
});
</script>

<style scoped>
.ai-log {
    scroll-behavior: smooth;
}
.ai-fc-terminal {
    max-height: 11rem;
    min-height: 4.5rem;
    scrollbar-width: thin;
}
</style>
