# Settings → AI agent → Apps: connect the team's Stripe, Linear, HubSpot or Shopify so Magpie can look things up.
class Api::V1::Accounts::AiAgents::AppsController < Api::V1::Accounts::AiAgents::BaseController
  PROVIDERS = %w[stripe linear hubspot shopify].freeze

  before_action :ensure_provider, only: [:connect, :destroy]

  def index
    render json: { apps: client.apps(Current.account.id) }
  end

  def connect
    render json: { authorize_url: client.connect_app(Current.account.id, params[:provider]) }
  end

  def destroy
    client.disconnect_app(Current.account.id, params[:provider])
    head :ok
  end

  private

  def ensure_provider
    head :not_found unless PROVIDERS.include?(params[:provider])
  end
end
