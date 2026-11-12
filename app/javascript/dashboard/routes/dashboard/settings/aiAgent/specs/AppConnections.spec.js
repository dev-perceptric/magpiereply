import { flushPromises, mount } from '@vue/test-utils';
import { useAlert } from 'dashboard/composables';
import aiAgentAPI from 'dashboard/api/aiAgent';
import AppConnections from '../components/AppConnections.vue';

const replace = vi.fn();
let query = {};

vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal()),
  useRoute: () => ({ query }),
  useRouter: () => ({ replace }),
}));
vi.mock('dashboard/composables', () => ({ useAlert: vi.fn() }));
vi.mock('dashboard/api/aiAgent', () => ({
  default: { apps: vi.fn(), connectApp: vi.fn(), disconnectApp: vi.fn() },
}));

const apps = [
  {
    provider: 'stripe',
    name: 'Stripe',
    available: true,
    status: 'connected',
    error: null,
  },
  {
    provider: 'linear',
    name: 'Linear',
    available: true,
    status: 'not_connected',
    error: null,
  },
  {
    provider: 'hubspot',
    name: 'HubSpot',
    available: false,
    status: 'not_connected',
    error: null,
  },
  {
    provider: 'shopify',
    name: 'Shopify',
    available: false,
    status: 'not_connected',
    error: null,
  },
];

const mountIt = async () => {
  aiAgentAPI.apps.mockResolvedValue({ data: { apps } });
  const wrapper = mount(AppConnections);
  await flushPromises();
  return wrapper;
};

describe('Settings → AI agent → Apps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query = {};
  });

  it('shows each app with its state, and keeps apps that need setup closed', async () => {
    const wrapper = await mountIt();
    const text = wrapper.text();

    expect(text).toContain('AI_AGENT_SETTINGS.APPS.CONNECTED');
    expect(text).toContain('AI_AGENT_SETTINGS.APPS.NEEDS_SETUP');
    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(4);
    expect(buttons[2].attributes('disabled')).toBeDefined();
  });

  it("sends the admin to the app's own sign-in page", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { assign },
      writable: true,
    });
    aiAgentAPI.connectApp.mockResolvedValue({
      data: { authorize_url: 'https://mcp.linear.app/authorize?state=s' },
    });
    const wrapper = await mountIt();

    await wrapper.findAll('button')[1].trigger('click');
    await flushPromises();

    expect(aiAgentAPI.connectApp).toHaveBeenCalledWith('linear');
    expect(assign).toHaveBeenCalledWith(
      'https://mcp.linear.app/authorize?state=s'
    );
  });

  it('disconnects an app', async () => {
    aiAgentAPI.disconnectApp.mockResolvedValue({});
    const wrapper = await mountIt();

    await wrapper.findAll('button')[0].trigger('click');
    await flushPromises();

    expect(aiAgentAPI.disconnectApp).toHaveBeenCalledWith('stripe');
  });

  it('says how the sign-in went when the admin comes back', async () => {
    query = {
      app: 'stripe',
      result: 'connected',
      message: 'Stripe is connected.',
    };
    await mountIt();

    expect(useAlert).toHaveBeenCalledWith('Stripe is connected.');
    expect(replace).toHaveBeenCalledWith({ query: {} });
  });
});
