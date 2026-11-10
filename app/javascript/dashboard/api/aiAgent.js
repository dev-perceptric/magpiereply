/* global axios */
import ApiClient from './ApiClient';

// Settings → AI agent: Magpie AI's on/off switch and inboxes for the account.
class AiAgentAPI extends ApiClient {
  constructor() {
    super('ai_agent', { accountScoped: true });
  }

  show() {
    return axios.get(this.url);
  }

  update({ enabled, inboxIds }) {
    return axios.patch(this.url, {
      ai_agent: { enabled, inbox_ids: inboxIds },
    });
  }
}

export default new AiAgentAPI();
