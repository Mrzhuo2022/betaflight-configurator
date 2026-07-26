import { defineStore } from "pinia";
import { computed, ref } from "vue";
import GUI from "../js/gui";
import { get as getConfig, set as setConfig } from "@/js/ConfigStorage";

export const useNavigationStore = defineStore("navigation", () => {
    // Proxy state directly to legacy reactive objects
    // This ensures full bi-directional synchronization during migration

    const activeTab = computed({
        get: () => GUI.active_tab,
        set: (val) => (GUI.active_tab = val),
    });

    const tabSwitchInProgress = computed({
        get: () => GUI.tab_switch_in_progress,
        set: (val) => (GUI.tab_switch_in_progress = val),
    });

    const expertMode = ref(false);

    // Set to true to imperatively open the OptionsDialog (e.g. on first run).
    // Sidebar.vue consumes and resets this flag.
    const optionsDialogOpen = ref(false);

    // AI assistant right rail visibility. Persistent + two-way (unlike the one-shot
    // optionsDialogOpen flag above): the toggle button in Sidebar and the render site
    // in App.vue both read/write this same source of truth. Persisted so the pilot's
    // last choice survives reloads, mirroring the enabled-key pattern in stores/aiAssistant.js
    // (the project does not use pinia-plugin-persistedstate).
    // NOTE: config keys here lack the `ai_` prefix used by stores/aiAssistant.js — kept
    // as-is to avoid breaking existing user settings on upgrade.
    const aiAssistantPanelOpen = ref(!!getConfig("aiAssistantPanelOpen", false).aiAssistantPanelOpen);
    function setAiAssistantPanelOpen(v) {
        aiAssistantPanelOpen.value = !!v;
        setConfig({ aiAssistantPanelOpen: aiAssistantPanelOpen.value });
    }

    // AI assistant right rail width in CSS pixels. User-resizable via a drag handle on the
    // rail's left edge; persisted so the chosen width survives reloads. Clamped to a sane
    // range so the main tab area can't collapse to nothing or the rail grow past the viewport.
    const AI_RAIL_MIN_PX = 320;
    const AI_RAIL_MAX_PX = 768;
    const AI_RAIL_DEFAULT_PX = 480; // 30rem
    function clampRailWidth(px) {
        const n = Number(px);
        if (!Number.isFinite(n)) return AI_RAIL_DEFAULT_PX;
        return Math.min(AI_RAIL_MAX_PX, Math.max(AI_RAIL_MIN_PX, Math.round(n)));
    }
    const aiRailWidthPx = ref(clampRailWidth(getConfig("aiRailWidthPx", AI_RAIL_DEFAULT_PX).aiRailWidthPx));
    function setAiRailWidthPx(px) {
        aiRailWidthPx.value = clampRailWidth(px);
        setConfig({ aiRailWidthPx: aiRailWidthPx.value });
    }

    function cleanup(callback) {
        GUI.tab_switch_cleanup(callback);
    }

    return {
        activeTab,
        tabSwitchInProgress,
        expertMode,
        optionsDialogOpen,
        aiAssistantPanelOpen,
        setAiAssistantPanelOpen,
        aiRailWidthPx,
        setAiRailWidthPx,
        aiRailMinPx: AI_RAIL_MIN_PX,
        aiRailMaxPx: AI_RAIL_MAX_PX,
        cleanup,
    };
});
