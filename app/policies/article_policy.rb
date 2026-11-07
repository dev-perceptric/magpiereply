class ArticlePolicy < ApplicationPolicy
  def index?
    agent_bot? || @account.users.include?(@user)
  end

  def update?
    administrator?
  end

  def show?
    agent_bot? || administrator?
  end

  def edit?
    administrator?
  end

  def create?
    administrator?
  end

  def destroy?
    administrator?
  end

  def reorder?
    administrator?
  end

  private

  # The Magpie AI agent bot reads help articles to answer customers. It never changes them.
  def agent_bot?
    @user.is_a?(AgentBot)
  end

  # Agent bots have no account user, so they are never administrators.
  def administrator?
    @account_user.present? && @account_user.administrator?
  end
end

ArticlePolicy.prepend_mod_with('ArticlePolicy')
