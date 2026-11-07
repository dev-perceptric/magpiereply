<script>
import FeaturePlaceholder from './FeaturePlaceholder.vue';
export default {
  components: { FeaturePlaceholder },
  props: {
    message: {
      type: String,
      required: true,
    },
  },
};
</script>

<template>
  <div class="flex flex-col items-center justify-center h-full gap-3 px-4">
    <span
      class="inline-flex items-center gap-2 py-1 ps-1 pe-3 -rotate-2 rounded-md bg-n-surface-1 shadow-sticker text-sm font-semibold text-n-slate-12"
    >
      <span
        class="grid size-5 place-content-center rounded bg-n-brand text-white"
        aria-hidden="true"
      >
        <span class="i-lucide-inbox size-3.5" />
      </span>
      {{ $t('CONVERSATION.EMPTY_STATE_LABEL') }}
    </span>
    <span
      class="max-w-sm text-base font-semibold tracking-display text-center text-n-slate-12"
    >
      {{ message }}
    </span>
    <!-- Cmd bar, keyboard shortcuts placeholder -->
    <FeaturePlaceholder />
  </div>
</template>
