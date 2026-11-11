# Replay tests: Magpie answers past conversations again and is graded against what the team sent.
class Api::V1::Accounts::AiAgents::TestsController < Api::V1::Accounts::AiAgents::BaseController
  def index
    render json: { tests: client.tests(Current.account.id) }
  end

  def show
    render json: { cases: client.test_cases(Current.account.id, params[:id]) }
  end

  def create
    render json: client.start_test(Current.account.id), status: :created
  end
end
