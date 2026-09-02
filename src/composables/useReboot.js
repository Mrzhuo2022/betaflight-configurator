import { reinitializeConnection } from "@/js/serial_backend"; // Backend logic
import { useNavigationStore } from "@/stores/navigation";
import { mspHelper } from "@/js/msp/MSPHelper";
import MSP from "@/js/msp";
import MSPCodes from "@/js/msp/MSPCodes";
import FC from "@/js/fc";
import { gui_log } from "@/js/gui_log";
import { i18n } from "@/js/localization";

// setArmingEnabled rides the legacy MSP path, whose callback is silently dropped after its
// retry budget is exhausted. This deadline must comfortably exceed that budget (3 retries
// × per-request timeout) so a healthy link never trips it.
const ARMING_DISABLE_TIMEOUT_MS = 10000;

/**
 * Persist the current configuration to EEPROM without rebooting. This is the await-able,
 * error-aware counterpart to the callback-based mspHelper.writeConfiguration: it uses an
 * error-aware MSP request, so a tab switch / disconnect that clears the MSP queue rejects
 * with MspCancelledError (letting runSave settle) instead of dropping the callback and
 * hanging. Mirrors writeConfiguration's arming-safety guard; the 100ms settle delay is
 * unnecessary because callers await their MSP_SET_* writes before persisting
 * (verified at every call site: MotorsTab, ConfigurationTab, ReceiverTab, SensorsTab,
 * FailsafeTab, GpsTab, OnboardLoggingTab and usePortsConfiguration all await writes or
 * persist from the write's ack callback).
 *
 * The arming-disable step is itself callback-based on the legacy MSP path (its callback is
 * dropped on timeout, exactly like writeConfiguration was), so it is raced against a
 * deadline: a hung arming-disable fails the save visibly instead of deadlocking every
 * awaiting caller. The save is NOT allowed to proceed past a failed arming-disable —
 * persisting while arming is possible is the hazard the guard exists to prevent.
 *
 * Defined at module scope (not per useReboot() call) because it closes over no
 * composable-local state — only module-level imports.
 * @returns {Promise<void>} resolves once the EEPROM write is acknowledged
 */
async function saveToEeprom() {
    // Never persist while arming is possible (matches writeConfiguration).
    if (!FC.CONFIG.armingDisabled) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("arming-disable request timed out")),
                ARMING_DISABLE_TIMEOUT_MS,
            );
            mspHelper.setArmingEnabled(false, false, () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    await MSP.promise(MSPCodes.MSP_EEPROM_WRITE);
    gui_log(i18n.getMessage("configurationEepromSaved"));
}

export function useReboot() {
    // Reboot is owned end-to-end by serial_backend.reinitializeConnection(): it sends the
    // reboot command, drives the per-transport reconnect, shows the reboot progress dialog
    // and settles the connection-state phase. This composable is just the Vue-tab entry point.
    // Return the delegated call so callers keep the backend contract (it resolves to the
    // reboot timestamp).
    const reboot = () => reinitializeConnection();

    const navigationStore = useNavigationStore();

    function cleanupAndReboot(resolve) {
        navigationStore.cleanup(() => {
            reboot();
            resolve();
        });
    }

    /**
     * Persist the current configuration to EEPROM and then reboot the board,
     * settling the connection state via the shared reboot flow.
     *
     * Built on the error-aware saveToEeprom() instead of the legacy callback-based
     * mspHelper.writeConfiguration: the legacy path leaves its callback queued forever when
     * the EEPROM write times out or the link drops, which hung this promise (and every
     * caller's await, e.g. the AI apply flow's isApplying flag) until page reload.
     * @returns {Promise<void>} resolves once the reboot sequence has started; rejects if the EEPROM write fails
     */
    async function saveAndReboot() {
        await saveToEeprom();
        return new Promise((resolve) => {
            cleanupAndReboot(resolve);
        });
    }

    return {
        reboot,
        saveAndReboot,
        saveToEeprom,
    };
}
