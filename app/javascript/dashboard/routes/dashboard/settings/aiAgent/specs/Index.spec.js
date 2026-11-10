import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useMapGetter } from 'dashboard/composables/store';
import { useAlert } from 'dashboard/composables';
import aiAgentAPI from 'dashboard/api/aiAgent';
import AiAgent from '../Index.vue';

vi.mock('dashboard/composables/store');
vi.mock('dashboard/composables', () => ({ useAlert: vi.fn() }));
vi.mock('dashboard/api/aiAgent', () => ({
  default: { show: vi.fn(), update: vi.fn() },
}));

const inboxes = [
  { id: 1, name: 'Website' },
  { id: 2, name: 'Email' },
];

const mountPage = async state => {
  aiAgentAPI.show.mockResolvedValue({ data: state });
  const wrapper = mount(AiAgent, {
    global: {
      stubs: {
        BaseSettingsHeader: { template: '<div />' },
        WootLoadingState: { template: '<div />' },
      },
    },
  });
  await flushPromises();
  return wrapper;
};

describe('Settings → AI agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMapGetter.mockReturnValue(ref(inboxes));
  });

  it('says so when Magpie AI is not set up', async () => {
    const wrapper = await mountPage({ available: false });

    expect(wrapper.text()).toContain('AI_AGENT_SETTINGS.UNAVAILABLE');
    expect(wrapper.find('[role="switch"]').exists()).toBe(false);
  });

  it('turns Magpie on for the chosen inbox', async () => {
    aiAgentAPI.update.mockResolvedValue({
      data: { available: true, enabled: true, mode: 'draft', inbox_ids: [2] },
    });
    const wrapper = await mountPage({
      available: true,
      enabled: false,
      mode: 'off',
      inbox_ids: [],
    });

    await wrapper.find('[role="switch"]').trigger('click');
    const boxes = wrapper.findAll('input[type="checkbox"]');
    await boxes[1].setValue(true);
    await wrapper.find('button:not([role="switch"])').trigger('click');
    await flushPromises();

    expect(aiAgentAPI.update).toHaveBeenCalledWith({
      enabled: true,
      inboxIds: [2],
    });
    expect(useAlert).toHaveBeenCalledWith('AI_AGENT_SETTINGS.SAVED');
  });

  it('shows the error the server gives', async () => {
    aiAgentAPI.update.mockRejectedValue({
      response: { data: { error: 'Magpie AI is unreachable right now.' } },
    });
    const wrapper = await mountPage({
      available: true,
      enabled: true,
      mode: 'draft',
      inbox_ids: [1],
    });

    await wrapper.find('button:not([role="switch"])').trigger('click');
    await flushPromises();

    expect(useAlert).toHaveBeenCalledWith(
      'Magpie AI is unreachable right now.'
    );
  });
});
