<script setup>
import { useAttrs } from 'vue';
import { useMapGetter } from 'dashboard/composables/store';

const attrs = useAttrs();
const globalConfig = useMapGetter('globalConfig/get');
</script>

<template>
  <img
    v-if="globalConfig.logoThumbnail"
    v-bind="attrs"
    :src="globalConfig.logoThumbnail"
  />
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
    <rect width="32" height="32" rx="8" fill="#0943b0" />
    <path
      d="M13 7.5h6a6 6 0 0 1 6 6v1a6 6 0 0 1-6 6h-5.6L6.5 26l1.9-6.9A6 6 0 0 1 7 15v-1.5a6 6 0 0 1 6-6Z"
      fill="#fff"
    />
    <circle cx="19.2" cy="12.6" r="1.7" fill="#0943b0" />
  </svg>
</template>
