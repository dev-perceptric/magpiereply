/**
 * Composable for branding-related utilities
 * Provides methods to customize text with installation-specific branding
 */
import { useMapGetter } from 'dashboard/composables/store.js';

const PRODUCT_NAME_PATTERN = /magpiereply|chatwoot/gi;

export function useBranding() {
  const globalConfig = useMapGetter('globalConfig/get');
  /**
   * Replaces the product name, "MagpieReply" or the upstream product name
   * (any casing), in text with the installation name from global config
   * @param {string} text - The text to process
   * @returns {string} - Text with the product name replaced by installation name
   */
  const replaceInstallationName = text => {
    if (!text) return text;

    const installationName = globalConfig.value?.installationName;
    if (!installationName) return text;

    return text.replace(PRODUCT_NAME_PATTERN, installationName);
  };

  return {
    replaceInstallationName,
  };
}
