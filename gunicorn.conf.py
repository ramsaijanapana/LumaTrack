import multiprocessing
import os


bind = f"0.0.0.0:{os.getenv('PORT', '8080')}"
workers = int(os.getenv("WEB_CONCURRENCY", max(2, min(4, multiprocessing.cpu_count() * 2))))
threads = int(os.getenv("GUNICORN_THREADS", "4"))
timeout = int(os.getenv("GUNICORN_TIMEOUT", "60"))
graceful_timeout = 30
keepalive = 5
accesslog = "-"
errorlog = "-"
worker_tmp_dir = "/dev/shm"
