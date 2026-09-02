import { describe, expect, it, vi, afterEach } from "vitest";

// Bug-hunting tests for the AiApi SSE layer. Written against the *spec* (SSE allows LF and
// CRLF line endings; data fields may span multiple lines) rather than against the
// implementation, so a parser regression shows up as a failing test, not as silent empty
// answers from spec-compliant providers.

import { AiApi } from "../../src/js/AiApi.js";

/** Build a minimal SSE-shaped response the parser can read (no jsdom Response needed). */
function sseResponse(chunks) {
    const encoder = new TextEncoder();
    const queue = chunks.map((chunk) => encoder.encode(chunk));
    return {
        ok: true,
        status: 200,
        text: async () => "",
        body: {
            getReader() {
                return {
                    read: async () => {
                        if (queue.length) {
                            return { value: queue.shift(), done: false };
                        }
                        return { value: undefined, done: true };
                    },
                    cancel: async () => {},
                };
            },
        },
    };
}

/** Stub global fetch: pass a Response-like object (always resolves with it) or an
 *  async implementation function (called with url/init). Returns the fetch mock. */
function stubFetch(implOrResponse) {
    const fetchMock = typeof implOrResponse === "function" ? vi.fn(implOrResponse) : vi.fn(async () => implOrResponse);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const api = new AiApi({ baseUrl: "https://api.example.test/v1", apiKey: "test-key" });

describe("AiApi streamChat SSE parsing", () => {
    it("parses LF-separated events", async () => {
        stubFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
                "data: [DONE]\n\n",
            ]),
        );
        const result = await api.streamChat([{ role: "user", content: "hi" }]);
        expect(result.content).toBe("Hello");
    });

    it("parses CRLF-separated events (spec §7 allows CRLF line endings)", async () => {
        // Regression: the parser previously split only on "\n\n", so a CRLF provider's
        // buffer never matched and streamChat returned empty content with no error.
        stubFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r\n',
                'data: {"choices":[{"delta":{"content":"B"}}]}\r\n\r\n',
                "data: [DONE]\r\n\r\n",
            ]),
        );
        const result = await api.streamChat([{ role: "user", content: "hi" }]);
        expect(result.content).toBe("AB");
    });

    it("handles an event split across two network chunks", async () => {
        stubFetch(
            sseResponse([
                'data: {"choices":[{"del',
                'ta":{"content":"X"}}]}\n\ndata: {"choices":[{"delta":{"content":"Y"}}]}\n\n',
                "data: [DONE]\n\n",
            ]),
        );
        const result = await api.streamChat([{ role: "user", content: "hi" }]);
        expect(result.content).toBe("XY");
    });

    it("does not duplicate tool-call names when a proxy resends the full name per delta", async () => {
        // OpenAI sends the name once as a fragment; some OpenAI-compatible proxies resend
        // the complete name in every delta, which previously accumulated as "cli_getcli_get".
        stubFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"cli_get","arguments":"{\\"name\\":"}}]}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"cli_get","arguments":"\\"p_roll\\"}"}}]}}]}\n\n',
                "data: [DONE]\n\n",
            ]),
        );
        const result = await api.streamChat([{ role: "user", content: "hi" }]);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].function.name).toBe("cli_get");
        expect(result.toolCalls[0].function.arguments).toBe('{"name":"p_roll"}');
    });

    it("concatenates genuine name fragments from OpenAI-style streaming", async () => {
        stubFetch(
            sseResponse([
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"cli_"}}]}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get"}}]}}]}\n\n',
                "data: [DONE]\n\n",
            ]),
        );
        const result = await api.streamChat([{ role: "user", content: "hi" }]);
        expect(result.toolCalls[0].function.name).toBe("cli_get");
    });

    it("reports the streaming finish_reason", async () => {
        stubFetch(sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n', "data: [DONE]\n\n"]));
        const result = await api.streamChat([{ role: "user", content: "hi" }]);
        expect(result.finishReason).toBe("length");
    });

    it("marks user-initiated cancellation with cancelled=true", async () => {
        const controller = new AbortController();
        controller.abort();
        stubFetch(async (_url, init) => {
            if (init.signal?.aborted) {
                throw new DOMException("The operation was aborted.", "AbortError");
            }
            return sseResponse([]);
        });
        await expect(
            api.streamChat([{ role: "user", content: "hi" }], { signal: controller.signal }),
        ).rejects.toMatchObject({ cancelled: true });
    });

    it("classifies an internal idle timeout as a timeout, not a cancellation", async () => {
        stubFetch(
            vi.fn(async () => {
                // Simulates the internal idle controller firing mid-stream: the combined
                // signal aborts, but the caller's signal did not — this is a timeout.
                throw new DOMException("The operation was aborted.", "AbortError");
            }),
        );
        await expect(api.streamChat([{ role: "user", content: "hi" }])).rejects.toMatchObject({
            cancelled: false,
            message: expect.stringMatching(/timed out/),
        });
    });
});

describe("AiApi chat finish_reason", () => {
    it("propagates finish_reason from a non-streaming completion", async () => {
        stubFetch({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "partial" }, finish_reason: "length" }],
            }),
        });
        const result = await api.chat([{ role: "user", content: "hi" }]);
        expect(result.content).toBe("partial");
        expect(result.finishReason).toBe("length");
    });
});
