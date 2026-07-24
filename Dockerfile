FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOLEHE_OUTPUT_DIR=/data

COPY . /app

RUN pip install --no-cache-dir beautifulsoup4 termcolor httpx trio fastapi uvicorn anyio requests
RUN pip install .

CMD ["python", "-m", "holehe", "--dashboard"]