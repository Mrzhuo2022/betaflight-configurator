import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// Bug-hunting tests for blackbox-digest delivery to the model.
//
// Rationale: the digest used to be computed and shown as "loaded" in the panel, but only the
// one-click diagnose button attached it to a request — free-form chat and CLI chat sent only
// the MSP tune snapshot, so the model answered "I received no blackbox data" while the UI
// claimed the opposite. These tests drive the real composable entry points and inspect the
// actual payload/messages each path would send, so a path that drops the digest fails here.

const { streamChatMock, chatMock, toolChatMock, buildTuneContextPayloadMock, selectWikiDocsMock } = vi.hoisted(() => ({
    streamChatMock: vi.fn(),
    chatMock: vi.fn(),
    toolChatMock: vi.fn(),
    buildTuneContextPayloadMock: vi.fn(async () => null),
    selectWikiDocsMock: vi.fn(async () => []),
}));

vi.mock("@/js/AiApi", () => {
    class AiApiError extends Error {
        constructor(message, { cancelled = false } = {}) {
            super(message);
            this.cancelled = cancelled;
        }
    }
    return {
        AiApiError,
        AiApi: class {
            streamChat = streamChatMock;
            chat = chatMock;
        },
    };
});

vi.mock("@/stores/aiAssistant", () => {
    function makeStore() {
        const store = {
            enabled: true,
            isConfigured: true,
            baseUrl: "https://api.test/v1",
            apiKey: "key",
            model: "test-model",
            temperature: 0.2,
            reasoningEffort: "off",
            messages: [],
            appliedChangeLog: [],
            lastBlackboxDigest: null,
            streamingContent: "",
            streamingReasoning: "",
            isBusy: false,
            lastError: "",
            addMessage(role, content, suggestion, reasoning) {
                store.messages.push({ role, content, suggestion, reasoning, ts: 0 });
            },
            setBusy(v) {
                store.isBusy = v;
            },
            setError(v) {
                store.lastError = v;
            },
            clearStreamingContent() {
                store.streamingContent = "";
                store.streamingReasoning = "";
            },
            setStreamingContent(v) {
                store.streamingContent = v;
            },
            setStreamingReasoning(v) {
                store.streamingReasoning = v;
            },
            setToolCallStatus: vi.fn(),
            setFcFetchStatus: vi.fn(),
            setLastFcSummary: vi.fn(),
            setBlackboxDigest(d) {
                store.lastBlackboxDigest = d;
            },
            clearBlackboxDigest() {
                store.lastBlackboxDigest = null;
            },
        };
        return store;
    }
    return { useAiAssistantStore: () => makeStore() };
});

vi.mock("@/stores/connection", () => ({
    useConnectionStore: () => ({ connectionValid: false }),
}));

vi.mock("@/composables/useDialog", () => ({
    useDialog: () => ({ openInfo: vi.fn(), showYesNo: vi.fn(async () => true) }),
}));

vi.mock("@/composables/ai/buildContext", () => ({
    buildTuneContextPayload: buildTuneContextPayloadMock,
    TUNE_PATH_ROOTS: ["PIDS", "FILTER_CONFIG", "ADVANCED_TUNING"],
}));

vi.mock("@/composables/ai/wikiSelector", () => ({
    selectWikiDocs: selectWikiDocsMock,
    formatWikiContext: vi.fn(() => ""),
}));

vi.mock("@/composables/ai/useAiToolCall", () => ({
    chatWithTools: toolChatMock,
}));

vi.mock("@/js/localization", () => ({
    i18n: { getMessage: () => "" },
}));

vi.mock("@/js/gui_log", () => ({ gui_log: vi.fn() }));

vi.mock("@/js/data_storage", () => ({ default: { cliActive: false } }));

const REGULAR_DIGEST = {
    log_type: "regular",
    sample_rate_hz: 2000,
    axes: {
        roll: {
            noise_peaks: [{ freq_hz: 337.89, power_db: -4.35 }],
            noise_floor_db: -23.32,
            sample_count: 333796,
        },
    },
    motor_noise: [{ motor: 0, peaks: [{ freq_hz: 337.89, power_db: 13.86 }] }],
    debug_mode: 6,
    debug_mode_name: "GYRO_SCALED",
    debug_channels: [
        { channel: 2, label: "Gyro Scaled [pitch]", peaks: [{ freq_hz: 337.89, power_db: 5.1 }], noise_floor_db: -20 },
    ],
    total_frames: 333796,
    corrupt_frames: 0,
};

const CHIRP_DIGEST = {
    log_type: "chirp",
    sample_rate_hz: 2000,
    axes: { roll: { bandwidth_hz: 90, phase_margin_deg: 42, resonant_peak_db: 3.2 } },
    total_frames: 1000,
    corrupt_frames: 0,
};

const DIAGNOSE_JSON = JSON.stringify({ summary: "s", findings: [], overallRisk: "low" });

const { formatBlackboxContext, useAiAssistant } = await import("../../src/composables/ai/useAiAssistant");

beforeEach(() => {
    setActivePinia(createPinia());
    streamChatMock.mockReset().mockResolvedValue({ content: "ok" });
    chatMock.mockReset().mockResolvedValue({ content: DIAGNOSE_JSON, reasoning: "", finishReason: "stop" });
    toolChatMock.mockReset().mockResolvedValue("done");
    buildTuneContextPayloadMock.mockReset().mockResolvedValue(null);
    selectWikiDocsMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("formatBlackboxContext", () => {
    it("returns empty string when there is no digest", () => {
        expect(formatBlackboxContext(null)).toBe("");
        expect(formatBlackboxContext(undefined)).toBe("");
        expect(formatBlackboxContext({})).toBe("");
    });

    it("regular digest embeds the full JSON and peak-significance guidance", () => {
        const ctx = formatBlackboxContext(REGULAR_DIGEST);
        expect(ctx).toContain("Blackbox regular flight-log analysis");
        expect(ctx).toContain("337.89");
        expect(ctx).toContain("noise_floor_db");
        expect(ctx).toContain("power_db - noise_floor_db > 10");
        expect(ctx).toContain("debug_mode_name");
    });

    it("chirp digest embeds transfer-function guidance", () => {
        const ctx = formatBlackboxContext(CHIRP_DIGEST);
        expect(ctx).toContain("CHIRP");
        expect(ctx).toContain("phase_margin_deg");
    });
});

describe("blackbox digest reaches the model on every chat path", () => {
    it("ask() includes the loaded digest in the trailing system context", async () => {
        const ai = useAiAssistant();
        ai.setBlackboxDigest(REGULAR_DIGEST);
        await ai.ask("帮我看看有没有噪声问题");

        expect(streamChatMock).toHaveBeenCalledTimes(1);
        const payload = streamChatMock.mock.calls[0][0];
        const contextMsg = payload[payload.length - 1];
        expect(contextMsg.role).toBe("system");
        expect(contextMsg.content).toContain("Blackbox regular flight-log analysis");
        expect(contextMsg.content).toContain("337.89");
    });

    it("ask() keeps blackbox evidence ahead of the FC tune snapshot", async () => {
        buildTuneContextPayloadMock.mockResolvedValue({
            context: {},
            text: "TUNE SUMMARY TEXT",
            json: "{}",
            populated: true,
            fetch: { ok: [], failed: [] },
        });
        const ai = useAiAssistant();
        ai.setBlackboxDigest(REGULAR_DIGEST);
        await ai.ask("看下");

        const payload = streamChatMock.mock.calls[0][0];
        const contextMsg = payload[payload.length - 1].content;
        const bbPos = contextMsg.indexOf("Blackbox regular flight-log analysis");
        const tunePos = contextMsg.indexOf("TUNE SUMMARY TEXT");
        expect(bbPos).toBeGreaterThanOrEqual(0);
        expect(tunePos).toBeGreaterThan(bbPos);
    });

    it("ask() without digest and without FC still tells the model no data is available", async () => {
        const ai = useAiAssistant();
        await ai.ask("你好");

        const payload = streamChatMock.mock.calls[0][0];
        const contextMsg = payload[payload.length - 1].content;
        expect(contextMsg).toContain("no blackbox data is available");
    });

    it("ask() passes digest-derived hints to the wiki selector", async () => {
        const ai = useAiAssistant();
        ai.setBlackboxDigest(REGULAR_DIGEST);
        await ai.ask("看下");

        expect(selectWikiDocsMock).toHaveBeenCalledTimes(1);
        const [, extraContext] = selectWikiDocsMock.mock.calls[0];
        expect(extraContext).toContain("blackbox");
        expect(extraContext).toContain("GYRO_SCALED");
        expect(extraContext).toContain("roll noise");
    });

    it("diagnose() sends a user turn even though it excludes history", async () => {
        const ai = useAiAssistant();
        ai.setBlackboxDigest(REGULAR_DIGEST);
        await ai.diagnose(REGULAR_DIGEST);

        expect(chatMock).toHaveBeenCalledTimes(1);
        const payload = chatMock.mock.calls[0][0];
        expect(payload.some((m) => m.role === "user")).toBe(true);
        const contextMsg = payload[payload.length - 1];
        expect(contextMsg.role).toBe("system");
        expect(contextMsg.content).toContain("Blackbox regular flight-log analysis");
    });

    it("cliAsk() injects the loaded digest into the system prompt", async () => {
        const ai = useAiAssistant();
        ai.setBlackboxDigest(REGULAR_DIGEST);
        await ai.cliAsk("结合日志说说");

        expect(toolChatMock).toHaveBeenCalledTimes(1);
        const messages = toolChatMock.mock.calls[0][1];
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain("Blackbox regular flight-log analysis");
        expect(messages[0].content).toContain("337.89");
    });

    it("cliAsk() without digest sends no blackbox block", async () => {
        const ai = useAiAssistant();
        await ai.cliAsk("cli_diff");

        const messages = toolChatMock.mock.calls[0][1];
        expect(messages[0].content).not.toContain("Blackbox regular flight-log analysis");
        expect(messages[0].content).not.toContain("CHIRP");
    });
});
