import FC from "@/js/fc";
import { getByPath } from "./pathUtils";

/**
 * Parameter range definitions. Derived from MSPHelper.js crunch() push8/push16 patterns.
 * - U8 fields: 0-255
 * - U16 fields: 0-65535
 * - *100 fields: FC stores the human-readable value (e.g. 1.80), crunch multiplies by 100
 *   before push8, so the FC-side range is 0.00-2.55.
 * - I8 fields: -128..127 (only autoProfileCellCount)
 */
const PARAM_RANGES = {
    // PIDS: 10x3 array, all U8
    // paths like "PIDS[0][0]" matched by prefix

    // RC_TUNING (*100 → push8)
    "RC_TUNING.RC_RATE": { min: 0, max: 2.55 },
    "RC_TUNING.RC_EXPO": { min: 0, max: 2.55 },
    "RC_TUNING.roll_rate": { min: 0, max: 2.55 },
    "RC_TUNING.pitch_rate": { min: 0, max: 2.55 },
    "RC_TUNING.yaw_rate": { min: 0, max: 2.55 },
    "RC_TUNING.throttle_MID": { min: 0, max: 2.55 },
    "RC_TUNING.throttle_EXPO": { min: 0, max: 2.55 },
    "RC_TUNING.RC_YAW_EXPO": { min: 0, max: 2.55 },
    "RC_TUNING.rcYawRate": { min: 0, max: 2.55 },
    "RC_TUNING.rcPitchRate": { min: 0, max: 2.55 },
    "RC_TUNING.RC_PITCH_EXPO": { min: 0, max: 2.55 },
    "RC_TUNING.throttleLimitType": { min: 0, max: 2 },
    "RC_TUNING.throttleLimitPercent": { min: 0, max: 100 },
    "RC_TUNING.roll_rate_limit": { min: 0, max: 1998 },
    "RC_TUNING.pitch_rate_limit": { min: 0, max: 1998 },
    "RC_TUNING.yaw_rate_limit": { min: 0, max: 1998 },
    "RC_TUNING.rates_type": { min: 0, max: 4 },
    "RC_TUNING.throttle_HOVER": { min: 0, max: 2.55 },

    // FILTER_CONFIG frequencies (U16)
    "FILTER_CONFIG.gyro_lowpass_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_lowpass_dyn_min_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_lowpass_dyn_max_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_lowpass2_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.dterm_lowpass_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.dterm_lowpass_dyn_min_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.dterm_lowpass_dyn_max_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.dterm_lowpass2_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.yaw_lowpass_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_notch_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_notch_cutoff": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_notch2_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_notch2_cutoff": { min: 0, max: 65535 },
    "FILTER_CONFIG.dterm_notch_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.dterm_notch_cutoff": { min: 0, max: 65535 },
    "FILTER_CONFIG.dyn_notch_min_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.dyn_notch_max_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.dyn_notch_q": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_rpm_notch_fade_range_hz": { min: 0, max: 65535 },
    "FILTER_CONFIG.gyro_rpm_notch_q": { min: 0, max: 65535 },
    // FILTER_CONFIG types (U8)
    "FILTER_CONFIG.gyro_lowpass_type": { min: 0, max: 1 },
    "FILTER_CONFIG.gyro_lowpass2_type": { min: 0, max: 1 },
    "FILTER_CONFIG.dterm_lowpass_type": { min: 0, max: 1 },
    "FILTER_CONFIG.dterm_lowpass2_type": { min: 0, max: 1 },
    "FILTER_CONFIG.gyro_hardware_lpf": { min: 0, max: 255 },
    "FILTER_CONFIG.dyn_lpf_curve_expo": { min: 0, max: 255 },
    "FILTER_CONFIG.dyn_notch_range": { min: 0, max: 255 },
    "FILTER_CONFIG.dyn_notch_width_percent": { min: 0, max: 255 },
    "FILTER_CONFIG.dyn_notch_count": { min: 0, max: 255 },
    "FILTER_CONFIG.gyro_rpm_notch_harmonics": { min: 0, max: 255 },
    "FILTER_CONFIG.gyro_rpm_notch_min_hz": { min: 0, max: 255 },

    // ADVANCED_TUNING
    "ADVANCED_TUNING.feedforwardRoll": { min: 0, max: 65535 },
    "ADVANCED_TUNING.feedforwardPitch": { min: 0, max: 65535 },
    "ADVANCED_TUNING.feedforwardYaw": { min: 0, max: 65535 },
    "ADVANCED_TUNING.dMaxRoll": { min: 0, max: 255 },
    "ADVANCED_TUNING.dMaxPitch": { min: 0, max: 255 },
    "ADVANCED_TUNING.dMaxYaw": { min: 0, max: 255 },
    "ADVANCED_TUNING.dMaxGain": { min: 0, max: 255 },
    "ADVANCED_TUNING.dMaxAdvance": { min: 0, max: 255 },
    "ADVANCED_TUNING.tpaRate": { min: 0, max: 2.55 },
    "ADVANCED_TUNING.tpaBreakpoint": { min: 0, max: 65535 },
    "ADVANCED_TUNING.motorOutputLimit": { min: 0, max: 100 },
    "ADVANCED_TUNING.idleMinRpm": { min: 0, max: 255 },
    "ADVANCED_TUNING.itermRelax": { min: 0, max: 255 },
    "ADVANCED_TUNING.itermRelaxType": { min: 0, max: 255 },
    "ADVANCED_TUNING.itermRelaxCutoff": { min: 0, max: 255 },
    "ADVANCED_TUNING.throttleBoost": { min: 0, max: 255 },
    "ADVANCED_TUNING.antiGravityGain": { min: 0, max: 65535 },
    "ADVANCED_TUNING.feedforwardTransition": { min: 0, max: 255 },
    "ADVANCED_TUNING.feedforward_averaging": { min: 0, max: 255 },
    "ADVANCED_TUNING.feedforward_smooth_factor": { min: 0, max: 255 },
    "ADVANCED_TUNING.feedforward_boost": { min: 0, max: 255 },
    "ADVANCED_TUNING.feedforward_jitter_factor": { min: 0, max: 255 },
    "ADVANCED_TUNING.vbat_sag_compensation": { min: 0, max: 255 },
    "ADVANCED_TUNING.thrustLinearization": { min: 0, max: 255 },
    "ADVANCED_TUNING.autoProfileCellCount": { min: -128, max: 127 },
    "ADVANCED_TUNING.feedforward_max_rate_limit": { min: 0, max: 65535 },

    // TUNING_SLIDERS (all U8)
    "TUNING_SLIDERS.slider_master_multiplier": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_pd_ratio": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_pd_gain": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_feedforward_gain": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_dterm_filter": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_dterm_filter_multiplier": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_gyro_filter": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_gyro_filter_multiplier": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_pids_mode": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_d_gain": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_pi_gain": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_dmax_gain": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_i_gain": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_roll_pitch_ratio": { min: 0, max: 255 },
    "TUNING_SLIDERS.slider_pitch_pi_gain": { min: 0, max: 255 },

    // MIXER_CONFIG (MSP_SET_MIXER_CONFIG: mixer U8, reverseMotorDir U8)
    "MIXER_CONFIG.mixer": { min: 0, max: 255 },
    "MIXER_CONFIG.reverseMotorDir": { min: 0, max: 1 },

    // MOTOR_CONFIG (MSP_SET_MOTOR_CONFIG: minthrottle/maxthrottle/mincommand U16,
    // motor_poles U8, use_dshot_telemetry bool)
    "MOTOR_CONFIG.minthrottle": { min: 0, max: 65535 },
    "MOTOR_CONFIG.maxthrottle": { min: 0, max: 65535 },
    "MOTOR_CONFIG.mincommand": { min: 0, max: 65535 },
    "MOTOR_CONFIG.motor_poles": { min: 0, max: 255 },
    "MOTOR_CONFIG.use_dshot_telemetry": { min: 0, max: 1 },

    // PID_ADVANCED_CONFIG (MSP_SET_ADVANCED_CONFIG) — field names mirror crunch() reads.
    "PID_ADVANCED_CONFIG.gyro_sync_denom": { min: 0, max: 255 },
    "PID_ADVANCED_CONFIG.pid_process_denom": { min: 0, max: 255 },
    "PID_ADVANCED_CONFIG.use_unsyncedPwm": { min: 0, max: 1 },
    "PID_ADVANCED_CONFIG.fast_pwm_protocol": { min: 0, max: 255 },
    "PID_ADVANCED_CONFIG.motor_pwm_rate": { min: 0, max: 65535 },
    // motorIdle is *100 → push16, so FC-side range 0.00-655.35
    "PID_ADVANCED_CONFIG.motorIdle": { min: 0, max: 655.35 },
    "PID_ADVANCED_CONFIG.motorPwmInversion": { min: 0, max: 1 },
    "PID_ADVANCED_CONFIG.gyro_to_use": { min: 0, max: 255 },
    "PID_ADVANCED_CONFIG.gyroHighFsr": { min: 0, max: 1 },
    "PID_ADVANCED_CONFIG.gyroMovementCalibThreshold": { min: 0, max: 255 },
    "PID_ADVANCED_CONFIG.gyroCalibDuration": { min: 0, max: 65535 },
    "PID_ADVANCED_CONFIG.gyroOffsetYaw": { min: 0, max: 65535 },
    "PID_ADVANCED_CONFIG.gyroCheckOverflow": { min: 0, max: 255 },
    "PID_ADVANCED_CONFIG.debugMode": { min: 0, max: 255 },
};

/**
 * Allowed top-level prefixes for paramChanges[].path.
 * Must match FC object roots and buildContext pathConvention.roots.
 */
const VALID_PREFIXES = [
    "PIDS",
    "ADVANCED_TUNING",
    "RC_TUNING",
    "FILTER_CONFIG",
    "TUNING_SLIDERS",
    "MIXER_CONFIG",
    "MOTOR_CONFIG",
    "PID_ADVANCED_CONFIG",
];

/**
 * Map common model mistakes / legacy camelCase context keys onto real FC roots.
 * Keeps apply working even when the model quotes the readable context names.
 */
const PATH_PREFIX_ALIASES = {
    pids: "PIDS",
    advancedTuning: "ADVANCED_TUNING",
    ADVANCED_TUNING: "ADVANCED_TUNING",
    rcTuning: "RC_TUNING",
    RC_TUNING: "RC_TUNING",
    filterConfig: "FILTER_CONFIG",
    FILTER_CONFIG: "FILTER_CONFIG",
    filters: "FILTER_CONFIG",
    tuningSliders: "TUNING_SLIDERS",
    TUNING_SLIDERS: "TUNING_SLIDERS",
    mixerConfig: "MIXER_CONFIG",
    MIXER_CONFIG: "MIXER_CONFIG",
    motorConfig: "MOTOR_CONFIG",
    MOTOR_CONFIG: "MOTOR_CONFIG",
    pidAdvancedConfig: "PID_ADVANCED_CONFIG",
    PID_ADVANCED_CONFIG: "PID_ADVANCED_CONFIG",
    rates: "RC_TUNING",
};

/**
 * Normalize a model-supplied path to the canonical FC path used by apply.
 * @param {string} path
 * @returns {string}
 */
export function normalizeParamPath(path) {
    if (!path || typeof path !== "string") {
        return path;
    }
    const trimmed = path.trim();
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
    if (!match) {
        return trimmed;
    }
    const [, root, rest] = match;
    const canonical = PATH_PREFIX_ALIASES[root] || root;
    return `${canonical}${rest}`;
}

/**
 * Paths whose FC encoding scales by 100 (crunch multiplies before push), so fractional
 * human-readable values are legal. Every other field is written as a whole U8/U16/I8 and
 * must be suggested as an integer — a decimal would be silently truncated on encode,
 * leaving the UI and the firmware disagreeing.
 */
const FRACTIONAL_PATHS = new Set([
    "RC_TUNING.RC_RATE",
    "RC_TUNING.RC_EXPO",
    "RC_TUNING.roll_rate",
    "RC_TUNING.pitch_rate",
    "RC_TUNING.yaw_rate",
    "RC_TUNING.throttle_MID",
    "RC_TUNING.throttle_EXPO",
    "RC_TUNING.RC_YAW_EXPO",
    "RC_TUNING.rcYawRate",
    "RC_TUNING.rcPitchRate",
    "RC_TUNING.RC_PITCH_EXPO",
    "RC_TUNING.throttle_HOVER",
    "ADVANCED_TUNING.tpaRate",
    "PID_ADVANCED_CONFIG.motorIdle",
]);

/** Path segments that must never be written through (they resolve to meta/inherited
 *  properties and would corrupt the FC object instead of updating a parameter). */
const FORBIDDEN_SEGMENTS = new Set(["length", "__proto__", "constructor", "prototype"]);

/**
 * Validate a set of parameter changes against FC field definitions.
 *
 * @param {Array<{path: string, current: *, suggested: *}>} changes
 *   from DiagnosisCard's suggestion.paramChanges
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateParamChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) {
        return { valid: true, errors: [], normalized: [] };
    }

    const errors = [];
    const normalized = [];

    for (const change of changes) {
        if (!change?.path || typeof change.path !== "string") {
            errors.push("Missing or invalid path in paramChange.");
            continue;
        }

        const path = normalizeParamPath(change.path);
        const suggested = change.suggested;

        // 1. Prefix check
        const prefix = path.split(/[.[]/)[0];
        if (!VALID_PREFIXES.includes(prefix)) {
            errors.push(`Unknown parameter prefix "${prefix}" in path "${path}".`);
            continue;
        }

        // 2. Reject meta/inherited segments: a naive existence check happily resolves
        // "PIDS.length" or a "__proto__" walk, and setByPath would then truncate the PIDS
        // array or pollute a prototype instead of writing a parameter.
        const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".");
        const badSegment = segments.find((seg) => FORBIDDEN_SEGMENTS.has(seg));
        if (badSegment !== undefined) {
            errors.push(`Path "${path}" contains forbidden segment "${badSegment}".`);
            continue;
        }

        // 3. Existence check on FC — own property of the parent object only, so inherited
        // members can never validate a hallucinated path.
        const parent = getByPath(FC, segments.slice(0, -1).join("."));
        const leaf = segments[segments.length - 1];
        if (parent == null || typeof parent !== "object" || !Object.hasOwn(parent, leaf)) {
            errors.push(`Parameter "${path}" not found on flight controller.`);
            continue;
        }
        const current = parent[leaf];

        // 4. Value type check
        if (typeof suggested !== "number" || !Number.isFinite(suggested)) {
            errors.push(`Non-numeric value for "${path}": ${JSON.stringify(suggested)}.`);
            continue;
        }

        // 5. Integer check (see FRACTIONAL_PATHS for the only legal decimals).
        if (!FRACTIONAL_PATHS.has(path) && !Number.isInteger(suggested)) {
            errors.push(`"${path}" expects an integer value, got ${suggested}.`);
            continue;
        }

        // 6. Range check (if we have a range definition)
        const range = PARAM_RANGES[path];
        if (range) {
            if (suggested < range.min || suggested > range.max) {
                errors.push(`"${path}" value ${suggested} is outside safe range [${range.min}, ${range.max}].`);
            }
        }

        // 7. PIDS array range (all U8 0-255)
        if (prefix === "PIDS" && (suggested < 0 || suggested > 255)) {
            errors.push(`PID value ${suggested} for "${path}" is outside [0, 255].`);
        }

        normalized.push({
            ...change,
            path,
            current: change.current ?? current,
            suggested,
        });
    }

    return { valid: errors.length === 0, errors, normalized };
}
