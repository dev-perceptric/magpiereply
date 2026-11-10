require 'rails_helper'

RSpec.describe 'Settings: AI agent', type: :request do
  let(:account) { create(:account) }
  let(:admin) { create(:user, :administrator, account: account) }
  let(:agent) { create(:user, account: account, role: :agent) }
  let!(:inbox) { create(:inbox, account: account) }
  let!(:other_inbox) { create(:inbox, account: account) }
  let(:agent_url) { 'http://agent-api:8080' }
  let(:env) { { MAGPIE_AGENT_URL: agent_url, MAGPIE_AGENT_KEY: 'k' * 40 } }
  let(:path) { "/api/v1/accounts/#{account.id}/ai_agent" }

  def json
    { 'Content-Type' => 'application/json' }
  end

  def stub_state(connected:, mode: 'off', inbox_ids: [])
    stub_request(:get, "#{agent_url}/internal/accounts/#{account.id}")
      .to_return(status: 200, body: { connected: connected, mode: mode, inbox_ids: inbox_ids }.to_json, headers: json)
  end

  it 'is unavailable when the agent service is not configured' do
    with_modified_env(MAGPIE_AGENT_URL: nil, MAGPIE_AGENT_KEY: nil) do
      get path, headers: admin.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:success)
    expect(response.parsed_body).to eq('available' => false)
  end

  it 'is for administrators only' do
    with_modified_env(**env) do
      get path, headers: agent.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:unauthorized)
  end

  it 'shows Magpie as off for an account that never turned it on' do
    stub_state(connected: false)
    with_modified_env(**env) do
      get path, headers: admin.create_new_auth_token, as: :json
    end

    expect(response.parsed_body).to include('available' => true, 'enabled' => false, 'inbox_ids' => [])
  end

  context 'when turning it on' do
    let(:connect) do
      stub_request(:post, "#{agent_url}/internal/accounts/#{account.id}/connect")
        .to_return(status: 200, headers: json,
                   body: { hook_url: 'https://agent.example.com/hooks/chatwoot/h', panel_url: 'https://agent.example.com/panel/p' }.to_json)
    end
    let(:settings) do
      stub_request(:put, "#{agent_url}/internal/accounts/#{account.id}")
        .with(body: { mode: 'draft', inbox_ids: [inbox.id] }.to_json)
        .to_return(status: 200, body: { connected: true, mode: 'draft', inbox_ids: [inbox.id] }.to_json,
                   headers: json)
    end

    before do
      stub_state(connected: true, mode: 'draft', inbox_ids: [inbox.id])
      connect
      settings
    end

    it 'creates the bot, connects it, attaches only the chosen inbox and adds the side panel' do
      with_modified_env(**env) do
        patch path, params: { ai_agent: { enabled: true, inbox_ids: [inbox.id, 999_999] } }, headers: admin.create_new_auth_token, as: :json
      end

      expect(response).to have_http_status(:success)
      expect(response.parsed_body).to include('enabled' => true, 'mode' => 'draft', 'inbox_ids' => [inbox.id])

      bot = account.agent_bots.find_by!(name: 'Magpie AI')
      expect(bot.outgoing_url).to eq('https://agent.example.com/hooks/chatwoot/h')
      expect(inbox.reload.agent_bot).to eq(bot)
      expect(other_inbox.reload.agent_bot).to be_nil
      expect(account.dashboard_apps.find_by!(title: 'Magpie').content).to eq([{ 'type' => 'frame', 'url' => 'https://agent.example.com/panel/p' }])
    end

    it 'connects once and tells the agent service the chosen inboxes' do
      with_modified_env(**env) do
        patch path, params: { ai_agent: { enabled: true, inbox_ids: [inbox.id] } }, headers: admin.create_new_auth_token, as: :json
      end

      expect(connect).to have_been_requested.once
      expect(settings).to have_been_requested.once
    end
  end

  it 'turning it off detaches the bot from every inbox and keeps the bot for next time' do
    bot = create(:agent_bot, account: account, name: 'Magpie AI')
    create(:agent_bot_inbox, inbox: inbox, agent_bot: bot)
    stub_state(connected: true)
    off = stub_request(:put, "#{agent_url}/internal/accounts/#{account.id}")
          .with(body: { mode: 'off', inbox_ids: [] }.to_json)
          .to_return(status: 200, body: { connected: true, mode: 'off', inbox_ids: [] }.to_json, headers: json)

    with_modified_env(**env) do
      patch path, params: { ai_agent: { enabled: false, inbox_ids: [inbox.id] } }, headers: admin.create_new_auth_token, as: :json
    end

    expect(response.parsed_body).to include('enabled' => false)
    expect(inbox.reload.agent_bot).to be_nil
    expect(bot.reload).to be_persisted
    expect(off).to have_been_requested.once
  end

  it 'answers with a short error when the agent service is down' do
    stub_request(:get, "#{agent_url}/internal/accounts/#{account.id}").to_timeout
    with_modified_env(**env) do
      get path, headers: admin.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:bad_gateway)
    expect(response.parsed_body['error']).to eq('Magpie AI is unreachable right now. Try again in a minute.')
  end
end
