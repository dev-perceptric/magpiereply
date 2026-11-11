<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import Button from 'dashboard/components-next/button/Button.vue';

const props = defineProps({
  summary: { type: Object, required: true },
});

const { t } = useI18n();
const router = useRouter();

const STATS = [
  ['drafts', 'DRAFTS'],
  ['sentAsIs', 'SENT_AS_IS'],
  ['sentEdited', 'SENT_EDITED'],
  ['discarded', 'DISCARDED'],
  ['autoSent', 'AUTO_SENT'],
  ['solvedByMagpie', 'SOLVED'],
  ['handedOff', 'HANDED_OFF'],
  ['reopened', 'REOPENED'],
  ['flaggedAttacks', 'FLAGGED'],
];

const money = value => `$${Number(value || 0).toFixed(2)}`;

const share = computed(() => {
  const { cost_usd: cost, cap_usd: cap } = props.summary.month;
  return cap > 0 ? Math.min(100, Math.round((cost / cap) * 100)) : 100;
});

// Twelfths keep the bar to Tailwind's own width classes.
const BAR_WIDTHS = [
  'w-0',
  'w-1/12',
  'w-2/12',
  'w-3/12',
  'w-4/12',
  'w-5/12',
  'w-6/12',
  'w-7/12',
  'w-8/12',
  'w-9/12',
  'w-10/12',
  'w-11/12',
  'w-full',
];
const barWidth = computed(
  () => BAR_WIDTHS[Math.round((share.value / 100) * 12)]
);

const stats = computed(() =>
  STATS.map(([key, label]) => ({
    key,
    label: t(`AI_AGENT_SETTINGS.USAGE.${label}`),
    value: props.summary.last_30_days?.[key] ?? 0,
  }))
);

const openTraces = () => router.push({ name: 'settings_ai_agent_traces' });
</script>

<template>
  <div
    class="flex flex-col gap-4 p-4 outline outline-1 -outline-offset-1 outline-n-weak rounded-xl"
  >
    <div class="flex items-center justify-between gap-3">
      <span class="text-heading-3 text-n-slate-12">
        {{ t('AI_AGENT_SETTINGS.USAGE.HEADER') }}
      </span>
      <Button
        :label="t('AI_AGENT_SETTINGS.USAGE.TRACES')"
        slate
        sm
        @click="openTraces"
      />
    </div>
    <div class="flex flex-col gap-2">
      <span class="text-body-main text-n-slate-12">
        {{
          t('AI_AGENT_SETTINGS.USAGE.MONTH', {
            spent: money(summary.month.cost_usd),
            cap: money(summary.month.cap_usd),
          })
        }}
      </span>
      <div class="h-2 rounded-full bg-n-slate-4 overflow-hidden">
        <div
          class="h-full rounded-full"
          :class="[
            barWidth,
            summary.month.cap_reached ? 'bg-n-ruby-9' : 'bg-n-brand',
          ]"
        />
      </div>
      <span
        v-if="summary.month.cap_reached"
        class="text-body-main text-n-ruby-11"
      >
        {{ t('AI_AGENT_SETTINGS.USAGE.CAP_REACHED') }}
      </span>
    </div>
    <div class="flex flex-col gap-2">
      <span class="text-body-main font-medium text-n-slate-12">
        {{ t('AI_AGENT_SETTINGS.USAGE.LAST_30_DAYS') }}
      </span>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div
          v-for="stat in stats"
          :key="stat.key"
          class="flex flex-col gap-0.5 p-3 rounded-lg bg-n-alpha-1"
        >
          <span class="text-heading-2 text-n-slate-12">{{ stat.value }}</span>
          <span class="text-body-main text-n-slate-11">{{ stat.label }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
