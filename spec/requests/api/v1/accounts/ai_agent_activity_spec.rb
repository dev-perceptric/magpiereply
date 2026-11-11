require 'rails_helper'

RSpec.describe 'Settings: AI agent usage, traces and replay tests', type: :request do
  let(:account) { create(:account) }
  let(:admin) { create(:user, :administrator, account: account) }
  let(:agent_url) { 'http://agent-api:8080' }
  let(:env) { { MAGPIE_AGENT_URL: agent_url, MAGPIE_AGENT_KEY: 'k' * 40 } }
  let(:base) { "/api/v1/accounts/#{account.id}/ai_agent" }
  let(:internal) { "#{agent_url}/internal/accounts/#{account.id}" }
  let(:json) { { 'Content-Type' => 'application/json' } }

  def call(method, path)
    with_modified_env(**env) do
      public_send(method, "#{base}#{path}", headers: admin.create_new_auth_token, as: :json)
    end
  end

  it 'shows usage and whether Auto is open' do
    stub_request(:get, "#{internal}/summary")
      .to_return(status: 200, headers: json, body: { month: { cost_usd: 1.5, cap_usd: 50 }, auto: { allowed: false } }.to_json)
    call(:get, '/summary')

    expect(response.parsed_body).to include('month' => { 'cost_usd' => 1.5, 'cap_usd' => 50 })
  end

  it 'lists traces page by page and opens one' do
    listed = stub_request(:get, "#{internal}/runs?before=40").to_return(status: 200, headers: json, body: { runs: [{ id: 39 }] }.to_json)
    opened = stub_request(:get, "#{internal}/runs/39").to_return(status: 200, headers: json, body: { run: { id: 39 }, steps: [] }.to_json)
    with_modified_env(**env) do
      get "#{base}/runs", params: { before: 40 }, headers: admin.create_new_auth_token
    end
    call(:get, '/runs/39')

    expect(listed).to have_been_requested.once
    expect(opened).to have_been_requested.once
    expect(response.parsed_body).to eq('run' => { 'id' => 39 }, 'steps' => [])
  end

  it "starts a replay test and passes on the agent's reason when one is running" do
    stub_request(:post, "#{internal}/tests")
      .to_return({ status: 201, headers: json, body: { id: 7, status: 'running' }.to_json },
                 { status: 422, headers: json, body: { error: 'A replay test is already running.' }.to_json })
    call(:post, '/tests')
    expect(response).to have_http_status(:created)

    call(:post, '/tests')
    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body['error']).to eq('A replay test is already running.')
  end

  it 'shows the cases of one replay test' do
    stub_request(:get, "#{internal}/tests/7").to_return(status: 200, headers: json, body: { cases: [{ verdict: 'same' }] }.to_json)
    call(:get, '/tests/7')

    expect(response.parsed_body).to eq('cases' => [{ 'verdict' => 'same' }])
  end
end
