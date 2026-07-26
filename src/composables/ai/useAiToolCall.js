import { AiApiError } from "@/js/AiApi";
import { useMspCliSession, saveAndReconnect } from "@/composables/useMspCliSession";
import { invalidateTuneCache } from "./buildContext";

/**
 * CLI tools available to the AI. OpenAI function-calling format.
 * The AI can call these to inspect and modify FC configuration.
 */
const CLI_TOOLS = [
    {
        type: "function",
        function: {
            name: "cli_diff",
            description:
                "读取飞控当前的完整 CLI diff（等同于 'diff all' 命令），返回所有非默认配置项。用于了解飞控当前状态。",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "cli_get",
            description: "读取飞控某个参数的值。参数名如 p_roll、d_pitch、gyro_lowpass_hz、rates_type 等。",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "参数名称" },
                },
                required: ["name"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "cli_status",
            description: "读取飞控状态信息（版本、CPU 负载、传感器状态等）",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "cli_set",
            description:
                "修改飞控某个参数的值（等同于 CLI 'set name=value'）。每次调用会弹窗请用户确认，用户拒绝时返回 rejected。" +
                "只在用户明确要求修改参数时使用。修改不会自动保存——完成一批修改后必须调用 cli_save 才会写入并重启。",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "参数名称，如 p_roll、gyro_lowpass_hz" },
                    value: { type: "string", description: "新值。数字或枚举名，如 45、ON、OFF、ACTUAL" },
                },
                required: ["name", "value"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "cli_save",
            description: "保存之前 cli_set 的修改到 EEPROM 并重启飞控（等同于 CLI 'save'）。会弹窗请用户确认。",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
];

/**
 * Sanitize a model-supplied CLI parameter name before interpolating it into a command.
 *
 * The AI controls `args.name`, so without this guard a malicious or confused reply like
 * `name = "foo\nset d_roll=999\nsave"` could execute an arbitrary write command. CLI
 * parameter names are a fixed vocabulary of [A-Za-z0-9_-], so anything else is rejected.
 * Exported for unit testing.
 *
 * @param {*} raw  value coming from the model's tool-call arguments
 * @returns {string|null}  the trimmed name when valid, null otherwise
 */
export function sanitizeCliName(raw) {
    if (typeof raw !== "string") return null;
    const name = raw.trim();
    if (!name) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
    return name;
}

/**
 * Sanitize a model-supplied CLI value for `set name=value`.
 *
 * Betaflight `set` values are numbers (incl. negative/decimal) or enum identifiers
 * (ON, OFF, ACTUAL, FIRST, …). Anything outside [A-Za-z0-9_.-] (e.g. newlines, `;`,
 * `=`) could smuggle extra CLI commands, so it's rejected. Exported for unit testing.
 *
 * @param {*} raw
 * @returns {string|null}
 */
export function sanitizeCliValue(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (!value) return null;
    if (!/^-?[A-Za-z0-9_.]+$/.test(value)) return null;
    return value;
}

/**
 * Execute a CLI tool call against a connected FC.
 * Returns text to feed back to the AI.
 *
 * @param {string} functionName
 * @param {string} argsStr   raw JSON arguments string from the model
 * @param {{log?: function, confirmWrite?: (description: string) => Promise<boolean>}} [sink]
 *   per-call log sink and write-confirmation gate (no shared module state).
 *   Write tools (cli_set / cli_save) are REJECTED when confirmWrite is absent —
 *   reads never require it.
 * @returns {Promise<string>}
 */
export async function executeCliTool(functionName, argsStr, sink = {}) {
    let args = {};
    try {
        args = JSON.parse(argsStr || "{}");
    } catch {
        /* keep empty */
    }

    const cli = useMspCliSession();
    const log = typeof sink.log === "function" ? sink.log : () => {};

    try {
        switch (functionName) {
            case "cli_diff": {
                const lines = await cli.readDumpAll();
                const txt = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
                log(`[cli_diff] ${txt.length} chars`);
                return txt.slice(0, 4000); // Truncate for token limits
            }
            case "cli_get": {
                const name = sanitizeCliName(args.name);
                if (!name) return "Error: invalid parameter name";
                const res = await cli.send(`get ${name}`, { timeoutMs: 3000 });
                const txt = Array.isArray(res) ? res.join("\n") : String(res || "");
                log(`[cli_get ${name}] ${txt.slice(0, 100)}`);
                return txt;
            }
            case "cli_status": {
                const res = await cli.send("status", { timeoutMs: 5000 });
                const txt = Array.isArray(res) ? res.join("\n") : String(res || "");
                log(`[cli_status] ${txt.slice(0, 100)}`);
                return txt;
            }
            case "cli_set": {
                if (typeof sink.confirmWrite !== "function") {
                    return "Error: write tools are not enabled in this session";
                }
                const name = sanitizeCliName(args.name);
                if (!name) return "Error: invalid parameter name";
                const value = sanitizeCliValue(args.value);
                if (value === null) return "Error: invalid value";
                const command = `set ${name}=${value}`;
                const approved = await sink.confirmWrite(command);
                if (!approved) {
                    log(`[cli_set] rejected: ${command}`);
                    return `rejected: user declined '${command}'`;
                }
                const res = await cli.send(command, { timeoutMs: 3000 });
                const txt = Array.isArray(res) ? res.join("\n") : String(res || "");
                // FC values changed; the cached tune snapshot is stale now.
                invalidateTuneCache();
                log(`[cli_set] ${command} → ${txt.slice(0, 100)}`);
                return txt || "OK";
            }
            case "cli_save": {
                if (typeof sink.confirmWrite !== "function") {
                    return "Error: write tools are not enabled in this session";
                }
                const approved = await sink.confirmWrite("save");
                if (!approved) {
                    log("[cli_save] rejected");
                    return "rejected: user declined 'save'";
                }
                invalidateTuneCache();
                const { ok, error } = await saveAndReconnect();
                log(`[cli_save] ok=${ok}`);
                if (ok) {
                    // The FC is rebooting: the serial link is gone, so any further tool call
                    // this round would just error out. Signal the loop to stop offering tools.
                    sink.terminate = true;
                    return "saved: FC is rebooting and will reconnect shortly";
                }
                return `Error: save failed (${error?.message || "unknown"})`;
            }
            default:
                return `Unknown tool: ${functionName}`;
        }
    } catch (e) {
        const msg = e instanceof AiApiError ? e.message : String(e?.message ?? e);
        return `CLI error: ${msg}`;
    }
}

/** Names of tools that modify FC state — only advertised when a confirmWrite gate exists. */
const WRITE_TOOL_NAMES = new Set(["cli_set", "cli_save"]);

/**
 * Send messages to AI with CLI tools available.
 * Handles the tool-call loop: send → if tool_calls → execute → send results → repeat.
 *
 * @param {import("@/js/AiApi").AiApi} api
 * @param {Array} messages   Initial messages payload
 * @param {object} opts      Same as api.chat opts
 * @param {{signal?: AbortSignal, onLog?: function, onToolCall?: function, confirmWrite?: (description: string) => Promise<boolean>, onDelta?: function, onReasoning?: function}} [handlers]
 *   Write tools (cli_set/cli_save) are only offered to the model when confirmWrite is provided.
 *   onDelta/onReasoning stream answer/thinking tokens live (final text is still returned).
 * @returns {Promise<string>} Final assistant text content
 */
export async function chatWithTools(
    api,
    messages,
    opts = {},
    { signal, onLog, onToolCall, confirmWrite, onDelta, onReasoning } = {},
) {
    const sink = {
        log: typeof onLog === "function" ? onLog : null,
        confirmWrite: typeof confirmWrite === "function" ? confirmWrite : null,
    };
    // Don't advertise write tools the session can't confirm — the model would
    // just waste rounds calling them and getting rejections back.
    const tools = sink.confirmWrite ? CLI_TOOLS : CLI_TOOLS.filter((t) => !WRITE_TOOL_NAMES.has(t.function.name));
    const maxRounds = 5;
    const msgs = [...messages]; // Don't mutate the original

    for (let round = 0; round < maxRounds; round++) {
        // Honour a user-initiated cancel between rounds so the Stop button works mid-loop.
        if (signal?.aborted) {
            return "(cancelled)";
        }

        // After a successful cli_save the FC is rebooting and the serial link is gone —
        // withdraw all tools so the model must produce its final text answer this round.
        // streamChat accumulates tool-call fragments and returns the same shape as chat(),
        // while onDelta/onReasoning surface answer/thinking tokens live in the UI.
        const result = await api.streamChat(msgs, {
            ...opts,
            ...(sink.terminate ? {} : { tools, tool_choice: "auto" }),
            onDelta,
            onReasoning,
            signal,
        });

        // AI returned text — done
        if (result.content && !result.toolCalls) {
            return result.content;
        }

        // AI wants to call tools
        if (result.toolCalls && result.toolCalls.length > 0) {
            // Add AI's tool-call request to history
            msgs.push({
                role: "assistant",
                content: result.content || null,
                tool_calls: result.toolCalls,
            });

            for (const tc of result.toolCalls) {
                // Check abort signal before each tool execution (long CLI commands
                // like readDumpAll can take several seconds)
                if (signal?.aborted) {
                    return "(cancelled)";
                }
                if (tc.type !== "function") continue;
                const fnName = tc.function?.name;
                const fnArgs = tc.function?.arguments || "{}";
                // A cli_save earlier in this batch rebooted the FC: don't execute further
                // tools, but every tool_call id still needs a result message for the API.
                if (sink.terminate) {
                    msgs.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: "skipped: FC is rebooting after save",
                    });
                    continue;
                }
                // Report which tool is about to execute so the UI can show progress.
                onToolCall?.(fnName, fnArgs);
                const toolResult = await executeCliTool(fnName, fnArgs, sink);
                msgs.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: String(toolResult),
                });
            }
            // Loop continues — AI gets tool results and responds
            continue;
        }

        // Empty response — give up
        return result.content || "";
    }

    return "(AI tool call limit reached)";
}
