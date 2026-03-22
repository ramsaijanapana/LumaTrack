FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    LUMATRACK_HOST=0.0.0.0

WORKDIR /app

RUN groupadd --system app && useradd --system --gid app --create-home --home-dir /home/app app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir -r requirements.txt

COPY . .

RUN chown -R app:app /app /home/app

USER app

CMD ["gunicorn", "--config", "gunicorn.conf.py", "server:app"]
