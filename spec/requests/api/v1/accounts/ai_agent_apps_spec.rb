require 'rails_helper'

RSpec.describe 'Settings: AI agent apps', type: :request do
  let(:account) { create(:account) }
  let(:admin) { create(:user, :administrator, account: account) }
  let(:agent) { create(:user, account: account, role: :agent) }
  let(:agent_url) { 'http://agent-api:8080' }
  let(:env) { { MAGPIE_AGENT_URL: agent_url, MAGPIE_AGENT_KEY: 'k' * 40 } }
  let(:base) { "/api/v1/accounts/#{account.id}/ai_agent/apps" }
  let(:internal) { "#{agent_url}/internal/accounts/#{account.id}/apps" }
  let(:json) { { 'Content-Type' => 'application/json' } }

  def as(user, method, path)
    with_modified_env(**env) do
      public_send(method, path, headers: user.create_new_auth_token, as: :json)
    end
  end

  it 'lists the apps and their state' do
    stub_request(:get, internal).to_return(status: 200, headers: json, body: { apps: [{ provider: 'stripe', status: 'connected' }] }.to_json)
    as(admin, :get, base)

    expect(response.parsed_body['apps']).to eq([{ 'provider' => 'stripe', 'status' => 'connected' }])
  end

  it "hands back the app's sign-in page" do
    stub_request(:post, "#{internal}/linear/connect")
      .to_return(status: 200, headers: json, body: { authorize_url: 'https://mcp.linear.app/authorize?state=s' }.to_json)
    as(admin, :post, "#{base}/linear/connect")

    expect(response.parsed_body).to eq('authorize_url' => 'https://mcp.linear.app/authorize?state=s')
  end

  it "passes on the agent's reason when an app isn't set up" do
    stub_request(:post, "#{internal}/hubspot/connect")
      .to_return(status: 422, headers: json, body: { error: "HubSpot isn't set up on this installation yet." }.to_json)
    as(admin, :post, "#{base}/hubspot/connect")

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body['error']).to eq("HubSpot isn't set up on this installation yet.")
  end

  it 'disconnects an app, refuses unknown ones and is for administrators only' do
    removed = stub_request(:delete, "#{internal}/stripe").to_return(status: 200, headers: json, body: { status: 'disconnected' }.to_json)
    as(admin, :delete, "#{base}/stripe")
    expect(removed).to have_been_requested.once

    as(admin, :post, "#{base}/paypal/connect")
    expect(response).to have_http_status(:not_found)

    as(agent, :get, base)
    expect(response).to have_http_status(:unauthorized)
  end
end
