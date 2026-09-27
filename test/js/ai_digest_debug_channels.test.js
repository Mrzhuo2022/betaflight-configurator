import { describe, expect, it, vi, beforeEach } from "vitest";

// Tests for debug-channel extraction in digestBlackboxData.
//
// Rationale: the digest used to analyze only gyro + motor PSD, so a log recorded with
// debug_mode = D_MAX or GYRO_SCALED carried uninterpretable "debug[0..3]" values for the
// model. These tests pin the contract: the recorded debug_mode must resolve to the
// firmware enum name via the shared debugModes table, channels must carry the friendly
// labels (e.g. "Actual D [roll]"), and logs without a resolvable debug_mode must omit
// the debug section entirely rather than feed the model unlabeled noise.

vi.mock("@/js/gui_log", () => ({ gui_log: vi.fn() }));

// The parser is mocked (no sample .bbl fixture in the repo): parseChirpLog always throws
// so digestBlackboxData takes the regular-log branch for every fake log.
const parseRegularLogMock = vi.fn();
vi.mock("@/js/blackbox/chirp_bbl_parser", () => ({
    findLogBoundaries: vi.fn(() => [{ start: 0, end: 10 }]),
    parseChirpLog: vi.fn(() => {
        throw new Error("not a chirp log");
    }),
    parseRegularLog: parseRegularLogMock,
}));

const { getDebugModes, getDebugFieldNames } = await import("@/js/utils/debugModes");
const { digestBlackboxData } = await import("../../src/composables/ai/digestBlackbox");

const N = 2048; // ≥ segSize (1024 @ 2 kHz) so computePeaks produces real peaks
const SR = 2000;

/** 2048-sample sine at `freq` Hz with amplitude `amp` — enough for a clean PSD peak. */
function sine(freq, amp = 100) {
    const sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    return sig;
}

const gyroArrays = () => [sine(300), sine(300, 80), sine(300, 60)];

function mockLog({ debugMode, debug = [sine(337.89), sine(337.89), sine(337.89), sine(337.89)] }) {
    parseRegularLogMock.mockReturnValue({
        sysConfig: { looptime: 125, pid_process_denom: 4, debug_mode: debugMode },
        flightData: {
            gyro: gyroArrays(),
            motor: [sine(337.89, 500), sine(337.89, 480), sine(337.89, 470), sine(337.89, 490)],
            debug,
            debugMode,
            sampleCount: N,
            totalFrames: N,
            corruptFrames: 0,
        },
    });
}

beforeEach(() => {
    parseRegularLogMock.mockReset();
});

describe("digestBlackboxData debug channels", () => {
    it("labels channels from the recorded debug_mode (D_MAX)", async () => {
        // D_MAX only exists in the 1.47+ firmware enum (the pre-1.47 slot is D_MIN), so
        // resolve the index and the digest names against the same versioned table.
        const dmaxIndex = getDebugModes("1.47.0").indexOf("D_MAX");
        mockLog({ debugMode: dmaxIndex });
        const digest = await digestBlackboxData(new Uint8Array(16), "1.47.0");
        expect(digest.debug_mode).toBe(dmaxIndex);
        expect(digest.debug_mode_name).toBe("D_MAX");
        expect(digest.debug_channels).toHaveLength(4);
        expect(digest.debug_channels[2].label).toBe("Actual D [roll]");
        expect(digest.debug_channels[3].label).toBe("Actual D [pitch]");
        // A 337.89 Hz sine must show up as a peak near that frequency.
        const peaks = digest.debug_channels[2].peaks;
        expect(peaks.length).toBeGreaterThan(0);
        expect(Math.abs(peaks[0].freq_hz - 337.89)).toBeLessThan(10);
    });

    it("resolves GYRO_SCALED for the base enum (pre-1.47 index 6)", async () => {
        mockLog({ debugMode: getDebugModes(undefined).indexOf("GYRO_SCALED") });
        const digest = await digestBlackboxData(new Uint8Array(16), undefined);
        expect(digest.debug_mode_name).toBe("GYRO_SCALED");
        expect(digest.debug_channels[0].label).toBe("Gyro Scaled [roll]");
    });

    it("omits the debug section when debug_mode is missing (-1)", async () => {
        mockLog({ debugMode: -1 });
        const digest = await digestBlackboxData(new Uint8Array(16), undefined);
        expect(digest.log_type).toBe("regular");
        expect("debug_mode" in digest).toBe(false);
        expect("debug_mode_name" in digest).toBe(false);
        expect("debug_channels" in digest).toBe(false);
    });

    it("omits debug_channels when the log recorded no debug fields", async () => {
        mockLog({
            debugMode: getDebugModes("1.47.0").indexOf("D_MAX"),
            debug: [new Float32Array(0), new Float32Array(0), new Float32Array(0), new Float32Array(0)],
        });
        const digest = await digestBlackboxData(new Uint8Array(16), "1.47.0");
        expect(digest.debug_mode_name).toBe("D_MAX");
        expect("debug_channels" in digest).toBe(false);
    });

    it("resolves names against the apiVersion table, not just the base list", async () => {
        // API 1.47+ removes GYRO_SCALED from the enum, so index 6 must NOT resolve to it.
        mockLog({ debugMode: 6 });
        const digest = await digestBlackboxData(new Uint8Array(16), "1.47.0");
        const baseIndex6 = getDebugModes("1.47.0")[6];
        expect(digest.debug_mode_name).toBe(baseIndex6);
        expect(digest.debug_mode_name).not.toBe("GYRO_SCALED");
        // Labels come from the same versioned table.
        expect(digest.debug_channels[0].label).toBe(
            getDebugFieldNames("1.47.0")[baseIndex6]?.["debug[0]"] ?? `debug[0]`,
        );
    });
});
