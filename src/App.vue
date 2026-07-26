<template>
    <UApp :tooltip="{ delayDuration: 100 }" portal="#main-wrapper">
        <div class="app-wrapper">
            <div id="background" v-if="isMobileSidebarOpen" aria-hidden="true" @click="isRevealed = false"></div>
            <div id="side_menu_swipe"></div>
            <div class="mobile-topbar" :class="{ 'mobile-topbar--hidden': topbarHidden }">
                <UButton
                    id="menu_btn"
                    icon="i-lucide-menu"
                    color="neutral"
                    variant="soft"
                    size="lg"
                    square
                    :aria-label="$t('openSidebarMenu')"
                    @click="isRevealed = !isRevealed"
                />
                <div class="mobile-topbar__logo" :title="logoTooltip" aria-hidden="true"></div>
                <div class="mobile-topbar__spacer" aria-hidden="true"></div>
            </div>
            <div id="tab-content-container">
                <div class="tab_container" :class="{ reveal: isMobileSidebarOpen }">
                    <betaflight-logo
                        :configurator-version="CONFIGURATOR.getDisplayVersion()"
                        :firmware-version="FC.CONFIG.flightControllerVersion"
                        :firmware-id="FC.CONFIG.flightControllerIdentifier"
                        :hardware-id="FC.CONFIG.hardwareName"
                    ></betaflight-logo>
                    <ConnectButton />
                    <Sidebar />
                    <div class="clear-both"></div>
                </div>
                <div id="content" @scroll.passive="onContentScroll">
                    <keep-alive :include="keptAliveTabs">
                        <component
                            :is="activeTabComponent"
                            v-if="activeTabComponent"
                            :key="activeTabKey"
                            ref="activeTabInstance"
                        />
                    </keep-alive>
                </div>
                <!-- Embedded AI assistant right rail (desktop / wide screens). The third flex
                     child of #tab-content-container; #content (flex:1 1 0) yields space.
                     Width is user-resizable via the drag handle on the left edge and persisted. -->
                <div
                    v-if="renderAiRailEmbedded"
                    id="ai-assistant-rail"
                    :style="{
                        width: `${navigationStore.aiRailWidthPx}px`,
                        flexBasis: `${navigationStore.aiRailWidthPx}px`,
                    }"
                >
                    <div
                        class="ai-rail-resizer"
                        role="separator"
                        tabindex="0"
                        :aria-orientation="'vertical'"
                        :aria-label="$t('aiRailResize')"
                        :aria-valuenow="navigationStore.aiRailWidthPx"
                        :aria-valuemin="navigationStore.aiRailMinPx"
                        :aria-valuemax="navigationStore.aiRailMaxPx"
                        @mousedown.prevent="onRailResizeStart"
                        @dblclick="onRailResizeReset"
                        @keydown="onRailResizeKeydown"
                    />
                    <AiAssistantContent ref="aiRailContentRef" />
                </div>
            </div>
            <!-- Mobile / narrow screens: AI assistant as a slide-over panel. -->
            <AiAssistantPanel v-if="renderAiSlideover" v-model="navigationStore.aiAssistantPanelOpen" />
            <status-bar
                :port-usage-down="PortUsage.port_usage_down"
                :port-usage-up="PortUsage.port_usage_up"
                :connection-timestamp="CONNECTION.timestamp"
                :packet-error="MSP.packet_error"
                :cycle-time="FC.CONFIG.cycleTime"
                :cpu-load="FC.CONFIG.cpuload"
                :configurator-version="CONFIGURATOR.getDisplayVersion()"
                :firmware-version="FC.CONFIG.flightControllerVersion"
                :firmware-target="FC.CONFIG.hardwareName"
            ></status-bar>
            <div id="cache">
                <div class="data-loading">
                    <p i18n="dataWaitingForData">Waiting for data ...</p>
                </div>
            </div>
        </div>
        <GlobalDialogs />
    </UApp>
</template>

<script setup>
import { computed, nextTick, onUnmounted, provide, reactive, ref, shallowRef, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import ConnectButton from "./components/device-picker/ConnectButton.vue";
import GlobalDialogs from "./components/dialogs/GlobalDialogs.vue";
import Sidebar from "./components/sidebar/Sidebar.vue";
import AiAssistantContent from "./components/ai-assistant/AiAssistantContent.vue";
import AiAssistantPanel from "./components/ai-assistant/AiAssistantPanel.vue";
import FCModule from "./js/fc.js";
import MSPModule from "./js/msp.js";
import PortUsageModule from "./js/port_usage.js";
import CONFIGURATORModule from "./js/data_storage.js";
import GUI from "./js/gui.js";
import { useNavigationStore } from "./stores/navigation";
import { useAiAssistantStore } from "./stores/aiAssistant";
import { i18n } from "./js/localization";
import {
    completeVueTabMount,
    tabAdapterRegistration,
    TAB_ADAPTER_REGISTRATION_KEY,
    vueTabState,
} from "./js/vue_tab_mounter.js";
import { VueTabComponents } from "./js/vue_tab_registry.js";

// Tests or unusual entry points may run without init.js; init.js overwrites this synchronously after its model exists.
if (!window.vm) {
    window.vm = reactive({ expertMode: false });
}

// Stable fallback so computed() does not allocate a new reactive per evaluation when window.vm.CONNECTION is missing.
const connectionFallback = reactive({ timestamp: null });

// Track latest window.vm so computeds re-run when it is reassigned (import order vs. init.js).
const syncedVm = shallowRef(window.vm);

// Intercept future assignments to window.vm so syncedVm stays in sync
// without needing side effects inside computed getters.
let _windowVm = window.vm;
Object.defineProperty(window, "vm", {
    get: () => _windowVm,
    set: (v) => {
        _windowVm = v;
        syncedVm.value = v;
    },
    configurable: true,
    enumerable: true,
});

function currentVm() {
    return syncedVm.value;
}

const CONFIGURATOR = computed(() => currentVm()?.CONFIGURATOR ?? CONFIGURATORModule);
const FC = computed(() => currentVm()?.FC ?? FCModule);
const MSP = computed(() => currentVm()?.MSP ?? MSPModule);
const PortUsage = computed(() => currentVm()?.PortUsage ?? PortUsageModule);
const CONNECTION = computed(() => currentVm()?.CONNECTION ?? connectionFallback);

const activeTabInstance = ref(null);

const isRevealed = ref(false);
const sidebarNarrow = useMediaQuery("(max-width: 1055px)");
const isCompactBreakpoint = useMediaQuery(
    "(max-width: 575px), (max-width: 950px) and (max-height: 500px) and (orientation: landscape)",
);
const isMobileSidebarOpen = computed(() => isCompactBreakpoint.value && isRevealed.value);
const isSidebarExpanded = computed(() => !sidebarNarrow.value || isRevealed.value);

// AI assistant right rail: embedded on desktop, slide-over on mobile. Same persisted
// toggle drives both; the two render modes are mutually exclusive by breakpoint.
const navigationStore = useNavigationStore();
const aiAssistantStore = useAiAssistantStore();
const aiRailContentRef = ref(null);
const renderAiRailEmbedded = computed(
    () => aiAssistantStore.enabled && !isCompactBreakpoint.value && navigationStore.aiAssistantPanelOpen,
);
const renderAiSlideover = computed(
    () => aiAssistantStore.enabled && isCompactBreakpoint.value && navigationStore.aiAssistantPanelOpen,
);

// User-resizable AI rail: drag the handle on the rail's left edge. The rail is on the right,
// so dragging LEFT grows it and dragging RIGHT shrinks it → width = (startWidth + startX - moveX).
// Global mousemove/mouseup listeners are added on drag start and removed on end; we also
// disable text selection + native drag while active so the gesture stays clean.
let railDragStartX = 0;
let railDragStartWidth = 0;
function onRailResizeMove(event) {
    const delta = railDragStartX - event.clientX;
    navigationStore.setAiRailWidthPx(railDragStartWidth + delta);
}
function onRailResizeEnd() {
    document.body.classList.remove("ai-rail-resizing");
    document.removeEventListener("mousemove", onRailResizeMove);
    document.removeEventListener("mouseup", onRailResizeEnd);
}
function onRailResizeStart(event) {
    railDragStartX = event.clientX;
    railDragStartWidth = navigationStore.aiRailWidthPx;
    document.body.classList.add("ai-rail-resizing");
    document.addEventListener("mousemove", onRailResizeMove);
    document.addEventListener("mouseup", onRailResizeEnd);
}
// Double-click the handle to snap back to the default width.
function onRailResizeReset() {
    navigationStore.setAiRailWidthPx(navigationStore.aiRailWidthPx === 480 ? 560 : 480);
}
// Keyboard support for the resize handle (WAI-ARIA separator pattern).
function onRailResizeKeydown(event) {
    const step = 16;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        navigationStore.setAiRailWidthPx(navigationStore.aiRailWidthPx + step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        navigationStore.setAiRailWidthPx(navigationStore.aiRailWidthPx - step);
    }
}
// Clean up drag listeners if the component unmounts mid-drag.
onUnmounted(() => {
    onRailResizeEnd();
});

// Re-sync AI settings + scroll to bottom whenever the embedded rail appears, so values
// changed in OptionsDialog since last open take effect. (The slide-over does the same in
// its own watch(open).)
watch(renderAiRailEmbedded, (visible) => {
    if (visible) {
        nextTick(() => {
            aiRailContentRef.value?.syncSettings?.();
            aiRailContentRef.value?.scrollToBottom?.();
        });
    }
});

// Auto-close the drawer when leaving the mobile drawer breakpoint.
watch(isCompactBreakpoint, (compact) => {
    if (!compact) {
        isRevealed.value = false;
    }
});

const topbarHidden = ref(false);
let lastScrollTop = 0;
const scrollThreshold = 6;

function onContentScroll(event) {
    const current = event.target.scrollTop;
    if (current <= 0) {
        topbarHidden.value = false;
        lastScrollTop = 0;
        return;
    }
    const diff = current - lastScrollTop;
    if (diff > scrollThreshold) {
        topbarHidden.value = true;
        lastScrollTop = current;
    } else if (diff < -scrollThreshold) {
        topbarHidden.value = false;
        lastScrollTop = current;
    }
}

// Ensure the topbar is visible when the drawer opens so the hamburger stays reachable.
watch(isRevealed, (revealed) => {
    if (revealed) {
        topbarHidden.value = false;
    }
});

const logoTooltip = computed(() => {
    const lines = [`${i18n.getMessage("versionLabelConfigurator")}: ${CONFIGURATOR.value.getDisplayVersion()}`];
    const cfg = FC.value.CONFIG ?? {};
    if (cfg.flightControllerVersion && cfg.flightControllerIdentifier) {
        lines.push(
            `${i18n.getMessage("versionLabelFirmware")}: ${cfg.flightControllerVersion} ${cfg.flightControllerIdentifier}`,
        );
    }
    if (cfg.hardwareName) {
        lines.push(`${i18n.getMessage("versionLabelTarget")}: ${cfg.hardwareName}`);
    }
    return lines.join("\n");
});

provide("sidebarExpanded", isSidebarExpanded);
provide("closeMobileSidebar", () => {
    if (isCompactBreakpoint.value) {
        isRevealed.value = false;
    }
});

const activeTabComponent = computed(() => {
    const tabName = vueTabState.activeTabName;
    return tabName ? (VueTabComponents[tabName] ?? null) : null;
});

// Tabs that keep their state (and heavy resources) alive across switches rather than being torn
// down. Matched by component name.
const keptAliveTabs = ["BlackboxViewerTab"];

// The mounter bumps activeTabKey on every switch to force a fresh instance. Kept-alive tabs need
// a stable key instead, or keep-alive caches by an ever-changing key and never restores.
const activeTabKey = computed(() =>
    vueTabState.activeTabName === "blackbox_viewer" ? "blackbox_viewer" : vueTabState.activeTabKey,
);

provide("betaflightModel", currentVm());
provide("gui", GUI);
provide(TAB_ADAPTER_REGISTRATION_KEY, tabAdapterRegistration);

watch(
    () => vueTabState.activeTabKey,
    async () => {
        if (!vueTabState.activeTabName) {
            return;
        }

        await nextTick();
        completeVueTabMount(activeTabInstance.value);
    },
    { flush: "post" },
);
</script>

<style scoped>
@keyframes spin {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(360deg);
    }
}
</style>

<style>
/* Main app content wrapper - flex column to push status bar to bottom */
.app-wrapper {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0; /* Allow flex children to shrink below content size */
}

/* Legacy cache node is required by some code paths but should never be visible in Vue UI */
#cache {
    display: none;
}

/* Mobile top bar — hamburger left, centred wide logo, auto-hides on scroll down.
   The bar grows by the safe-area inset and pads its contents down by the same amount, so the
   controls sit below the Android/iOS status bar with the content box unchanged. */
.mobile-topbar {
    display: none;
    position: fixed;
    top: 0;
    inset-inline-start: 0;
    inset-inline-end: 0;
    z-index: 2001;
    /* Explicit, not inherited from the Tailwind reset: the height below is an outer height, and
       #content's matching padding-top depends on it staying one. */
    box-sizing: border-box;
    height: calc(3rem + env(safe-area-inset-top, 0px));
    padding: calc(0.25rem + env(safe-area-inset-top, 0px)) 0.5rem 0.25rem;
    align-items: center;
    gap: 0.5rem;
    background-color: var(--surface-100);
    border-bottom: 1px solid var(--surface-200);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 0.25s ease;
}
.mobile-topbar--hidden {
    transform: translateY(-100%);
}
.mobile-topbar__logo {
    flex: 1;
    min-width: 0;
    height: 2.5rem;
    background-image: url(./images/bf_logo_white.svg);
    background-repeat: no-repeat;
    background-position: center;
    background-size: auto 100%;
}
.dark .mobile-topbar__logo {
    background-image: url(./images/bf_logo_black.svg);
}
.mobile-topbar__spacer {
    width: 2.5rem;
    flex-shrink: 0;
}

@media all and (max-width: 575px), all and (max-width: 950px) and (max-height: 500px) and (orientation: landscape) {
    .mobile-topbar {
        display: flex;
    }
    /* Leave room at the top of the content area for the top bar (including safe area). */
    #content {
        padding-top: calc(3rem + env(safe-area-inset-top, 0px));
    }
}
</style>
