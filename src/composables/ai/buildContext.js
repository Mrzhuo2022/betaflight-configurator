import FC from "@/js/fc";
import MSP from "@/js/msp";
import MSPCodes from "@/js/msp/MSPCodes";
import { useConnectionStore } from "@/stores/connection";

/**
 * Build a compact, AI-friendly snapshot of the current flight-controller tune.
 *
 * IMPORTANT — MSP fetch before read:
 * The AI assistant calls this on demand, so FC.* may not be populated yet.
 * We actively fire MSP commands first (same pattern as BetaflightAssistant),
 * then read the reactive FC properties.
 *
 * Path convention (must stay consistent across buildContext / diagnose prompt /
 * validateSuggestion / applySuggestion):
 *   PIDS[axis][0|1|2]          // 0=P, 1=I, 2=D; axes 0=ROLL, 1=PITCH, 2=YAW
 *   ADVANCED_TUNING.<field>
 *   RC_TUNING.<field>
 *   FILTER_CONFIG.<field>
 *   TUNING_SLIDERS.<field>
 *   MIXER_CONFIG.<field>
 *   MOTOR_CONFIG.<field>
 *   PID_ADVANCED_CONFIG.<field>
 *
 * These paths resolve directly on the FC object via setByPath/getByPath.
 */

const clone = (obj) => JSON.parse(JSON.stringify(obj));

const AXIS_LABELS = ["ROLL", "PITCH", "YAW"];
const PID_TERMS = ["P", "I", "D"];

/** Top-level keys used in the AI context and for paramChanges[].path. */
export const TUNE_PATH_ROOTS = [
    "PIDS",
    "ADVANCED_TUNING",
    "RC_TUNING",
    "FILTER_CONFIG",
    "TUNING_SLIDERS",
    "MIXER_CONFIG",
    "MOTOR_CONFIG",
    "PID_ADVANCED_CONFIG",
];

function captureEnabledFeatures() {
    const features = FC.FEATURE_CONFIG?.features;
    if (!features) {
        return [];
    }
    if (typeof features.getEnabledFeatures === "function") {
        try {
            return features.getEnabledFeatures();
        } catch {
            // fall through
        }
    }
    return [];
}

/**
 * MSP codes required to populate the tune snapshot.
 * Sent SEQUENTIALLY (same pattern as ConfigurationTab / FailsafeTab) — parallel
 * Promise.all floods the serial queue and silently drops answers under load.
 */
const TUNE_MSP_SEQUENCE = [
    { code: MSPCodes.MSP_PID, label: "MSP_PID" },
    { code: MSPCodes.MSP_PIDNAMES, label: "MSP_PIDNAMES" },
    { code: MSPCodes.MSP_PID_ADVANCED, label: "MSP_PID_ADVANCED" },
    { code: MSPCodes.MSP_ADVANCED_CONFIG, label: "MSP_ADVANCED_CONFIG" },
    { code: MSPCodes.MSP_FILTER_CONFIG, label: "MSP_FILTER_CONFIG" },
    { code: MSPCodes.MSP_RC_TUNING, label: "MSP_RC_TUNING" },
    { code: MSPCodes.MSP_MOTOR_CONFIG, label: "MSP_MOTOR_CONFIG" },
    { code: MSPCodes.MSP_MIXER_CONFIG, label: "MSP_MIXER_CONFIG" },
    { code: MSPCodes.MSP_SIMPLIFIED_TUNING, label: "MSP_SIMPLIFIED_TUNING" },
    { code: MSPCodes.MSP_FEATURE_CONFIG, label: "MSP_FEATURE_CONFIG" },
];

/**
 * Fire MSP commands to populate the FC.* tuning fields.
 * @returns {Promise<{ok: string[], failed: Array<{label: string, error: string}>}>}
 */
async function fetchTuningData() {
    const ok = [];
    const failed = [];

    // Prefer the live module, fall back to the window global used by legacy tabs.
    const msp = MSP || (typeof window !== "undefined" ? window.MSP : null);
    if (!msp || typeof msp.promise !== "function") {
        failed.push({ label: "MSP", error: "MSP module unavailable" });
        return { ok, failed };
    }

    // Classic CLI mode steals the serial receive path (read_serial routes to TABS.cli),
    // so MSP responses never reach mspHelper.process_data. Fail fast with a clear reason.
    try {
        const { default: CONFIGURATOR } = await import("@/js/data_storage");
        if (CONFIGURATOR?.cliActive) {
            failed.push({
                label: "MSP",
                error: "CLI mode is active — exit CLI tab/mode before reading FC tune via MSP",
            });
            return { ok, failed };
        }
    } catch {
        // data_storage may be unavailable in unit tests; continue.
    }

    for (const { code, label } of TUNE_MSP_SEQUENCE) {
        try {
            await msp.promise(code);
            ok.push(label);
        } catch (e) {
            failed.push({ label, error: e?.message || String(e) });
        }
    }
    return { ok, failed };
}

/**
 * Detect whether the FC snapshot looks like real live data rather than zeros left
 * over from resetState(). Used to warn the UI when MSP "succeeded" but values are empty.
 */
function looksPopulated(ctx) {
    if (!ctx) {
        return false;
    }
    const roll = ctx.pids?.ROLL;
    const hasPid = roll && (roll.P || roll.I || roll.D);
    const f = ctx.FILTER_CONFIG || {};
    const hasFilter = f.gyro_lowpass_dyn_min_hz || f.gyro_lowpass_hz || f.dterm_lowpass_dyn_min_hz || f.dyn_notch_count;
    const r = ctx.RC_TUNING || {};
    const hasRates = r.RC_RATE || r.roll_rate || r.rcPitchRate;
    return !!(hasPid || hasFilter || hasRates);
}

/**
 * Shape PIDS into a human-readable map the model can reason about,
 * while still exposing the exact path needed for apply.
 *
 * Example:
 *   {
 *     ROLL:  { P: 45, I: 80, D: 30, path: { P: "PIDS[0][0]", I: "PIDS[0][1]", D: "PIDS[0][2]" } },
 *     ...
 *   }
 */
function shapePids() {
    const pids = FC.PIDS || [];
    const names = FC.PID_NAMES || [];
    const shaped = {};

    for (let axis = 0; axis < 3; axis++) {
        const label = AXIS_LABELS[axis];
        const row = Array.isArray(pids[axis]) ? pids[axis] : [0, 0, 0];
        const entry = {
            name: names[axis] || label,
            P: row[0] ?? 0,
            I: row[1] ?? 0,
            D: row[2] ?? 0,
            path: {
                P: `PIDS[${axis}][0]`,
                I: `PIDS[${axis}][1]`,
                D: `PIDS[${axis}][2]`,
            },
        };
        shaped[label] = entry;
    }

    // Keep remaining PID groups (LEVEL, MAG, etc.) for completeness if present.
    for (let i = 3; i < pids.length; i++) {
        const name = names[i] || `PID_${i}`;
        const row = Array.isArray(pids[i]) ? pids[i] : null;
        if (!row) {
            continue;
        }
        shaped[name] = {
            name,
            P: row[0] ?? 0,
            I: row[1] ?? 0,
            D: row[2] ?? 0,
            path: {
                P: `PIDS[${i}][0]`,
                I: `PIDS[${i}][1]`,
                D: `PIDS[${i}][2]`,
            },
        };
    }

    return shaped;
}

/**
 * Pick the tuning-relevant advanced fields and annotate with path hints.
 */
function shapeAdvancedTuning() {
    const a = FC.ADVANCED_TUNING || {};
    return {
        feedforward: {
            roll: a.feedforwardRoll,
            pitch: a.feedforwardPitch,
            yaw: a.feedforwardYaw,
            transition: a.feedforwardTransition,
            averaging: a.feedforward_averaging,
            smooth_factor: a.feedforward_smooth_factor,
            boost: a.feedforward_boost,
            jitter_factor: a.feedforward_jitter_factor,
            max_rate_limit: a.feedforward_max_rate_limit,
        },
        dMax: {
            roll: a.dMaxRoll,
            pitch: a.dMaxPitch,
            yaw: a.dMaxYaw,
            gain: a.dMaxGain,
            advance: a.dMaxAdvance,
        },
        tpa: {
            rate: a.tpaRate,
            breakpoint: a.tpaBreakpoint,
        },
        itermRelax: {
            mode: a.itermRelax,
            type: a.itermRelaxType,
            cutoff: a.itermRelaxCutoff,
        },
        antiGravityGain: a.antiGravityGain,
        throttleBoost: a.throttleBoost,
        motorOutputLimit: a.motorOutputLimit,
        idleMinRpm: a.idleMinRpm,
        vbat_sag_compensation: a.vbat_sag_compensation,
        thrustLinearization: a.thrustLinearization,
        // Raw object kept so the model can quote exact field paths for apply.
        _rawPaths: "ADVANCED_TUNING.<fieldName>",
        _raw: clone(a),
    };
}

function shapeFilters() {
    const f = FC.FILTER_CONFIG || {};
    return {
        gyro: {
            lpf1_static_hz: f.gyro_lowpass_hz,
            lpf1_dyn_min_hz: f.gyro_lowpass_dyn_min_hz,
            lpf1_dyn_max_hz: f.gyro_lowpass_dyn_max_hz,
            lpf1_type: f.gyro_lowpass_type,
            lpf2_static_hz: f.gyro_lowpass2_hz,
            lpf2_type: f.gyro_lowpass2_type,
            notch1_hz: f.gyro_notch_hz,
            notch1_cutoff: f.gyro_notch_cutoff,
            notch2_hz: f.gyro_notch2_hz,
            notch2_cutoff: f.gyro_notch2_cutoff,
            rpm_harmonics: f.gyro_rpm_notch_harmonics,
            rpm_min_hz: f.gyro_rpm_notch_min_hz,
            rpm_q: f.gyro_rpm_notch_q,
            rpm_fade_range_hz: f.gyro_rpm_notch_fade_range_hz,
        },
        dterm: {
            lpf1_static_hz: f.dterm_lowpass_hz,
            lpf1_dyn_min_hz: f.dterm_lowpass_dyn_min_hz,
            lpf1_dyn_max_hz: f.dterm_lowpass_dyn_max_hz,
            lpf1_type: f.dterm_lowpass_type,
            lpf2_static_hz: f.dterm_lowpass2_hz,
            lpf2_type: f.dterm_lowpass2_type,
            notch_hz: f.dterm_notch_hz,
            notch_cutoff: f.dterm_notch_cutoff,
        },
        dyn_notch: {
            count: f.dyn_notch_count,
            q: f.dyn_notch_q,
            min_hz: f.dyn_notch_min_hz,
            max_hz: f.dyn_notch_max_hz,
            width_percent: f.dyn_notch_width_percent,
        },
        yaw_lowpass_hz: f.yaw_lowpass_hz,
        // Exact FC field names for paramChanges paths.
        _rawPaths: "FILTER_CONFIG.<fieldName>",
        _raw: clone(f),
    };
}

function shapeRates() {
    const r = FC.RC_TUNING || {};
    return {
        rates_type: r.rates_type,
        roll: { rc_rate: r.RC_RATE, srate: r.roll_rate, expo: r.RC_EXPO, rate_limit: r.roll_rate_limit },
        pitch: { rc_rate: r.rcPitchRate, srate: r.pitch_rate, expo: r.RC_PITCH_EXPO, rate_limit: r.pitch_rate_limit },
        yaw: { rc_rate: r.rcYawRate, srate: r.yaw_rate, expo: r.RC_YAW_EXPO, rate_limit: r.yaw_rate_limit },
        throttle: {
            mid: r.throttle_MID,
            expo: r.throttle_EXPO,
            hover: r.throttle_HOVER,
            limit_type: r.throttleLimitType,
            limit_percent: r.throttleLimitPercent,
        },
        _rawPaths: "RC_TUNING.<fieldName>",
        _raw: clone(r),
    };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.includeFeatures]
 * @returns {Promise<object|null>}
 */
export async function buildTuneContext({ includeFeatures = true } = {}) {
    const connectionStore = useConnectionStore();
    if (!connectionStore.connectionValid) {
        return null;
    }

    const fetchResult = await fetchTuningData();

    const meta = {
        apiVersion: FC.CONFIG?.apiVersion,
        flightControllerVersion: FC.CONFIG?.flightControllerVersion,
        boardType: FC.CONFIG?.boardType,
        boardName: FC.CONFIG?.boardName || "",
        hardwareName: FC.CONFIG?.hardwareName || "",
        profile: FC.CONFIG?.profile,
        rateProfile: FC.CONFIG?.rateProfile,
        pidProfileName: FC.CONFIG?.pidProfileNames?.[FC.CONFIG?.profile] || "",
        rateProfileName: FC.CONFIG?.rateProfileNames?.[FC.CONFIG?.rateProfile] || "",
        mspOk: fetchResult.ok,
        mspFailed: fetchResult.failed,
    };

    const context = {
        meta,
        // Human-readable shapes first — these are what the model should reason over.
        pids: shapePids(),
        advancedTuning: shapeAdvancedTuning(),
        filters: shapeFilters(),
        rates: shapeRates(),
        tuningSliders: clone(FC.TUNING_SLIDERS),
        mixerConfig: clone(FC.MIXER_CONFIG),
        motorConfig: clone(FC.MOTOR_CONFIG),
        pidAdvancedConfig: clone(FC.PID_ADVANCED_CONFIG),
        // Raw FC-shaped objects for exact path application. paramChanges[].path
        // MUST use these root names so validate/apply can resolve them on FC.
        PIDS: clone(FC.PIDS),
        ADVANCED_TUNING: clone(FC.ADVANCED_TUNING),
        RC_TUNING: clone(FC.RC_TUNING),
        FILTER_CONFIG: clone(FC.FILTER_CONFIG),
        TUNING_SLIDERS: clone(FC.TUNING_SLIDERS),
        MIXER_CONFIG: clone(FC.MIXER_CONFIG),
        MOTOR_CONFIG: clone(FC.MOTOR_CONFIG),
        PID_ADVANCED_CONFIG: clone(FC.PID_ADVANCED_CONFIG),
        pathConvention: {
            roots: TUNE_PATH_ROOTS,
            examples: [
                "PIDS[0][0]  // ROLL P",
                "PIDS[1][2]  // PITCH D",
                "FILTER_CONFIG.gyro_lowpass_dyn_min_hz",
                "ADVANCED_TUNING.dMaxRoll",
                "RC_TUNING.roll_rate",
                "TUNING_SLIDERS.slider_d_gain",
                "PID_ADVANCED_CONFIG.motorIdle",
            ],
            note: "paramChanges[].path MUST use one of the roots above and match the _raw / raw FC field names exactly.",
        },
    };

    if (includeFeatures) {
        context.enabledFeatures = captureEnabledFeatures();
    }

    context._populated = looksPopulated(context);
    context._fetch = fetchResult;
    return context;
}

/**
 * Compact plain-text summary — easier for the model to scan than raw JSON alone.
 * Still pairs with the full JSON for exact numbers/paths.
 */
export function formatTuneContextText(ctx) {
    if (!ctx) {
        return "";
    }

    const lines = [];
    const m = ctx.meta || {};
    lines.push("## Flight Controller");
    lines.push(`- Firmware: ${m.flightControllerVersion || "?"} (API ${m.apiVersion || "?"})`);
    lines.push(`- Board: ${m.hardwareName || m.boardName || m.boardType || "?"}`);
    lines.push(`- PID profile: ${m.profile}${m.pidProfileName ? ` (${m.pidProfileName})` : ""}`);
    lines.push(`- Rate profile: ${m.rateProfile}${m.rateProfileName ? ` (${m.rateProfileName})` : ""}`);
    if (Array.isArray(m.mspOk)) {
        lines.push(`- MSP ok (${m.mspOk.length}): ${m.mspOk.join(", ") || "(none)"}`);
    }
    if (Array.isArray(m.mspFailed) && m.mspFailed.length) {
        lines.push(
            `- MSP failed (${m.mspFailed.length}): ${m.mspFailed.map((f) => `${f.label}: ${f.error}`).join(" | ")}`,
        );
    }
    if (ctx._populated === false) {
        lines.push("- WARNING: snapshot looks empty/unpopulated. MSP may have failed or returned zeros.");
    }
    lines.push("");

    lines.push("## PIDs  (path = PIDS[axis][P=0|I=1|D=2])");
    for (const axis of AXIS_LABELS) {
        const p = ctx.pids?.[axis];
        if (!p) {
            continue;
        }
        lines.push(`- ${axis}: P=${p.P} (${p.path.P}), I=${p.I} (${p.path.I}), D=${p.D} (${p.path.D})`);
    }
    lines.push("");

    const a = ctx.advancedTuning || {};
    lines.push("## Advanced Tuning  (path = ADVANCED_TUNING.<field>)");
    if (a.feedforward) {
        lines.push(`- FF: roll=${a.feedforward.roll}, pitch=${a.feedforward.pitch}, yaw=${a.feedforward.yaw}`);
    }
    if (a.dMax) {
        lines.push(
            `- D_Max: roll=${a.dMax.roll}, pitch=${a.dMax.pitch}, yaw=${a.dMax.yaw}, gain=${a.dMax.gain}, advance=${a.dMax.advance}`,
        );
    }
    if (a.tpa) {
        lines.push(`- TPA: rate=${a.tpa.rate}, breakpoint=${a.tpa.breakpoint}`);
    }
    if (a.itermRelax) {
        lines.push(
            `- I-Term Relax: mode=${a.itermRelax.mode}, type=${a.itermRelax.type}, cutoff=${a.itermRelax.cutoff}`,
        );
    }
    lines.push(`- Anti-Gravity gain: ${a.antiGravityGain}`);
    lines.push(`- Motor output limit: ${a.motorOutputLimit}`);
    lines.push("");

    const f = ctx.filters || {};
    lines.push("## Filters  (path = FILTER_CONFIG.<field>)");
    if (f.gyro) {
        lines.push(
            `- Gyro LPF1: static=${f.gyro.lpf1_static_hz} Hz, dyn=${f.gyro.lpf1_dyn_min_hz}-${f.gyro.lpf1_dyn_max_hz} Hz (type ${f.gyro.lpf1_type})`,
        );
        lines.push(`- Gyro LPF2: static=${f.gyro.lpf2_static_hz} Hz (type ${f.gyro.lpf2_type})`);
        lines.push(
            `- Gyro notches: n1=${f.gyro.notch1_hz}/${f.gyro.notch1_cutoff}, n2=${f.gyro.notch2_hz}/${f.gyro.notch2_cutoff}`,
        );
        lines.push(`- RPM filter: harmonics=${f.gyro.rpm_harmonics}, min=${f.gyro.rpm_min_hz} Hz, Q=${f.gyro.rpm_q}`);
    }
    if (f.dterm) {
        lines.push(
            `- DTerm LPF1: static=${f.dterm.lpf1_static_hz} Hz, dyn=${f.dterm.lpf1_dyn_min_hz}-${f.dterm.lpf1_dyn_max_hz} Hz`,
        );
        lines.push(`- DTerm LPF2: static=${f.dterm.lpf2_static_hz} Hz`);
    }
    if (f.dyn_notch) {
        lines.push(
            `- Dyn notch: count=${f.dyn_notch.count}, Q=${f.dyn_notch.q}, range=${f.dyn_notch.min_hz}-${f.dyn_notch.max_hz} Hz`,
        );
    }
    lines.push("");

    const r = ctx.rates || {};
    lines.push("## Rates  (path = RC_TUNING.<field>)");
    lines.push(`- Type: ${r.rates_type}`);
    if (r.roll) {
        lines.push(
            `- ROLL: rcRate=${r.roll.rc_rate}, sRate=${r.roll.srate}, expo=${r.roll.expo}, limit=${r.roll.rate_limit}`,
        );
    }
    if (r.pitch) {
        lines.push(
            `- PITCH: rcRate=${r.pitch.rc_rate}, sRate=${r.pitch.srate}, expo=${r.pitch.expo}, limit=${r.pitch.rate_limit}`,
        );
    }
    if (r.yaw) {
        lines.push(
            `- YAW: rcRate=${r.yaw.rc_rate}, sRate=${r.yaw.srate}, expo=${r.yaw.expo}, limit=${r.yaw.rate_limit}`,
        );
    }
    lines.push("");

    const sl = ctx.TUNING_SLIDERS || ctx.tuningSliders || {};
    lines.push("## Tuning Sliders  (path = TUNING_SLIDERS.<field>)");
    lines.push(
        `- mode=${sl.slider_pids_mode}, master=${sl.slider_master_multiplier}, pd_gain=${sl.slider_pd_gain}, d_gain=${sl.slider_d_gain}, pi_gain=${sl.slider_pi_gain}, i_gain=${sl.slider_i_gain}, ff_gain=${sl.slider_feedforward_gain}, dmax_gain=${sl.slider_dmax_gain}`,
    );
    lines.push(
        `- gyro_filter=${sl.slider_gyro_filter} x${sl.slider_gyro_filter_multiplier}, dterm_filter=${sl.slider_dterm_filter} x${sl.slider_dterm_filter_multiplier}`,
    );
    lines.push("");

    const motor = ctx.MOTOR_CONFIG || ctx.motorConfig || {};
    const adv = ctx.PID_ADVANCED_CONFIG || ctx.pidAdvancedConfig || {};
    lines.push("## Motors");
    lines.push(`- throttle range: ${motor.minthrottle}-${motor.maxthrottle} (mincommand ${motor.mincommand})`);
    lines.push(`- poles: ${motor.motor_poles}, dshot telemetry: ${motor.use_dshot_telemetry}`);
    lines.push(
        `- digital idle (PID_ADVANCED_CONFIG.motorIdle): ${adv.motorIdle}, pwm protocol: ${adv.fast_pwm_protocol}, rate: ${adv.motor_pwm_rate}`,
    );

    if (Array.isArray(ctx.enabledFeatures) && ctx.enabledFeatures.length) {
        lines.push("");
        lines.push(`## Enabled features: ${ctx.enabledFeatures.join(", ")}`);
    }

    lines.push("");
    lines.push("## Path rules for paramChanges");
    lines.push(`- Use ONLY these roots: ${TUNE_PATH_ROOTS.join(", ")}`);
    lines.push("- Examples: PIDS[0][0], FILTER_CONFIG.gyro_lowpass_dyn_min_hz, ADVANCED_TUNING.dMaxRoll");
    lines.push("- Prefer small, evidence-backed changes. Do not invent field names.");

    return lines.join("\n");
}

/**
 * @returns {Promise<string|null>} JSON string, or null when not connected
 */
export async function buildTuneContextJson(opts) {
    const ctx = await buildTuneContext(opts);
    return ctx ? JSON.stringify(ctx, null, 2) : null;
}

/**
 * Full prompt payload: readable summary + JSON for exact values/paths.
 * @returns {Promise<{ text: string, json: string, context: object, populated: boolean, fetch: object }|null>}
 */
export async function buildTuneContextPayload(opts) {
    const ctx = await buildTuneContext(opts);
    if (!ctx) {
        return null;
    }
    // Strip internal bookkeeping from the JSON sent to the model — keep it on the
    // returned object for the UI terminal.
    const { _populated, _fetch, ...promptCtx } = ctx;
    return {
        context: ctx,
        text: formatTuneContextText(ctx),
        json: JSON.stringify(promptCtx, null, 2),
        populated: !!_populated,
        fetch: _fetch || { ok: [], failed: [] },
    };
}

// Re-export helpers used by prompts / tests.
export { AXIS_LABELS, PID_TERMS };
