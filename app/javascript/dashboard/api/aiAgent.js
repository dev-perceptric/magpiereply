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

  sources() {
    return axios.get(`${this.url}/sources`);
  }

  addWebsite(url) {
    return axios.post(`${this.url}/sources`, { url });
  }

  addFile(file) {
    const form = new FormData();
    form.append('file', file);
    return axios.post(`${this.url}/sources`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }

  readSource(id) {
    return axios.post(`${this.url}/sources/${id}/read`);
  }

  removeSource(id) {
    return axios.delete(`${this.url}/sources/${id}`);
  }
}

export default new AiAgentAPI();
