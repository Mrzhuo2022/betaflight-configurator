import { describe, expect, it, vi } from "vitest";
import { createApp, h, ref } from "vue";

// Mount smoke test for AiAssistantContent.vue.
//
// Rationale: a previous refactor registered watches on `streamingContent`/`isBusy` BEFORE
// those consts were destructured further down in <script setup> — a TDZ ReferenceError that
// crashed the panel on every mount. None of the existing unit tests import the component,
// and `vite build` only compiles it, so the bug sailed through lint/build/1137 green tests.
// This test executes the real setup() + render against jsdom so any future top-level
// ordering crash fails CI instead of the pilot's first click.

vi.mock("i18next-vue", () => ({
    useTranslation: () => ({ t: (key) => key }),
}));

vi.mock("@/composables/ai/useAiAssistant", () => ({
    useAiAssistant: () => ({
        messages: ref([]),
        isHistoryLoaded: ref(true),
        isBusy: ref(false),
        isStreaming: ref(false),
        canCancel: ref(false),
        streamingContent: ref(""),
        streamingReasoning: ref(""),
        toolCallStatus: ref(""),
        isConnected: ref(false),
        isConfigured: ref(true),
        isEnabled: ref(true),
        lastFcSummary: ref(""),
        fcFetchStatus: ref("idle"),
        fcFetchError: ref(""),
        lastFcFetchedAt: ref(0),
        lastBlackboxDigest: ref(null),
        reasoningEffort: ref("off"),
        availableModels: ref([]),
        isLoadingModels: ref(false),
        modelsError: ref(""),
        setReasoningEffort: vi.fn(),
        ask: vi.fn(),
        cliAsk: vi.fn(),
        diagnose: vi.fn(),
        cancelStreaming: vi.fn(),
        resetConversation: vi.fn(),
        refreshFcSnapshot: vi.fn(async () => null),
        invalidateTuneCache: vi.fn(),
        fetchModels: vi.fn(),
        clearFcSnapshot: vi.fn(),
        syncSettings: vi.fn(),
        setBlackboxDigest: vi.fn(),
        clearBlackboxDigest: vi.fn(),
        recordAppliedChanges: vi.fn(),
        popFailedExchange: vi.fn(() => ""),
    }),
}));

vi.mock("@/composables/ai/digestBlackbox", () => ({
    useBlackboxDigest: () => ({
        isProcessing: ref(false),
        error: ref(""),
        digest: vi.fn(),
        digestBlackboxData: vi.fn(),
    }),
}));

vi.mock("@/composables/useDataflashPull", () => ({
    useDataflashPull: () => ({
        pulling: ref(false),
        progress: ref(0),
        available: ref(false),
        pull: vi.fn(),
    }),
}));

vi.mock("@/composables/useDialog", () => ({
    useDialog: () => ({ openInfo: vi.fn(), showYesNo: vi.fn() }),
}));

vi.mock("@/blackbox-viewer/stores/log", () => ({
    useLogStore: () => ({ hasLog: false, flightLogDataArray: null }),
}));

vi.mock("@/js/pinia_instance", () => ({ pinia: {} }));
vi.mock("@/js/gui_log", () => ({ gui_log: vi.fn() }));
vi.mock("@/js/fc", () => ({ default: { CONFIG: {} } }));
vi.mock("@/stores/navigation", () => ({ useNavigationStore: () => ({}) }));

const { default: AiAssistantContent } = await import("../../src/components/ai-assistant/AiAssistantContent.vue");

/** Mount the component into jsdom with $t stubbed; returns {app, html}. Throws on setup/render errors. */
function mountComponent() {
    const app = createApp({ render: () => h(AiAssistantContent) });
    app.config.globalProperties.$t = (key) => key;
    // Nuxt UI components (UButton, UBadge, …) are globally registered by the real app;
    // unresolved here they only log warnings, which is fine for a smoke test.
    app.config.warnHandler = () => {};
    const el = document.createElement("div");
    document.body.appendChild(el);
    app.mount(el);
    return { app, html: el.innerHTML };
}

describe("AiAssistantContent mount smoke", () => {
    it("mounts and renders without a setup crash", () => {
        const { app, html } = mountComponent();
        try {
            // $t is stubbed to echo the key, so the conversation title key must appear in
            // the rendered output — proves the template actually rendered.
            expect(html).toContain("aiConversationTitle");
            expect(html).toContain("aiFcTerminalTitle");
        } finally {
            app.unmount();
        }
    });

    it("mounts cleanly a second time (per-instance state, no module-level leakage)", () => {
        const first = mountComponent();
        first.app.unmount();
        const second = mountComponent();
        try {
            expect(second.html).toContain("aiConversationTitle");
        } finally {
            second.app.unmount();
        }
    });
});
