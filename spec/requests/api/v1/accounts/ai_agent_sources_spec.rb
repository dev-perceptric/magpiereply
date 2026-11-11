require 'rails_helper'

RSpec.describe 'Settings: AI agent knowledge sources', type: :request do
  let(:account) { create(:account) }
  let(:admin) { create(:user, :administrator, account: account) }
  let(:agent) { create(:user, account: account, role: :agent) }
  let(:agent_url) { 'http://agent-api:8080' }
  let(:env) { { MAGPIE_AGENT_URL: agent_url, MAGPIE_AGENT_KEY: 'k' * 40 } }
  let(:path) { "/api/v1/accounts/#{account.id}/ai_agent/sources" }
  let(:sources_url) { "#{agent_url}/internal/accounts/#{account.id}/sources" }
  let(:json) { { 'Content-Type' => 'application/json' } }
  let(:website) { { id: 3, kind: 'website', name: 'https://shop.example.com/', status: 'reading', error: nil, pages: 0, read_at: nil } }

  it 'lists the websites and files' do
    stub_request(:get, sources_url).to_return(status: 200, body: { sources: [website] }.to_json, headers: json)
    with_modified_env(**env) do
      get path, headers: admin.create_new_auth_token, as: :json
    end

    expect(response.parsed_body['sources'].first).to include('id' => 3, 'kind' => 'website', 'status' => 'reading')
  end

  it 'is for administrators only' do
    with_modified_env(**env) do
      get path, headers: agent.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:unauthorized)
  end

  it 'adds a website' do
    added = stub_request(:post, sources_url).with(body: { url: 'https://shop.example.com' }.to_json)
                                            .to_return(status: 201, body: { source: website }.to_json, headers: json)
    with_modified_env(**env) do
      post path, params: { url: 'https://shop.example.com' }, headers: admin.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:created)
    expect(added).to have_been_requested.once
  end

  it "passes on the agent's reason when it refuses" do
    stub_request(:post, sources_url).to_return(status: 422, body: { error: 'That website is already added.' }.to_json, headers: json)
    with_modified_env(**env) do
      post path, params: { url: 'https://shop.example.com' }, headers: admin.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body['error']).to eq('That website is already added.')
  end

  it 'uploads a file with its own name' do
    uploaded = stub_request(:post, sources_url)
               .with { |request| request.body.include?('filename="Returns policy.txt"') && request.body.include?('Returns within 30 days.') }
               .to_return(status: 201, body: { source: { id: 4, kind: 'file', name: 'Returns policy.txt' } }.to_json, headers: json)
    file = Rack::Test::UploadedFile.new(StringIO.new('Returns within 30 days.'), 'text/plain', original_filename: 'Returns policy.txt')
    with_modified_env(**env) do
      post path, params: { file: file }, headers: admin.create_new_auth_token
    end

    expect(response).to have_http_status(:created)
    expect(uploaded).to have_been_requested.once
  end

  it 'reads a source again and removes one' do
    read = stub_request(:post, "#{sources_url}/3/read").to_return(status: 200, body: { status: 'reading' }.to_json, headers: json)
    removed = stub_request(:delete, "#{sources_url}/3").to_return(status: 200, body: { status: 'removed' }.to_json, headers: json)
    with_modified_env(**env) do
      post "#{path}/3/read", headers: admin.create_new_auth_token, as: :json
      delete "#{path}/3", headers: admin.create_new_auth_token, as: :json
    end

    expect(read).to have_been_requested.once
    expect(removed).to have_been_requested.once
  end

  it 'answers with a short error when the agent service is down' do
    stub_request(:get, sources_url).to_timeout
    with_modified_env(**env) do
      get path, headers: admin.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:bad_gateway)
  end
end
