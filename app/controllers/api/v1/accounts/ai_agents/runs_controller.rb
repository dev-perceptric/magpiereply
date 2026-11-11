# Traces: each turn Magpie took, and the steps inside one.
class Api::V1::Accounts::AiAgents::RunsController < Api::V1::Accounts::AiAgents::BaseController
  def index
    render json: { runs: client.runs(Current.account.id, before: params[:before]) }
  end

  def show
    render json: client.run(Current.account.id, params[:id])
  end
end
