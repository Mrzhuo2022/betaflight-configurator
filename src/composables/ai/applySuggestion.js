import { ref } from "vue";
import FC from "@/js/fc";
import MSP from "@/js/msp";
import MSPCodes from "@/js/msp/MSPCodes";
import { mspHelper } from "@/js/msp/MSPHelper";
import { isMspCancelled } from "@/js/msp/mspErrors";
import { useMspCliSession, isMspCliSupported, saveAndReconnect } from "@/composables/useMspCliSession";
import { useReboot } from "@/composables/useReboot";
import { normalizeParamPath, validateParamChanges } from "./validateSuggestion";
import { gui_log } from "@/js/gui_log";
import { i18n } from "@/js/localization";

/**
 * Resolve a dot/bracket path to set a value on the FC object.
 */
function setByPath(obj, path, value) {
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

/**
 * Resolve a dot/bracket path to read a value from an object. Returns undefined if not found.
 * Mirrors the private getter in validateSuggestion.js — kept local to avoid coupling.
 */
function getByPath(obj, path) {
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
 * Determine which MSP SET commands are needed based on the param paths being changed.
 * Paths must already be normalized to FC roots (PIDS, RC_TUNING, FILTER_CONFIG, ...).
 */
function collectMspCodes(changes) {
    const codes = new Set();
    for (const { path: rawPath } of changes) {
        const path = normalizeParamPath(rawPath);
        // PIDS (FC.PIDS) ← MSP_SET_PID
        if (path.startsWith("PIDS")) {
            codes.add(MSPCodes.MSP_SET_PID);
        }
        // RC_TUNING ← MSP_SET_RC_TUNING
        if (path.startsWith("RC_TUNING")) {
            codes.add(MSPCodes.MSP_SET_RC_TUNING);
        }
        // FILTER_CONFIG ← MSP_SET_FILTER_CONFIG
        if (path.startsWith("FILTER_CONFIG")) {
            codes.add(MSPCodes.MSP_SET_FILTER_CONFIG);
        }
        // ADVANCED_TUNING ← MSP_SET_PID_ADVANCED
        if (path.startsWith("ADVANCED_TUNING")) {
            codes.add(MSPCodes.MSP_SET_PID_ADVANCED);
        }
        // PID_ADVANCED_CONFIG ← MSP_SET_ADVANCED_CONFIG
        if (path.startsWith("PID_ADVANCED_CONFIG")) {
            codes.add(MSPCodes.MSP_SET_ADVANCED_CONFIG);
        }
        // TUNING_SLIDERS ← MSP_SET_SIMPLIFIED_TUNING
        if (path.startsWith("TUNING_SLIDERS")) {
            codes.add(MSPCodes.MSP_SET_SIMPLIFIED_TUNING);
        }
        // MIXER_CONFIG ← MSP_SET_MIXER_CONFIG
        if (path.startsWith("MIXER_CONFIG")) {
            codes.add(MSPCodes.MSP_SET_MIXER_CONFIG);
        }
        // MOTOR_CONFIG ← MSP_SET_MOTOR_CONFIG
        if (path.startsWith("MOTOR_CONFIG")) {
            codes.add(MSPCodes.MSP_SET_MOTOR_CONFIG);
        }
    }
    return codes;
}

/**
 * Composable for applying AI-suggested parameter changes to the flight controller.
 *
 * Flow: validate → backup (diff all) → set FC fields → MSP write → EEPROM save → optional reboot.
 * Returns a revert() function that restores the backup via CLI.
 */
export function useApplySuggestion() {
    const isApplying = ref(false);
    const error = ref("");
    const lastBackup = ref(null);

    /**
     * Apply parameter changes to the FC.
     *
     * @param {Array<{path: string, current: *, suggested: *}>} changes
     *   from DiagnosisCard's suggestion.paramChanges
     * @returns {Promise<{ok: boolean, revert?: Function, error?: string}>}
     */
    async function apply(changes) {
        error.value = "";

        // 1. Validate + normalize model paths (camelCase aliases → FC roots)
        const { valid, errors: validationErrors, normalized = [] } = validateParamChanges(changes);
        if (!valid) {
            const msg = validationErrors.join(" ");
            error.value = msg;
            return { ok: false, error: msg };
        }
        const toApply = normalized.length
            ? normalized
            : changes.map((c) => ({
                ...c,
                path: normalizeParamPath(c.path),
            }));

        isApplying.value = true;
        try {
            // 2. Backup via CLI diff all (only on supported firmware). A failed backup must NOT
            // block the apply — the pilot asked for the tune change, and "no revert" is a
            // strictly better outcome than "can't tune at all". We surface it as a warning and
            // skip revert, rather than hard-failing the whole operation.
            let backup = null;
            let backupSkipped = false;
            // Classic CLI mode owns the serial receive path, so MSP-CLI commands never get a
            // reply (diff all would time out). Mirrors the guard in buildContext.
            let cliBlocked = false;
            try {
                const { default: CONFIGURATOR } = await import("@/js/data_storage");
                if (CONFIGURATOR?.cliActive) {
                    cliBlocked = true;
                }
            } catch {
                // data_storage unavailable (tests) — assume not blocked.
            }

            if (!isMspCliSupported() || cliBlocked) {
                backupSkipped = true;
                const reason = cliBlocked ? "CLI mode is active" : "firmware too old for CLI backup";
                gui_log(
                    i18n.getMessage("aiApplySkipBackup") || `Skipping backup (${reason}); revert will be unavailable.`,
                );
            } else {
                const cliSession = useMspCliSession();
                // diff all can transiently time out when the serial buffer is busy right after
                // an MSP-heavy diagnose. One retry before we give up on the backup.
                for (let attempt = 0; attempt < 2 && !backup; attempt++) {
                    try {
                        backup = await cliSession.readDumpAll();
                    } catch (e) {
                        if (attempt === 1) {
                            // Last attempt failed: degrade gracefully instead of aborting.
                            backupSkipped = true;
                            gui_log(
                                i18n.getMessage("aiApplyBackupFailed", { message: e.message }) ||
                                    `Backup failed (${e.message}); applying without revert.`,
                            );
                        }
                    }
                }
                if (backup) {
                    lastBackup.value = backup;
                }
            }

            // 3. Apply changes to the FC object, then encode + send MSP, then persist.
            // Order matters: mspHelper.crunch() reads FC.* values directly, so the suggested
            // values must be on FC before crunch runs. We snapshot the originals first so that
            // if MSP write or EEPROM save fails partway, we can roll FC back to match firmware
            // (otherwise the reactive FC would drift out of sync with the hardware).
            const applied = []; // [{path, original}] for rollback
            for (const { path, suggested } of toApply) {
                const original = getByPath(FC, path);
                applied.push({ path, original });
                setByPath(FC, path, suggested);
            }

            try {
                // 4. MSP write (only the commands that cover the changed fields)
                const codes = collectMspCodes(toApply);
                for (const code of codes) {
                    await MSP.promise(code, mspHelper.crunch(code));
                }

                // 5. Persist to EEPROM AND reboot so the firmware reloads parameters from flash.
                // saveToEeprom() alone is not enough: Betaflight applies PID / filter / rate
                // changes only after a reboot; without it the FC keeps running the old values.
                // saveAndReboot() = writeConfiguration() + reinitializeConnection(), matching
                // the PresetsTab flow that correctly picks up new params after apply.
                const { saveAndReboot } = useReboot();
                await saveAndReboot();
            } catch (mspErr) {
                // Roll FC back to the pre-apply state so it matches the firmware we failed to
                // update. The in-memory values would otherwise look "applied" while the FC held
                // the old config.
                for (const { path, original } of applied) {
                    setByPath(FC, path, original);
                }
                throw mspErr;
            }

            isApplying.value = false;
            gui_log(
                i18n.getMessage("aiApplySuccessReboot") ||
                    "Parameter changes applied and saved. A reboot is recommended to ensure all settings take effect.",
            );

            // Return a revert function only when we actually have a backup to replay.
            return {
                ok: true,
                backupSkipped,
                revert: backup ? () => revert(backup) : null,
            };
        } catch (e) {
            if (isMspCancelled(e)) {
                // Tab switch or disconnect — not a real failure
                return { ok: true };
            }
            const msg = i18n.getMessage("aiApplyWriteFailed", { message: e.message }) || `Write failed: ${e.message}`;
            error.value = msg;
            return { ok: false, error: msg };
        } finally {
            isApplying.value = false;
        }
    }

    /**
     * Revert to a previous configuration by replaying the CLI backup.
     *
     * @param {string[]} backup  CLI lines from readDumpAll()
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async function revert(backup) {
        if (!backup || !backup.length) {
            return { ok: false, error: "No backup available." };
        }

        isApplying.value = true;
        error.value = "";
        try {
            const cliSession = useMspCliSession();

            // Remove trailing 'save' to avoid mid-batch reboot
            const commands = backup.filter((line) => line.trim().toLowerCase() !== "save");

            // Ensure 'defaults nosave' prefix
            const hasDefaults = commands.some((l) => l.trim().toLowerCase() === "defaults nosave");
            const finalCommands = hasDefaults ? commands : ["defaults nosave", "", ...commands];

            const result = await cliSession.runBatch(finalCommands);

            if (result.errors.length > 0) {
                const msg = `Revert had ${result.errors.length} error(s).`;
                error.value = msg;
                return { ok: false, error: msg };
            }

            // Save and reconnect (static import catches breakage at build time vs dynamic)
            await saveAndReconnect();

            gui_log(i18n.getMessage("aiRevertSuccess") || "Configuration reverted.");
            return { ok: true };
        } catch (e) {
            const msg = `Revert failed: ${e.message}`;
            error.value = msg;
            return { ok: false, error: msg };
        } finally {
            isApplying.value = false;
        }
    }

    return { isApplying, error, lastBackup, apply, revert };
}
