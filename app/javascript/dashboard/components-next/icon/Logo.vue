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
    <path
      d="M3.5 28.5V16A12.5 12.5 0 1 1 16 28.5Z"
      stroke="#0B1220"
      stroke-width="5"
    />
    <path
      d="M28.5 16A12.5 12.5 0 0 1 16 28.5"
      stroke="#2450ff"
      stroke-width="5"
    />
    <circle cx="16" cy="16" r="3.5" fill="#0B1220" />
  </svg>
</template>
