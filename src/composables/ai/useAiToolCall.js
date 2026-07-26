import { AiApiError } from "@/js/AiApi";
import { useMspCliSession } from "@/composables/useMspCliSession";

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
 * Execute a CLI tool call against a connected FC.
 * Returns text to feed back to the AI.
 *
 * @param {string} functionName
 * @param {string} argsStr   raw JSON arguments string from the model
 * @param {{log?: function}} [sink]  per-call log sink (no shared module state)
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
            default:
                return `Unknown tool: ${functionName}`;
        }
    } catch (e) {
        const msg = e instanceof AiApiError ? e.message : String(e?.message ?? e);
        return `CLI error: ${msg}`;
    }
}

/**
 * Send messages to AI with CLI tools available.
 * Handles the tool-call loop: send → if tool_calls → execute → send results → repeat.
 *
 * @param {import("@/js/AiApi").AiApi} api
 * @param {Array} messages   Initial messages payload
 * @param {object} opts      Same as api.chat opts
 * @param {{signal?: AbortSignal, onLog?: function}} [handlers]
 * @returns {Promise<string>} Final assistant text content
 */
export async function chatWithTools(api, messages, opts = {}, { signal, onLog } = {}) {
    const sink = { log: typeof onLog === "function" ? onLog : null };
    const maxRounds = 5;
    const msgs = [...messages]; // Don't mutate the original

    for (let round = 0; round < maxRounds; round++) {
        // Honour a user-initiated cancel between rounds so the Stop button works mid-loop.
        if (signal?.aborted) {
            return "(cancelled)";
        }

        const result = await api.chat(msgs, {
            ...opts,
            tools: CLI_TOOLS,
            tool_choice: "auto",
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
