# Talks to the Magpie AI agent service (agent/ in this repo) over the servers' private network.
# MAGPIE_AGENT_URL is the agent's internal address and MAGPIE_AGENT_KEY its INTERNAL_API_KEY.
class Magpie::AgentClient
  class Error < StandardError; end

  TIMEOUT_SECONDS = 10

  def self.configured?
    ENV.fetch('MAGPIE_AGENT_URL', '').present? && ENV.fetch('MAGPIE_AGENT_KEY', '').present?
  end

  def state(account_id)
    request(:get, "/internal/accounts/#{account_id}")
  end

  def connect(account_id, name:, bot:)
    request(:post, "/internal/accounts/#{account_id}/connect",
            { name: name, bot_id: bot.id, bot_token: bot.access_token.token, bot_secret: bot.secret })
  end

  def update(account_id, mode:, inbox_ids:)
    request(:put, "/internal/accounts/#{account_id}", { mode: mode, inbox_ids: inbox_ids })
  end

  private

  def request(method, path, body = nil)
    response = HTTParty.public_send(
      method,
      "#{ENV.fetch('MAGPIE_AGENT_URL').chomp('/')}#{path}",
      headers: { 'Authorization' => "Bearer #{ENV.fetch('MAGPIE_AGENT_KEY')}", 'Content-Type' => 'application/json' },
      body: body&.to_json,
      timeout: TIMEOUT_SECONDS
    )
    raise Error, "Magpie agent answered #{response.code}" unless response.success?

    response.parsed_response
  rescue HTTParty::Error, SocketError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout => e
    raise Error, "Magpie agent unreachable: #{e.class}"
  end
end
