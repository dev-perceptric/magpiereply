# The Magpie AI agent bot asks the app to email a customer a verification code. Only the account's own Magpie bot may.
class Api::V1::Accounts::AiAgents::VerificationEmailsController < Api::V1::Accounts::BaseController
  EMAIL = /\A[^@\s]+@[^@\s]+\.[^@\s]+\z/
  CODE = /\A\d{6}\z/

  before_action :ensure_magpie_bot

  def create
    email = params.require(:email).to_s.strip
    code = params.require(:code).to_s
    return head :unprocessable_entity unless email.match?(EMAIL) && code.match?(CODE)
    return render json: { error: I18n.t('magpie.verification_email.not_set_up') }, status: :unprocessable_entity unless email_set_up?

    MagpieMailer.with(account: Current.account).verification_code(email, code).deliver_later
    head :accepted
  end

  private

  def ensure_magpie_bot
    bot = Current.user
    magpie = bot.is_a?(AgentBot) && bot.account_id == Current.account.id && bot.name == Magpie::AiAgent::BOT_NAME
    render json: { error: 'Only the Magpie AI bot can send verification codes' }, status: :unauthorized unless magpie
  end

  def email_set_up?
    ENV.fetch('SMTP_ADDRESS', nil).present? || Rails.env.development?
  end
end
