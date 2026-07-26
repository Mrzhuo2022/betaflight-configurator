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
                >({{ suggestion.snapshot.blackbox.axes.join(", ") }})</span
            >
        </div>
        <!-- Summary + overall risk badge -->
        <div class="flex items-start gap-2">
            <UBadge
                :color="riskColor"
                :label="$t('aiDiagnoseRiskLabel') + ': ' + (suggestion.overallRisk || 'low')"
                size="sm"
                variant="subtle"
            />
        </div>
        <p v-if="suggestion.summary" class="font-medium">{{ suggestion.summary }}</p>

        <p v-if="!findings.length" class="text-dimmed">{{ $t("aiDiagnoseNoFindings") }}</p>

        <div v-for="(f, i) in findings" :key="i" class="rounded-md border border-default p-2 flex flex-col gap-1">
            <div class="flex items-center gap-2 flex-wrap">
                <UBadge :color="severityColor(f.severity)" :label="f.severity" size="xs" variant="subtle" />
                <UBadge v-if="f.area" :label="f.area" color="neutral" size="xs" variant="subtle" />
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
                            <th class="font-medium py-0.5 pr-2">{{ $t("aiDiagnoseParam") }}</th>
                            <th class="font-medium py-0.5 pr-2">{{ $t("aiDiagnoseCurrent") }}</th>
                            <th class="font-medium py-0.5 pr-2">{{ $t("aiDiagnoseSuggested") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="c in f.paramChanges" :key="c.path" class="border-t border-default">
                            <td class="py-0.5 pr-2 font-mono">{{ c.path }}</td>
                            <td class="py-0.5 pr-2 font-mono">{{ formatVal(c.current) }}</td>
                            <td class="py-0.5 pr-2 font-mono text-primary font-semibold">
                                {{ formatVal(c.suggested) }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Apply / Revert actions (only when paramChanges exist) -->
        <div v-if="allParamChanges.length" class="flex gap-2 mt-1">
            <UButton
                v-if="!appliedOk"
                :label="$t('aiDiagnoseApplyAll')"
                icon="i-lucide-check"
                :loading="isApplying"
                :disabled="isApplying"
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
import { computed, ref } from "vue";
import { useApplySuggestion } from "@/composables/ai/applySuggestion";
import { useDialog } from "@/composables/useDialog";
import { i18n } from "@/js/localization";

const props = defineProps({
    suggestion: { type: Object, required: true },
});

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

const allParamChanges = computed(() => {
    const changes = [];
    for (const f of findings.value) {
        if (Array.isArray(f.paramChanges)) {
            changes.push(...f.paramChanges);
        }
    }
    return changes;
});

async function onApply() {
    const title = i18n.getMessage("aiDiagnoseApplyConfirmTitle") || "Apply AI suggestions?";
    const body =
        i18n.getMessage("aiDiagnoseApplyConfirmBody") ||
        "This will write the suggested parameter changes to your flight controller. A backup will be saved first.";
    const confirmed = await dialog.showYesNo(title, body);
    if (!confirmed) {
        return;
    }
    const result = await apply(allParamChanges.value);
    if (result.ok) {
        appliedOk.value = true;
        revertFn.value = typeof result.revert === "function" ? result.revert : null;
        backupSkipped.value = !!result.backupSkipped;
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
