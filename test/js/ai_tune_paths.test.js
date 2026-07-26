import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock connection + MSP so buildContext can be imported without a live FC link.
vi.mock("@/stores/connection", () => ({
    useConnectionStore: () => ({ connectionValid: true }),
}));

// useAiToolCall imports useMspCliSession, which pulls in MSP/serial runtime side effects.
// sanitizeCliName is a pure function, so stub the session factory to avoid the import hang.
vi.mock("@/composables/useMspCliSession", () => ({
    useMspCliSession: () => ({ send: vi.fn(), readDumpAll: vi.fn() }),
    isMspCliSupported: () => false,
    saveAndReconnect: vi.fn(),
}));

vi.mock("@/js/msp/MSPHelper", () => ({
    mspHelper: { crunch: vi.fn(() => []) },
}));

vi.mock("@/js/msp/mspErrors", () => ({
    isMspCancelled: () => false,
}));

vi.mock("@/composables/useReboot", () => ({
    useReboot: () => ({ saveAndReboot: vi.fn() }),
}));

vi.mock("@/js/gui_log", () => ({
    gui_log: vi.fn(),
}));

vi.mock("@/js/localization", () => ({
    i18n: { getMessage: (key, params) => params?.message || key },
}));

vi.mock("@/js/msp", () => ({
    default: {
        promise: vi.fn(async () => undefined),
    },
}));

vi.mock("@/js/msp/MSPCodes", () => ({
    default: {
        MSP_PID: 112,
        MSP_PIDNAMES: 117,
        MSP_PID_ADVANCED: 94,
        MSP_ADVANCED_CONFIG: 90,
        MSP_FILTER_CONFIG: 92,
        MSP_RC_TUNING: 111,
        MSP_MOTOR_CONFIG: 131,
        MSP_MIXER_CONFIG: 42,
        MSP_SIMPLIFIED_TUNING: 140,
        MSP_FEATURE_CONFIG: 36,
        MSP_SET_PID: 202,
        MSP_SET_RC_TUNING: 204,
        MSP_SET_FILTER_CONFIG: 93,
        MSP_SET_PID_ADVANCED: 95,
        MSP_SET_ADVANCED_CONFIG: 91,
        MSP_SET_SIMPLIFIED_TUNING: 141,
        MSP_SET_MIXER_CONFIG: 43,
        MSP_SET_MOTOR_CONFIG: 222,
    },
}));

// Minimal FC shape used by validate/buildContext.
vi.mock("@/js/fc", () => {
    const FC = {
        CONFIG: {
            apiVersion: "1.47.0",
            flightControllerVersion: "4.5.0",
            boardType: 2,
            boardName: "TEST",
            hardwareName: "TEST-BOARD",
            profile: 0,
            rateProfile: 0,
            pidProfileNames: ["Default"],
            rateProfileNames: ["Default"],
        },
        PIDS: [
            [45, 80, 30],
            [48, 82, 32],
            [40, 70, 0],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
        ],
        PID_NAMES: ["ROLL", "PITCH", "YAW"],
        ADVANCED_TUNING: {
            feedforwardRoll: 100,
            feedforwardPitch: 100,
            feedforwardYaw: 90,
            dMaxRoll: 40,
            dMaxPitch: 42,
            dMaxYaw: 0,
            dMaxGain: 30,
            dMaxAdvance: 20,
            tpaRate: 0.65,
            tpaBreakpoint: 1350,
            itermRelax: 2,
            itermRelaxType: 1,
            itermRelaxCutoff: 15,
            antiGravityGain: 3500,
            throttleBoost: 5,
            motorOutputLimit: 100,
            idleMinRpm: 0,
            vbat_sag_compensation: 0,
            thrustLinearization: 0,
            feedforwardTransition: 0,
            feedforward_averaging: 0,
            feedforward_smooth_factor: 0,
            feedforward_boost: 0,
            feedforward_jitter_factor: 0,
            feedforward_max_rate_limit: 0,
        },
        RC_TUNING: {
            RC_RATE: 1.0,
            RC_EXPO: 0.0,
            roll_rate: 0.7,
            pitch_rate: 0.7,
            yaw_rate: 0.7,
            rcPitchRate: 1.0,
            RC_PITCH_EXPO: 0.0,
            rcYawRate: 1.0,
            RC_YAW_EXPO: 0.0,
            throttle_MID: 0.5,
            throttle_EXPO: 0.0,
            throttle_HOVER: 0.5,
            throttleLimitType: 0,
            throttleLimitPercent: 100,
            roll_rate_limit: 1998,
            pitch_rate_limit: 1998,
            yaw_rate_limit: 1998,
            rates_type: 0,
        },
        FILTER_CONFIG: {
            gyro_lowpass_hz: 0,
            gyro_lowpass_dyn_min_hz: 200,
            gyro_lowpass_dyn_max_hz: 500,
            gyro_lowpass_type: 0,
            gyro_lowpass2_hz: 500,
            gyro_lowpass2_type: 0,
            gyro_notch_hz: 0,
            gyro_notch_cutoff: 0,
            gyro_notch2_hz: 0,
            gyro_notch2_cutoff: 0,
            dterm_lowpass_hz: 0,
            dterm_lowpass_dyn_min_hz: 100,
            dterm_lowpass_dyn_max_hz: 150,
            dterm_lowpass_type: 0,
            dterm_lowpass2_hz: 150,
            dterm_lowpass2_type: 0,
            dterm_notch_hz: 0,
            dterm_notch_cutoff: 0,
            yaw_lowpass_hz: 100,
            dyn_notch_count: 3,
            dyn_notch_q: 300,
            dyn_notch_min_hz: 100,
            dyn_notch_max_hz: 600,
            dyn_notch_width_percent: 0,
            gyro_rpm_notch_harmonics: 3,
            gyro_rpm_notch_min_hz: 100,
            gyro_rpm_notch_q: 500,
            gyro_rpm_notch_fade_range_hz: 50,
        },
        TUNING_SLIDERS: {
            slider_pids_mode: 2,
            slider_master_multiplier: 100,
            slider_pd_gain: 100,
            slider_d_gain: 100,
            slider_pi_gain: 100,
            slider_i_gain: 100,
            slider_feedforward_gain: 100,
            slider_dmax_gain: 100,
            slider_gyro_filter: 1,
            slider_gyro_filter_multiplier: 100,
            slider_dterm_filter: 1,
            slider_dterm_filter_multiplier: 100,
        },
        MIXER_CONFIG: { mixer: 3, reverseMotorDir: 0 },
        MOTOR_CONFIG: {
            minthrottle: 1070,
            maxthrottle: 2000,
            mincommand: 1000,
            motor_count: 4,
            motor_poles: 14,
            use_dshot_telemetry: true,
            use_esc_sensor: false,
        },
        PID_ADVANCED_CONFIG: {
            gyro_sync_denom: 1,
            pid_process_denom: 1,
            use_unsyncedPwm: 0,
            fast_pwm_protocol: 6,
            motor_pwm_rate: 480,
            motorIdle: 5.5,
            debugMode: 0,
        },
        FEATURE_CONFIG: {
            features: {
                getEnabledFeatures: () => ["RX_SERIAL", "DYNAMIC_FILTER"],
            },
        },
    };
    return { default: FC };
});

describe("AI tune path alignment", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("normalizes camelCase / alias paths to FC roots", async () => {
        const { normalizeParamPath } = await import("../../src/composables/ai/validateSuggestion.js");

        expect(normalizeParamPath("filterConfig.gyro_lowpass_dyn_min_hz")).toBe(
            "FILTER_CONFIG.gyro_lowpass_dyn_min_hz",
        );
        expect(normalizeParamPath("advancedTuning.dMaxRoll")).toBe("ADVANCED_TUNING.dMaxRoll");
        expect(normalizeParamPath("rcTuning.roll_rate")).toBe("RC_TUNING.roll_rate");
        expect(normalizeParamPath("tuningSliders.slider_d_gain")).toBe("TUNING_SLIDERS.slider_d_gain");
        expect(normalizeParamPath("motorConfig.minthrottle")).toBe("MOTOR_CONFIG.minthrottle");
        expect(normalizeParamPath("pidAdvancedConfig.motorIdle")).toBe("PID_ADVANCED_CONFIG.motorIdle");
        expect(normalizeParamPath("PIDS[0][0]")).toBe("PIDS[0][0]");
        expect(normalizeParamPath("pids[1][2]")).toBe("PIDS[1][2]");
    });

    it("accepts alias paths in validateParamChanges and returns normalized FC paths", async () => {
        const { validateParamChanges } = await import("../../src/composables/ai/validateSuggestion.js");

        const result = validateParamChanges([
            { path: "filterConfig.gyro_lowpass_dyn_min_hz", current: 200, suggested: 180 },
            { path: "advancedTuning.dMaxRoll", current: 40, suggested: 38 },
            { path: "PIDS[0][0]", current: 45, suggested: 42 },
        ]);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.normalized.map((c) => c.path)).toEqual([
            "FILTER_CONFIG.gyro_lowpass_dyn_min_hz",
            "ADVANCED_TUNING.dMaxRoll",
            "PIDS[0][0]",
        ]);
    });

    it("rejects invented path roots", async () => {
        const { validateParamChanges } = await import("../../src/composables/ai/validateSuggestion.js");
        const result = validateParamChanges([{ path: "fooBar.made_up", current: 1, suggested: 2 }]);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toMatch(/Unknown parameter prefix/);
    });

    it("exports the same FC path roots used by prompts", async () => {
        const { TUNE_PATH_ROOTS } = await import("../../src/composables/ai/buildContext.js");
        expect(TUNE_PATH_ROOTS).toEqual([
            "PIDS",
            "ADVANCED_TUNING",
            "RC_TUNING",
            "FILTER_CONFIG",
            "TUNING_SLIDERS",
            "MIXER_CONFIG",
            "MOTOR_CONFIG",
            "PID_ADVANCED_CONFIG",
        ]);
    });

    it("builds a readable tune summary with exact apply paths", async () => {
        const { buildTuneContext, formatTuneContextText, TUNE_PATH_ROOTS } =
            await import("../../src/composables/ai/buildContext.js");

        const ctx = await buildTuneContext();
        expect(ctx).not.toBeNull();
        expect(ctx.PIDS[0]).toEqual([45, 80, 30]);
        expect(ctx.pids.ROLL).toMatchObject({
            P: 45,
            I: 80,
            D: 30,
            path: { P: "PIDS[0][0]", I: "PIDS[0][1]", D: "PIDS[0][2]" },
        });
        expect(ctx.pathConvention.roots).toEqual(TUNE_PATH_ROOTS);

        const text = formatTuneContextText(ctx);
        expect(text).toContain("ROLL: P=45 (PIDS[0][0])");
        expect(text).toContain("FILTER_CONFIG");
        expect(text).toContain("ADVANCED_TUNING");
        expect(text).toContain("gyro_lowpass_dyn_min_hz");
        expect(text).toContain("dyn=200-500");
    });

    it("maps FC roots to MSP SET codes for apply", async () => {
        const MSPCodes = (await import("../../src/js/msp/MSPCodes.js")).default;
        const { collectMspCodes } = await import("../../src/composables/ai/applySuggestion.js");

        // Aliases must still resolve after normalize (collectMspCodes normalizes internally).
        const codes = [
            ...collectMspCodes([
                { path: "filterConfig.gyro_lowpass_dyn_min_hz" },
                { path: "advancedTuning.dMaxRoll" },
                { path: "pids[0][0]" },
                { path: "motorConfig.minthrottle" },
                { path: "pidAdvancedConfig.motorIdle" },
            ]),
        ].sort((a, b) => a - b);

        expect(codes).toEqual(
            [
                MSPCodes.MSP_SET_FILTER_CONFIG,
                MSPCodes.MSP_SET_PID_ADVANCED,
                MSPCodes.MSP_SET_ADVANCED_CONFIG,
                MSPCodes.MSP_SET_PID,
                MSPCodes.MSP_SET_MOTOR_CONFIG,
            ].sort((a, b) => a - b),
        );
    });
});

describe("AI cli_get parameter sanitization", () => {
    it("accepts well-formed parameter names", async () => {
        const { sanitizeCliName } = await import("../../src/composables/ai/useAiToolCall.js");
        expect(sanitizeCliName("p_roll")).toBe("p_roll");
        expect(sanitizeCliName("gyro_lowpass_hz")).toBe("gyro_lowpass_hz");
        expect(sanitizeCliName("d_pitch")).toBe("d_pitch");
        expect(sanitizeCliName("rates-type")).toBe("rates-type");
        expect(sanitizeCliName("  dterm_lowpass2_hz  ")).toBe("dterm_lowpass2_hz");
    });

    it("rejects injection attempts and malformed input", async () => {
        const { sanitizeCliName } = await import("../../src/composables/ai/useAiToolCall.js");
        // The motivating bug: a model reply embedding CLI write commands.
        expect(sanitizeCliName("foo\nset d_roll=999\nsave")).toBeNull();
        expect(sanitizeCliName("foo;save")).toBeNull();
        expect(sanitizeCliName("foo bar")).toBeNull(); // space → not in vocabulary
        expect(sanitizeCliName("set x=1")).toBeNull();
        expect(sanitizeCliName("")).toBeNull();
        expect(sanitizeCliName("   ")).toBeNull();
        expect(sanitizeCliName(null)).toBeNull();
        expect(sanitizeCliName(42)).toBeNull();
        expect(sanitizeCliName(undefined)).toBeNull();
    });
});

describe("AI param range validation across all FC roots", () => {
    it("enforces ranges on the previously-unvalidated MIXER/MOTOR/PID_ADVANCED_CONFIG roots", async () => {
        const { validateParamChanges } = await import("../../src/composables/ai/validateSuggestion.js");

        // Out-of-range values must now be caught (they used to pass silently).
        const bad = validateParamChanges([
            { path: "MOTOR_CONFIG.minthrottle", current: 1070, suggested: 99999 },
            { path: "MIXER_CONFIG.mixer", current: 3, suggested: 500 },
            { path: "PID_ADVANCED_CONFIG.pid_process_denom", current: 1, suggested: 999 },
        ]);
        expect(bad.valid).toBe(false);
        expect(bad.errors.join(" ")).toMatch(/minthrottle/);
        expect(bad.errors.join(" ")).toMatch(/mixer/);
        expect(bad.errors.join(" ")).toMatch(/pid_process_denom/);
    });

    it("accepts in-range values on the same roots", async () => {
        const { validateParamChanges } = await import("../../src/composables/ai/validateSuggestion.js");
        const ok = validateParamChanges([
            { path: "MOTOR_CONFIG.minthrottle", current: 1070, suggested: 1100 },
            { path: "MIXER_CONFIG.mixer", current: 3, suggested: 4 },
            { path: "PID_ADVANCED_CONFIG.pid_process_denom", current: 1, suggested: 2 },
            { path: "PID_ADVANCED_CONFIG.motorIdle", current: 5.5, suggested: 6.0 },
        ]);
        expect(ok.valid).toBe(true);
        expect(ok.errors).toEqual([]);
    });
});

describe("AI reasoning effort routing", () => {
    it("injects reasoning_effort for OpenAI o-series / GPT-5", async () => {
        const { resolveReasoningParams } = await import("../../src/js/AiApi.js");
        expect(resolveReasoningParams("gpt-5", "high")).toEqual({ reasoning_effort: "high" });
        expect(resolveReasoningParams("o3-mini", "medium")).toEqual({ reasoning_effort: "medium" });
        expect(resolveReasoningParams("o1", "low")).toEqual({ reasoning_effort: "low" });
    });

    it("injects thinking.budget_tokens for Claude models (except Haiku)", async () => {
        const { resolveReasoningParams } = await import("../../src/js/AiApi.js");
        expect(resolveReasoningParams("claude-opus-4-1", "medium")).toEqual({
            thinking: { type: "enabled", budget_tokens: 10000 },
        });
        expect(resolveReasoningParams("claude-sonnet-4", "high").thinking.budget_tokens).toBe(24000);
        // Haiku has no extended thinking support.
        expect(resolveReasoningParams("claude-3-5-haiku", "high")).toEqual({});
    });

    it("matches DeepSeek first (project default) and honours its thinking on/off + effort rules", async () => {
        const { resolveReasoningParams } = await import("../../src/js/AiApi.js");
        // Current DeepSeek model names (deepseek-reasoner/deepseek-chat were retired
        // 2026-07-24): v4-pro is the reasoning model, v4-flash defaults to thinking too.
        // DeepSeek thinking defaults to ENABLED server-side, so "off" must be an explicit
        // disabled block — not omitted.
        expect(resolveReasoningParams("deepseek-v4-pro", "off")).toEqual({ thinking: { type: "disabled" } });
        // Any enabled level resolves to high: DeepSeek only has high/max for real, and maps
        // low|medium → high for compatibility.
        expect(resolveReasoningParams("deepseek-v4-pro", "low")).toEqual({
            thinking: { type: "enabled" },
            reasoning_effort: "high",
        });
        expect(resolveReasoningParams("deepseek-v4-pro", "medium")).toEqual({
            thinking: { type: "enabled" },
            reasoning_effort: "high",
        });
        expect(resolveReasoningParams("deepseek-v4-pro", "high")).toEqual({
            thinking: { type: "enabled" },
            reasoning_effort: "high",
        });
        // v4-flash supports thinking + non-thinking modes, so the routing must hit it too.
        expect(resolveReasoningParams("deepseek-v4-flash", "off")).toEqual({ thinking: { type: "disabled" } });
        expect(resolveReasoningParams("deepseek-v4-flash", "high")).toEqual({
            thinking: { type: "enabled" },
            reasoning_effort: "high",
        });
    });

    it("leaves non-DeepSeek R1-style models untouched and respects off for OpenAI/Claude", async () => {
        const { resolveReasoningParams } = await import("../../src/js/AiApi.js");
        // Qwen/Grok via proxies take no request param; reasoning arrives via stream.
        expect(resolveReasoningParams("qwen3-235b", "medium")).toEqual({});
        expect(resolveReasoningParams("grok-4", "high")).toEqual({});
        // Off must inject nothing for providers that have no on/off switch.
        expect(resolveReasoningParams("gpt-5", "off")).toEqual({});
        expect(resolveReasoningParams("claude-opus-4-1", "off")).toEqual({});
        expect(resolveReasoningParams("", "high")).toEqual({});
    });
});

describe("AI wiki doc selection", () => {
    it("selects PID tuning and D-term docs for a PID question", async () => {
        const { selectWikiDocs } = await import("../../src/composables/ai/wikiSelector.js");
        const docs = await selectWikiDocs("My D term is too high and causing motor noise, how should I tune PIDs?");
        const titles = docs.map((d) => d.title);
        expect(titles).toContain("PID Tuning Guide");
        expect(titles).toContain("Dynamic D (DMax)");
        expect(docs.length).toBeLessThanOrEqual(3);
    });

    it("selects RPM filtering doc for a filter question", async () => {
        const { selectWikiDocs } = await import("../../src/composables/ai/wikiSelector.js");
        const docs = await selectWikiDocs("gyro rpm notch harmonics noise");
        const titles = docs.map((d) => d.title);
        expect(titles).toContain("DSHOT RPM Filtering");
    });

    it("selects blackbox + PSD docs for a blackbox analysis question", async () => {
        const { selectWikiDocs } = await import("../../src/composables/ai/wikiSelector.js");
        const docs = await selectWikiDocs("黑匣子频谱分析 noise floor psd");
        const titles = docs.map((d) => d.title);
        expect(titles).toContain("Power Spectral Density Charts");
    });

    it("returns empty for an unrelated question", async () => {
        const { selectWikiDocs } = await import("../../src/composables/ai/wikiSelector.js");
        const docs = await selectWikiDocs("How do I bind my Spektrum receiver?");
        expect(docs).toEqual([]);
    });

    it("formats wiki docs into a context string", async () => {
        const { formatWikiContext } = await import("../../src/composables/ai/wikiSelector.js");
        const text = formatWikiContext([{ title: "Test Doc", content: "Hello world" }]);
        expect(text).toContain("Betaflight Wiki Reference");
        expect(text).toContain("Test Doc");
        expect(text).toContain("Hello world");
        expect(formatWikiContext([])).toBe("");
    });

    it("handles null/undefined input gracefully", async () => {
        const { formatWikiContext, selectWikiDocs } = await import("../../src/composables/ai/wikiSelector.js");
        expect(formatWikiContext(null)).toBe("");
        expect(formatWikiContext(undefined)).toBe("");
        const docs = await selectWikiDocs(null);
        expect(Array.isArray(docs)).toBe(true);
    });
});

describe("AI chatWithTools loop", () => {
    it("returns text content when AI responds without tool calls", async () => {
        const { chatWithTools } = await import("../../src/composables/ai/useAiToolCall.js");
        const mockApi = {
            chat: vi.fn().mockResolvedValue({ content: "Hello!", toolCalls: null }),
        };
        const result = await chatWithTools(mockApi, [{ role: "user", content: "Hi" }]);
        expect(result).toBe("Hello!");
        expect(mockApi.chat).toHaveBeenCalledTimes(1);
    });

    it("returns (cancelled) when signal is aborted before a round", async () => {
        const { chatWithTools } = await import("../../src/composables/ai/useAiToolCall.js");
        const controller = new AbortController();
        controller.abort();
        const mockApi = { chat: vi.fn() };
        const result = await chatWithTools(mockApi, [], {}, { signal: controller.signal });
        expect(result).toBe("(cancelled)");
        expect(mockApi.chat).not.toHaveBeenCalled();
    });

    it("returns (AI tool call limit reached) after max rounds", async () => {
        const { chatWithTools } = await import("../../src/composables/ai/useAiToolCall.js");
        // Always return a tool call to exhaust the round limit
        const mockApi = {
            chat: vi.fn().mockResolvedValue({
                content: null,
                toolCalls: [{ id: "tc1", type: "function", function: { name: "cli_status", arguments: "{}" } }],
            }),
        };
        const result = await chatWithTools(mockApi, [{ role: "user", content: "test" }]);
        expect(result).toBe("(AI tool call limit reached)");
        expect(mockApi.chat).toHaveBeenCalledTimes(5);
    });
});

describe("AI validateParamChanges edge cases", () => {
    it("returns valid for empty array", async () => {
        const { validateParamChanges } = await import("../../src/composables/ai/validateSuggestion.js");
        const result = validateParamChanges([]);
        expect(result.valid).toBe(true);
        expect(result.normalized).toEqual([]);
    });

    it("accepts feedforward_max_rate_limit in PARAM_RANGES", async () => {
        const { validateParamChanges } = await import("../../src/composables/ai/validateSuggestion.js");
        const result = validateParamChanges([
            { path: "ADVANCED_TUNING.feedforward_max_rate_limit", current: 0, suggested: 100 },
        ]);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it("rejects out-of-range feedforward_max_rate_limit", async () => {
        const { validateParamChanges } = await import("../../src/composables/ai/validateSuggestion.js");
        const result = validateParamChanges([
            { path: "ADVANCED_TUNING.feedforward_max_rate_limit", current: 0, suggested: 99999 },
        ]);
        expect(result.valid).toBe(false);
        expect(result.errors.join(" ")).toMatch(/feedforward_max_rate_limit/);
    });
});
