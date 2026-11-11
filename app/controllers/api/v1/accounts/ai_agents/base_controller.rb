# Shared by the Settings → AI agent screens that read from the agent service. Administrators only.
class Api::V1::Accounts::AiAgents::BaseController < Api::V1::Accounts::BaseController
  before_action :check_admin_authorization?
  before_action :ensure_configured

  # Rails tries the last handler first, so the narrower Rejected comes after Error.
  rescue_from Magpie::AgentClient::Error do
    render json: { error: I18n.t('magpie.ai_agent.unreachable') }, status: :bad_gateway
  end

  rescue_from Magpie::AgentClient::Rejected do |error|
    render json: { error: error.message }, status: :unprocessable_entity
  end

  private

  def ensure_configured
    render json: { available: false }, status: :unprocessable_entity unless Magpie::AgentClient.configured?
  end

  def client
    @client ||= Magpie::AgentClient.new
  end
end
