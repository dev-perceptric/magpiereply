# magpie-brain: Parlant for the trial. Build from the repo root, so the help articles come along:
#   fly deploy --config brain/fly.toml --dockerfile brain/Dockerfile .
FROM python:3.12-slim
WORKDIR /app
COPY brain/requirements.txt brain/requirements.txt
RUN pip install --no-cache-dir -r brain/requirements.txt
COPY brain/*.py brain/
COPY agent/evals/trial/articles agent/evals/trial/articles
WORKDIR /app/brain
ENV PYTHONUNBUFFERED=1 PARLANT_HOME=/data
EXPOSE 8800
CMD ["python", "main.py"]
