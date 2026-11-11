import aiAgentAPI from '../aiAgent';
import ApiClient from '../ApiClient';

describe('#AiAgentAPI', () => {
  it('creates correct instance', () => {
    expect(aiAgentAPI).toBeInstanceOf(ApiClient);
    expect(aiAgentAPI).toHaveProperty('show');
    expect(aiAgentAPI).toHaveProperty('update');
  });

  describe('API calls', () => {
    const originalAxios = window.axios;
    const axiosMock = {
      get: vi.fn(() => Promise.resolve()),
      patch: vi.fn(() => Promise.resolve()),
    };

    beforeEach(() => {
      window.axios = axiosMock;
    });

    afterEach(() => {
      window.axios = originalAxios;
    });

    it('#show', () => {
      aiAgentAPI.show();
      expect(axiosMock.get).toHaveBeenCalledWith('/api/v1/ai_agent');
    });

    it('#update', () => {
      aiAgentAPI.update({ enabled: true, inboxIds: [1, 2] });
      expect(axiosMock.patch).toHaveBeenCalledWith('/api/v1/ai_agent', {
        ai_agent: { enabled: true, mode: 'draft', inbox_ids: [1, 2] },
      });
    });
  });

  it('reads traces page by page', () => {
    const axiosMock = { get: vi.fn(() => Promise.resolve()) };
    const originalAxios = window.axios;
    window.axios = axiosMock;
    aiAgentAPI.runs(40);
    expect(axiosMock.get).toHaveBeenCalledWith('/api/v1/ai_agent/runs', {
      params: { before: 40 },
    });
    window.axios = originalAxios;
  });
});
