import { computed, onUnmounted } from "vue";
import { useAiAssistantStore } from "@/stores/aiAssistant";
import { useConnectionStore } from "@/stores/connection";
import { useDialog } from "@/composables/useDialog";
import { AiApi, AiApiError } from "@/js/AiApi";
import { chatWithTools } from "./useAiToolCall";
import { buildTuneContextPayload, TUNE_PATH_ROOTS } from "./buildContext";
import { selectWikiDocs, formatWikiContext } from "./wikiSelector";
import { i18n } from "@/js/localization";
import { gui_log } from "@/js/gui_log";

/**
 * Orchestration composable for the AI Assistant.
 *
 * Wires the settings store + AiApi client + config snapshot, and exposes `ask()` (free-form
 * chat) and `diagnose()` (one-click structured report) actions to the Vue components. The
 * components never touch MSP or fetch directly (per AGENTS.md boundary rule).
 */

const SYSTEM_PROMPT = [
    "你是嵌入在 Betaflight Configurator 中的专业飞控调参助手。",
    "你分析用户当前的飞控参数并给出清晰、可执行的建议。",
    "准则：",
    "- 用中文回复。简洁，优先给出具体数字和参数名，不要空泛描述。",
    "- 优先引用“可读摘要”中的数值；需要精确字段时再查 JSON。",
    "- 建议参数变更时，必须使用可应用路径，例如：",
    "  PIDS[0][0]（ROLL P）、FILTER_CONFIG.gyro_lowpass_dyn_min_hz、ADVANCED_TUNING.dMaxRoll。",
    `- 路径根必须是：${TUNE_PATH_ROOTS.join(", ")}。`,
    "- 区分保守改动（滤波截止、滑块）和激进改动（大幅提高 D / DMax），激进改动要警告。",
    "- 如果没有飞控连接也没有黑匣子数据，如实告知并询问飞手观察到了什么问题。",
    "- 不要编造 Betaflight 中不存在的功能或字段。",
    "- 没有证据时不要给出具体数值建议；可以先要求用户补充现象、黑匣子或 CLI dump。",
].join("\n");

// --- One-click diagnostic: structured JSON output -----------------------------

const DIAGNOSE_SCHEMA = {
    type: "object",
    required: ["summary", "findings", "overallRisk"],
    properties: {
        summary: { type: "string", description: "One-line overview, <=200 chars, Chinese" },
        findings: {
            type: "array",
            items: {
                type: "object",
                required: ["severity", "area", "title", "finding", "recommendation"],
                properties: {
                    severity: { type: "string", enum: ["info", "warning", "critical"] },
                    area: { type: "string", enum: ["PID", "filter", "rate", "rc", "motor", "feature", "other"] },
                    title: { type: "string", description: "Short title, 10-30 chars, Chinese" },
                    finding: { type: "string", description: "Observed symptom with numbers" },
                    reason: { type: "string", description: "Why this is happening" },
                    recommendation: { type: "string", description: "Concrete suggested action" },
                    paramChanges: {
                        type: "array",
                        items: {
                            type: "object",
                            required: ["path", "current", "suggested"],
                            properties: {
                                path: {
                                    type: "string",
                                    description:
                                        "Exact FC path, e.g. PIDS[0][0], FILTER_CONFIG.gyro_lowpass_dyn_min_hz",
                                },
                                current: {},
                                suggested: {},
                                reason: { type: "string" },
                            },
                        },
                    },
                },
            },
        },
        overallRisk: { type: "string", enum: ["low", "medium", "high"] },
    },
};

const DIAGNOSE_SYSTEM_PROMPT = [
    "你是 Betaflight 飞控调参专家，正在执行一键诊断。",
    "分析提供的数据并返回结构化诊断报告。",
    "",
    "关键规则——违反将导致诊断无效：",
    "1) 所有发现必须引用提供数据中的具体数值。",
    "2) 若有黑匣子 regular 日志：优先分析 axes.*.noise_peaks 与 noise_floor_db；",
    "   仅当峰值相对噪声底 >10 dB 时才视为显著。",
    "3) 若有黑匣子 chirp 日志：优先分析 bandwidth_hz / phase_margin_deg / resonant_peak_db / overshoot_pct。",
    "4) 若有飞控调参数据：先看可读摘要，再查 JSON；paramChanges 只能使用真实字段。",
    "5) 禁止给没有数据支撑的笼统建议；没有异常就直说。",
    "6) 完全没有可用数据时，findings 必须为空数组。",
    "",
    "参数修改规则：",
    `- paramChanges[].path 必须以这些根开头：${TUNE_PATH_ROOTS.join(", ")}`,
    "- 正确示例：PIDS[0][0]、PIDS[1][2]、FILTER_CONFIG.dterm_lowpass_dyn_min_hz、ADVANCED_TUNING.dMaxRoll",
    "- 错误示例：pids.ROLL.P、filterConfig.gyroLowpass1DynamicMinCutoff、set p_roll",
    "- current 必须尽量取自提供数据；suggested 要给出合理小步调整。",
    "- 没有把握时宁可不给 paramChanges。",
    "",
    "输出规则：",
    "- 只返回符合下面 schema 的 JSON 对象（不要夹带其他文字，不要 markdown 围栏）：",
    JSON.stringify(DIAGNOSE_SCHEMA),
    "- findings 按严重程度排序（critical 在前）。",
    "- 用中文写 summary/title/finding/reason/recommendation。",
].join("\n");

/**
 * Parse a model's diagnosis reply into a schema-shaped object, tolerating markdown fences
 * and partial/extra text (provider output varies; we deliberately don't rely on json_object mode).
 */
function parseDiagnosis(raw) {
    const stripped = String(raw || "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
    let obj;
    try {
        obj = JSON.parse(stripped);
    } catch {
        // Fallback: extract the outermost JSON object. Walk from the first '{' and count
        // braces to find its matching close — a greedy regex would over-capture if the
        // model wrapped the JSON in prose containing stray braces.
        const start = stripped.indexOf("{");
        if (start < 0) {
            throw new Error("AI did not return valid JSON");
        }
        let depth = 0;
        let end = -1;
        let inStr = false;
        let esc = false;
        for (let i = start; i < stripped.length; i++) {
            const ch = stripped[i];
            if (esc) {
                esc = false;
                continue;
            }
            if (ch === "\\") {
                esc = true;
                continue;
            }
            if (ch === '"') {
                inStr = !inStr;
                continue;
            }
            if (inStr) continue;
            if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end < 0) {
            throw new Error("AI did not return valid JSON");
        }
        obj = JSON.parse(stripped.slice(start, end + 1));
    }
    obj.findings = Array.isArray(obj.findings) ? obj.findings : [];
    obj.overallRisk = ["low", "medium", "high"].includes(obj.overallRisk) ? obj.overallRisk : "low";
    obj.summary = typeof obj.summary === "string" ? obj.summary : "";
    return obj;
}

function makeApi(store) {
    return new AiApi({ baseUrl: store.baseUrl, apiKey: store.apiKey });
}

/**
 * Format the session's applied-change batches as a context block for the model.
 * Returns "" when nothing has been applied yet. Exported for unit testing.
 */
export function formatAppliedChangeLog(batches) {
    if (!Array.isArray(batches) || !batches.length) {
        return "";
    }
    const lines = ["## Changes already applied in this session (oldest first)"];
    for (const batch of batches) {
        const when = new Date(batch.ts).toISOString();
        for (const c of batch.changes) {
            lines.push(`- [${when}] ${c.path}: ${c.current} → ${c.suggested}`);
        }
    }
    lines.push(
        "When diagnosing, compare the current tune against these earlier steps: " +
            "if a previously applied change did not fix the reported issue, say so and adjust the strategy rather than repeating it.",
    );
    return lines.join("\n");
}

export function useAiAssistant() {
    const store = useAiAssistantStore();
    const connectionStore = useConnectionStore();
    const dialog = useDialog();

    const isConnected = computed(() => connectionStore.connectionValid);
    const isConfigured = computed(() => store.isConfigured);

    // Abort controllers for cancelling in-flight requests. _abort covers streaming chat,
    // _cliAbort covers the multi-round cliAsk tool loop (which otherwise runs unbounded).
    let _abort = null;
    let _cliAbort = null;
    const isStreaming = computed(() => store.isBusy && (!!store.streamingContent || !!store.streamingReasoning));

    function cancelStreaming() {
        if (_abort) {
            _abort.abort();
            _abort = null;
        }
        if (_cliAbort) {
            _cliAbort.abort();
            _cliAbort = null;
        }
    }

    /**
     * Shared request skeleton: guards → setBusy → build payload → chat → store message → finally.
     * Both ask() and diagnose() delegate here so error/finally handling isn't duplicated.
     *
     * @param {object} args
     * @param {string} args.userText        Text shown in the conversation as the user turn.
     * @param {string} args.systemPrompt    Overrides SYSTEM_PROMPT.
     * @param {boolean} [args.useHistory]   Include recent turns (diagnose passes false).
     * @param {number} [args.temperature]
     * @param {object} [args.responseFormat]
     * @param {(raw:string)=>{content:string, suggestion?:object}} [args.postProcess]
     * @param {boolean} [args.stream]       Use streaming for free-form answers (ask only).
     * @returns {Promise<object|string>}  the suggestion object if postProcess returned one, else content
     */
    async function runChat({
        userText,
        systemPrompt,
        useHistory = true,
        temperature,
        responseFormat,
        postProcess,
        stream = false,
        extraContext = "",
    }) {
        if (!store.enabled) {
            throw new Error(i18n.getMessage("aiErrorDisabled") || "AI assistant is disabled.");
        }
        if (!store.isConfigured) {
            throw new Error(
                i18n.getMessage("aiErrorNotConfigured") ||
                    "AI service is not configured. Set API key/base URL in Options.",
            );
        }

        store.addMessage("user", userText);
        store.setBusy(true);
        store.setError("");
        store.clearStreamingContent();

        try {
            // Readable summary first, full JSON second. Models reason better over the summary
            // and use JSON only for exact values/paths. Use the TTL cache for follow-up
            // messages to avoid 10 MSP round-trips on every single chat turn.
            store.setFcFetchStatus("loading");
            const isFirstInSession = store.messages.filter((m) => m.role === "user").length <= 1;
            const tunePayload = await buildTuneContextPayload({
                forceRefresh: isFirstInSession,
            });
            const tuneContext = tunePayload?.context || null;

            if (tunePayload) {
                store.setLastFcSummary(tunePayload.text);
                if (!tunePayload.populated) {
                    const failed = tunePayload.fetch?.failed || [];
                    const detail = failed.length
                        ? failed.map((f) => `${f.label}: ${f.error}`).join("; ")
                        : "MSP returned empty/zero values";
                    store.setFcFetchStatus("empty", detail);
                    gui_log(`AI: FC snapshot empty — ${detail}`);
                } else {
                    store.setFcFetchStatus("ready");
                    gui_log(
                        `AI: FC snapshot ready (MSP ok=${tunePayload.fetch?.ok?.length || 0}, failed=${tunePayload.fetch?.failed?.length || 0})`,
                    );
                }
            } else if (connectionStore.connectionValid) {
                store.setLastFcSummary("");
                store.setFcFetchStatus("error", "Connected but snapshot was null");
            } else {
                store.setLastFcSummary("");
                store.setFcFetchStatus("disconnected");
            }

            let contextNote = "";
            if (extraContext) {
                // Blackbox / external evidence first so the model treats it as primary.
                contextNote = extraContext;
            }
            if (tunePayload) {
                contextNote +=
                    `\n\n## Current flight-controller tune (readable summary)\n${tunePayload.text}` +
                    `\n\n## Current flight-controller tune (JSON, for exact values/paths)\n\`\`\`json\n${tunePayload.json}\n\`\`\``;
            } else if (!extraContext) {
                contextNote =
                    "No flight controller is currently connected and no blackbox data is available. Cannot perform diagnostic.";
            }

            // Applied-change history: lets the model reason about before/after across the
            // tuning session ("we already raised D by 15% last step and propwash persists…").
            const changeLogNote = formatAppliedChangeLog(store.appliedChangeLog);
            if (changeLogNote) {
                contextNote += `\n\n${changeLogNote}`;
            }

            // Selectively inject relevant Betaflight wiki docs based on keyword matching
            // against the user's question + FC context. Keeps token cost low while giving
            // the model authoritative, version-specific knowledge for the specific topic.
            const wikiHaystack = `${userText}\n${tunePayload?.text || ""}`;
            const wikiDocs = await selectWikiDocs(wikiHaystack);
            if (wikiDocs.length > 0) {
                const wikiText = formatWikiContext(wikiDocs);
                contextNote += `\n\n${wikiText}`;
                gui_log(`AI: injected ${wikiDocs.map((d) => d.title).join(", ")}`);
            }

            const api = makeApi(store);
            const payload = [
                { role: "system", content: systemPrompt },
                // Carry only role+content of prior turns to avoid leaking suggestion objects.
                ...(useHistory
                    ? store.messages
                        .filter((m) => m.role === "user" || m.role === "assistant")
                        .slice(-10)
                        .map((m) => ({ role: m.role, content: m.content }))
                    : []),
                { role: "system", content: contextNote },
            ];

            const baseOpts = { model: store.model, temperature: store.temperature };
            if (typeof temperature === "number") {
                baseOpts.temperature = temperature;
            }
            // Pass the user's reasoning effort so the provider can budget thinking tokens.
            // Skipped automatically when a responseFormat is set (diagnose) per OpenAI's rule.
            baseOpts.reasoningEffort = store.reasoningEffort;

            let reply = "";
            let reasoning = "";
            // Always stream when possible so the pilot sees answer tokens AND chain-of-thought
            // tokens live. postProcess (diagnose JSON parse) still runs on the final text.
            // Fallback to non-stream only if stream is explicitly disabled.
            if (stream !== false) {
                _abort = new AbortController();
                const streamed = await api.streamChat(payload, {
                    ...baseOpts,
                    signal: _abort.signal,
                    onDelta: (_delta, full) => {
                        // During diagnose, hide raw JSON from the live bubble; still stream CoT.
                        if (!postProcess) {
                            store.setStreamingContent(full);
                        }
                    },
                    onReasoning: (_delta, fullReasoning) => {
                        reasoning = fullReasoning;
                        store.setStreamingReasoning(fullReasoning);
                    },
                });
                reply = typeof streamed === "string" ? streamed : streamed?.content || "";
                if (typeof streamed === "object" && streamed?.reasoning) {
                    reasoning = streamed.reasoning;
                }
            } else {
                const chatOpts = { ...baseOpts };
                if (responseFormat) {
                    chatOpts.responseFormat = responseFormat;
                }
                const result = await api.chat(payload, chatOpts);
                reply = result?.content || "";
                reasoning = result?.reasoning || "";
            }

            store.clearStreamingContent();
            const { content, suggestion } = postProcess ? postProcess(reply, tuneContext) : { content: reply };
            // Attach the full chain-of-thought so the conversation UI can show it above the answer.
            store.addMessage("assistant", content, suggestion, reasoning);
            return suggestion ?? content;
        } catch (e) {
            // Preserve partial streaming content if the stream failed mid-way — the user
            // may find the partial analysis useful rather than losing it entirely.
            const partial = store.streamingContent || "";
            store.clearStreamingContent();
            const msg = e instanceof AiApiError ? e.message : `AI request failed: ${e.message}`;
            store.setError(msg);
            const content = partial ? `${partial}\n\n⚠️ ${msg}` : `⚠️ ${msg}`;
            store.addMessage("assistant", content, null, "", true);
            gui_log(`AI assistant error: ${msg}`);
            throw e;
        } finally {
            store.setBusy(false);
        }
    }

    /** Free-form chat: send the user's question with the current tune as context. */
    async function ask(userText) {
        const trimmed = (userText || "").trim();
        if (!trimmed) {
            return "";
        }
        return runChat({
            userText: trimmed,
            systemPrompt: SYSTEM_PROMPT,
            useHistory: true,
            stream: true,
        });
    }

    /** CLI-assisted chat: AI can execute CLI commands (diff/get/status) autonomously. */
    async function cliAsk(userText) {
        const trimmed = (userText || "").trim();
        if (!trimmed) return "";
        if (!store.enabled) throw new Error(i18n.getMessage("aiErrorDisabled") || "AI assistant is disabled.");
        if (!store.isConfigured) throw new Error(i18n.getMessage("aiErrorNotConfigured") || "Not configured.");

        store.addMessage("user", trimmed);
        store.setBusy(true);
        store.setError("");
        store.clearStreamingContent();

        _cliAbort = new AbortController();
        try {
            const api = makeApi(store);
            const systemPrompt =
                `${SYSTEM_PROMPT}\n\n你可以使用 cli_diff、cli_get、cli_status 工具来读取飞控参数。遇到不确定的问题时先用工具获取数据再回答。` +
                `\n你还可以在用户明确要求修改参数时使用 cli_set 修改参数（每次修改用户都会确认），全部修改完成后用 cli_save 保存并重启。` +
                `未经用户要求不要主动修改参数。`;
            const messages = [
                { role: "system", content: systemPrompt },
                ...store.messages
                    .filter((m) => m.role === "user" || m.role === "assistant")
                    .slice(-8)
                    .map((m) => ({ role: m.role, content: m.content })),
            ];

            const reply = await chatWithTools(
                api,
                messages,
                {
                    model: store.model,
                    temperature: store.temperature,
                    reasoningEffort: store.reasoningEffort,
                },
                {
                    signal: _cliAbort.signal,
                    // Every FC write goes through a YesNo dialog. The command string shown to
                    // the pilot is the exact sanitized CLI line that will run — nothing else.
                    confirmWrite: (command) =>
                        dialog.showYesNo(
                            i18n.getMessage("aiCliWriteConfirmTitle") || "AI wants to change FC settings",
                            i18n.getMessage("aiCliWriteConfirmBody", { command }) ||
                                `Allow the AI assistant to run this CLI command?\n\n${command}`,
                        ),
                    onToolCall: (fnName, fnArgs) => {
                        // Show progress in the UI so the user knows the AI is executing CLI commands.
                        let label = fnName;
                        if (fnName === "cli_get") {
                            // Model-generated args may be malformed JSON — never let that abort the chat.
                            try {
                                const name = JSON.parse(fnArgs || "{}").name;
                                if (name) label = `cli_get ${name}`;
                            } catch {
                                /* keep bare fnName */
                            }
                        }
                        store.setToolCallStatus(label);
                        gui_log(`AI: tool call → ${label}`);
                    },
                    // Live token display. `full` restarts per round (each tool round is its own
                    // completion), so always overwrite rather than append. Clear the tool status
                    // once answer tokens arrive — the model is done calling tools this round.
                    onDelta: (_chunk, full) => {
                        store.setToolCallStatus("");
                        store.setStreamingContent(full);
                    },
                    onReasoning: (_chunk, full) => store.setStreamingReasoning(full),
                },
            );

            if (reply === "(cancelled)") {
                store.clearStreamingContent();
                store.addMessage("assistant", `⚠️ ${i18n.getMessage("aiCancelled") || "Cancelled."}`);
                return "";
            }
            store.clearStreamingContent();
            store.addMessage("assistant", reply);
            return reply;
        } catch (e) {
            // Preserve partial streamed content — same rationale as the runChat error path.
            const partial = store.streamingContent || "";
            store.clearStreamingContent();
            // User-initiated cancel is not an error worth surfacing as a failure.
            if (_cliAbort?.signal?.aborted || e?.message === "AI request was cancelled.") {
                store.addMessage("assistant", `⚠️ ${i18n.getMessage("aiCancelled") || "Cancelled."}`);
                return "";
            }
            const msg = e instanceof AiApiError ? e.message : `CLI chat failed: ${e.message}`;
            store.setError(msg);
            const content = partial ? `${partial}\n\n⚠️ ${msg}` : `⚠️ ${msg}`;
            store.addMessage("assistant", content, null, "", true);
            gui_log(`AI CLI tool error: ${msg}`);
            throw e;
        } finally {
            _cliAbort = null;
            store.setBusy(false);
        }
    }

    /**
     * One-click diagnostic: returns a structured report (stored as an assistant message whose
     * suggestion.kind === "diagnosis"). Independent of chat history (useHistory:false) and run
     * at temperature 0 for determinism. No write-back (P3).
     *
     * @param {object} [blackboxDigest]  optional frequency-domain summary from digestBlackbox
     */
    async function diagnose(blackboxDigest) {
        let extraContext = "";
        let userLabel = i18n.getMessage("aiDiagnoseTrigger") || "Run a one-click diagnostic on my tune.";
        const snapshot = { blackbox: null, tuneConnected: false };
        if (blackboxDigest) {
            const axes = Object.keys(blackboxDigest.axes || {});
            snapshot.blackbox = { log_type: blackboxDigest.log_type, axes };
            if (blackboxDigest.log_type === "chirp") {
                extraContext = [
                    "Blackbox CHIRP / autotune analysis — USE THIS AS YOUR PRIMARY DATA SOURCE:",
                    "```json",
                    JSON.stringify(blackboxDigest, null, 2),
                    "```",
                    "For each axis, inspect bandwidth_hz, phase_margin_deg, resonant_peak_db, sensitivity_peak_db, overshoot_pct, rise_time_ms, settling_time_ms.",
                    "Typical concerns: phase_margin_deg < 30, resonant_peak_db > 6, overshoot_pct > 30, very low bandwidth.",
                    "Only recommend PID/filter changes that are supported by these measurements.",
                ].join("\n");
            } else {
                extraContext = [
                    "Blackbox regular flight-log analysis — USE THIS AS YOUR PRIMARY DATA SOURCE:",
                    "```json",
                    JSON.stringify(blackboxDigest, null, 2),
                    "```",
                    "Analyze axes.*.noise_peaks (freq_hz, power_db) against noise_floor_db.",
                    "Treat a peak as significant only when power_db - noise_floor_db > 10.",
                    "Motor noise peaks may indicate prop/motor imbalance or insufficient RPM filtering.",
                    "Only recommend filter/PID changes supported by these peaks.",
                ].join("\n");
            }
            userLabel += ` [Blackbox: ${blackboxDigest.log_type}, axes=${axes.join(",")}]`;
            gui_log(`AI: diagnose with blackbox (type=${blackboxDigest.log_type}, axes=${axes.join(",")})`);
        } else {
            gui_log("AI: diagnose without blackbox data");
        }
        return runChat({
            userText: userLabel,
            systemPrompt: DIAGNOSE_SYSTEM_PROMPT,
            useHistory: false,
            temperature: 0,
            extraContext,
            postProcess: (raw, tuneContext) => {
                const obj = parseDiagnosis(raw);
                // Drop empty / garbage findings early so the card stays useful.
                obj.findings = (obj.findings || []).filter((f) => f && (f.title || f.finding || f.recommendation));
                const head = obj.summary || i18n.getMessage("aiDiagnose") || "Diagnostic";
                const lines = obj.findings.map((f) => `[${f.severity}] ${f.area}: ${f.title}`);
                const content = `📋 ${head}${lines.length ? `\n${lines.join("\n")}` : ""}`;
                snapshot.tuneConnected = !!tuneContext;
                return { content, suggestion: { kind: "diagnosis", ...obj, snapshot } };
            },
        });
    }

    /**
     * Manually refresh the FC snapshot and terminal panel without sending a chat.
     * Useful when the pilot just connected and wants to inspect what the AI sees.
     */
    async function refreshFcSnapshot() {
        if (!connectionStore.connectionValid) {
            store.setLastFcSummary("");
            store.setFcFetchStatus("disconnected");
            return null;
        }
        store.setFcFetchStatus("loading");
        try {
            const payload = await buildTuneContextPayload({ forceRefresh: true });
            if (!payload) {
                store.setLastFcSummary("");
                store.setFcFetchStatus("error", "Snapshot was null");
                return null;
            }
            store.setLastFcSummary(payload.text);
            if (!payload.populated) {
                const failed = payload.fetch?.failed || [];
                const detail = failed.length
                    ? failed.map((f) => `${f.label}: ${f.error}`).join("; ")
                    : "MSP returned empty/zero values";
                store.setFcFetchStatus("empty", detail);
                gui_log(`AI: FC snapshot empty — ${detail}`);
            } else {
                store.setFcFetchStatus("ready");
                gui_log(
                    `AI: FC snapshot ready (MSP ok=${payload.fetch?.ok?.length || 0}, failed=${payload.fetch?.failed?.length || 0})`,
                );
            }
            return payload;
        } catch (e) {
            const msg = e?.message || String(e);
            store.setFcFetchStatus("error", msg);
            store.setLastFcSummary("");
            gui_log(`AI: FC snapshot failed — ${msg}`);
            throw e;
        }
    }

    function resetConversation() {
        store.clearMessages();
    }

    /**
     * Fetch the list of models available on the configured provider (GET /models) and
     * cache it in the store so the Options picker can offer it.
     *
     * @param {object} [override]  optional { baseUrl, apiKey } to use instead of the store
     *   values — used by Options so the fetch reflects what the user just typed in the dialog
     *   before the store has been re-synced.
     * @returns {Promise<string[]>}  model ids (also stored)
     */
    async function fetchModels(override) {
        const baseUrl = override?.baseUrl ?? store.baseUrl;
        const apiKey = override?.apiKey ?? store.apiKey;
        if (!baseUrl || !apiKey) {
            const msg = i18n.getMessage("aiErrorNotConfigured") || "AI service is not configured.";
            store.setModelsError(msg);
            throw new Error(msg);
        }
        store.setLoadingModels(true);
        store.setModelsError("");
        try {
            const api = new AiApi({ baseUrl, apiKey });
            const ids = await api.listModels();
            store.setAvailableModels(ids);
            return ids;
        } catch (e) {
            const msg = e instanceof AiApiError ? e.message : `Failed to list models: ${e.message}`;
            store.setModelsError(msg);
            gui_log(`AI assistant listModels error: ${msg}`);
            throw e;
        } finally {
            store.setLoadingModels(false);
        }
    }

    // Clean up streaming abort controllers when the host component unmounts
    onUnmounted(() => {
        if (_abort) {
            _abort.abort();
            _abort = null;
        }
        if (_cliAbort) {
            _cliAbort.abort();
            _cliAbort = null;
        }
    });

    return {
        // state (reactive)
        messages: computed(() => store.messages),
        isHistoryLoaded: computed(() => store.isHistoryLoaded),
        isBusy: computed(() => store.isBusy),
        lastError: computed(() => store.lastError),
        streamingContent: computed(() => store.streamingContent),
        streamingReasoning: computed(() => store.streamingReasoning),
        toolCallStatus: computed(() => store.toolCallStatus),
        reasoningEffort: computed(() => store.reasoningEffort),
        setReasoningEffort: (v) => store.setReasoningEffort(v),
        // FC snapshot terminal
        lastFcSummary: computed(() => store.lastFcSummary),
        fcFetchStatus: computed(() => store.fcFetchStatus),
        fcFetchError: computed(() => store.fcFetchError),
        lastFcFetchedAt: computed(() => store.lastFcFetchedAt),
        // blackbox digest (single source of truth in store)
        lastBlackboxDigest: computed(() => store.lastBlackboxDigest),
        // model list
        availableModels: computed(() => store.availableModels),
        isLoadingModels: computed(() => store.isLoadingModels),
        modelsError: computed(() => store.modelsError),
        // gates
        isConnected,
        isConfigured,
        isEnabled: computed(() => store.enabled),
        isStreaming,
        // actions
        ask,
        cliAsk,
        diagnose,
        cancelStreaming,
        resetConversation,
        refreshFcSnapshot,
        fetchModels,
        setBlackboxDigest: (d) => store.setBlackboxDigest(d),
        clearBlackboxDigest: () => store.clearBlackboxDigest(),
        recordAppliedChanges: (changes) => store.recordAppliedChanges(changes),
        popFailedExchange: () => store.popFailedExchange(),
        syncSettings: () => store.syncFromStorage(),
    };
}
