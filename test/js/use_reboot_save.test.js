import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Tests for the arming-disable deadline in useReboot.saveToEeprom. setArmingEnabled rides
// the legacy MSP path whose callback is silently dropped after its retry budget — without
// the deadline race, a non-answering FC left every awaiting caller (AI apply, Motors,
// Receiver, …) hung forever.

const FC = { CONFIG: { armingDisabled: false } };

vi.mock("@/js/serial_backend", () => ({ reinitializeConnection: vi.fn() }));
vi.mock("@/stores/navigation", () => ({ useNavigationStore: () => ({ cleanup: (cb) => cb() }) }));
vi.mock("@/js/msp/MSPHelper", () => ({
    mspHelper: { setArmingEnabled: vi.fn(), writeConfiguration: vi.fn() },
}));
vi.mock("@/js/msp", () => ({ default: { promise: vi.fn(async () => undefined) } }));
vi.mock("@/js/msp/MSPCodes", () => ({ default: { MSP_EEPROM_WRITE: 250 } }));
vi.mock("@/js/fc", () => ({ default: FC }));
vi.mock("@/js/gui_log", () => ({ gui_log: vi.fn() }));
vi.mock("@/js/localization", () => ({ i18n: { getMessage: (key) => key } }));

const { mspHelper } = await import("@/js/msp/MSPHelper");
const MSP = (await import("@/js/msp")).default;
const { useReboot } = await import("../../src/composables/useReboot.js");

describe("useReboot saveToEeprom arming-disable deadline", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        FC.CONFIG.armingDisabled = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("skips the arming-disable request when arming is already disabled", async () => {
        FC.CONFIG.armingDisabled = true;
        const { saveToEeprom } = useReboot();
        await saveToEeprom();
        expect(mspHelper.setArmingEnabled).not.toHaveBeenCalled();
        expect(MSP.promise).toHaveBeenCalledWith(250);
    });

    it("resolves when setArmingEnabled acknowledges, then writes EEPROM in order", async () => {
        mspHelper.setArmingEnabled.mockImplementation((_a, _b, cb) => cb());
        const { saveToEeprom } = useReboot();
        await saveToEeprom();
        expect(mspHelper.setArmingEnabled).toHaveBeenCalled();
        expect(MSP.promise).toHaveBeenCalledWith(250);
    });

    it("rejects when the arming-disable callback never fires (legacy MSP timeout)", async () => {
        // Simulate a dead FC: request accepted, callback dropped.
        mspHelper.setArmingEnabled.mockImplementation(() => {});
        vi.useFakeTimers();
        const { saveToEeprom } = useReboot();
        const pending = saveToEeprom();
        const assertion = expect(pending).rejects.toThrow(/arming-disable request timed out/);
        await vi.advanceTimersByTimeAsync(10000);
        await assertion;
        // The EEPROM write must NOT have gone out behind a failed arming-disable.
        expect(MSP.promise).not.toHaveBeenCalled();
    });
});
