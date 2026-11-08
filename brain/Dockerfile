# Magpie AI brain (Parlant). Build context: the brain/ folder.
FROM python:3.12.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data PARLANT_HOME=/data/parlant
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY magpie_brain ./magpie_brain
COPY trial ./trial
RUN useradd --create-home --uid 10001 brain && mkdir -p /data && chown brain /data
USER brain
EXPOSE 8800
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD python -c "import json,urllib.request,sys; s=json.load(urllib.request.urlopen('http://127.0.0.1:8800/healthz', timeout=4))['status']; sys.exit(s == 'unhealthy')"
CMD ["python", "-m", "magpie_brain.main"]
