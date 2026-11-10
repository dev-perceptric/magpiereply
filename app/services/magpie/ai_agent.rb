# Turns Magpie AI on or off for an account from Settings → AI agent.
#
# Turning it on the first time creates the account's "Magpie AI" agent bot, connects it to the agent service,
# points the bot's webhook at the address the service hands back and adds the "Magpie" dashboard app (the drafts
# side panel). Each save then attaches the bot to exactly the chosen inboxes and tells the service which ones it
# works in. Magpie only writes drafts: a person sends every reply.
class Magpie::AiAgent
  BOT_NAME = 'Magpie AI'.freeze
  PANEL_TITLE = 'Magpie'.freeze

  def initialize(account:, user:, client: Magpie::AgentClient.new)
    @account = account
    @user = user
    @client = client
  end

  def state
    remote = @client.state(@account.id)
    {
      available: true,
      enabled: remote['connected'] && remote['mode'] != 'off' && bot.present?,
      mode: remote['mode'],
      inbox_ids: remote['inbox_ids'] & @account.inboxes.pluck(:id)
    }
  end

  def update(enabled:, inbox_ids:)
    inbox_ids = @account.inboxes.where(id: inbox_ids).pluck(:id)
    connect unless bot.present? && @client.state(@account.id)['connected']

    chosen = enabled ? inbox_ids : []
    attach_bot(chosen)
    @client.update(@account.id, mode: enabled ? 'draft' : 'off', inbox_ids: chosen)
    state
  end

  private

  def bot
    @bot ||= @account.agent_bots.find_by(name: BOT_NAME)
  end

  def connect
    @bot = bot || @account.agent_bots.create!(
      name: BOT_NAME, description: I18n.t('magpie.ai_agent.bot_description'), bot_type: :webhook, outgoing_url: ''
    )
    addresses = @client.connect(@account.id, name: @account.name, bot: @bot)
    @bot.update!(outgoing_url: addresses['hook_url'])
    save_panel(addresses['panel_url'])
  end

  def save_panel(url)
    panel = @account.dashboard_apps.find_or_initialize_by(title: PANEL_TITLE)
    panel.update!(content: [{ type: 'frame', url: url }], user: panel.user || @user)
  end

  def attach_bot(inbox_ids)
    AgentBotInbox.where(account: @account, agent_bot: bot).where.not(inbox_id: inbox_ids).destroy_all
    @account.inboxes.where(id: inbox_ids).find_each do |inbox|
      agent_bot_inbox = inbox.agent_bot_inbox || AgentBotInbox.new(inbox: inbox)
      agent_bot_inbox.update!(agent_bot: bot, status: :active)
    end
  end
end
