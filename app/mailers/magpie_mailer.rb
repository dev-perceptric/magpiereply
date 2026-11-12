# Emails Magpie AI sends to a team's customers. For now, the verification code that lets Magpie look up a customer's
# own account when they chat without signing in.
class MagpieMailer < ApplicationMailer
  def verification_code(email, code)
    return unless smtp_config_set_or_development?

    account_name = params[:account].name
    mail(
      to: email,
      subject: I18n.t('magpie.verification_email.subject', account: account_name),
      content_type: 'text/plain',
      body: I18n.t('magpie.verification_email.body', account: account_name, code: code)
    )
  end
end
