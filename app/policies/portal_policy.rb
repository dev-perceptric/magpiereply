class PortalPolicy < ApplicationPolicy
  def index?
    agent_bot? || @account.users.include?(@user)
  end

  def update?
    @account_user.administrator?
  end

  def show?
    @account.users.include?(@user)
  end

  def edit?
    @account_user.administrator?
  end

  def create?
    @account_user.administrator?
  end

  def destroy?
    @account_user.administrator?
  end

  def logo?
    @account_user.administrator?
  end

  def send_instructions?
    @account_user.administrator?
  end

  def ssl_status?
    @account.users.include?(@user)
  end

  private

  # The Magpie AI agent bot lists the account's help centers to sync their articles (read-only).
  def agent_bot?
    @user.is_a?(AgentBot)
  end
end

PortalPolicy.prepend_mod_with('PortalPolicy')
