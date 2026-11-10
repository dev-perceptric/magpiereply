import AiAgent from './Index.vue';
import { frontendURL } from '../../../../helper/URLHelper';
import SettingsWrapper from '../SettingsWrapper.vue';

export default {
  routes: [
    {
      path: frontendURL('accounts/:accountId/settings/ai-agent'),
      meta: {
        permissions: ['administrator'],
      },
      component: SettingsWrapper,
      children: [
        {
          path: '',
          name: 'settings_ai_agent',
          component: AiAgent,
          meta: {
            permissions: ['administrator'],
          },
        },
      ],
    },
  ],
};
