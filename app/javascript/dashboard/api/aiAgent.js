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

  update({ enabled, inboxIds, mode = 'draft' }) {
    return axios.patch(this.url, {
      ai_agent: { enabled, mode, inbox_ids: inboxIds },
    });
  }

  summary() {
    return axios.get(`${this.url}/summary`);
  }

  runs(before) {
    return axios.get(`${this.url}/runs`, { params: before ? { before } : {} });
  }

  run(id) {
    return axios.get(`${this.url}/runs/${id}`);
  }

  tests() {
    return axios.get(`${this.url}/tests`);
  }

  startTest() {
    return axios.post(`${this.url}/tests`);
  }

  testCases(id) {
    return axios.get(`${this.url}/tests/${id}`);
  }

  apps() {
    return axios.get(`${this.url}/apps`);
  }

  connectApp(provider) {
    return axios.post(`${this.url}/apps/${provider}/connect`);
  }

  disconnectApp(provider) {
    return axios.delete(`${this.url}/apps/${provider}`);
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
