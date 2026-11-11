<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useAlert } from 'dashboard/composables';
import aiAgentAPI from 'dashboard/api/aiAgent';
import { frontendURL, conversationUrl } from 'dashboard/helper/URLHelper';

import SettingsLayout from '../SettingsLayout.vue';
import BaseSettingsHeader from '../components/BaseSettingsHeader.vue';
import Button from 'dashboard/components-next/button/Button.vue';
import Label from 'dashboard/components-next/label/Label.vue';

const OUTCOME_COLORS = {
  sent_by_magpie: 'teal',
  sent_by_person: 'blue',
  pending: 'amber',
  monthly_limit: 'ruby',
  two_tries: 'amber',
};

const { t, te } = useI18n();
const route = useRoute();

const runs = ref([]);
const isLoading = ref(true);
const isLoadingMore = ref(false);
const hasMore = ref(false);
const openRunId = ref(null);
const steps = ref([]);

const errorMessage = error =>
  error?.response?.data?.error || t('AI_AGENT_SETTINGS.KNOWLEDGE.ERROR');

const loadPage = async before => {
  const { data } = await aiAgentAPI.runs(before);
  hasMore.value = data.runs.length === 50;
  runs.value = before ? [...runs.value, ...data.runs] : data.runs;
};

const loadFirst = async () => {
  try {
    await loadPage();
  } catch (error) {
    useAlert(errorMessage(error));
  } finally {
    isLoading.value = false;
  }
};

const loadMore = async () => {
  isLoadingMore.value = true;
  try {
    await loadPage(runs.value[runs.value.length - 1]?.id);
  } catch (error) {
    useAlert(errorMessage(error));
  } finally {
    isLoadingMore.value = false;
  }
};

const toggle = async run => {
  if (openRunId.value === run.id) {
    openRunId.value = null;
    return;
  }
  try {
    const { data } = await aiAgentAPI.run(run.id);
    steps.value = data.steps;
    openRunId.value = run.id;
  } catch (error) {
    useAlert(errorMessage(error));
  }
};

const outcomeLabel = run => {
  if (run.status === 'failed') return t('AI_AGENT_SETTINGS.TRACES.FAILED');
  const key = `AI_AGENT_SETTINGS.TRACES.OUTCOME.${run.outcome}`;
  return run.outcome && te(key) ? t(key) : run.status;
};

const outcomeColor = run =>
  run.status === 'failed' ? 'ruby' : OUTCOME_COLORS[run.outcome] || 'slate';

const conversationLink = run =>
  frontendURL(
    conversationUrl({
      accountId: route.params.accountId,
      id: run.conversationId,
    })
  );

const when = value => new Date(value).toLocaleString();
const cost = value => `$${Number(value || 0).toFixed(4)}`;
const seconds = ms => (ms === null ? '' : `${(ms / 1000).toFixed(1)}s`);
const pretty = value => JSON.stringify(value, null, 2);

onMounted(loadFirst);
</script>

<template>
  <SettingsLayout
    :is-loading="isLoading"
    :loading-message="t('AI_AGENT_SETTINGS.LOADING')"
    :no-records-found="!runs.length"
    :no-records-message="t('AI_AGENT_SETTINGS.TRACES.EMPTY')"
  >
    <template #header>
      <BaseSettingsHeader
        :title="t('AI_AGENT_SETTINGS.TRACES.HEADER')"
        :description="t('AI_AGENT_SETTINGS.TRACES.DESCRIPTION')"
        :back-button-label="t('AI_AGENT_SETTINGS.TRACES.BACK')"
      />
    </template>
    <template #body>
      <div class="flex flex-col max-w-4xl">
        <div
          v-for="run in runs"
          :key="run.id"
          class="flex flex-col gap-2 py-3 border-b border-n-weak"
        >
          <button
            type="button"
            class="flex flex-wrap items-center gap-3 text-start"
            @click="toggle(run)"
          >
            <span class="text-body-main text-n-slate-11 w-40">
              {{ when(run.startedAt) }}
            </span>
            <a
              :href="conversationLink(run)"
              class="text-body-main text-n-blue-11 hover:underline"
              @click.stop
            >
              {{
                t('AI_AGENT_SETTINGS.TRACES.CONVERSATION', {
                  id: run.conversationId,
                })
              }}
            </a>
            <Label
              :label="outcomeLabel(run)"
              :color="outcomeColor(run)"
              compact
            />
            <span class="flex-1" />
            <span class="text-body-main text-n-slate-11">
              {{ seconds(run.durationMs) }}
            </span>
            <span class="text-body-main text-n-slate-12 w-20 text-end">
              {{ cost(run.costUsd) }}
            </span>
          </button>
          <span v-if="run.error" class="text-body-main text-n-ruby-11">
            {{ run.error }}
          </span>
          <div v-if="openRunId === run.id" class="flex flex-col gap-2">
            <div
              v-for="(step, index) in steps"
              :key="index"
              class="flex flex-col gap-1 p-3 rounded-lg bg-n-alpha-1"
            >
              <div class="flex items-center gap-3">
                <span class="text-body-main font-medium text-n-slate-12">
                  {{ step.name }}
                </span>
                <span class="text-body-main text-n-slate-11">
                  {{ seconds(step.durationMs) }}
                </span>
              </div>
              <pre
                v-if="step.output"
                class="text-xs text-n-slate-12 whitespace-pre-wrap break-words m-0"
                >{{ pretty(step.output) }}</pre
              >
            </div>
          </div>
        </div>
        <div v-if="hasMore" class="pt-3">
          <Button
            :label="t('AI_AGENT_SETTINGS.TRACES.LOAD_MORE')"
            :is-loading="isLoadingMore"
            slate
            sm
            @click="loadMore"
          />
        </div>
      </div>
    </template>
  </SettingsLayout>
</template>
