require 'rails_helper'

RSpec.describe 'Magpie AI verification code emails', type: :request do
  let(:account) { create(:account, name: 'Tidewell') }
  let(:bot) { create(:agent_bot, account: account, name: 'Magpie AI') }
  let(:other_bot) { create(:agent_bot, account: account, name: 'Another bot') }
  let(:admin) { create(:user, :administrator, account: account) }
  let(:path) { "/api/v1/accounts/#{account.id}/ai_agent/verification_emails" }
  let(:body) { { email: 'maya@example.com', code: '483920' } }

  def post_as(token)
    post path, params: body, headers: { api_access_token: token }, as: :json
  end

  it 'emails the code when the account’s Magpie bot asks' do
    with_modified_env(SMTP_ADDRESS: 'smtp.example.com') do
      expect { post_as(bot.access_token.token) }.to have_enqueued_mail(MagpieMailer, :verification_code)
    end

    expect(response).to have_http_status(:accepted)
  end

  it 'refuses other bots and people' do
    with_modified_env(SMTP_ADDRESS: 'smtp.example.com') do
      post_as(other_bot.access_token.token)
      expect(response).to have_http_status(:unauthorized)
      post path, params: body, headers: admin.create_new_auth_token, as: :json
    end

    expect(response).to have_http_status(:unauthorized)
  end

  it 'refuses when the app has no email set up, so no customer waits for a code that never comes' do
    with_modified_env(SMTP_ADDRESS: nil) do
      expect { post_as(bot.access_token.token) }.not_to have_enqueued_mail(MagpieMailer, :verification_code)
    end

    expect(response).to have_http_status(:unprocessable_entity)
  end

  it 'only takes a real address and a 6-digit code' do
    with_modified_env(SMTP_ADDRESS: 'smtp.example.com') do
      post path, params: { email: 'nope', code: '12' }, headers: { api_access_token: bot.access_token.token }, as: :json
    end

    expect(response).to have_http_status(:unprocessable_entity)
  end

  it 'writes the code in a plain email from the account' do
    with_modified_env(SMTP_ADDRESS: 'smtp.example.com') do
      mail = MagpieMailer.with(account: account).verification_code('maya@example.com', '483920')
      expect(mail.subject).to eq('Your Tidewell verification code')
      expect(mail.body.encoded).to include('483920')
      expect(mail.to).to eq(['maya@example.com'])
    end
  end
end
