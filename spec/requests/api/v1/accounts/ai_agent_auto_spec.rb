require 'rails_helper'

RSpec.describe 'Settings: AI agent Auto mode', type: :request do
  let(:account) { create(:account) }
  let(:admin) { create(:user, :administrator, account: account) }
  let!(:inbox) { create(:inbox, account: account) }
  let(:agent_url) { 'http://agent-api:8080' }
  let(:env) { { MAGPIE_AGENT_URL: agent_url, MAGPIE_AGENT_KEY: 'k' * 40 } }
  let(:json) { { 'Content-Type' => 'application/json' } }
  let(:bot) { create(:agent_bot, account: account, name: 'Magpie AI') }

  before do
    bot
    stub_request(:get, "#{agent_url}/internal/accounts/#{account.id}")
      .to_return(status: 200, headers: json, body: { connected: true, mode: 'draft', inbox_ids: [inbox.id] }.to_json)
  end

  it "shows the agent's reason when Auto isn't unlocked yet, and leaves the inboxes as they were" do
    create(:agent_bot_inbox, inbox: inbox, agent_bot: bot)
    stub_request(:put, "#{agent_url}/internal/accounts/#{account.id}")
      .with(body: { mode: 'auto', inbox_ids: [inbox.id] }.to_json)
      .to_return(status: 422, headers: json, body: { error: 'Auto unlocks after a replay test of at least 10 replies your team sent.' }.to_json)

    with_modified_env(**env) do
      patch "/api/v1/accounts/#{account.id}/ai_agent", params: { ai_agent: { enabled: true, mode: 'auto', inbox_ids: [inbox.id] } },
                                                       headers: admin.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body['error']).to start_with('Auto unlocks after a replay test')
    expect(inbox.reload.agent_bot).to eq(bot)
  end
end
