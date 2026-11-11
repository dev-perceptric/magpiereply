# Settings → AI agent: turn Magpie AI on or off and choose its inboxes. Administrators only.
class Api::V1::Accounts::AiAgentsController < Api::V1::Accounts::BaseController
  before_action :check_admin_authorization?

  def show
    return render json: { available: false } unless Magpie::AgentClient.configured?

    render json: ai_agent.state
  rescue Magpie::AgentClient::Error
    render json: { error: I18n.t('magpie.ai_agent.unreachable') }, status: :bad_gateway
  end

  def update
    return render json: { available: false }, status: :unprocessable_entity unless Magpie::AgentClient.configured?

    render json: ai_agent.update(enabled: ActiveModel::Type::Boolean.new.cast(ai_agent_params[:enabled]),
                                 inbox_ids: Array(ai_agent_params[:inbox_ids]).map(&:to_i),
                                 mode: ai_agent_params[:mode] == 'auto' ? 'auto' : 'draft')
  rescue Magpie::AgentClient::Rejected => e
    render json: { error: e.message }, status: :unprocessable_entity
  rescue Magpie::AgentClient::Error
    render json: { error: I18n.t('magpie.ai_agent.unreachable') }, status: :bad_gateway
  end

  private

  def ai_agent
    @ai_agent ||= Magpie::AiAgent.new(account: Current.account, user: Current.user)
  end

  def ai_agent_params
    params.require(:ai_agent).permit(:enabled, :mode, inbox_ids: [])
  end
end
