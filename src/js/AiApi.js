/**
 * Minimal OpenAI-compatible chat completions client.
 *
 * Why OpenAI-compatible: it's the de-facto lingua franca. OpenAI, Azure OpenAI, local Ollama
 * (`/v1/chat/completions`), OpenRouter, LiteLLM, and most proxies all speak this shape, so a
 * single implementation covers BYO-key users regardless of provider. This mirrors how the
 * project's other API wrappers (BuildApi / UserApi) are thin fetch-based classes rather than
 * SDK dependencies.
 *
 * The API key never leaves the browser (stored in localStorage via ConfigStorage, sent only
 * as a Bearer header to the user-configured endpoint). See design doc "Privacy" section.
 */

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MODEL = "gpt-4o";

/**
 * Reasoning / "thinking" effort mapping, routed per provider so a single user-facing
 * setting (off|low|medium|high) works across BYO-key providers.
 *
 * DeepSeek is matched FIRST (project default): per api-docs.deepseek.com/guides/thinking_mode,
 * the thinking switch defaults to ENABLED, so "off" must be sent explicitly as
 * `thinking: {type:"disabled"}` — merely omitting the param still triggers reasoning.
 * Strength is `reasoning_effort`; DeepSeek's real levels are high/max, and low|medium are
 * compatibility-mapped to high by the API, so we send high for any non-off level.
 *
 * OpenAI o-series / GPT-5 take a top-level `reasoning_effort`. Anthropic Claude takes a
 * `thinking.budget_tokens` block. R1-style models that ignore request params (Qwen3, Grok
 * via some proxies) still surface chain-of-thought through the streaming `reasoning_content`
 * field, parsed in streamChat.
 *
 * Budgets are deliberately conservative (Sonnet caps ~64k, Opus ~64k, Haiku has none).
 * Claude 3.5 Haiku does not support extended thinking at all and is excluded.
 */
const REASONING_BUDGET_TOKENS = { low: 4096, medium: 10000, high: 24000 };
const REASONING_NO_THINKING_MODELS = /\bhaiku\b/i;

/**
 * Resolve provider-specific reasoning params to merge into the chat-completion body.
 * Returns {} when the model/effort combo doesn't warrant injection (so callers can
 * spread it unconditionally). Exported for unit testing.
 *
 * @param {string} model   model id, e.g. "deepseek-v4-pro", "gpt-5", "claude-opus-4-1"
 * @param {string} effort  "off" | "low" | "medium" | "high"
 * @returns {object}
 */
export function resolveReasoningParams(model, effort) {
    if (!model) return {};
    if (REASONING_NO_THINKING_MODELS.test(model)) return {};

    // DeepSeek (project default — matched first). Thinking defaults to ON server-side, so
    // even "off" must be expressed as an explicit disabled block; low/medium are mapped to
    // high by the API, so any enabled level resolves to effort:"high".
    if (/deepseek/i.test(model)) {
        if (!effort || effort === "off") {
            return { thinking: { type: "disabled" } };
        }
        return { thinking: { type: "enabled" }, reasoning_effort: "high" };
    }

    // OpenAI o-series / GPT-5 family: top-level reasoning_effort (no on/off switch).
    if (/^(o\d+|gpt-5)/i.test(model)) {
        if (!effort || effort === "off") return {};
        return { reasoning_effort: effort };
    }
    // Anthropic Claude (via OpenAI-compatible proxies): thinking budget (no on/off switch).
    if (/claude/i.test(model)) {
        if (!effort || effort === "off") return {};
        return {
            thinking: {
                type: "enabled",
                budget_tokens: REASONING_BUDGET_TOKENS[effort] || REASONING_BUDGET_TOKENS.medium,
            },
        };
    }
    // R1-style models that take no request param (Qwen3/Grok via proxies): reasoning, if any,
    // arrives via the streaming reasoning_content field — handled in streamChat.
    return {};
}

export class AiApiError extends Error {
    constructor(message, { status = 0, body = "" } = {}) {
        super(message);
        this.name = "AiApiError";
        this.status = status;
        this.body = body;
    }
}

export class AiApi {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl   OpenAI-compatible base, e.g. "https://api.openai.com/v1"
     * @param {string} opts.apiKey    user-supplied key
     * @param {number} [opts.timeoutMs]
     */
    constructor({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
        this.apiKey = apiKey || "";
        this.timeoutMs = timeoutMs;
    }

    /** @returns {boolean} enough configured to attempt a request */
    isConfigured() {
        return !!this.baseUrl && !!this.apiKey;
    }

    _headers() {
        return {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
        };
    }

    /**
     * Non-streaming chat completion. Returns the assistant message content string.
     *
     * @param {Array<{role: string, content: string}>} messages
     * @param {object} [opts]
     * @param {string} [opts.model]
     * @param {number} [opts.temperature]
     * @param {object} [opts.responseFormat]  passthrough for `response_format` (e.g. JSON mode)
     * @param {Array} [opts.tools]            OpenAI function-calling tools definition
     * @param {string|object} [opts.tool_choice]  "auto" | "none" | {type:"function", function:{name}}
     * @param {string} [opts.reasoningEffort] "off"|"low"|"medium"|"high" (provider-routed)
     * @param {AbortSignal} [opts.signal]     external cancel signal (user-initiated)
     * @returns {Promise<{content:string, toolCalls?:Array}>}
     */
    async chat(messages, { model, temperature, responseFormat, tools, tool_choice, reasoningEffort, signal } = {}) {
        if (!this.isConfigured()) {
            throw new AiApiError("AI service is not configured (missing base URL or API key).");
        }

        const effectiveModel = model || DEFAULT_MODEL;
        const body = {
            model: effectiveModel,
            messages,
        };
        if (typeof temperature === "number") body.temperature = temperature;
        if (responseFormat) body.response_format = responseFormat;
        if (tools) body.tools = tools;
        if (tool_choice) body.tool_choice = tool_choice;
        // OpenAI forbids reasoning_effort together with response_format JSON mode; skip when
        // a responseFormat is set (diagnose relies on plain JSON parsing instead).
        if (!responseFormat) {
            Object.assign(body, resolveReasoningParams(effectiveModel, reasoningEffort));
        }

        const res = await this._fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: this._headers(),
            body: JSON.stringify(body),
            signal,
        });

        const data = await this._safeJson(res);
        const msg = data?.choices?.[0]?.message;
        // DeepSeek / Qwen / some proxies put the chain-of-thought on the message as
        // reasoning_content (or reasoning). Surface it so the UI can render it above the answer.
        const reasoning = msg?.reasoning_content || msg?.reasoning || "";
        return {
            content: msg?.content || "",
            reasoning: typeof reasoning === "string" ? reasoning : "",
            toolCalls: msg?.tool_calls || null,
        };
    }

    /**
     * List available model ids via GET /models (OpenAI-compatible).
     * Returns a sorted, deduplicated array of model id strings.
     * Use this to populate a model picker in Options. Failures throw AiApiError with a
     * provider/CORS-aware message that can be shown directly to the user.
     *
     * @returns {Promise<string[]>}
     */
    async listModels() {
        if (!this.isConfigured()) {
            throw new AiApiError("AI service is not configured (missing base URL or API key).");
        }
        const res = await this._fetch(`${this.baseUrl}/models`, {
            method: "GET",
            headers: this._headers(),
        });
        const data = await this._safeJson(res);
        const list = Array.isArray(data?.data) ? data.data : [];
        const ids = list
            .map((m) => (typeof m === "string" ? m : m?.id))
            .filter((id) => typeof id === "string" && id.length);
        // de-dup + sort for a stable picker
        return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
    }

    /**
     * Streaming chat completion (SSE). Calls onDelta for each answer token and
     * onReasoning for each thinking token (DeepSeek / Qwen / Grok-style CoT).
     *
     * @returns {Promise<{content:string, reasoning:string}>}
     */
    async streamChat(messages, { model, temperature, reasoningEffort, onDelta, onReasoning, signal } = {}) {
        if (!this.isConfigured()) {
            throw new AiApiError("AI service is not configured (missing base URL or API key).");
        }

        const effectiveModel = model || DEFAULT_MODEL;
        const body = { model: effectiveModel, messages, stream: true };
        if (typeof temperature === "number") {
            body.temperature = temperature;
        }
        Object.assign(body, resolveReasoningParams(effectiveModel, reasoningEffort));

        const IDLE_TIMEOUT_MS = 60000;
        let idleTimer = null;
        // Use an internal controller for idle timeout so we don't abort the caller's signal
        // (which may be shared with other operations).
        const idleController = new AbortController();
        const combinedSignal = signal ? AbortSignal.any([signal, idleController.signal]) : idleController.signal;

        const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                idleController.abort();
            }, IDLE_TIMEOUT_MS);
        };

        let reader = null;
        try {
            const res = await fetch(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers: this._headers(),
                body: JSON.stringify(body),
                signal: combinedSignal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new AiApiError(`AI request failed (HTTP ${res.status}).`, {
                    status: res.status,
                    body: text.slice(0, 500),
                });
            }

            reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            let full = "";
            let reasoning = "";

            resetIdle();
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                resetIdle();
                buf += decoder.decode(value, { stream: true });

                let idx;
                while ((idx = buf.indexOf("\n\n")) >= 0) {
                    const event = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
                    if (!dataLine) continue;
                    const payload = dataLine.slice(5).trim();
                    if (payload === "[DONE]") return { content: full, reasoning };
                    let json;
                    try {
                        json = JSON.parse(payload);
                    } catch {
                        continue;
                    }

                    const delta = json?.choices?.[0]?.delta;
                    const answer = delta?.content || "";
                    if (answer) {
                        full += answer;
                        onDelta?.(answer, full);
                    }
                    const think = delta?.reasoning_content || delta?.reasoning || "";
                    if (think) {
                        reasoning += think;
                        onReasoning?.(think, reasoning);
                    }
                }
            }
            return { content: full, reasoning };
        } catch (e) {
            if (e instanceof AiApiError) throw e;
            if (e.name === "AbortError") {
                if (signal?.aborted) {
                    throw new AiApiError("AI request was cancelled.");
                }
                throw new AiApiError(`AI stream timed out (no data received for ${IDLE_TIMEOUT_MS / 1000}s).`);
            }
            throw new AiApiError(
                `AI stream failed: ${e.message}. If you are on the web/PWA build, the provider may be blocking CORS.`,
            );
        } finally {
            clearTimeout(idleTimer);
            // Release the reader so the underlying TCP connection can be reused; without this,
            // aborting mid-stream leaves the reader locked until GC on some browsers.
            if (reader) {
                try {
                    await reader.cancel();
                } catch {
                    /* already closed */
                }
            }
        }
    }

    async _fetch(url, init) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        // Bridge an external caller signal (user cancel / cliAsk abort) to the internal
        // controller that owns the timeout. Without this, `{ ...init, signal: controller.signal }`
        // would silently overwrite any signal the caller passed, making chat() uncancelable.
        const external = init?.signal;
        const onExternalAbort = () => controller.abort();
        if (external) {
            if (external.aborted) {
                controller.abort();
            } else {
                external.addEventListener("abort", onExternalAbort, { once: true });
            }
        }
        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new AiApiError(`AI request failed (HTTP ${res.status}).`, {
                    status: res.status,
                    body: text.slice(0, 500),
                });
            }
            return res;
        } catch (e) {
            if (e instanceof AiApiError) {
                throw e;
            }
            // Distinguish user-cancelled (external signal) from a hard timeout so the caller
            // can surface the right message.
            if (external?.aborted) {
                throw new AiApiError("AI request was cancelled.");
            }
            if (e.name === "AbortError") {
                throw new AiApiError(`AI request timed out after ${this.timeoutMs}ms.`);
            }
            // Network / CORS errors land here
            throw new AiApiError(
                `AI request failed: ${e.message}. If you are on the web/PWA build, the provider may be blocking CORS.`,
            );
        } finally {
            clearTimeout(timer);
            if (external) external.removeEventListener("abort", onExternalAbort);
        }
    }

    async _safeJson(res) {
        try {
            return await res.json();
        } catch {
            throw new AiApiError("AI service returned a non-JSON response.", { status: res.status });
        }
    }
}
