require 'rails_helper'

RSpec.describe ArticlePolicy, type: :policy do
  subject(:article_policy) { described_class }

  let(:account) { create(:account) }
  let(:administrator) { create(:user, :administrator, account: account) }
  let(:agent) { create(:user, account: account) }
  let(:portal) { create(:portal, account: account) }
  let(:article) { create(:article, account: account, portal: portal, author: administrator) }

  let(:administrator_context) { { user: administrator, account: account, account_user: account.account_users.first } }
  let(:agent_context) { { user: agent, account: account, account_user: account.account_users.first } }
  let(:agent_bot) { create(:agent_bot, account: account) }
  let(:agent_bot_context) { { user: agent_bot, account: account, account_user: nil } }

  permissions :index? do
    context 'when administrator' do
      it { expect(article_policy).to permit(administrator_context, article) }
    end

    context 'when agent' do
      it { expect(article_policy).to permit(agent_context, article) }
    end
  end

  permissions :index?, :show? do
    context 'when agent bot' do
      it { expect(article_policy).to permit(agent_bot_context, article) }
    end
  end

  permissions :update?, :edit?, :create?, :destroy?, :reorder? do
    context 'when agent bot' do
      it { expect(article_policy).not_to permit(agent_bot_context, article) }
    end
  end

  permissions :update?, :show?, :edit?, :create?, :destroy?, :reorder? do
    context 'when administrator' do
      it { expect(article_policy).to permit(administrator_context, article) }
    end

    context 'when agent' do
      it { expect(article_policy).not_to permit(agent_context, article) }
    end
  end
end
