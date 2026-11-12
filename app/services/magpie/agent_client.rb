# Talks to the Magpie AI agent service (agent/ in this repo) over the servers' private network.
# MAGPIE_AGENT_URL is the agent's internal address and MAGPIE_AGENT_KEY its INTERNAL_API_KEY.
class Magpie::AgentClient
  class Error < StandardError; end
  # The agent refused the request with a reason the person can act on ("That website is already added.").
  class Rejected < Error; end

  TIMEOUT_SECONDS = 10
  UPLOAD_TIMEOUT_SECONDS = 60

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

  def summary(account_id)
    request(:get, "/internal/accounts/#{account_id}/summary")
  end

  def runs(account_id, before: nil)
    request(:get, "/internal/accounts/#{account_id}/runs#{"?before=#{before.to_i}" if before.present?}")['runs']
  end

  def run(account_id, run_id)
    request(:get, "/internal/accounts/#{account_id}/runs/#{run_id.to_i}")
  end

  def tests(account_id)
    request(:get, "/internal/accounts/#{account_id}/tests")['tests']
  end

  def start_test(account_id)
    request(:post, "/internal/accounts/#{account_id}/tests")
  end

  def test_cases(account_id, test_id)
    request(:get, "/internal/accounts/#{account_id}/tests/#{test_id.to_i}")['cases']
  end

  def apps(account_id)
    request(:get, "/internal/accounts/#{account_id}/apps")['apps']
  end

  # The app's own sign-in page, where an admin approves MagpieReply.
  def connect_app(account_id, provider)
    request(:post, "/internal/accounts/#{account_id}/apps/#{provider}/connect")['authorize_url']
  end

  def disconnect_app(account_id, provider)
    request(:delete, "/internal/accounts/#{account_id}/apps/#{provider}")
  end

  def sources(account_id)
    request(:get, "/internal/accounts/#{account_id}/sources")['sources']
  end

  def add_website(account_id, url)
    request(:post, "/internal/accounts/#{account_id}/sources", { url: url })['source']
  end

  def add_file(account_id, upload)
    response = HTTParty.post(
      address("/internal/accounts/#{account_id}/sources"),
      headers: { 'Authorization' => authorization },
      multipart: true,
      body: { file: upload },
      timeout: UPLOAD_TIMEOUT_SECONDS
    )
    parsed(response)['source']
  rescue HTTParty::Error, SocketError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout => e
    raise Error, "Magpie agent unreachable: #{e.class}"
  end

  def read_source(account_id, source_id)
    request(:post, "/internal/accounts/#{account_id}/sources/#{source_id}/read")
  end

  def remove_source(account_id, source_id)
    request(:delete, "/internal/accounts/#{account_id}/sources/#{source_id}")
  end

  private

  def address(path)
    "#{ENV.fetch('MAGPIE_AGENT_URL').chomp('/')}#{path}"
  end

  def authorization
    "Bearer #{ENV.fetch('MAGPIE_AGENT_KEY')}"
  end

  def parsed(response)
    raise Rejected, rejection_message(response) if response.code.in?([404, 422])
    raise Error, "Magpie agent answered #{response.code}" unless response.success?

    response.parsed_response
  end

  def rejection_message(response)
    body = response.parsed_response
    body.is_a?(Hash) && body['error'].present? && response.code == 422 ? body['error'] : I18n.t('magpie.ai_agent.source_missing')
  end

  def request(method, path, body = nil)
    response = HTTParty.public_send(
      method,
      address(path),
      headers: { 'Authorization' => authorization, 'Content-Type' => 'application/json' },
      body: body&.to_json,
      timeout: TIMEOUT_SECONDS
    )
    parsed(response)
  rescue HTTParty::Error, SocketError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout => e
    raise Error, "Magpie agent unreachable: #{e.class}"
  end
end
