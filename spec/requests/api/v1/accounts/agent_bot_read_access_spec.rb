require 'rails_helper'

# The Magpie AI agent bot reads a conversation's messages, the contact and the team's help
# articles with its own API key. It stays limited to the accounts it serves and can't change any of them.
RSpec.describe 'Agent bot read access', type: :request do
  let(:account) { create(:account) }
  let(:inbox) { create(:inbox, account: account) }
  let(:contact) { create(:contact, account: account) }
  let(:contact_inbox) { create(:contact_inbox, contact: contact, inbox: inbox) }
  let(:conversation) { create(:conversation, account: account, inbox: inbox, contact: contact, contact_inbox: contact_inbox) }
  let(:agent_bot) { create(:agent_bot, account: account) }
  let(:headers) { { api_access_token: agent_bot.access_token.token } }
  let(:admin) { create(:user, :administrator, account: account) }
  let(:portal) { create(:portal, account: account) }
  let!(:article) { create(:article, account: account, portal: portal, author: admin, title: 'Refund policy') }

  before do
    create(:agent_bot_inbox, inbox: inbox, agent_bot: agent_bot)
    create(:message, account: account, inbox: inbox, conversation: conversation, content: 'I was charged twice')
  end

  it 'lists the messages of a conversation in its inbox' do
    get "/api/v1/accounts/#{account.id}/conversations/#{conversation.display_id}/messages", headers: headers, as: :json

    expect(response).to have_http_status(:success)
    expect(response.parsed_body['payload'].pluck('content')).to include('I was charged twice')
  end

  it 'shows a contact in its account' do
    get "/api/v1/accounts/#{account.id}/contacts/#{contact.id}", headers: headers, as: :json

    expect(response).to have_http_status(:success)
    expect(response.parsed_body['payload']['id']).to eq(contact.id)
  end

  it 'lists and shows help articles' do
    get "/api/v1/accounts/#{account.id}/portals/#{portal.slug}/articles", headers: headers, as: :json

    expect(response).to have_http_status(:success)
    expect(response.parsed_body['payload'].pluck('title')).to include('Refund policy')

    get "/api/v1/accounts/#{account.id}/portals/#{portal.slug}/articles/#{article.id}", headers: headers, as: :json

    expect(response).to have_http_status(:success)
    expect(response.parsed_body['payload']['title']).to eq('Refund policy')
  end

  it 'cannot read another account' do
    other_account = create(:account)
    other_contact = create(:contact, account: other_account)

    get "/api/v1/accounts/#{other_account.id}/contacts/#{other_contact.id}", headers: headers, as: :json

    expect(response).to have_http_status(:unauthorized)
  end

  it 'cannot change contacts or articles' do
    delete "/api/v1/accounts/#{account.id}/contacts/#{contact.id}", headers: headers, as: :json
    expect(response).to have_http_status(:unauthorized)

    patch "/api/v1/accounts/#{account.id}/portals/#{portal.slug}/articles/#{article.id}",
          params: { title: 'Changed' }, headers: headers, as: :json
    expect(response).to have_http_status(:unauthorized)
    expect(article.reload.title).to eq('Refund policy')
  end

  it 'cannot list contacts' do
    get "/api/v1/accounts/#{account.id}/contacts", headers: headers, as: :json

    expect(response).to have_http_status(:unauthorized)
  end
end
