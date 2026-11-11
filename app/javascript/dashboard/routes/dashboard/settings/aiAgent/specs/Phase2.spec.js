import { flushPromises, mount } from '@vue/test-utils';
import aiAgentAPI from 'dashboard/api/aiAgent';
import UsageSummary from '../components/UsageSummary.vue';
import ReplayTests from '../components/ReplayTests.vue';
import Traces from '../Traces.vue';

vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal()),
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: { accountId: '4' } }),
}));
vi.mock('dashboard/composables', () => ({ useAlert: vi.fn() }));
vi.mock('dashboard/api/aiAgent', () => ({
  default: {
    tests: vi.fn(),
    startTest: vi.fn(),
    testCases: vi.fn(),
    runs: vi.fn(),
    run: vi.fn(),
  },
}));

const global = {
  stubs: {
    BaseSettingsHeader: { template: '<div />' },
    WootLoadingState: { template: '<div />' },
  },
  directives: { tooltip: {} },
};

describe('Settings → AI agent, phase 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the month against the cap and the last 30 days', () => {
    const wrapper = mount(UsageSummary, {
      props: {
        summary: {
          month: { cost_usd: 25, cap_usd: 50, cap_reached: false },
          last_30_days: { drafts: 12, autoSent: 7 },
        },
      },
      global,
    });

    expect(wrapper.find('.w-6\\/12').exists()).toBe(true);
    expect(wrapper.text()).toContain('12');
    expect(wrapper.text()).toContain('7');
  });

  it('runs a replay test and shows its answers', async () => {
    aiAgentAPI.tests.mockResolvedValue({
      data: {
        tests: [
          {
            id: 3,
            status: 'done',
            cases: 10,
            passed: 9,
            startedAt: '2026-11-11T10:00:00Z',
          },
        ],
      },
    });
    aiAgentAPI.startTest.mockResolvedValue({ data: { id: 4 } });
    aiAgentAPI.testCases.mockResolvedValue({
      data: {
        cases: [
          {
            question: 'When is my refund back?',
            reference: '5 to 10 days',
            candidate: 'In 2 days',
            verdict: 'wrong',
            reason: 'Wrong timing',
          },
        ],
      },
    });
    const wrapper = mount(ReplayTests, { global });
    await flushPromises();

    const buttons = wrapper.findAll('button');
    await buttons[1].trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('In 2 days');
    expect(wrapper.text()).toContain('Wrong timing');

    await buttons[0].trigger('click');
    await flushPromises();
    expect(aiAgentAPI.startTest).toHaveBeenCalled();
  });

  it('lists turns and opens their steps', async () => {
    aiAgentAPI.runs.mockResolvedValue({
      data: {
        runs: [
          {
            id: 9,
            conversationId: 55,
            status: 'done',
            startedAt: '2026-11-11T10:00:00Z',
            durationMs: 3200,
            costUsd: 0.0042,
            outcome: 'sent_by_magpie',
            error: null,
          },
        ],
      },
    });
    aiAgentAPI.run.mockResolvedValue({
      data: {
        steps: [
          {
            name: 'brain',
            durationMs: 3000,
            output: { reply: 'We ship to Canada.' },
          },
        ],
      },
    });
    const wrapper = mount(Traces, { global });
    await flushPromises();

    expect(wrapper.text()).toContain('$0.0042');
    expect(wrapper.find('a').attributes('href')).toBe(
      '/app/accounts/4/conversations/55'
    );
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('We ship to Canada.');
  });
});
