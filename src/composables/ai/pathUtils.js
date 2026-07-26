/**
 * Shared path utilities for AI assistant composables.
 * Used by both applySuggestion.js and validateSuggestion.js.
 */

/**
 * Resolve a dot/bracket path to read a value from an object. Returns undefined if not found.
 * @param {object} obj
 * @param {string} path  e.g. "PIDS[0][0]", "RC_TUNING.roll_rate"
 * @returns {*}
 */
export function getByPath(obj, path) {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let cur = obj;
    for (const p of parts) {
        if (cur == null) {
            return undefined;
        }
        cur = cur[p];
    }
    return cur;
}

/**
 * Resolve a dot/bracket path to set a value on an object.
 * @param {object} obj
 * @param {string} path
 * @param {*} value
 * @returns {boolean} true if the value was set, false if an intermediate path was null
 */
export function setByPath(obj, path, value) {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = cur[parts[i]];
        if (cur == null) {
            return false;
        }
    }
    cur[parts[parts.length - 1]] = value;
    return true;
}
