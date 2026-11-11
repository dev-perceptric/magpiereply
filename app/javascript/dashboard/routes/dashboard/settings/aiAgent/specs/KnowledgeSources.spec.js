import { flushPromises, mount } from '@vue/test-utils';
import { useAlert } from 'dashboard/composables';
import aiAgentAPI from 'dashboard/api/aiAgent';
import KnowledgeSources from '../components/KnowledgeSources.vue';

vi.mock('dashboard/composables', () => ({ useAlert: vi.fn() }));
vi.mock('dashboard/api/aiAgent', () => ({
  default: {
    sources: vi.fn(),
    addWebsite: vi.fn(),
    addFile: vi.fn(),
    readSource: vi.fn(),
    removeSource: vi.fn(),
  },
}));

const website = {
  id: 3,
  kind: 'website',
  name: 'https://shop.example.com/',
  status: 'ready',
  error: null,
  pages: 12,
};
const file = {
  id: 4,
  kind: 'file',
  name: 'Returns.pdf',
  status: 'failed',
  error: 'No text was found in this file.',
  pages: 0,
};

const mountWith = async sources => {
  aiAgentAPI.sources.mockResolvedValue({ data: { sources } });
  const wrapper = mount(KnowledgeSources, {
    global: { directives: { tooltip: {} } },
  });
  await flushPromises();
  return wrapper;
};

describe('Settings → AI agent → Knowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('lists websites and files with their state and errors', async () => {
    const wrapper = await mountWith([website, file]);

    expect(wrapper.text()).toContain('https://shop.example.com/');
    expect(wrapper.text()).toContain('Returns.pdf');
    expect(wrapper.text()).toContain('No text was found in this file.');
    expect(wrapper.text()).toContain('AI_AGENT_SETTINGS.KNOWLEDGE.FAILED');
  });

  it('adds a website and reloads the list', async () => {
    aiAgentAPI.addWebsite.mockResolvedValue({ data: { source: website } });
    const wrapper = await mountWith([]);

    await wrapper
      .find('input[type="url"]')
      .setValue(' https://shop.example.com ');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(aiAgentAPI.addWebsite).toHaveBeenCalledWith(
      'https://shop.example.com'
    );
    expect(aiAgentAPI.sources).toHaveBeenCalledTimes(2);
  });

  it('uploads the chosen file', async () => {
    aiAgentAPI.addFile.mockResolvedValue({ data: { source: file } });
    const wrapper = await mountWith([]);
    const chosen = new File(['Returns within 30 days.'], 'Returns.txt', {
      type: 'text/plain',
    });
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [chosen] });

    await input.trigger('change');
    await flushPromises();

    expect(aiAgentAPI.addFile).toHaveBeenCalledWith(chosen);
  });

  it("shows the server's reason when adding fails", async () => {
    aiAgentAPI.addWebsite.mockRejectedValue({
      response: { data: { error: 'That website is already added.' } },
    });
    const wrapper = await mountWith([]);

    await wrapper
      .find('input[type="url"]')
      .setValue('https://shop.example.com');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(useAlert).toHaveBeenCalledWith('That website is already added.');
  });

  it('checks again while something is being read', async () => {
    vi.useFakeTimers();
    await mountWith([{ ...website, status: 'reading' }]);
    expect(aiAgentAPI.sources).toHaveBeenCalledTimes(1);

    aiAgentAPI.sources.mockResolvedValue({ data: { sources: [website] } });
    await vi.advanceTimersByTimeAsync(5000);

    expect(aiAgentAPI.sources).toHaveBeenCalledTimes(2);
  });
});
