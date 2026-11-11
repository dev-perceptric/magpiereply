<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAlert } from 'dashboard/composables';
import aiAgentAPI from 'dashboard/api/aiAgent';

import Button from 'dashboard/components-next/button/Button.vue';
import Label from 'dashboard/components-next/label/Label.vue';

const emit = defineEmits(['finished']);

const POLL_MS = 5000;
const VERDICT_COLORS = { same: 'teal', fine: 'blue', wrong: 'ruby' };
const { t } = useI18n();

const tests = ref([]);
const isStarting = ref(false);
const openTestId = ref(null);
const cases = ref([]);
let timer = null;

const errorMessage = error =>
  error?.response?.data?.error || t('AI_AGENT_SETTINGS.KNOWLEDGE.ERROR');

const stopPolling = () => {
  clearTimeout(timer);
  timer = null;
};

const load = async () => {
  stopPolling();
  const wasRunning = tests.value.some(test => test.status === 'running');
  try {
    const { data } = await aiAgentAPI.tests();
    tests.value = data.tests;
  } catch (error) {
    useAlert(errorMessage(error));
    return;
  }
  const running = tests.value.some(test => test.status === 'running');
  if (running) timer = setTimeout(load, POLL_MS);
  if (wasRunning && !running) emit('finished');
};

const start = async () => {
  isStarting.value = true;
  try {
    await aiAgentAPI.startTest();
    await load();
  } catch (error) {
    useAlert(errorMessage(error));
  } finally {
    isStarting.value = false;
  }
};

const toggleCases = async test => {
  if (openTestId.value === test.id) {
    openTestId.value = null;
    return;
  }
  try {
    const { data } = await aiAgentAPI.testCases(test.id);
    cases.value = data.cases;
    openTestId.value = test.id;
  } catch (error) {
    useAlert(errorMessage(error));
  }
};

const resultLabel = test => {
  if (test.status === 'running') return t('AI_AGENT_SETTINGS.TESTS.RUNNING');
  if (test.status === 'failed') return t('AI_AGENT_SETTINGS.TESTS.FAILED');
  return t('AI_AGENT_SETTINGS.TESTS.RESULT', {
    passed: test.passed,
    cases: test.cases,
  });
};

const resultColor = test => {
  if (test.status !== 'done') return test.status === 'failed' ? 'ruby' : 'blue';
  return test.cases && test.passed / test.cases >= 0.9 ? 'teal' : 'amber';
};

const startedOn = value => new Date(value).toLocaleString();

onMounted(load);
onBeforeUnmount(stopPolling);
</script>

<template>
  <div
    class="flex flex-col gap-3 p-4 outline outline-1 -outline-offset-1 outline-n-weak rounded-xl"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-heading-3 text-n-slate-12">
          {{ t('AI_AGENT_SETTINGS.TESTS.HEADER') }}
        </span>
        <span class="text-body-main text-n-slate-11">
          {{ t('AI_AGENT_SETTINGS.TESTS.DESCRIPTION') }}
        </span>
      </div>
      <Button
        :label="t('AI_AGENT_SETTINGS.TESTS.RUN')"
        :is-loading="isStarting"
        :disabled="tests.some(test => test.status === 'running')"
        sm
        @click="start"
      />
    </div>
    <p v-if="!tests.length" class="text-body-main text-n-slate-11">
      {{ t('AI_AGENT_SETTINGS.TESTS.NONE') }}
    </p>
    <div
      v-for="test in tests.slice(0, 5)"
      :key="test.id"
      class="flex flex-col gap-2 py-2 border-t border-n-weak"
    >
      <div class="flex items-center gap-3">
        <span class="flex-1 text-body-main text-n-slate-12">
          {{ startedOn(test.startedAt) }}
        </span>
        <Label :label="resultLabel(test)" :color="resultColor(test)" compact />
        <Button
          v-if="test.status === 'done' && test.cases"
          :label="
            openTestId === test.id
              ? t('AI_AGENT_SETTINGS.TESTS.HIDE')
              : t('AI_AGENT_SETTINGS.TESTS.SHOW')
          "
          slate
          xs
          ghost
          @click="toggleCases(test)"
        />
      </div>
      <div v-if="openTestId === test.id" class="flex flex-col gap-3">
        <div
          v-for="(item, index) in cases"
          :key="index"
          class="flex flex-col gap-1 p-3 rounded-lg bg-n-alpha-1"
        >
          <div class="flex items-center gap-2">
            <Label
              :label="t(`AI_AGENT_SETTINGS.TESTS.VERDICT.${item.verdict}`)"
              :color="VERDICT_COLORS[item.verdict]"
              compact
            />
            <span class="text-body-main text-n-slate-11">{{
              item.reason
            }}</span>
          </div>
          <span class="text-body-main text-n-slate-12 break-words">
            <strong>{{ t('AI_AGENT_SETTINGS.TESTS.QUESTION') }}:</strong>
            {{ item.question }}
          </span>
          <span class="text-body-main text-n-slate-12 break-words">
            <strong>{{ t('AI_AGENT_SETTINGS.TESTS.REFERENCE') }}:</strong>
            {{ item.reference }}
          </span>
          <span class="text-body-main text-n-slate-12 break-words">
            <strong>{{ t('AI_AGENT_SETTINGS.TESTS.CANDIDATE') }}:</strong>
            {{ item.candidate }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
