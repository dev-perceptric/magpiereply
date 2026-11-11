# Usage this month, how Magpie did in the last 30 days, and whether Auto mode is open to the account.
class Api::V1::Accounts::AiAgents::SummariesController < Api::V1::Accounts::AiAgents::BaseController
  def show
    render json: client.summary(Current.account.id)
  end
end
