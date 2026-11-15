<script setup>
import { computed, useAttrs } from 'vue';
import { useMapGetter } from 'dashboard/composables/store';

const DEFAULT_THUMBNAIL = '/brand-assets/logo_thumbnail.svg';

const attrs = useAttrs();
const globalConfig = useMapGetter('globalConfig/get');

// A custom-branded install shows its own image. The MagpieReply mark is drawn
// inline so its ring follows the text color and stays visible on the dark sidebar.
const customThumbnail = computed(() => {
  const thumbnail = globalConfig.value.logoThumbnail;
  if (!thumbnail || thumbnail.endsWith(DEFAULT_THUMBNAIL)) return null;
  return thumbnail;
});
</script>

<template>
  <img v-if="customThumbnail" v-bind="attrs" :src="customThumbnail" />
  <svg
    v-else
    v-once
    v-bind="attrs"
    width="16"
    height="16"
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M3.5 28.5V16A12.5 12.5 0 1 1 16 28.5Z"
      stroke="currentColor"
      stroke-width="5"
    />
    <path
      d="M28.5 16A12.5 12.5 0 0 1 16 28.5"
      stroke="#2450ff"
      stroke-width="5"
    />
    <circle cx="16" cy="16" r="3.5" fill="currentColor" />
  </svg>
</template>
