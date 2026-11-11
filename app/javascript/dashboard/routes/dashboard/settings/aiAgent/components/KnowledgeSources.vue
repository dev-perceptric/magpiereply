<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAlert } from 'dashboard/composables';
import aiAgentAPI from 'dashboard/api/aiAgent';

import Input from 'dashboard/components-next/input/Input.vue';
import Button from 'dashboard/components-next/button/Button.vue';
import Label from 'dashboard/components-next/label/Label.vue';

const POLL_MS = 5000;
const FILE_TYPES = '.pdf,.docx,.pptx,.xlsx,.html,.htm,.md,.txt';

const { t } = useI18n();

const sources = ref([]);
const websiteUrl = ref('');
const isAdding = ref(false);
const isUploading = ref(false);
const fileInputRef = ref(null);
let timer = null;

const websites = computed(() =>
  sources.value.filter(source => source.kind === 'website')
);
const files = computed(() =>
  sources.value.filter(source => source.kind === 'file')
);
const sections = computed(() => [
  {
    key: 'websites',
    header: t('AI_AGENT_SETTINGS.KNOWLEDGE.WEBSITES'),
    description: t('AI_AGENT_SETTINGS.KNOWLEDGE.WEBSITES_DESCRIPTION'),
    items: websites.value,
  },
  {
    key: 'files',
    header: t('AI_AGENT_SETTINGS.KNOWLEDGE.FILES'),
    description: t('AI_AGENT_SETTINGS.KNOWLEDGE.FILES_DESCRIPTION'),
    items: files.value,
  },
]);

const errorMessage = error =>
  error?.response?.data?.error || t('AI_AGENT_SETTINGS.KNOWLEDGE.ERROR');

const statusLabel = source => {
  if (source.status === 'reading') {
    return { text: t('AI_AGENT_SETTINGS.KNOWLEDGE.READING'), color: 'blue' };
  }
  if (source.status === 'failed') {
    return { text: t('AI_AGENT_SETTINGS.KNOWLEDGE.FAILED'), color: 'ruby' };
  }
  return {
    text: t(
      'AI_AGENT_SETTINGS.KNOWLEDGE.READY',
      { n: source.pages },
      source.pages
    ),
    color: 'teal',
  };
};

const stopPolling = () => {
  clearTimeout(timer);
  timer = null;
};

const load = async () => {
  stopPolling();
  try {
    const { data } = await aiAgentAPI.sources();
    sources.value = data.sources;
  } catch (error) {
    useAlert(errorMessage(error));
    return;
  }
  if (sources.value.some(source => source.status === 'reading')) {
    timer = setTimeout(load, POLL_MS);
  }
};

const addWebsite = async () => {
  if (!websiteUrl.value.trim()) return;
  isAdding.value = true;
  try {
    await aiAgentAPI.addWebsite(websiteUrl.value.trim());
    websiteUrl.value = '';
    await load();
  } catch (error) {
    useAlert(errorMessage(error));
  } finally {
    isAdding.value = false;
  }
};

const openFileDialog = () => fileInputRef.value?.click();

const uploadFile = async event => {
  const [file] = event.target.files || [];
  event.target.value = '';
  if (!file) return;
  isUploading.value = true;
  try {
    await aiAgentAPI.addFile(file);
    await load();
  } catch (error) {
    useAlert(errorMessage(error));
  } finally {
    isUploading.value = false;
  }
};

const readAgain = async source => {
  try {
    await aiAgentAPI.readSource(source.id);
    await load();
  } catch (error) {
    useAlert(errorMessage(error));
  }
};

const remove = async source => {
  try {
    await aiAgentAPI.removeSource(source.id);
    await load();
  } catch (error) {
    useAlert(errorMessage(error));
  }
};

onMounted(load);
onBeforeUnmount(stopPolling);
</script>

<template>
  <div
    class="flex flex-col gap-4 p-4 outline outline-1 -outline-offset-1 outline-n-weak rounded-xl"
  >
    <div class="flex flex-col gap-1">
      <span class="text-heading-3 text-n-slate-12">
        {{ t('AI_AGENT_SETTINGS.KNOWLEDGE.HEADER') }}
      </span>
      <span class="text-body-main text-n-slate-11">
        {{ t('AI_AGENT_SETTINGS.KNOWLEDGE.DESCRIPTION') }}
      </span>
    </div>

    <input
      ref="fileInputRef"
      type="file"
      :accept="FILE_TYPES"
      class="hidden"
      @change="uploadFile"
    />
    <div class="flex flex-col gap-1">
      <span class="text-body-main font-medium text-n-slate-12">
        {{ t('AI_AGENT_SETTINGS.KNOWLEDGE.HELP_CENTER') }}
      </span>
      <span class="text-body-main text-n-slate-11">
        {{ t('AI_AGENT_SETTINGS.KNOWLEDGE.HELP_CENTER_DESCRIPTION') }}
      </span>
    </div>

    <div
      v-for="section in sections"
      :key="section.key"
      class="flex flex-col gap-2"
    >
      <div class="flex flex-col gap-1">
        <span class="text-body-main font-medium text-n-slate-12">
          {{ section.header }}
        </span>
        <span class="text-body-main text-n-slate-11">
          {{ section.description }}
        </span>
      </div>
      <p v-if="!section.items.length" class="text-body-main text-n-slate-11">
        {{ t('AI_AGENT_SETTINGS.KNOWLEDGE.EMPTY') }}
      </p>
      <div
        v-for="source in section.items"
        :key="source.id"
        class="flex items-start gap-3 py-2 border-t border-n-weak"
      >
        <div class="flex flex-col flex-1 min-w-0 gap-1">
          <span class="text-body-main text-n-slate-12 break-all">
            {{ source.name }}
          </span>
          <span
            v-if="source.status === 'failed' && source.error"
            class="text-body-main text-n-ruby-11"
          >
            {{ source.error }}
          </span>
        </div>
        <Label
          :label="statusLabel(source).text"
          :color="statusLabel(source).color"
          compact
        />
        <Button
          v-if="source.status !== 'reading'"
          v-tooltip.top="t('AI_AGENT_SETTINGS.KNOWLEDGE.READ_AGAIN')"
          :aria-label="t('AI_AGENT_SETTINGS.KNOWLEDGE.READ_AGAIN')"
          icon="i-lucide-refresh-cw"
          slate
          xs
          ghost
          @click="readAgain(source)"
        />
        <Button
          v-tooltip.top="t('AI_AGENT_SETTINGS.KNOWLEDGE.REMOVE')"
          :aria-label="t('AI_AGENT_SETTINGS.KNOWLEDGE.REMOVE')"
          icon="i-lucide-trash-2"
          slate
          xs
          ghost
          @click="remove(source)"
        />
      </div>
      <form
        v-if="section.key === 'websites'"
        class="flex items-start gap-2"
        @submit.prevent="addWebsite"
      >
        <Input
          v-model="websiteUrl"
          type="url"
          class="flex-1"
          :placeholder="t('AI_AGENT_SETTINGS.KNOWLEDGE.WEBSITE_PLACEHOLDER')"
        />
        <Button
          type="submit"
          :label="t('AI_AGENT_SETTINGS.KNOWLEDGE.ADD_WEBSITE')"
          :is-loading="isAdding"
          :disabled="!websiteUrl.trim()"
        />
      </form>
      <div v-else>
        <Button
          :label="t('AI_AGENT_SETTINGS.KNOWLEDGE.UPLOAD_FILE')"
          :is-loading="isUploading"
          slate
          @click="openFileDialog"
        />
      </div>
    </div>
  </div>
</template>
