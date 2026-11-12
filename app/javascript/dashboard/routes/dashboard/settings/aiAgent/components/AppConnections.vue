<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useAlert } from 'dashboard/composables';
import aiAgentAPI from 'dashboard/api/aiAgent';

import Button from 'dashboard/components-next/button/Button.vue';
import Label from 'dashboard/components-next/label/Label.vue';

const STATUS = {
  connected: { key: 'CONNECTED', color: 'teal' },
  not_connected: { key: 'NOT_CONNECTED', color: 'slate' },
  pending: { key: 'PENDING', color: 'blue' },
  failed: { key: 'FAILED', color: 'ruby' },
};

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const apps = ref([]);
const busy = ref(null);

const errorMessage = error =>
  error?.response?.data?.error || t('AI_AGENT_SETTINGS.APPS.ERROR');

const statusOf = app => {
  if (!app.available) return { key: 'NEEDS_SETUP', color: 'amber' };
  return STATUS[app.status] || STATUS.not_connected;
};

const load = async () => {
  try {
    const { data } = await aiAgentAPI.apps();
    apps.value = data.apps;
  } catch (error) {
    useAlert(errorMessage(error));
  }
};

// The app's own sign-in page sends the admin back here with how it went.
const showReturn = () => {
  const { app, result, message, ...rest } = route.query;
  if (!app || !message) return;
  useAlert(message);
  router.replace({ query: rest });
};

const connect = async app => {
  busy.value = app.provider;
  try {
    const { data } = await aiAgentAPI.connectApp(app.provider);
    window.location.assign(data.authorize_url);
  } catch (error) {
    useAlert(errorMessage(error));
    busy.value = null;
  }
};

const disconnect = async app => {
  busy.value = app.provider;
  try {
    await aiAgentAPI.disconnectApp(app.provider);
    await load();
  } catch (error) {
    useAlert(errorMessage(error));
  } finally {
    busy.value = null;
  }
};

onMounted(() => {
  showReturn();
  load();
});
</script>

<template>
  <div
    class="flex flex-col gap-3 p-4 outline outline-1 -outline-offset-1 outline-n-weak rounded-xl"
  >
    <div class="flex flex-col gap-1">
      <span class="text-heading-3 text-n-slate-12">
        {{ t('AI_AGENT_SETTINGS.APPS.HEADER') }}
      </span>
      <span class="text-body-main text-n-slate-11">
        {{ t('AI_AGENT_SETTINGS.APPS.DESCRIPTION') }}
      </span>
    </div>
    <div
      v-for="app in apps"
      :key="app.provider"
      class="flex items-start gap-3 py-2 border-t border-n-weak"
    >
      <div class="flex flex-col flex-1 min-w-0 gap-1">
        <div class="flex items-center gap-2">
          <span class="text-body-main font-medium text-n-slate-12">
            {{ app.name }}
          </span>
          <Label
            :label="t(`AI_AGENT_SETTINGS.APPS.${statusOf(app).key}`)"
            :color="statusOf(app).color"
            compact
          />
        </div>
        <span class="text-body-main text-n-slate-11">
          {{ t(`AI_AGENT_SETTINGS.APPS.DETAILS.${app.provider}`) }}
        </span>
        <span
          v-if="app.status === 'failed' && app.error"
          class="text-body-main text-n-ruby-11"
        >
          {{ app.error }}
        </span>
      </div>
      <Button
        v-if="app.status === 'connected'"
        :label="t('AI_AGENT_SETTINGS.APPS.DISCONNECT')"
        :is-loading="busy === app.provider"
        slate
        sm
        @click="disconnect(app)"
      />
      <Button
        v-else
        :label="t('AI_AGENT_SETTINGS.APPS.CONNECT')"
        :is-loading="busy === app.provider"
        :disabled="!app.available"
        sm
        @click="connect(app)"
      />
    </div>
  </div>
</template>
