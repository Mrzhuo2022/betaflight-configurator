<template>
    <div class="flex flex-col gap-2 text-sm">
        <!-- Data snapshot: what the AI actually received -->
        <div v-if="suggestion.snapshot" class="text-xs bg-default/20 rounded p-1.5 flex flex-wrap gap-1 items-center">
            <span class="text-dimmed">{{ $t("aiDiagnoseDataSource") || "AI received:" }}</span>
            <UBadge
                v-if="suggestion.snapshot.tuneConnected"
                :label="$t('aiDiagnoseSourceFC') || 'FC tune'"
                color="primary"
                size="xs"
                variant="subtle"
            />
            <UBadge v-else :label="$t('aiDiagnoseSourceNoFC') || 'No FC'" color="neutral" size="xs" variant="subtle" />
            <UBadge
                v-if="suggestion.snapshot.blackbox"
                :label="$t('aiDiagnoseSourceBBL') || 'Blackbox'"
                color="success"
                size="xs"
                variant="subtle"
            />
            <span v-if="suggestion.snapshot.blackbox" class="text-dimmed"
                >({{ suggestion.snapshot.blackbox.axes?.join(", ") }})</span
            >
        </div>
        <!-- Summary + overall risk badge -->
        <div class="flex items-start gap-2">
            <UBadge
                :color="riskColor"
                :label="$t('aiDiagnoseRiskLabel') + ': ' + riskLabel"
                size="sm"
                variant="subtle"
            />
        </div>
        <p v-if="suggestion.summary" class="font-medium">{{ suggestion.summary }}</p>

        <p v-if="!findings.length" class="text-dimmed">{{ $t("aiDiagnoseNoFindings") }}</p>

        <div v-for="(f, i) in findings" :key="i" class="rounded-md border border-default p-2 flex flex-col gap-1">
            <div class="flex items-center gap-2 flex-wrap">
                <UBadge
                    :color="severityColor(f.severity)"
                    :label="severityLabel(f.severity)"
                    size="xs"
                    variant="subtle"
                />
                <UBadge v-if="f.area" :label="areaLabel(f.area)" color="neutral" size="xs" variant="subtle" />
                <span class="font-semibold">{{ f.title }}</span>
            </div>
            <p v-if="f.finding">{{ f.finding }}</p>
            <p v-if="f.reason" class="text-dimmed">{{ f.reason }}</p>
            <p v-if="f.recommendation">
                <span class="font-semibold">{{ $t("aiDiagnoseRecommendation") }}:</span> {{ f.recommendation }}
            </p>

            <!-- Read-only parameter change preview (apply lands in P3) -->
            <div v-if="f.paramChanges && f.paramChanges.length" class="mt-1">
                <table class="w-full text-xs border-collapse" :aria-label="$t('aiDiagnoseParamChanges')">
                    <caption class="sr-only">
                        {{
                            $t("aiDiagnoseParamChanges")
                        }}
                    </caption>
                    <thead>
                        <tr class="text-dimmed text-left">
                            <th class="py-0.5 pr-1 w-6"></th>
                            <th class="font-medium py-0.5 pr-2">{{ $t("aiDiagnoseParam") }}</th>
                            <th class="font-medium py-0.5 pr-2">{{ $t("aiDiagnoseCurrent") }}</th>
                            <th class="font-medium py-0.5 pr-2">{{ $t("aiDiagnoseSuggested") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(c, ci) in f.paramChanges" :key="ci" class="border-t border-default">
                            <td class="py-0.5 pr-1">
                                <UCheckbox
                                    v-model="checked[c.path]"
                                    size="xs"
                                    :disabled="appliedOk"
                                    :aria-label="$t('aiDiagnoseSelectParam')"
                                />
                            </td>
                            <td class="py-0.5 pr-2 font-mono" :class="{ 'opacity-50': checked[c.path] === false }">
                                {{ c.path }}
                            </td>
                            <td class="py-0.5 pr-2 font-mono">{{ formatVal(c.current) }}</td>
                            <td
                                class="py-0.5 pr-2 font-mono font-semibold"
                                :class="changeDirectionClass(c.current, c.suggested)"
                            >
                                {{ formatVal(c.suggested) }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Apply / Revert actions (only when paramChanges exist) -->
        <div v-if="allParamChanges.length" class="flex gap-2 mt-1 items-center flex-wrap">
            <UButton
                v-if="!appliedOk"
                :label="applyLabel"
                icon="i-lucide-check"
                :loading="isApplying"
                :disabled="isApplying || !selectedChanges.length"
                size="xs"
                color="primary"
                @click="onApply"
            />
            <template v-else>
                <UBadge color="success" :label="$t('aiDiagnoseApplied')" size="sm" variant="subtle" />
                <UButton
                    v-if="revertFn"
                    :label="$t('aiDiagnoseRevert')"
                    icon="i-lucide-undo-2"
                    :loading="isApplying"
                    :disabled="isApplying"
                    size="xs"
                    variant="soft"
                    @click="onRevert"
                />
                <UBadge
                    v-if="backupSkipped"
                    color="warning"
                    :label="$t('aiDiagnoseNoBackup')"
                    size="sm"
                    variant="subtle"
                />
            </template>
            <p v-if="applyError" class="text-xs text-error mt-1">{{ applyError }}</p>
        </div>
    </div>
</template>

<script setup>
import { computed, reactive, ref } from "vue";
import { useTranslation } from "i18next-vue";
import { useApplySuggestion } from "@/composables/ai/applySuggestion";
import { useDialog } from "@/composables/useDialog";
import { i18n } from "@/js/localization";

const props = defineProps({
    suggestion: { type: Object, required: true },
});

const emit = defineEmits(["applied"]);

const { t } = useTranslation();

const { isApplying, error: applyError, apply } = useApplySuggestion();
const dialog = useDialog();
const appliedOk = ref(false);
const revertFn = ref(null);
// True when the apply went through without a CLI backup (diff all timed out / CLI mode active /
// firmware too old). There's no revert in that case, so we hide the Revert button and tell the
// pilot why — instead of silently hard-failing the whole tune (the old behaviour).
const backupSkipped = ref(false);

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

const findings = computed(() => {
    const list = Array.isArray(props.suggestion?.findings) ? props.suggestion.findings : [];
    return [...list].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
});

function severityColor(sev) {
    if (sev === "critical") {
        return "error";
    }
    if (sev === "warning") {
        return "warning";
    }
    return "neutral";
}

// Model-supplied enums (severity/area/overallRisk) arrive as raw English tokens; map them
// through i18n so zh_CN (and future locales) don't show untranslated badges.
const SEVERITY_LABEL_KEYS = {
    critical: "aiSeverityCritical",
    warning: "aiSeverityWarning",
    info: "aiSeverityInfo",
};
function severityLabel(sev) {
    return t(SEVERITY_LABEL_KEYS[sev] || "aiSeverityInfo");
}
const AREA_LABEL_KEYS = {
    PID: "aiAreaPID",
    filter: "aiAreaFilter",
    rate: "aiAreaRate",
    rc: "aiAreaRC",
    motor: "aiAreaMotor",
    feature: "aiAreaFeature",
    other: "aiAreaOther",
};
function areaLabel(area) {
    return t(AREA_LABEL_KEYS[area] || "aiAreaOther");
}
const RISK_LABEL_KEYS = {
    low: "aiRiskLow",
    medium: "aiRiskMedium",
    high: "aiRiskHigh",
};
const riskLabel = computed(() => t(RISK_LABEL_KEYS[props.suggestion?.overallRisk] || "aiRiskLow"));

const riskColor = computed(() => {
    const risk = props.suggestion?.overallRisk;
    return severityColor(risk === "high" ? "critical" : risk);
});

function formatVal(v) {
    if (v === null || v === undefined) {
        return "";
    }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** CSS class for the suggested value cell: green for increase, red for decrease, neutral for same. */
function changeDirectionClass(current, suggested) {
    if (typeof current !== "number" || typeof suggested !== "number") return "text-primary";
    if (suggested > current) return "text-success";
    if (suggested < current) return "text-warning";
    return "text-dimmed";
}

const allParamChanges = computed(() => {
    const changes = [];
    for (const f of findings.value) {
        if (Array.isArray(f.paramChanges)) {
            changes.push(...f.paramChanges);
        }
    }
    return changes;
});

// Per-path selection state. Everything starts checked; the pilot unticks what
// they don't want. Keyed by path (paths are unique across findings in practice;
// duplicates would collapse into one checkbox, which is the sane behaviour anyway).
const checked = reactive({});
for (const c of allParamChanges.value) {
    checked[c.path] = true;
}

const selectedChanges = computed(() => allParamChanges.value.filter((c) => checked[c.path] !== false));

const applyLabel = computed(() => {
    const total = allParamChanges.value.length;
    const sel = selectedChanges.value.length;
    const base = i18n.getMessage("aiDiagnoseApplyAll") || "Apply";
    return sel < total ? `${base} (${sel}/${total})` : base;
});

/** Escape AI-supplied strings for the v-html confirm dialog (paths/values are model output). */
function escapeHtml(v) {
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function onApply() {
    const applying = selectedChanges.value;
    const title = i18n.getMessage("aiDiagnoseApplyConfirmTitle") || "Apply AI suggestions?";
    const intro =
        i18n.getMessage("aiDiagnoseApplyConfirmBody") ||
        "This will write the suggested parameter changes to your flight controller. A backup will be saved first.";
    // Consolidated change list so the pilot reviews exactly what will be written,
    // in one place, before confirming — instead of scanning per-finding tables.
    const rows = applying
        .map(
            (c) =>
                `<tr><td style="padding:2px 12px 2px 0"><code>${escapeHtml(c.path)}</code></td>` +
                `<td style="padding:2px 12px 2px 0">${escapeHtml(formatVal(c.current))}</td>` +
                `<td style="padding:2px 0"><b>→ ${escapeHtml(formatVal(c.suggested))}</b></td></tr>`,
        )
        .join("");
    const body =
        `<p>${intro}</p>` +
        `<table style="margin-top:8px;font-size:0.85em;font-family:monospace"><tbody>${rows}</tbody></table>`;
    const confirmed = await dialog.showYesNo(title, body);
    if (!confirmed) {
        return;
    }
    const result = await apply(applying);
    if (result.interrupted) {
        // Connection dropped mid-write: changes may not have been saved. Don't show the
        // "Applied" badge or record the batch — the pilot must reconnect and re-check.
        dialog.openInfo(
            i18n.getMessage("aiDiagnoseApplyInterruptedTitle") || "Apply interrupted",
            i18n.getMessage("aiDiagnoseApplyInterrupted") ||
                "The connection was lost while writing parameters. Changes may not have been saved — reconnect and verify your tune.",
        );
        return;
    }
    if (result.ok) {
        appliedOk.value = true;
        revertFn.value = typeof result.revert === "function" ? result.revert : null;
        backupSkipped.value = !!result.backupSkipped;
        // Notify the conversation so the next diagnose can compare before/after.
        emit("applied", applying);
    }
}

async function onRevert() {
    if (revertFn.value) {
        const result = await revertFn.value();
        if (result && !result.ok) {
            // Revert failed (CLI timeout, network error, etc.) — don't pretend it succeeded.
            dialog.openInfo(i18n.getMessage("aiDiagnoseRevertFailed") || "Revert failed", result.error || "");
            return;
        }
    }
    appliedOk.value = false;
    revertFn.value = null;
}
</script>
