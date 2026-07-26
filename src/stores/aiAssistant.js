import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { get as getConfig, set as setConfig, remove as removeConfig } from "@/js/ConfigStorage";
import {
    loadHistory as loadHistoryFromDB,
    saveHistory as saveHistoryToDB,
    clearHistory as clearHistoryFromDB,
} from "@/js/AiHistoryDB";

/**
 * AI Assistant store.
 *
 * Holds AI settings (persisted to ConfigStorage, mirroring OptionsDialog's pattern) and
 * the in-memory conversation state (transient, not persisted).
 *
 * Mirrors the setup-style store pattern of stores/log.js and stores/dialog.js: pure refs,
 * no pinia-plugin-persistedstate (the project doesn't use it), persistence is explicit.
 *
 * Config keys (all prefixed `ai_` to match the existing convention seen in
 * `preflight_notam_*` / `expertMode` / `meteredConnection`):
 *   - ai_enabled            boolean  master toggle
 *   - ai_api_key            string   user-supplied LLM API key (OpenAI-compatible)
 *   - ai_base_url           string   OpenAI-compatible endpoint base URL
 *   - ai_model              string   model id (e.g. "gpt-4o", "claude-...-via-proxy")
 *   - ai_temperature        number   sampling temperature, 0..2
 *   - ai_reasoning_effort   string   "off"|"low"|"medium"|"high" (provider-routed)
 */
export const useAiAssistantStore = defineStore("aiAssistant", () => {
    // --- persisted settings ---
    const enabled = ref(!!getConfig("ai_enabled", false).ai_enabled);
    const apiKey = ref(getConfig("ai_api_key", "").ai_api_key || "");
    const baseUrl = ref(
        getConfig("ai_base_url", "https://api.openai.com/v1").ai_base_url || "https://api.openai.com/v1",
    );
    const model = ref(getConfig("ai_model", "gpt-4o").ai_model || "gpt-4o");
    const temperature = ref(getConfig("ai_temperature", 0.2).ai_temperature ?? 0.2);
    const reasoningEffort = ref(getConfig("ai_reasoning_effort", "off").ai_reasoning_effort || "off");

    // --- conversation state (persisted to IndexedDB — no truncation, no limits) ---
    // Previously stored in localStorage (ConfigStorage), which caps at ~5MB total and silently
    // drops saves on quota overflow — that's why history "disappeared". IndexedDB has hundreds
    // of MB to GB, so we store full content + reasoning + suggestion objects intact.

    /** @type {import('vue').Ref<Array<{role: 'user'|'assistant'|'system', content: string, suggestion?: object, reasoning?: string, ts: number}>>} */
    const messages = ref([]);
    const isHistoryLoaded = ref(false);
    const isBusy = ref(false);
    const lastError = ref("");
    const streamingContent = ref("");
    // Live chain-of-thought tokens from R1-style models (DeepSeek/Qwen/Grok). Parallel to
    // streamingContent so the UI can render a separate collapsible "thinking" panel.
    const streamingReasoning = ref("");

    // --- last FC snapshot for the terminal panel (transient, not persisted) ---
    /** @type {import('vue').Ref<string>} plain-text summary shown in the AI terminal */
    const lastFcSummary = ref("");
    /** @type {import('vue').Ref<'idle'|'loading'|'ready'|'empty'|'error'|'disconnected'>} */
    const fcFetchStatus = ref("idle");
    /** @type {import('vue').Ref<string>} */
    const fcFetchError = ref("");
    /** @type {import('vue').Ref<number>} epoch ms of last successful/failed fetch */
    const lastFcFetchedAt = ref(0);

    // --- blackbox digest (transient, single source of truth for the panel) ---
    // Holds the parsed frequency-domain summary so the UI can show the numbers the AI saw,
    // not just a "loaded" badge. Cleared after diagnose consumes it (one-shot).
    /** @type {import('vue').Ref<object|null>} */
    const lastBlackboxDigest = ref(null);

    // History loading is asynchronous. New messages may arrive before IndexedDB opens, so keep
    // them and merge after load rather than letting either side overwrite the other.
    let historyClearedDuringLoad = false;
    let savePending = false;
    let saveAgain = false;

    function messageIdentity(message) {
        return `${message.ts || 0}\u0000${message.role || ""}\u0000${message.content || ""}`;
    }

    function mergeHistory(stored, current) {
        const merged = [];
        const seen = new Set();
        for (const message of [...stored, ...current]) {
            const key = messageIdentity(message);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(message);
        }
        return merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }

    async function persistHistory() {
        if (!isHistoryLoaded.value) {
            saveAgain = true;
            return;
        }
        if (savePending) {
            saveAgain = true;
            return;
        }
        savePending = true;
        do {
            saveAgain = false;
            // Snapshot through JSON so later reactive mutations don't change an in-flight save.
            const snapshot = JSON.parse(JSON.stringify(messages.value));
            await saveHistoryToDB(snapshot);
        } while (saveAgain);
        savePending = false;
    }

    function scheduleSave() {
        saveAgain = true;
        Promise.resolve().then(persistHistory);
    }

    (async () => {
        try {
            let stored = await loadHistoryFromDB();
            // One-time migration from the old localStorage backend. Keep the old data until the
            // IndexedDB write succeeds, then remove it so migration is idempotent.
            const legacy = getConfig("ai_history", []).ai_history;
            if (Array.isArray(legacy) && legacy.length > 0) {
                stored = mergeHistory(stored, legacy);
            }
            if (!historyClearedDuringLoad) {
                messages.value = mergeHistory(stored, messages.value);
            }
            isHistoryLoaded.value = true;
            const saved = await saveHistoryToDB(messages.value);
            if (saved && Array.isArray(legacy) && legacy.length > 0) {
                removeConfig("ai_history");
            }
            if (saveAgain) scheduleSave();
        } catch (error) {
            console.error("AI history initialization failed:", error);
            isHistoryLoaded.value = true;
            scheduleSave();
        }
    })();

    // --- transient model-list state (not persisted; refreshed per provider on demand) ---
    /** @type {import('vue').Ref<string[]>} fetched model ids from GET /models */
    const availableModels = ref([]);
    const isLoadingModels = ref(false);
    const modelsError = ref("");

    // --- getters ---
    const isConfigured = computed(() => !!apiKey.value && !!baseUrl.value && !!model.value);

    // --- actions: settings (persist on change, like OptionsDialog's per-field watchers) ---
    function setEnabled(v) {
        enabled.value = !!v;
        setConfig({ ai_enabled: enabled.value });
    }
    function setApiKey(v) {
        apiKey.value = v || "";
        setConfig({ ai_api_key: apiKey.value });
    }
    function setBaseUrl(v) {
        baseUrl.value = v || "";
        setConfig({ ai_base_url: baseUrl.value });
    }
    function setModel(v) {
        model.value = v || "";
        setConfig({ ai_model: model.value });
    }
    function setTemperature(v) {
        const n = Number(v);
        if (Number.isFinite(n)) {
            temperature.value = Math.min(2, Math.max(0, n));
            setConfig({ ai_temperature: temperature.value });
        }
    }
    const REASONING_EFFORTS = ["off", "low", "medium", "high"];
    function setReasoningEffort(v) {
        reasoningEffort.value = REASONING_EFFORTS.includes(v) ? v : "off";
        setConfig({ ai_reasoning_effort: reasoningEffort.value });
    }

    // --- actions: conversation ---
    function addMessage(role, content, suggestion = null, reasoning = "") {
        messages.value.push({ role, content, suggestion, reasoning: reasoning || "", ts: Date.now() });
        scheduleSave();
    }
    function clearMessages() {
        historyClearedDuringLoad = true;
        messages.value = [];
        lastError.value = "";
        clearHistoryFromDB();
    }
    function setBusy(v) {
        isBusy.value = !!v;
    }
    function setError(msg) {
        lastError.value = msg || "";
    }
    function setStreamingContent(text) {
        streamingContent.value = text;
    }
    function clearStreamingContent() {
        streamingContent.value = "";
        streamingReasoning.value = "";
    }
    function setStreamingReasoning(text) {
        streamingReasoning.value = text || "";
    }

    function setFcFetchStatus(status, error = "") {
        fcFetchStatus.value = status || "idle";
        fcFetchError.value = error || "";
    }
    function setLastFcSummary(text) {
        lastFcSummary.value = text || "";
        lastFcFetchedAt.value = Date.now();
    }
    function clearFcSnapshot() {
        lastFcSummary.value = "";
        fcFetchStatus.value = "idle";
        fcFetchError.value = "";
        lastFcFetchedAt.value = 0;
    }
    function setBlackboxDigest(digest) {
        lastBlackboxDigest.value = digest || null;
    }
    function clearBlackboxDigest() {
        lastBlackboxDigest.value = null;
    }

    /**
     * Re-read settings from ConfigStorage. Used by the AI tab on mount to pick up
     * changes made in OptionsDialog since the store was created (same rationale as
     * OptionsDialog.syncSettingsFromStorage).
     */
    function syncFromStorage() {
        enabled.value = !!getConfig("ai_enabled", false).ai_enabled;
        apiKey.value = getConfig("ai_api_key", "").ai_api_key || "";
        baseUrl.value =
            getConfig("ai_base_url", "https://api.openai.com/v1").ai_base_url || "https://api.openai.com/v1";
        model.value = getConfig("ai_model", "gpt-4o").ai_model || "gpt-4o";
        temperature.value = getConfig("ai_temperature", 0.2).ai_temperature ?? 0.2;
        reasoningEffort.value = getConfig("ai_reasoning_effort", "off").ai_reasoning_effort || "off";
    }

    // --- actions: model list ---
    function setAvailableModels(list) {
        availableModels.value = Array.isArray(list) ? list.slice() : [];
    }
    function setLoadingModels(v) {
        isLoadingModels.value = !!v;
    }
    function setModelsError(msg) {
        modelsError.value = msg || "";
    }

    return {
        // settings
        enabled,
        apiKey,
        baseUrl,
        model,
        temperature,
        reasoningEffort,
        // conversation
        messages,
        isHistoryLoaded,
        isBusy,
        lastError,
        streamingContent,
        streamingReasoning,
        // FC snapshot terminal
        lastFcSummary,
        fcFetchStatus,
        fcFetchError,
        lastFcFetchedAt,
        // blackbox digest
        lastBlackboxDigest,
        // model list
        availableModels,
        isLoadingModels,
        modelsError,
        // getters
        isConfigured,
        // settings actions
        setEnabled,
        setApiKey,
        setBaseUrl,
        setModel,
        setTemperature,
        setReasoningEffort,
        syncFromStorage,
        // conversation actions
        addMessage,
        clearMessages,
        setBusy,
        setStreamingContent,
        setStreamingReasoning,
        clearStreamingContent,
        setError,
        // FC snapshot actions
        setFcFetchStatus,
        setLastFcSummary,
        clearFcSnapshot,
        // blackbox digest actions
        setBlackboxDigest,
        clearBlackboxDigest,
        // model list actions
        setAvailableModels,
        setLoadingModels,
        setModelsError,
    };
});
