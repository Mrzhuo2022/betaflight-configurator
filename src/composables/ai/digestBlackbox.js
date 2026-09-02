import { ref } from "vue";
import { findLogBoundaries, parseChirpLog, parseRegularLog } from "@/js/blackbox/chirp_bbl_parser";
import {
    welchTransferFunction,
    computeSensitivity,
    computeStepResponse,
    recommendGains,
    hanningWindow,
} from "@/js/blackbox/spectral_analysis";
import { ComplexFFT } from "@/js/blackbox/fft";
import { gui_log } from "@/js/gui_log";

const AXIS_NAMES = ["roll", "pitch", "yaw"];

function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

function computeSampleRate(sysConfig) {
    const looptimeUs = sysConfig.looptime || 125;
    const pidDenom = sysConfig.pid_process_denom || 1;
    // P-frame interval (not I-frame ratio) determines actual data rate
    const pInterval = sysConfig.frameIntervalPNum || 1;
    return 1e6 / (looptimeUs * pidDenom * pInterval);
}

/**
 * Welch PSD: top-N frequency peaks + noise floor for a signal.
 */
function computePeaks(signal, sampleRate, numPeaks = 5) {
    const segSize = Math.min(4096, Math.max(256, nextPow2(Math.floor(sampleRate * 0.5))));
    if (signal.length < segSize) return { peaks: [], noise_floor_db: 0 };

    const win = hanningWindow(segSize);
    const winSum = win.reduce((s, w) => s + w * w, 0);
    const fft = new ComplexFFT(segSize, false);
    const halfN = segSize / 2;
    const psd = new Float64Array(halfN);
    let nSeg = 0;

    const step = Math.floor(segSize * 0.5);
    const input = new Float64Array(segSize);
    const output = new Float64Array(2 * segSize);
    for (let off = 0; off + segSize <= signal.length; off += step, nSeg++) {
        for (let i = 0; i < segSize; i++) input[i] = signal[off + i] * win[i];
        fft.simple(output, input, "real");
        for (let k = 0; k < halfN; k++) {
            psd[k] += (output[2 * k] ** 2 + output[2 * k + 1] ** 2) / (segSize * winSum);
        }
    }
    if (nSeg === 0) return { peaks: [], noise_floor_db: 0 };

    const freqRes = sampleRate / segSize;
    const db = new Float64Array(halfN);
    for (let k = 0; k < halfN; k++) db[k] = 10 * Math.log10(Math.max(psd[k] / nSeg, 1e-20));

    const peaks = [];
    for (let k = 2; k < halfN - 2; k++) {
        if (db[k] > db[k - 1] && db[k] > db[k + 1] && db[k] > db[k - 2] && db[k] > db[k + 2]) {
            peaks.push({ freq_hz: Math.round(k * freqRes * 100) / 100, power_db: Math.round(db[k] * 100) / 100 });
        }
    }
    peaks.sort((a, b) => b.power_db - a.power_db);

    const sorted = Array.from(db).sort((a, b) => a - b);
    return {
        peaks: peaks.slice(0, numPeaks),
        noise_floor_db: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 100) / 100,
    };
}

/**
 * Parse a BBL file into a compact frequency-domain summary.
 * Strategy: chirp → transfer functions; fallback → regular log gyro PSD.
 */
export async function digestBlackboxData(data, apiVersion) {
    const logs = findLogBoundaries(data);
    if (!logs || logs.length === 0) return null;

    for (const log of logs) {
        // --- Chirp / autotune ---
        try {
            const { sysConfig, chirpData } = parseChirpLog(data, log.start, log.end, apiVersion);
            if (chirpData.sampleCount > 0 && chirpData.segments.length > 0) {
                const sr = computeSampleRate(sysConfig);
                const axes = {};
                for (const seg of chirpData.segments) {
                    // Out-of-range axis indices would create an "undefined" key and feed
                    // garbage to the model as primary evidence — name them explicitly instead.
                    const name = AXIS_NAMES[seg.axis] || `axis${seg.axis}`;
                    if (axes[name]) continue;
                    const len = seg.endIdx - seg.startIdx + 1;
                    const fftN = Math.min(4096, Math.max(256, nextPow2(Math.floor(sr * 0.5))));
                    if (len < fftN) continue;
                    const input = chirpData.setpoint[seg.axis].subarray(seg.startIdx, seg.endIdx + 1);
                    const output = chirpData.gyro[seg.axis].subarray(seg.startIdx, seg.endIdx + 1);
                    const tf = welchTransferFunction(input, output, sr, fftN, 0.5);
                    const sliders = {
                        masterMultiplier: (sysConfig.simplified_master_multiplier || 100) / 100,
                        piGain: (sysConfig.simplified_pi_gain || 100) / 100,
                        iGain: (sysConfig.simplified_i_gain || 100) / 100,
                        dGain: (sysConfig.simplified_d_gain || 100) / 100,
                        feedforwardGain: (sysConfig.simplified_feedforward_gain || 100) / 100,
                        dtermFilterMultiplier: (sysConfig.simplified_dterm_filter_multiplier || 100) / 100,
                    };
                    const rec = recommendGains(tf, sliders);
                    const sens = computeSensitivity(tf);
                    const step = computeStepResponse(tf, sr, fftN);
                    axes[name] = {
                        bandwidth_hz: Math.round(rec.analysis.bandwidthHz * 100) / 100,
                        phase_margin_deg: Math.round(rec.analysis.phaseMarginDeg * 100) / 100,
                        resonant_peak_db: Math.round(rec.analysis.resonantPeakDb * 100) / 100,
                        sensitivity_peak_db: Math.round(sens.peakDb * 100) / 100,
                        overshoot_pct: Math.round(step.overshootPct * 100) / 100,
                        rise_time_ms: Math.round(step.riseTimeMs * 100) / 100,
                        settling_time_ms: Math.round(step.settlingTimeMs * 100) / 100,
                        sample_count: len,
                    };
                }
                if (Object.keys(axes).length > 0) {
                    return {
                        log_type: "chirp",
                        sample_rate_hz: Math.round(sr),
                        looptime_us: sysConfig.looptime || 125,
                        axes,
                        total_frames: chirpData.totalFrames,
                        corrupt_frames: chirpData.corruptFrames,
                    };
                }
            }
        } catch (e) {
            gui_log(`AI: blackbox chirp parse failed: ${e.message || e}`);
        }

        // --- Regular flight log ---
        try {
            const { sysConfig, flightData } = parseRegularLog(data, log.start, log.end, apiVersion);
            if (flightData.sampleCount < 256) {
                gui_log(
                    `AI: blackbox has only ${flightData.sampleCount} gyro samples (need ≥256), try a longer flight log.`,
                );
                continue;
            }

            const sr = computeSampleRate(sysConfig);
            const axes = {};
            for (let a = 0; a < 3; a++) {
                const sig = flightData.gyro[a];
                if (sig.length < 256) continue;
                try {
                    const { peaks, noise_floor_db } = computePeaks(sig, sr);
                    axes[AXIS_NAMES[a]] = { noise_peaks: peaks, noise_floor_db, sample_count: sig.length };
                } catch {
                    // axis analysis skipped
                }
            }

            const motorPsd = [];
            for (let m = 0; m < 4; m++) {
                const sig = flightData.motor[m];
                if (sig.length < 256) continue;
                try {
                    motorPsd.push({ motor: m, peaks: computePeaks(sig, sr, 3).peaks });
                } catch {
                    // skip
                }
            }

            if (Object.keys(axes).length > 0) {
                return {
                    log_type: "regular",
                    sample_rate_hz: Math.round(sr),
                    looptime_us: sysConfig.looptime || 125,
                    axes,
                    motor_noise: motorPsd,
                    total_frames: flightData.totalFrames,
                    corrupt_frames: flightData.corruptFrames,
                };
            }
        } catch (e) {
            gui_log(`AI: blackbox regular parse failed: ${e.message || e}`);
        }
    }
    return null;
}

/** Composable: digest BBL bytes with loading state. */
export function useBlackboxDigest() {
    const isProcessing = ref(false);
    const error = ref("");

    async function digest(data, apiVersion) {
        isProcessing.value = true;
        error.value = "";
        try {
            return await digestBlackboxData(data, apiVersion);
        } catch (e) {
            error.value = e.message || String(e);
            return null;
        } finally {
            isProcessing.value = false;
        }
    }

    return { isProcessing, error, digest, digestBlackboxData };
}
