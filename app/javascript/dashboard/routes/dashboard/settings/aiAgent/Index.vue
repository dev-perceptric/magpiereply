<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import aiAgentAPI from 'dashboard/api/aiAgent';

import SettingsLayout from '../SettingsLayout.vue';
import BaseSettingsHeader from '../components/BaseSettingsHeader.vue';
import SettingsToggleSection from 'dashboard/components-next/Settings/SettingsToggleSection.vue';
import Checkbox from 'dashboard/components-next/checkbox/Checkbox.vue';
import Button from 'dashboard/components-next/button/Button.vue';
import RadioCard from 'dashboard/components-next/radioCard/RadioCard.vue';
import KnowledgeSources from './components/KnowledgeSources.vue';
import AppConnections from './components/AppConnections.vue';
import UsageSummary from './components/UsageSummary.vue';
import ReplayTests from './components/ReplayTests.vue';

const { t } = useI18n();
const inboxes = useMapGetter('inboxes/getInboxes');

const isLoading = ref(true);
const isSaving = ref(false);
const available = ref(false);
const enabled = ref(false);
const selectedInboxIds = ref([]);
const mode = ref('draft');
// What the server last saved: knowledge, usage and tests show once Magpie is on.
const isOn = ref(false);
const summary = ref(null);

const autoAllowed = computed(() => Boolean(summary.value?.auto?.allowed));
const autoReason = computed(() => summary.value?.auto?.reason || '');
const autoPaused = computed(() => Boolean(summary.value?.auto?.paused));

const loadSummary = async () => {
  try {
    const { data } = await aiAgentAPI.summary();
    summary.value = data;
  } catch {
    summary.value = null;
  }
};

const applyState = state => {
  available.value = state.available;
  enabled.value = Boolean(state.enabled);
  isOn.value = Boolean(state.enabled);
  mode.value = state.mode === 'auto' ? 'auto' : 'draft';
  selectedInboxIds.value = state.inbox_ids || [];
  if (isOn.value) loadSummary();
};

const isSelected = inboxId => selectedInboxIds.value.includes(inboxId);

const toggleInbox = (inboxId, checked) => {
  const others = selectedInboxIds.value.filter(id => id !== inboxId);
  selectedInboxIds.value = checked ? [...others, inboxId] : others;
};

const canSave = computed(
  () => !enabled.value || selectedInboxIds.value.length > 0
);

const errorMessage = error =>
  error?.response?.data?.error || t('AI_AGENT_SETTINGS.ERROR');

const load = async () => {
  try {
    const { data } = await aiAgentAPI.show();
    applyState(data);
  } catch (error) {
    useAlert(errorMessage(error));
  } finally {
    isLoading.value = false;
  }
};

const save = async () => {
  isSaving.value = true;
  try {
    const { data } = await aiAgentAPI.update({
      enabled: enabled.value,
      inboxIds: selectedInboxIds.value,
      mode: mode.value,
    });
    applyState(data);
    useAlert(t('AI_AGENT_SETTINGS.SAVED'));
  } catch (error) {
    useAlert(errorMessage(error));
  } finally {
    isSaving.value = false;
  }
};

onMounted(load);
</script>

<template>
  <SettingsLayout
    :is-loading="isLoading"
    :loading-message="t('AI_AGENT_SETTINGS.LOADING')"
    :no-records-found="!available"
    :no-records-message="t('AI_AGENT_SETTINGS.UNAVAILABLE')"
  >
    <template #header>
      <BaseSettingsHeader
        :title="t('AI_AGENT_SETTINGS.HEADER')"
        :description="t('AI_AGENT_SETTINGS.DESCRIPTION')"
      />
    </template>
    <template #body>
      <div class="flex flex-col gap-6 max-w-2xl">
        <SettingsToggleSection
          v-model="enabled"
          :header="t('AI_AGENT_SETTINGS.TOGGLE.HEADER')"
          :description="t('AI_AGENT_SETTINGS.TOGGLE.DESCRIPTION')"
        >
          <template #editor>
            <div class="flex flex-col gap-3">
              <span class="text-heading-3 text-n-slate-12">
                {{ t('AI_AGENT_SETTINGS.INBOXES.HEADER') }}
              </span>
              <p v-if="!inboxes.length" class="text-body-main text-n-slate-11">
                {{ t('AI_AGENT_SETTINGS.INBOXES.EMPTY') }}
              </p>
              <label
                v-for="inbox in inboxes"
                :key="inbox.id"
                class="flex items-center gap-3 cursor-pointer"
              >
                <Checkbox
                  :model-value="isSelected(inbox.id)"
                  :disabled="!enabled"
                  @update:model-value="
                    checked => toggleInbox(inbox.id, checked)
                  "
                />
                <span class="text-body-main text-n-slate-12">
                  {{ inbox.name }}
                </span>
              </label>
            </div>
          </template>
        </SettingsToggleSection>

        <div class="flex flex-col gap-3">
          <span class="text-heading-3 text-n-slate-12">
            {{ t('AI_AGENT_SETTINGS.MODE.HEADER') }}
          </span>
          <RadioCard
            id="draft"
            name="ai-agent-mode"
            :label="t('AI_AGENT_SETTINGS.MODE.DRAFT')"
            :description="t('AI_AGENT_SETTINGS.MODE.DRAFT_DESCRIPTION')"
            :is-active="mode === 'draft'"
            @select="mode = 'draft'"
          />
          <RadioCard
            id="auto"
            name="ai-agent-mode"
            :label="t('AI_AGENT_SETTINGS.MODE.AUTO')"
            :description="t('AI_AGENT_SETTINGS.MODE.AUTO_DESCRIPTION')"
            :is-active="mode === 'auto'"
            :disabled="!autoAllowed"
            :disabled-label="t('AI_AGENT_SETTINGS.MODE.LOCKED')"
            :disabled-message="autoReason"
            @select="mode = 'auto'"
          />
          <p v-if="autoPaused" class="text-body-main text-n-amber-11">
            {{ t('AI_AGENT_SETTINGS.MODE.PAUSED') }}
          </p>
        </div>

        <div>
          <Button
            :label="t('AI_AGENT_SETTINGS.SAVE')"
            :is-loading="isSaving"
            :disabled="!canSave"
            @click="save"
          />
        </div>

        <UsageSummary v-if="isOn && summary" :summary="summary" />
        <ReplayTests v-if="isOn" @finished="loadSummary" />
        <KnowledgeSources v-if="isOn" />
        <AppConnections v-if="isOn" />
      </div>
    </template>
  </SettingsLayout>
</template>
