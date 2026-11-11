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
import Label from 'dashboard/components-next/label/Label.vue';
import Button from 'dashboard/components-next/button/Button.vue';
import KnowledgeSources from './components/KnowledgeSources.vue';

const { t } = useI18n();
const inboxes = useMapGetter('inboxes/getInboxes');

const isLoading = ref(true);
const isSaving = ref(false);
const available = ref(false);
const enabled = ref(false);
const selectedInboxIds = ref([]);
// What the server last saved: knowledge can be added once Magpie is on.
const isOn = ref(false);

const applyState = state => {
  available.value = state.available;
  enabled.value = Boolean(state.enabled);
  isOn.value = Boolean(state.enabled);
  selectedInboxIds.value = state.inbox_ids || [];
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

        <div
          class="flex flex-col gap-3 p-4 outline outline-1 -outline-offset-1 outline-n-weak rounded-xl"
        >
          <span class="text-heading-3 text-n-slate-12">
            {{ t('AI_AGENT_SETTINGS.MODE.HEADER') }}
          </span>
          <div class="flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <span class="text-body-main text-n-slate-12">
                {{ t('AI_AGENT_SETTINGS.MODE.DRAFT') }}
              </span>
              <Label
                :label="t('AI_AGENT_SETTINGS.MODE.IN_USE')"
                color="blue"
                compact
              />
            </div>
            <span class="text-body-main text-n-slate-11">
              {{ t('AI_AGENT_SETTINGS.MODE.DRAFT_DESCRIPTION') }}
            </span>
          </div>
          <div class="flex flex-col gap-1 opacity-60">
            <div class="flex items-center gap-2">
              <span class="text-body-main text-n-slate-12">
                {{ t('AI_AGENT_SETTINGS.MODE.AUTO') }}
              </span>
              <Label :label="t('AI_AGENT_SETTINGS.MODE.COMING_SOON')" compact />
            </div>
            <span class="text-body-main text-n-slate-11">
              {{ t('AI_AGENT_SETTINGS.MODE.AUTO_DESCRIPTION') }}
            </span>
          </div>
        </div>

        <div>
          <Button
            :label="t('AI_AGENT_SETTINGS.SAVE')"
            :is-loading="isSaving"
            :disabled="!canSave"
            @click="save"
          />
        </div>

        <KnowledgeSources v-if="isOn" />
      </div>
    </template>
  </SettingsLayout>
</template>
