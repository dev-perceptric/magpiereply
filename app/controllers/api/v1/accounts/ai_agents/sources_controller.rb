# Settings → AI agent → Knowledge: the websites and files Magpie AI reads, next to the help center. Administrators only.
class Api::V1::Accounts::AiAgents::SourcesController < Api::V1::Accounts::AiAgents::BaseController
  def index
    render json: { sources: client.sources(Current.account.id) }
  end

  def create
    source = if params[:file].present?
               client.add_file(Current.account.id, params.require(:file))
             else
               client.add_website(Current.account.id, params.require(:url))
             end
    render json: { source: source }, status: :created
  end

  def read
    client.read_source(Current.account.id, params[:id])
    head :ok
  end

  def destroy
    client.remove_source(Current.account.id, params[:id])
    head :ok
  end
end
