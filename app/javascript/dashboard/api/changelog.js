import ApiClient from './ApiClient';

class ChangelogApi extends ApiClient {
  constructor() {
    super('changelog', { apiVersion: 'v1' });
  }

  // MagpieReply has no release notes feed yet. The upstream feed described another product, so the
  // sidebar card gets no posts and stays hidden.
  // eslint-disable-next-line class-methods-use-this
  fetchFromHub() {
    return Promise.resolve({ data: { posts: [] } });
  }
}

export default new ChangelogApi();
