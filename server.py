import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import quote, urlparse

import requests
from authlib.integrations.flask_client import OAuth
from authlib.jose import jwt
from flask import Flask, abort, g, has_request_context, jsonify, redirect, request, send_from_directory, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix


ROOT_DIR = Path(__file__).resolve().parent
ENV_PATH = ROOT_DIR / ".env"
DB_PATH = ROOT_DIR / "lumatrack.db"
SECRET_PATH = ROOT_DIR / ".lumatrack.secret"
SCHEMA_VERSION = 2
HTTP_HEADERS = {"User-Agent": "Watchnest/0.1 (watch tracker)"}
APPLE_AUDIENCE = "https://appleid.apple.com"
APPLE_CLIENT_SECRET_CACHE = {}
OMDB_CACHE = {}
SEARCH_CACHE = {}
EPISODE_CACHE = {}
PUBLIC_BASE_URL_ENV = "LUMATRACK_PUBLIC_BASE_URL"
DATABASE_URL_ENV = "DATABASE_URL"
POSTGRES_SCHEMES = ("postgres://", "postgresql://")
RATE_LIMIT_STATE = {}
ALLOWED_REMOTE_IMAGE_HOSTS = {
    "static.tvmaze.com",
    "www.tvmaze.com",
    "upload.wikimedia.org",
    "commons.wikimedia.org",
    "covers.openlibrary.org",
    "m.media-amazon.com",
    "ia.media-imdb.com",
}
SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(provider, provider_subject),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_states (
    user_id INTEGER PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_preview TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""
POSTGRES_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_identities (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS user_states (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_preview TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);
"""

PROVIDER_CONFIG = {
    "google": {
        "label": "Google",
        "client_id_env": "GOOGLE_CLIENT_ID",
        "client_secret_env": "GOOGLE_CLIENT_SECRET",
        "server_metadata_url": "https://accounts.google.com/.well-known/openid-configuration",
        "client_kwargs": {"scope": "openid email profile"},
    },
    "facebook": {
        "label": "Facebook",
        "client_id_env": "FACEBOOK_CLIENT_ID",
        "client_secret_env": "FACEBOOK_CLIENT_SECRET",
        "access_token_url": "https://graph.facebook.com/oauth/access_token",
        "authorize_url": "https://www.facebook.com/dialog/oauth",
        "api_base_url": "https://graph.facebook.com/",
        "client_kwargs": {"scope": "email public_profile"},
    },
    "apple": {
        "label": "Apple",
        "client_id_env": "APPLE_CLIENT_ID",
        "client_secret_env": "APPLE_CLIENT_SECRET",
        "server_metadata_url": "https://appleid.apple.com/.well-known/openid-configuration",
        "client_kwargs": {"scope": "name email"},
    },
}

CONNECTOR_DEFINITIONS = [
    {
        "id": "netflix",
        "name": "Netflix",
        "shortName": "Netflix",
        "accent": "#e50914",
        "defaultMode": "Browser auto-capture",
        "summary": "Background browser capture for Netflix playback pages, with manual fallback when needed.",
        "capabilities": ["Auto capture", "Manual fallback", "Activity merge"],
    },
    {
        "id": "prime-video",
        "name": "Prime Video",
        "shortName": "Prime",
        "accent": "#00a8e1",
        "defaultMode": "Browser auto-capture",
        "summary": "Background browser capture for Prime Video playback, plus manual fallback.",
        "capabilities": ["Auto capture", "Manual fallback", "Queue sync"],
    },
    {
        "id": "disney-plus",
        "name": "Disney+",
        "shortName": "Disney+",
        "accent": "#113ccf",
        "defaultMode": "Browser auto-capture",
        "summary": "Background browser capture for Disney+ playback, with manual fallback kept available.",
        "capabilities": ["Auto capture", "Manual fallback", "Watchlist merge"],
    },
    {
        "id": "max",
        "name": "Max",
        "shortName": "Max",
        "accent": "#0057ff",
        "defaultMode": "Browser auto-capture",
        "summary": "Background browser capture for Max playback and continue-watching updates.",
        "capabilities": ["Auto capture", "Continue watching", "Manual fallback"],
    },
    {
        "id": "apple-tv",
        "name": "Apple TV+",
        "shortName": "Apple TV+",
        "accent": "#333333",
        "defaultMode": "Browser auto-capture",
        "summary": "Background browser capture for Apple TV+ playback, with manual fallback retained.",
        "capabilities": ["Auto capture", "Manual fallback", "Drive sync"],
    },
    {
        "id": "plex",
        "name": "Plex / Jellyfin",
        "shortName": "Plex",
        "accent": "#d99000",
        "defaultMode": "Webhook or auto-capture",
        "summary": "Plex and Tautulli can post playback directly, with browser/manual fallback available.",
        "capabilities": ["Plex webhook", "Tautulli", "Manual fallback"],
    },
    {
        "id": "books",
        "name": "Books",
        "shortName": "Books",
        "accent": "#7c5a2b",
        "defaultMode": "Manual tracking",
        "summary": "Book progress and reading updates, with metadata search and manual tracking.",
        "capabilities": ["Manual progress", "Search add", "Library sync"],
    },
]

ALLOWED_STATIC_FILES = {
    "index.html",
    "styles.css",
    "app.js",
    "api.js",
    "connectors.js",
    "seed.js",
    "store.js",
    "manifest.webmanifest",
    "sw.js",
    "icon.svg",
    "icon-maskable.svg",
}


def parse_env_value(raw_value):
    value = raw_value.strip()
    if not value:
        return ""

    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]

    return value.replace("\\n", "\n")


def load_env_file(path=ENV_PATH):
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue

        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue

        os.environ[key] = parse_env_value(raw_value)


def env_value(name):
    return (os.environ.get(name) or "").strip()


def resolve_local_path(path_value):
    path = Path(path_value)
    return path if path.is_absolute() else ROOT_DIR / path


def parse_positive_int(value, default):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def env_flag(name, default=False):
    value = env_value(name)
    if not value:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def first_env_value(*names):
    for name in names:
        value = env_value(name)
        if value:
            return value
    return ""


def is_postgres_database():
    value = env_value(DATABASE_URL_ENV).lower()
    return value.startswith(POSTGRES_SCHEMES)


def read_apple_private_key():
    inline_key = env_value("APPLE_PRIVATE_KEY")
    if inline_key:
        return inline_key

    key_path = env_value("APPLE_PRIVATE_KEY_PATH")
    if not key_path:
        return ""

    resolved = resolve_local_path(key_path)
    if not resolved.exists():
        raise FileNotFoundError(f"Apple private key file not found: {resolved}")

    return resolved.read_text(encoding="utf-8").strip()


def build_apple_client_secret(client_id):
    explicit_secret = env_value("APPLE_CLIENT_SECRET")
    if explicit_secret:
        return explicit_secret

    team_id = env_value("APPLE_TEAM_ID")
    key_id = env_value("APPLE_KEY_ID")
    private_key = read_apple_private_key()
    if not client_id or not team_id or not key_id or not private_key:
        return ""

    ttl_days = min(parse_positive_int(env_value("APPLE_CLIENT_SECRET_TTL_DAYS"), 180), 180)
    issued_at = datetime.now(timezone.utc)
    expires_at = issued_at + timedelta(days=ttl_days)
    cache_key = (
        client_id,
        team_id,
        key_id,
        hashlib.sha256(private_key.encode("utf-8")).hexdigest(),
        ttl_days,
    )
    cached = APPLE_CLIENT_SECRET_CACHE.get(cache_key)
    if cached and cached["expires_at"] > issued_at.timestamp() + 300:
        return cached["token"]

    header = {"alg": "ES256", "kid": key_id}
    payload = {
        "iss": team_id,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
        "aud": APPLE_AUDIENCE,
        "sub": client_id,
    }
    token = jwt.encode(header, payload, private_key)
    if isinstance(token, bytes):
        token = token.decode("utf-8")

    APPLE_CLIENT_SECRET_CACHE.clear()
    APPLE_CLIENT_SECRET_CACHE[cache_key] = {
        "token": token,
        "expires_at": expires_at.timestamp(),
    }
    return token


def resolve_provider_credentials(provider, definition):
    client_id = env_value(definition["client_id_env"])
    client_secret = env_value(definition["client_secret_env"])
    error = None

    if provider == "apple" and client_id and not client_secret:
        try:
            client_secret = build_apple_client_secret(client_id)
        except Exception as exc:
            error = str(exc)
            client_secret = ""

    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "configured": bool(client_id and client_secret),
        "error": error,
    }


load_env_file()


def current_base_url():
    configured = first_env_value(PUBLIC_BASE_URL_ENV, "RENDER_EXTERNAL_URL").rstrip("/")
    if configured:
        return configured
    if not has_request_context():
        host = env_value("LUMATRACK_HOST") or "127.0.0.1"
        port = env_value("LUMATRACK_PORT") or "5000"
        scheme = "https" if env_flag("LUMATRACK_SESSION_COOKIE_SECURE") else "http"
        return f"{scheme}://{host}:{port}"
    return request.host_url.rstrip("/")


def public_url(path):
    normalized = path if path.startswith("/") else f"/{path}"
    return f"{current_base_url()}{normalized}"


def is_https_base_url():
    return current_base_url().lower().startswith("https://")


def allowed_hosts():
    configured = env_value("LUMATRACK_ALLOWED_HOSTS")
    if configured:
        return {item.strip().lower() for item in configured.split(",") if item.strip()}

    render_host = env_value("RENDER_EXTERNAL_HOSTNAME")
    if render_host:
        return {render_host.lower()}

    base_url = first_env_value(PUBLIC_BASE_URL_ENV, "RENDER_EXTERNAL_URL")
    if not base_url:
        return set()

    parsed = urlparse(base_url)
    return {parsed.netloc.lower()} if parsed.netloc else set()


def security_csp():
    return "; ".join(
        [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' https: data:",
            "font-src 'self' data:",
            "connect-src 'self'",
            "manifest-src 'self'",
            "worker-src 'self'",
            "form-action 'self'",
        ]
    )


def client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def enforce_rate_limit(bucket, limit, window_seconds):
    now = time.time()
    key = (bucket, client_ip())
    timestamps = RATE_LIMIT_STATE.setdefault(key, [])
    cutoff = now - window_seconds
    while timestamps and timestamps[0] < cutoff:
        timestamps.pop(0)
    if len(timestamps) >= limit:
        retry_after = max(1, int(window_seconds - (now - timestamps[0])))
        response = jsonify({"error": "Too many requests. Please try again shortly."})
        response.status_code = 429
        response.headers["Retry-After"] = str(retry_after)
        return response
    timestamps.append(now)
    return None


def ensure_csrf_token():
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def validate_csrf():
    expected = session.get("csrf_token")
    provided = request.headers.get("X-CSRF-Token", "")
    return bool(expected and provided and secrets.compare_digest(expected, provided))


class DatabaseCursor:
    def __init__(self, cursor):
        self.cursor = cursor

    def fetchone(self):
        return self.cursor.fetchone()

    def fetchall(self):
        return self.cursor.fetchall()

    @property
    def lastrowid(self):
        return getattr(self.cursor, "lastrowid", None)


class DatabaseConnection:
    def __init__(self, connection, backend):
        self.connection = connection
        self.backend = backend

    def execute(self, query, params=()):
        statement = query.replace("?", "%s") if self.backend == "postgres" else query
        if self.backend == "postgres":
            cursor = self.connection.cursor()
            cursor.execute(statement, params)
            return DatabaseCursor(cursor)
        return DatabaseCursor(self.connection.execute(statement, params))

    def executescript(self, script):
        if self.backend == "postgres":
            cursor = self.connection.cursor()
            for statement in [item.strip() for item in script.split(";") if item.strip()]:
                cursor.execute(statement)
            cursor.close()
            return
        self.connection.executescript(script)

    def commit(self):
        self.connection.commit()

    def close(self):
        self.connection.close()


def open_database_connection():
    if is_postgres_database():
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as error:
            raise RuntimeError("DATABASE_URL is set to PostgreSQL, but psycopg is not installed.") from error

        connection = psycopg.connect(env_value(DATABASE_URL_ENV), row_factory=dict_row)
        return DatabaseConnection(connection, "postgres")

    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return DatabaseConnection(connection, "sqlite")


def execute_insert_returning_id(query, params=()):
    db = get_db()
    if db.backend == "postgres":
        statement = query.strip().rstrip(";") + " RETURNING id"
        row = db.execute(statement, params).fetchone()
        db.commit()
        return row["id"]

    cursor = db.execute(query, params)
    db.commit()
    return cursor.lastrowid


def provider_requirements(provider, definition):
    if provider == "apple":
        return {
            "requiredEnv": [definition["client_id_env"]],
            "alternatives": [
                [definition["client_secret_env"]],
                ["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY_PATH"],
                ["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"],
            ],
        }
    return {
        "requiredEnv": [definition["client_id_env"], definition["client_secret_env"]],
        "alternatives": [],
    }


def provider_missing_env(provider, definition):
    requirements = provider_requirements(provider, definition)
    required_missing = [name for name in requirements["requiredEnv"] if not env_value(name)]
    if provider != "apple":
        return required_missing

    if not env_value(definition["client_id_env"]):
        return required_missing
    if env_value(definition["client_secret_env"]):
        return []

    alternative_groups = requirements["alternatives"][1:]
    if any(all(env_value(name) for name in group) for group in alternative_groups):
        return []

    return ["APPLE_CLIENT_SECRET or APPLE_TEAM_ID + APPLE_KEY_ID + APPLE_PRIVATE_KEY_PATH"]


def load_or_create_secret():
    env_secret = env_value("LUMATRACK_SECRET_KEY")
    if env_secret:
        return env_secret

    if SECRET_PATH.exists():
        return SECRET_PATH.read_text(encoding="utf-8").strip()

    secret = secrets.token_urlsafe(48)
    SECRET_PATH.write_text(secret, encoding="utf-8")
    return secret


app = Flask(__name__, static_folder=None)
app.config["SECRET_KEY"] = load_or_create_secret()
app.config["SESSION_COOKIE_NAME"] = "lumatrack_session"
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = env_flag("LUMATRACK_SESSION_COOKIE_SECURE", is_https_base_url())
app.config["PREFERRED_URL_SCHEME"] = "https" if is_https_base_url() else "http"
app.config["MAX_CONTENT_LENGTH"] = parse_positive_int(env_value("LUMATRACK_MAX_CONTENT_LENGTH"), 1024 * 1024)
if env_flag("LUMATRACK_TRUST_PROXY"):
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
oauth = OAuth(app)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def init_db():
    connection = open_database_connection()
    try:
        connection.executescript(POSTGRES_SCHEMA if connection.backend == "postgres" else SQLITE_SCHEMA)
        connection.commit()
    finally:
        connection.close()


def get_db():
    if "db" not in g:
        g.db = open_database_connection()
    return g.db


@app.teardown_appcontext
def close_db(_error):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def register_oauth_clients():
    for provider, definition in PROVIDER_CONFIG.items():
        credentials = resolve_provider_credentials(provider, definition)
        client_id = credentials["client_id"]
        client_secret = credentials["client_secret"]
        if not credentials["configured"]:
            if credentials["error"]:
                print(f"[oauth] {definition['label']} not configured: {credentials['error']}", flush=True)
            continue

        payload = {
            "client_id": client_id,
            "client_secret": client_secret,
            "client_kwargs": definition.get("client_kwargs", {}),
        }
        if "server_metadata_url" in definition:
            payload["server_metadata_url"] = definition["server_metadata_url"]
        else:
            payload["access_token_url"] = definition["access_token_url"]
            payload["authorize_url"] = definition["authorize_url"]
            payload["api_base_url"] = definition["api_base_url"]
        oauth.register(provider, **payload)


def provider_status():
    statuses = []
    for provider, definition in PROVIDER_CONFIG.items():
        credentials = resolve_provider_credentials(provider, definition)
        configured = credentials["configured"]
        callback_path = url_for("auth_callback", provider=provider)
        statuses.append(
            {
                "id": provider,
                "label": definition["label"],
                "configured": configured,
                "loginUrl": url_for("login_provider", provider=provider) if configured else None,
                "callbackUrl": public_url(callback_path),
                "requiredEnv": provider_requirements(provider, definition)["requiredEnv"],
                "missingEnv": provider_missing_env(provider, definition),
                "error": credentials["error"],
            }
        )
    return statuses


def pop_auth_error():
    return session.pop("auth_error", "")


def set_auth_error(provider, error):
    label = PROVIDER_CONFIG.get(provider, {}).get("label", provider.title())
    message = str(error).strip()
    session["auth_error"] = f"{label} sign-in failed. {message}" if message else f"{label} sign-in failed."


def parse_apple_profile():
    if request.method != "POST":
        return {}

    raw_user = request.form.get("user")
    if not raw_user:
        return {}

    try:
        payload = json.loads(raw_user)
    except json.JSONDecodeError:
        return {}

    profile = {}
    email = normalize_email(payload.get("email"))
    if email:
        profile["email"] = email

    name = payload.get("name") or {}
    first_name = (name.get("firstName") or "").strip()
    last_name = (name.get("lastName") or "").strip()
    full_name = " ".join(part for part in [first_name, last_name] if part)
    if full_name:
        profile["name"] = full_name

    return profile


def merge_userinfo(base, extra):
    merged = dict(base or {})
    for key, value in (extra or {}).items():
        if value and not merged.get(key):
            merged[key] = value
    return merged


def get_current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None

    row = get_db().execute(
        "SELECT id, email, display_name, avatar_url, created_at, last_login_at FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return dict(row) if row else None


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentication required."}), 401
        g.current_user = user
        return view(*args, **kwargs)

    return wrapped


def normalize_email(value):
    if not value:
        return ""
    return value.strip().lower()


def default_state(display_name):
    now = utc_now()
    return {
        "meta": {
            "schemaVersion": SCHEMA_VERSION,
            "appName": "Watchnest",
            "createdAt": now,
            "updatedAt": now,
        },
        "profile": {
            "name": display_name or "Viewer",
            "timezone": "UTC",
            "posture": "Cloud-backed",
        },
        "preferences": {
            "density": "comfortable",
            "theme": "daybreak",
        },
        "sync": {
            "mode": "cloud",
            "fileName": "",
            "linkedAt": None,
            "lastSyncedAt": now,
            "lastError": "",
            "autoSync": True,
        },
        "filters": {
            "search": "",
            "status": "all",
            "platform": "all",
            "kind": "all",
        },
        "connectors": [
            {
                "id": connector["id"],
                "mode": connector["defaultMode"],
                "status": "available",
                "autoTrack": False,
                "health": "idle",
                "lastSeenAt": None,
            }
            for connector in CONNECTOR_DEFINITIONS
        ],
        "titles": [],
        "sessions": [],
    }


def load_state_for_user(user_id, display_name):
    row = get_db().execute(
        "SELECT state_json FROM user_states WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    if not row:
        state = default_state(display_name)
        save_state_for_user(user_id, state)
        return state

    state = json.loads(row["state_json"])
    state.setdefault("meta", {})
    state["meta"]["schemaVersion"] = SCHEMA_VERSION
    state["meta"].setdefault("appName", "Watchnest")
    state["meta"].setdefault("updatedAt", utc_now())
    state.setdefault("profile", {})
    state["profile"]["name"] = display_name or state["profile"].get("name") or "Viewer"
    state.setdefault("titles", [])
    state.setdefault("sessions", [])
    state.setdefault("connectors", default_state(display_name)["connectors"])
    state.setdefault(
        "sync",
        {
            "mode": "cloud",
            "fileName": "",
            "linkedAt": None,
            "lastSyncedAt": utc_now(),
            "lastError": "",
            "autoSync": True,
        },
    )
    return state


def save_state_for_user(user_id, state):
    now = utc_now()
    state.setdefault("meta", {})
    state["meta"]["schemaVersion"] = SCHEMA_VERSION
    state["meta"]["appName"] = "Watchnest"
    state["meta"]["updatedAt"] = now
    state.setdefault("sync", {})
    if state["sync"].get("mode") == "cloud" or not state["sync"].get("mode"):
        state["sync"]["mode"] = "cloud"
        state["sync"]["lastSyncedAt"] = now
    payload = json.dumps(state)
    get_db().execute(
        """
        INSERT INTO user_states (user_id, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = excluded.updated_at
        """,
        (user_id, payload, now),
    )
    get_db().commit()


def create_user(email, display_name, password_hash=None, avatar_url=None):
    now = utc_now()
    user_id = execute_insert_returning_id(
        """
        INSERT INTO users (email, display_name, password_hash, avatar_url, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (normalize_email(email) or None, display_name, password_hash, avatar_url, now, now),
    )
    save_state_for_user(user_id, default_state(display_name))
    return user_id


def touch_last_login(user_id):
    get_db().execute(
        "UPDATE users SET last_login_at = ? WHERE id = ?",
        (utc_now(), user_id),
    )
    get_db().commit()


def serialize_user(user):
    return {
        "id": user["id"],
        "email": user.get("email"),
        "displayName": user["display_name"],
        "avatarUrl": user.get("avatar_url"),
        "createdAt": user.get("created_at"),
        "lastLoginAt": user.get("last_login_at"),
    }


def strip_html(value):
    if not value:
        return ""
    return re.sub(r"<[^>]+>", "", value).strip()


def normalize_title_key(value):
    cleaned = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return cleaned or secrets.token_hex(4)


def create_id(prefix):
    return f"{prefix}-{secrets.token_hex(8)}"


def parse_year(value):
    if not value:
        return None
    match = re.search(r"(\d{4})", str(value))
    return int(match.group(1)) if match else None


def current_timestamp():
    return time.time()


def parse_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def parse_iso_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_unit_key(value):
    cleaned = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return cleaned or ""


def format_episode_label(season_number=None, episode_number=None):
    if season_number and episode_number:
        return f"S{season_number} E{episode_number}"
    if episode_number:
        return f"Episode {episode_number}"
    return ""


def normalize_event_type(value):
    raw = (value or "").strip().lower()
    if raw in {"media.play", "play", "playing", "playback.start", "started"}:
        return "play"
    if raw in {"media.resume", "resume", "resumed", "playback.resume"}:
        return "resume"
    if raw in {"media.pause", "pause", "paused", "playback.pause"}:
        return "pause"
    if raw in {"media.stop", "stop", "stopped", "playback.stop"}:
        return "stop"
    if raw in {"media.scrobble", "ended", "end", "complete", "completed", "watched", "playback.scrobble"}:
        return "ended"
    if raw in {"progress", "timeupdate", "heartbeat", "tick"}:
        return "progress"
    return raw or "progress"


def ratings_provider_configured():
    return bool(env_value("OMDB_API_KEY"))


def normalize_ratings_list(ratings):
    if not isinstance(ratings, list):
        return []
    normalized = []
    for item in ratings:
        source = str((item or {}).get("source") or "").strip()
        value = str((item or {}).get("value") or "").strip()
        if source and value:
            normalized.append({"source": source, "value": value})
    return normalized[:4]


def cache_lookup(cache_store_obj, cache_key, max_age_seconds):
    cached = cache_store_obj.get(cache_key)
    if not cached:
        return None
    if current_timestamp() - cached["stored_at"] > max_age_seconds:
        cache_store_obj.pop(cache_key, None)
        return None
    return cached["value"]


def cache_store(cache_store_obj, cache_key, value, max_items=256):
    cache_store_obj[cache_key] = {
        "stored_at": current_timestamp(),
        "value": value,
    }
    if len(cache_store_obj) > max_items:
        oldest_key = min(cache_store_obj, key=lambda key: cache_store_obj[key]["stored_at"])
        cache_store_obj.pop(oldest_key, None)


def fetch_omdb_ratings(title, year=None, kind=None, imdb_id=None):
    api_key = env_value("OMDB_API_KEY")
    if not api_key:
        return {"ratings": [], "imdbId": imdb_id or "", "ratingUpdatedAt": None, "externalUrl": ""}

    normalized_title = (title or "").strip()
    if not normalized_title and not imdb_id:
        return {"ratings": [], "imdbId": "", "ratingUpdatedAt": None, "externalUrl": ""}

    cache_key = ("omdb", imdb_id or normalized_title.lower(), year or "", kind or "")
    cached = cache_lookup(OMDB_CACHE, cache_key, 12 * 60 * 60)
    if cached is not None:
        return cached

    params = {
        "apikey": api_key,
        "r": "json",
        "tomatoes": "true",
    }
    if imdb_id:
        params["i"] = imdb_id
    else:
        params["t"] = normalized_title
        if year:
            params["y"] = str(year)
        if kind == "movie":
            params["type"] = "movie"
        elif kind == "show":
            params["type"] = "series"

    response = requests.get(
        "https://www.omdbapi.com/",
        params=params,
        headers=HTTP_HEADERS,
        timeout=12,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("Response") == "False":
        result = {"ratings": [], "imdbId": imdb_id or "", "ratingUpdatedAt": None, "externalUrl": ""}
        cache_store(OMDB_CACHE, cache_key, result)
        return result

    ratings = []
    imdb_rating = (payload.get("imdbRating") or "").strip()
    if imdb_rating and imdb_rating != "N/A":
        ratings.append({"source": "IMDb", "value": f"{imdb_rating}/10"})
    for item in payload.get("Ratings") or []:
        source = str(item.get("Source") or "").strip()
        value = str(item.get("Value") or "").strip()
        if source and value and source.lower() != "internet movie database":
            ratings.append({"source": source, "value": value})
    metascore = (payload.get("Metascore") or "").strip()
    if metascore and metascore != "N/A" and not any(rating["source"] == "Metacritic" for rating in ratings):
        ratings.append({"source": "Metacritic", "value": f"{metascore}/100"})

    deduped = []
    seen_sources = set()
    for rating in ratings:
        key = rating["source"].lower()
        if key in seen_sources:
            continue
        seen_sources.add(key)
        deduped.append(rating)

    result = {
        "ratings": deduped[:4],
        "imdbId": (payload.get("imdbID") or imdb_id or "").strip(),
        "ratingUpdatedAt": utc_now(),
        "externalUrl": f"https://www.imdb.com/title/{payload.get('imdbID')}/" if payload.get("imdbID") else "",
    }
    cache_store(OMDB_CACHE, cache_key, result)
    return result


def normalize_search_text(value):
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def proxied_image_url(image_url):
    if not image_url:
        return None
    return f"/api/image?url={quote(image_url, safe='')}"


def metadata_result_score(query, result):
    normalized_query = normalize_search_text(query)
    normalized_title = normalize_search_text(result.get("title"))
    normalized_summary = normalize_search_text(result.get("summary"))
    if not normalized_query or not normalized_title:
        return 0

    score = 0
    query_tokens = normalized_query.split()
    title_tokens = normalized_title.split()

    if normalized_title == normalized_query:
        score += 1000
    if normalized_title.startswith(normalized_query):
        score += 700
        score += max(0, 180 - max(0, len(normalized_title) - len(normalized_query)) * 10)
    if normalized_query in normalized_title:
        score += 520
    if query_tokens and all(token in title_tokens for token in query_tokens):
        score += 360
    if query_tokens and all(any(word.startswith(token) for word in title_tokens) for token in query_tokens):
        score += 280

    for token in query_tokens:
        if token in title_tokens:
            score += 40
        elif token and token in normalized_title:
            score += 24
        if token and token in normalized_summary:
            score += 6

    score -= max(0, len(title_tokens) - len(query_tokens)) * 8

    score += int(float(result.get("_sourceScore") or 0) * 100)

    year = parse_year(result.get("year"))
    if year:
        score += max(0, 12 - min(abs(datetime.now(timezone.utc).year - year), 12))

    return score


def metadata_result_match_tier(query, result):
    normalized_query = normalize_search_text(query)
    normalized_title = normalize_search_text(result.get("title"))
    if not normalized_query or not normalized_title:
        return 0

    query_tokens = normalized_query.split()
    title_tokens = normalized_title.split()

    if normalized_title == normalized_query:
        return 5
    if normalized_title.startswith(normalized_query):
        return 4
    if query_tokens and all(token in title_tokens for token in query_tokens):
        return 3
    if normalized_query in normalized_title:
        return 2
    return 1


def dedupe_and_rank_metadata_results(query, results):
    ranked = []
    seen = {}
    for result in results:
        item = {**result}
        item["_score"] = metadata_result_score(query, item)
        item["_matchTier"] = metadata_result_match_tier(query, item)
        item["_sortYear"] = parse_year(item.get("year")) or 0
        key = (
            item.get("kind") or "",
            normalize_search_text(item.get("title")),
            parse_year(item.get("year")) or "",
        )
        existing = seen.get(key)
        if existing is None or item["_score"] > ranked[existing]["_score"]:
            if existing is None:
                seen[key] = len(ranked)
                ranked.append(item)
            else:
                ranked[existing] = item

    ranked.sort(
        key=lambda item: (
            -item.get("_matchTier", 0),
            -item.get("_score", 0),
            -item.get("_sortYear", 0),
            normalize_search_text(item.get("title")),
        )
    )
    return [
        {key: value for key, value in item.items() if not key.startswith("_")}
        for item in ranked
    ]


def wikidata_search_item_score(query, item):
    candidate = {
        "title": item.get("label"),
        "summary": item.get("description") or "",
        "_sourceScore": 0,
    }
    return metadata_result_score(query, candidate)


def parse_progress_percent(observation):
    raw_value = observation.get("progressPercent")
    if raw_value in {None, ""}:
        return None
    try:
        return clamp(int(round(float(raw_value))), 0, 100)
    except (TypeError, ValueError):
        return None


def parse_duration_minutes(kind, observation):
    explicit_minutes = observation.get("durationMin")
    if explicit_minutes not in {None, ""}:
        return max(1, parse_int(explicit_minutes, 44 if kind == "show" else 96))

    duration_seconds = observation.get("durationSeconds")
    if duration_seconds not in {None, ""}:
        return max(1, round(parse_int(duration_seconds, 0) / 60))

    duration_ms = observation.get("durationMs")
    if duration_ms not in {None, ""}:
        return max(1, round(parse_int(duration_ms, 0) / 60000))

    return 44 if kind == "show" else 96


def coerce_list(value):
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return []


def merge_or_insert_session(sessions, session_entry):
    current_unit = normalize_unit_key(session_entry.get("currentUnit"))
    started_at = parse_iso_timestamp(session_entry.get("startedAt")) or datetime.now(timezone.utc)

    for existing in sessions[:8]:
        existing_started = parse_iso_timestamp(existing.get("startedAt"))
        if not existing_started:
            continue
        if abs((started_at - existing_started).total_seconds()) > 90 * 60:
            continue
        if existing.get("titleId") != session_entry.get("titleId"):
            continue
        if existing.get("platformId") != session_entry.get("platformId"):
            continue
        if (existing.get("sourceLabel") or "") != (session_entry.get("sourceLabel") or ""):
            continue
        if normalize_unit_key(existing.get("currentUnit")) != current_unit:
            continue

        existing["startedAt"] = session_entry["startedAt"]
        existing["durationMin"] = max(parse_int(existing.get("durationMin"), 0), session_entry["durationMin"])
        existing["progressAfter"] = max(parse_int(existing.get("progressAfter"), 0), session_entry["progressAfter"])
        existing["summary"] = session_entry["summary"]
        existing["device"] = session_entry["device"]
        existing["eventType"] = session_entry.get("eventType") or existing.get("eventType")
        existing["currentUnit"] = session_entry.get("currentUnit") or existing.get("currentUnit")
        return existing

    sessions.insert(0, session_entry)
    return session_entry


def token_hash(raw_token):
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def get_api_tokens_for_user(user_id):
    rows = get_db().execute(
        """
        SELECT id, label, token_preview, created_at, last_used_at
        FROM api_tokens
        WHERE user_id = ?
        ORDER BY created_at DESC
        """,
        (user_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "label": row["label"],
            "preview": row["token_preview"],
            "createdAt": row["created_at"],
            "lastUsedAt": row["last_used_at"],
        }
        for row in rows
    ]


def get_token_owner(raw_token):
    row = get_db().execute(
        """
        SELECT api_tokens.id, api_tokens.user_id, users.display_name
        FROM api_tokens
        JOIN users ON users.id = api_tokens.user_id
        WHERE api_tokens.token_hash = ?
        """,
        (token_hash(raw_token),),
    ).fetchone()
    return dict(row) if row else None


def mark_token_used(token_id):
    get_db().execute(
        "UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
        (utc_now(), token_id),
    )
    get_db().commit()


def get_request_token(payload=None):
    token = get_bearer_token()
    if token:
        return token

    header_token = (request.headers.get("X-Watchnest-Token") or "").strip()
    if header_token:
        return header_token

    query_token = (request.args.get("token") or "").strip()
    if query_token:
        return query_token

    if isinstance(payload, dict):
        for key in ("token", "apiToken", "watchnestToken"):
            candidate = (payload.get(key) or "").strip()
            if candidate:
                return candidate

    form_token = (request.form.get("token") or request.form.get("apiToken") or request.form.get("watchnestToken") or "").strip()
    return form_token


def ingest_payload_for_owner(owner, payload):
    state = load_state_for_user(owner["user_id"], owner["display_name"])
    result = apply_observation_to_state(state, payload)
    save_state_for_user(owner["user_id"], state)
    mark_token_used(owner["id"])
    return result, state


def apply_observation_to_state(state, observation):
    title_name = (observation.get("title") or "").strip()
    if not title_name:
        raise ValueError("Observation must include a title.")

    platform_id = observation.get("platformId") or "netflix"
    kind = "movie" if observation.get("kind") == "movie" else "show"
    current_unit = observation.get("currentUnit") or ("S1 E1" if kind == "show" else "Movie")
    duration_min = parse_duration_minutes(kind, observation)
    progress_delta = clamp(parse_int(observation.get("progressDelta"), 16 if kind == "show" else 22), 1, 100)
    progress_percent = parse_progress_percent(observation)
    event_type = normalize_event_type(observation.get("eventType"))

    titles = state.setdefault("titles", [])
    sessions = state.setdefault("sessions", [])
    connectors = state.setdefault("connectors", [])

    target = None
    normalized_name = normalize_title_key(title_name)
    for candidate in titles:
        same_name = normalize_title_key(candidate.get("title", "")) == normalized_name
        same_platform = candidate.get("platformId") == platform_id
        if same_name and (same_platform or not candidate.get("platformId")):
            target = candidate
            break

    if not target:
        target = {
            "id": create_id("title"),
            "title": title_name,
            "kind": kind,
            "year": observation.get("year") or datetime.now(timezone.utc).year,
            "platformId": platform_id,
            "status": "watching",
            "progress": 0,
            "genres": coerce_list(observation.get("genres")),
            "currentUnit": current_unit,
            "summary": observation.get("summary") or "Added from browser companion capture.",
            "lastActivityAt": utc_now(),
            "favorite": False,
            "source": observation.get("source") or "companion",
            "externalUrl": observation.get("externalUrl") or "",
        }
        titles.insert(0, target)

    existing_progress = clamp(parse_int(target.get("progress"), 0), 0, 100)
    previous_unit = target.get("currentUnit") or current_unit
    unit_changed = kind == "show" and normalize_unit_key(previous_unit) != normalize_unit_key(current_unit)
    progress_before = 0 if unit_changed else existing_progress

    if progress_percent is not None:
        if event_type == "ended" or progress_percent >= 98:
            progress_after = 100
        elif unit_changed:
            progress_after = progress_percent
        else:
            progress_after = max(existing_progress, progress_percent)
    else:
        progress_after = max(progress_before, min(100, progress_before + progress_delta))

    started_at = utc_now()
    target["progress"] = progress_after
    target["status"] = "completed" if progress_after >= 100 else "watching"
    target["lastActivityAt"] = started_at
    target["platformId"] = platform_id
    target["kind"] = kind
    target["currentUnit"] = current_unit
    target["summary"] = observation.get("summary") or target.get("summary") or "Tracked in Watchnest."
    target["source"] = observation.get("source") or target.get("source") or "companion"
    if observation.get("year"):
        target["year"] = observation["year"]
    if observation.get("genres"):
        target["genres"] = coerce_list(observation["genres"])
    if observation.get("externalUrl"):
        target["externalUrl"] = observation["externalUrl"]

    session_entry = {
        "id": create_id("session"),
        "titleId": target["id"],
        "platformId": platform_id,
        "startedAt": started_at,
        "durationMin": duration_min,
        "progressBefore": progress_before,
        "progressAfter": progress_after,
        "sourceType": observation.get("sourceType") or "auto",
        "sourceLabel": observation.get("sourceLabel") or "Browser companion",
        "device": observation.get("device") or "Browser extension",
        "eventType": event_type,
        "currentUnit": current_unit,
        "summary": observation.get("sessionSummary")
        or f"Browser companion captured {target['title']} from {platform_id}.",
    }
    stored_session = merge_or_insert_session(sessions, session_entry)
    sessions.sort(
        key=lambda item: parse_iso_timestamp(item.get("startedAt")) or datetime.fromtimestamp(0, tz=timezone.utc),
        reverse=True,
    )
    state["sessions"] = sessions[:80]

    for connector in connectors:
        if connector.get("id") == platform_id:
            connector["status"] = "connected"
            connector["autoTrack"] = True
            connector["health"] = "live"
            connector["lastSeenAt"] = started_at
            break

    return {"title": target, "session": stored_session}


def parse_json_object(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def parse_secondsish(value):
    numeric = parse_int(value, 0)
    if numeric <= 0:
        return 0
    if numeric >= 10000:
        return round(numeric / 1000)
    return numeric


def compute_progress_percent(position_value, duration_value):
    duration_seconds = parse_secondsish(duration_value)
    position_seconds = parse_secondsish(position_value)
    if duration_seconds <= 0 or position_seconds < 0:
        return None
    return clamp(int(round((position_seconds / duration_seconds) * 100)), 0, 100)


def build_plex_observation(payload):
    event_type = normalize_event_type(payload.get("event"))
    if event_type not in {"play", "resume", "pause", "stop", "ended", "progress"}:
        return None

    metadata = payload.get("Metadata") or {}
    media_type = (metadata.get("type") or "").strip().lower()
    if media_type not in {"movie", "episode"}:
        return None

    kind = "show" if media_type == "episode" else "movie"
    title_name = (metadata.get("grandparentTitle") if kind == "show" else metadata.get("title") or "").strip()
    if not title_name:
        return None

    current_unit = (
        (format_episode_label(metadata.get("parentIndex"), metadata.get("index")) or metadata.get("title") or "Episode")
        if kind == "show"
        else "Movie"
    )
    player = payload.get("Player") or {}
    account = payload.get("Account") or {}
    server_info = payload.get("Server") or {}
    device = " / ".join(
        part
        for part in [player.get("title"), player.get("product"), player.get("platform")]
        if part
    ) or "Plex"
    progress_percent = compute_progress_percent(metadata.get("viewOffset"), metadata.get("duration"))
    if event_type == "ended":
        progress_percent = 100

    account_title = account.get("title") or ""

    return {
        "title": title_name,
        "kind": kind,
        "platformId": "plex",
        "currentUnit": current_unit,
        "durationSeconds": parse_secondsish(metadata.get("duration")),
        "progressPercent": progress_percent,
        "eventType": event_type,
        "summary": f"Synced from Plex webhook on {server_info.get('title') or 'your Plex server'}.",
        "sessionSummary": (
            f"Plex webhook captured {event_type} for {title_name}"
            f"{f' {current_unit}' if kind == 'show' else ''}"
            f"{f' via {device}' if device else ''}"
            f"{f' for {account_title}' if account_title else ''}."
        ),
        "device": device,
        "source": "plex-webhook",
        "sourceLabel": "Plex webhook",
    }


def build_tautulli_observation(payload):
    event_type = normalize_event_type(payload.get("event") or payload.get("action"))
    if event_type not in {"play", "resume", "pause", "stop", "ended", "progress"}:
        return None

    media_type = (payload.get("media_type") or payload.get("mediaType") or "").strip().lower()
    if media_type not in {"movie", "episode"}:
        media_type = "episode" if any(payload.get(key) for key in ("grandparent_title", "show_name", "series_title")) else "movie"

    kind = "show" if media_type == "episode" else "movie"
    title_name = (
        payload.get("grandparent_title")
        or payload.get("show_name")
        or payload.get("series_title")
        or payload.get("title")
        or payload.get("full_title")
        or ""
    ).strip()
    if not title_name:
        return None

    current_unit = (
        (
            format_episode_label(payload.get("season_num") or payload.get("parent_media_index"), payload.get("episode_num") or payload.get("media_index"))
            or payload.get("episode_title")
            or "Episode"
        )
        if kind == "show"
        else "Movie"
    )
    duration_value = payload.get("duration") or payload.get("stream_duration")
    progress_percent = parse_progress_percent({"progressPercent": payload.get("progress_percent") or payload.get("progressPercent")})
    if progress_percent is None:
        progress_percent = compute_progress_percent(payload.get("view_offset") or payload.get("viewOffset"), duration_value)
    if event_type == "ended":
        progress_percent = 100

    player = payload.get("player") or payload.get("player_title") or ""
    platform = payload.get("platform") or ""
    device = " / ".join(part for part in [player, platform] if part) or "Tautulli"
    user_label = payload.get("friendly_name") or payload.get("user") or ""

    return {
        "title": title_name,
        "kind": kind,
        "platformId": "plex",
        "currentUnit": current_unit,
        "durationSeconds": parse_secondsish(duration_value),
        "progressPercent": progress_percent,
        "eventType": event_type,
        "summary": "Synced from Tautulli playback automation.",
        "sessionSummary": (
            f"Tautulli captured {event_type} for {title_name}"
            f"{f' {current_unit}' if kind == 'show' else ''}"
            f"{f' via {device}' if device else ''}"
            f"{f' for {user_label}' if user_label else ''}."
        ),
        "device": device,
        "source": "tautulli",
        "sourceLabel": "Tautulli",
    }


def fetch_tvmaze_results(query):
    cache_key = ("tvmaze", normalize_search_text(query))
    cached = cache_lookup(SEARCH_CACHE, cache_key, 30 * 60)
    if cached is not None:
        return cached

    response = requests.get(
        "https://api.tvmaze.com/search/shows",
        params={"q": query},
        headers=HTTP_HEADERS,
        timeout=12,
    )
    response.raise_for_status()
    payload = response.json()
    results = []
    for item in payload[:8]:
        show = item.get("show") or {}
        average_rating = ((show.get("rating") or {}).get("average"))
        imdb_id = str(((show.get("externals") or {}).get("imdb") or "")).strip()
        ratings = []
        if average_rating not in {None, ""}:
            ratings.append({"source": "TVMaze", "value": f"{average_rating}/10"})
        results.append(
            {
                "id": f"tvmaze:{show.get('id')}",
                "kind": "show",
                "title": show.get("name"),
                "year": parse_year(show.get("premiered")),
                "runtimeMin": parse_int(show.get("averageRuntime") or show.get("runtime"), 0),
                "summary": strip_html(show.get("summary")),
                "genres": show.get("genres") or [],
                "image": proxied_image_url((show.get("image") or {}).get("original") or (show.get("image") or {}).get("medium")),
                "externalUrl": show.get("url"),
                "platformHint": (show.get("webChannel") or {}).get("name") or (show.get("network") or {}).get("name"),
                "currentUnit": "S1 E1",
                "source": "tvmaze",
                "sourceId": f"tvmaze:{show.get('id')}",
                "ratings": ratings,
                "imdbId": imdb_id,
                "_sourceScore": item.get("score") or 0,
            }
        )
    cache_store(SEARCH_CACHE, cache_key, results, max_items=128)
    return results


def fetch_movie_results(query):
    cache_key = ("wikidata", normalize_search_text(query))
    cached = cache_lookup(SEARCH_CACHE, cache_key, 30 * 60)
    if cached is not None:
        return cached

    response = requests.get(
        "https://www.wikidata.org/w/api.php",
        params={
            "action": "wbsearchentities",
            "search": query,
            "language": "en",
            "format": "json",
            "type": "item",
            "limit": 20,
        },
        headers=HTTP_HEADERS,
        timeout=12,
    )
    response.raise_for_status()
    search_results = response.json().get("search", [])
    filtered = [
        item
        for item in search_results
        if "film" in (item.get("description") or "").lower()
        or "movie" in (item.get("description") or "").lower()
        or "television film" in (item.get("description") or "").lower()
    ]
    if not filtered:
        filtered = search_results[:10]
    filtered.sort(key=lambda item: wikidata_search_item_score(query, item), reverse=True)
    shortlisted = filtered[:8]
    ids = [item.get("id") for item in shortlisted if item.get("id")]
    details = {}
    if ids:
        detail_response = requests.get(
            "https://www.wikidata.org/w/api.php",
            params={
                "action": "wbgetentities",
                "ids": "|".join(ids),
                "languages": "en",
                "format": "json",
                "props": "labels|descriptions|claims",
            },
            headers=HTTP_HEADERS,
            timeout=12,
        )
        detail_response.raise_for_status()
        details = detail_response.json().get("entities", {})

    results = []
    for item in shortlisted:
        entity = details.get(item.get("id"), {})
        image_name = claim_string(entity, "P18")
        results.append(
            {
                "id": f"wikidata:{item.get('id')}",
                "kind": "movie",
                "title": item.get("label"),
                "year": parse_year(claim_time(entity, "P577")),
                "runtimeMin": 0,
                "summary": item.get("description") or entity_description(entity) or "Film metadata from Wikidata.",
                "genres": [],
                "image": proxied_image_url(f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(image_name)}") if image_name else None,
                "externalUrl": item.get("concepturi"),
                "platformHint": None,
                "currentUnit": "Movie",
                "source": "wikidata",
                "sourceId": f"wikidata:{item.get('id')}",
                "_sourceScore": 0,
            }
        )
    cache_store(SEARCH_CACHE, cache_key, results, max_items=128)
    return results


def fetch_book_results(query):
    cache_key = ("openlibrary", normalize_search_text(query))
    cached = cache_lookup(SEARCH_CACHE, cache_key, 30 * 60)
    if cached is not None:
        return cached

    response = requests.get(
        "https://openlibrary.org/search.json",
        params={
            "q": query,
            "limit": 12,
            "fields": ",".join(
                [
                    "key",
                    "title",
                    "author_name",
                    "first_publish_year",
                    "cover_i",
                    "subject",
                    "publisher",
                    "ratings_average",
                    "ratings_count",
                    "edition_count",
                ]
            ),
        },
        headers=HTTP_HEADERS,
        timeout=12,
    )
    response.raise_for_status()
    payload = response.json()
    docs = payload.get("docs") or []

    results = []
    for item in docs[:8]:
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        authors = [str(name).strip() for name in (item.get("author_name") or []) if str(name).strip()]
        creator_label = ", ".join(authors[:2])
        subjects = [str(subject).strip() for subject in (item.get("subject") or []) if str(subject).strip()]
        publishers = [str(publisher).strip() for publisher in (item.get("publisher") or []) if str(publisher).strip()]
        cover_id = parse_int(item.get("cover_i"), 0)
        average_rating = item.get("ratings_average")
        ratings = []
        if average_rating not in {None, ""}:
            try:
                ratings.append({"source": "Open Library", "value": f"{round(float(average_rating), 1)}/5"})
            except (TypeError, ValueError):
                pass
        summary_parts = []
        if creator_label:
            summary_parts.append(f"by {creator_label}")
        if publishers:
            summary_parts.append(f"Published by {publishers[0]}")
        edition_count = parse_int(item.get("edition_count"), 0)
        if edition_count:
            summary_parts.append(f"{edition_count} editions indexed")

        results.append(
            {
                "id": f"openlibrary:{key.strip('/').split('/')[-1]}",
                "kind": "book",
                "title": title,
                "year": parse_year(item.get("first_publish_year")),
                "runtimeMin": 35,
                "summary": ". ".join(summary_parts) + ("." if summary_parts else "Book metadata from Open Library."),
                "genres": subjects[:2],
                "image": proxied_image_url(f"https://covers.openlibrary.org/b/id/{cover_id}-L.jpg") if cover_id else None,
                "externalUrl": f"https://openlibrary.org{key}",
                "platformHint": "Books",
                "creatorLabel": creator_label,
                "currentUnit": "Chapter 1",
                "source": "openlibrary",
                "sourceId": f"openlibrary:{key.strip('/').split('/')[-1]}",
                "ratings": ratings,
                "_sourceScore": max(parse_int(item.get("ratings_count"), 0) / 100, 0),
            }
        )

    cache_store(SEARCH_CACHE, cache_key, results, max_items=128)
    return results


def fetch_tvmaze_episode_options(source_id):
    if not source_id or not str(source_id).startswith("tvmaze:"):
        return {"episodes": [], "show": {}}

    cache_key = ("episodes", source_id)
    cached = cache_lookup(EPISODE_CACHE, cache_key, 24 * 60 * 60)
    if cached is not None:
        return cached

    show_id = str(source_id).split(":", 1)[1]
    response = requests.get(
        f"https://api.tvmaze.com/shows/{show_id}",
        params={"embed": "episodes"},
        headers=HTTP_HEADERS,
        timeout=12,
    )
    response.raise_for_status()
    payload = response.json()
    embedded = (payload.get("_embedded") or {}).get("episodes") or []
    episodes = []
    for item in embedded:
        season = parse_int(item.get("season"), 0)
        number = parse_int(item.get("number"), 0)
        if season <= 0 or number <= 0:
            continue
        label = f"S{season} E{number}"
        title = (item.get("name") or "").strip()
        episodes.append(
            {
                "value": label,
                "label": f"{label} - {title}" if title else label,
                "season": season,
                "number": number,
                "name": title,
                "airdate": item.get("airdate") or "",
                "airstamp": item.get("airstamp") or "",
                "runtime": parse_int(item.get("runtime"), 0),
                "summary": strip_html(item.get("summary")) if item.get("summary") else "",
                "available": bool(parse_iso_timestamp(item.get("airstamp") or item.get("airdate")) and parse_iso_timestamp(item.get("airstamp") or item.get("airdate")) <= datetime.now(timezone.utc)),
            }
        )

    show_payload = {
        "title": payload.get("name") or "",
        "summary": strip_html(payload.get("summary")) if payload.get("summary") else "",
        "image": proxied_image_url((payload.get("image") or {}).get("original") or (payload.get("image") or {}).get("medium")),
        "externalUrl": payload.get("url") or "",
        "imdbId": str(((payload.get("externals") or {}).get("imdb") or "")).strip(),
        "runtimeMin": parse_int(payload.get("averageRuntime") or payload.get("runtime"), 0),
        "ratings": [{"source": "TVMaze", "value": f"{((payload.get('rating') or {}).get('average'))}/10"}] if ((payload.get("rating") or {}).get("average")) not in {None, ""} else [],
    }

    result = {"episodes": episodes, "show": show_payload}
    cache_store(EPISODE_CACHE, cache_key, result, max_items=128)
    return result


def entity_description(entity):
    descriptions = entity.get("descriptions") or {}
    return (descriptions.get("en") or {}).get("value")


def claim_string(entity, claim_key):
    claims = (entity.get("claims") or {}).get(claim_key) or []
    if not claims:
        return None
    mainsnak = claims[0].get("mainsnak") or {}
    datavalue = mainsnak.get("datavalue") or {}
    return datavalue.get("value")


def claim_time(entity, claim_key):
    claims = (entity.get("claims") or {}).get(claim_key) or []
    if not claims:
        return None
    mainsnak = claims[0].get("mainsnak") or {}
    datavalue = mainsnak.get("datavalue") or {}
    value = datavalue.get("value") or {}
    return value.get("time")


def get_bearer_token():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return (request.headers.get("X-Watchnest-Token") or request.headers.get("X-LumaTrack-Token") or "").strip()


@app.before_request
def enforce_request_security():
    hosts = allowed_hosts()
    request_host = request.host.lower()
    hostname_only = request_host.split(":", 1)[0]
    if hosts and request_host not in hosts and hostname_only not in hosts:
        abort(400)

    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        exempt_paths = {
            "/api/ingest/observation",
            "/api/integrations/plex/webhook",
            "/api/integrations/tautulli/webhook",
            "/auth/callback/google",
            "/auth/callback/facebook",
            "/auth/callback/apple",
        }
        if request.path not in exempt_paths and not validate_csrf():
            return jsonify({"error": "CSRF validation failed."}), 403


@app.after_request
def apply_headers(response):
    if request.path.startswith("/api/ingest/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Watchnest-Token, X-LumaTrack-Token"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Content-Security-Policy"] = security_csp()
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Origin-Agent-Cluster"] = "?1"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if is_https_base_url():
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.route("/api/bootstrap")
def api_bootstrap():
    user = get_current_user()
    payload = {
        "auth": {
            "authenticated": bool(user),
            "user": serialize_user(user) if user else None,
            "providers": provider_status(),
            "error": pop_auth_error(),
        },
        "app": {
            "baseUrl": current_base_url(),
            "csrfToken": ensure_csrf_token(),
            "schemaVersion": SCHEMA_VERSION,
            "companionReady": True,
            "storageBackend": get_db().backend,
            "ratingsReady": ratings_provider_configured(),
            "ratingsProvider": "omdb" if ratings_provider_configured() else "",
        },
        "connectors": CONNECTOR_DEFINITIONS,
        "tokens": [],
        "state": None,
    }
    if user:
        payload["state"] = load_state_for_user(user["id"], user["display_name"])
        payload["tokens"] = get_api_tokens_for_user(user["id"])
    return jsonify(payload)


@app.route("/api/auth/register", methods=["POST"])
def api_register():
    limited = enforce_rate_limit("auth-register", 5, 600)
    if limited:
        return limited

    payload = request.get_json(silent=True) or {}
    email = normalize_email(payload.get("email"))
    password = payload.get("password") or ""
    display_name = (payload.get("displayName") or "").strip() or email.split("@")[0]
    minimum_length = parse_positive_int(env_value("LUMATRACK_MIN_PASSWORD_LENGTH"), 12)

    if not email or "@" not in email:
        return jsonify({"error": "A valid email address is required."}), 400
    if len(password) < minimum_length:
        return jsonify({"error": f"Password must be at least {minimum_length} characters."}), 400

    existing = get_db().execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        return jsonify({"error": "An account with that email already exists."}), 409

    user_id = create_user(email, display_name, generate_password_hash(password))
    session["user_id"] = user_id
    user = get_db().execute(
        "SELECT id, email, display_name, avatar_url, created_at, last_login_at FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return jsonify(
        {
            "user": serialize_user(dict(user)),
            "state": load_state_for_user(user_id, display_name),
            "tokens": [],
            "csrfToken": ensure_csrf_token(),
        }
    )


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    limited = enforce_rate_limit("auth-login", 10, 600)
    if limited:
        return limited

    payload = request.get_json(silent=True) or {}
    email = normalize_email(payload.get("email"))
    password = payload.get("password") or ""
    row = get_db().execute(
        """
        SELECT id, email, display_name, avatar_url, password_hash, created_at, last_login_at
        FROM users
        WHERE email = ?
        """,
        (email,),
    ).fetchone()
    if not row or not row["password_hash"] or not check_password_hash(row["password_hash"], password):
        return jsonify({"error": "Invalid email or password."}), 401

    touch_last_login(row["id"])
    session["user_id"] = row["id"]
    user = get_current_user()
    return jsonify(
        {
            "user": serialize_user(user),
            "state": load_state_for_user(user["id"], user["display_name"]),
            "tokens": get_api_tokens_for_user(user["id"]),
            "csrfToken": ensure_csrf_token(),
        }
    )


@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True, "csrfToken": ensure_csrf_token()})


@app.route("/auth/login/<provider>")
def login_provider(provider):
    limited = enforce_rate_limit(f"oauth-{provider}", 20, 600)
    if limited:
        return limited

    client = oauth.create_client(provider)
    if client is None:
        abort(404)

    pop_auth_error()
    redirect_uri = public_url(url_for("auth_callback", provider=provider))
    if provider == "apple":
        return client.authorize_redirect(redirect_uri, response_mode="form_post")
    return client.authorize_redirect(redirect_uri)


@app.route("/auth/callback/<provider>", methods=["GET", "POST"])
def auth_callback(provider):
    client = oauth.create_client(provider)
    if client is None:
        abort(404)

    try:
        token = client.authorize_access_token()
        if provider in {"google", "apple"}:
            userinfo = token.get("userinfo")
            if not userinfo:
                userinfo = client.parse_id_token(token)
            if provider == "apple":
                userinfo = merge_userinfo(userinfo, parse_apple_profile())
        else:
            response = client.get("me?fields=id,name,email,picture.type(large)")
            response.raise_for_status()
            userinfo = response.json()
        user_id = resolve_oauth_user(provider, userinfo)
    except Exception as error:
        set_auth_error(provider, error)
        return redirect(url_for("index"))

    session["user_id"] = user_id
    return redirect(url_for("index"))


def resolve_oauth_user(provider, userinfo):
    subject = userinfo.get("sub") or userinfo.get("id")
    if not subject:
        raise ValueError("OAuth provider did not return a stable subject.")

    email = normalize_email(userinfo.get("email"))
    name = userinfo.get("name") or userinfo.get("given_name") or email or provider.title()
    picture = userinfo.get("picture")
    avatar_url = picture.get("data", {}).get("url") if isinstance(picture, dict) else picture

    identity = get_db().execute(
        "SELECT user_id FROM user_identities WHERE provider = ? AND provider_subject = ?",
        (provider, subject),
    ).fetchone()
    if identity:
        user_id = identity["user_id"]
        get_db().execute(
            "UPDATE users SET display_name = ?, avatar_url = ?, email = COALESCE(email, ?) WHERE id = ?",
            (name, avatar_url, email or None, user_id),
        )
        get_db().commit()
        touch_last_login(user_id)
        return user_id

    existing_user = None
    if email:
        existing_user = get_db().execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()

    if existing_user:
        user_id = existing_user["id"]
        get_db().execute(
            "UPDATE users SET display_name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?",
            (name, avatar_url, utc_now(), user_id),
        )
    else:
        user_id = create_user(email or None, name, password_hash=None, avatar_url=avatar_url)

    get_db().execute(
        """
        INSERT INTO user_identities (user_id, provider, provider_subject, email, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (user_id, provider, subject, email or None, utc_now()),
    )
    get_db().commit()
    touch_last_login(user_id)
    return user_id


@app.route("/api/state", methods=["GET"])
@login_required
def api_get_state():
    user = g.current_user
    return jsonify(
        {
            "state": load_state_for_user(user["id"], user["display_name"]),
            "tokens": get_api_tokens_for_user(user["id"]),
        }
    )


@app.route("/api/state", methods=["PUT"])
@login_required
def api_put_state():
    payload = request.get_json(silent=True) or {}
    state = payload.get("state")
    if not isinstance(state, dict):
        return jsonify({"error": "State payload must be an object."}), 400

    save_state_for_user(g.current_user["id"], state)
    return jsonify({"state": load_state_for_user(g.current_user["id"], g.current_user["display_name"])})


@app.route("/api/metadata/search")
@login_required
def api_metadata_search():
    query = (request.args.get("q") or "").strip()
    kind = (request.args.get("kind") or "all").strip().lower()
    if len(query) < 2:
        return jsonify({"results": []})

    results = []
    try:
        if kind in {"all", "show"}:
            results.extend(fetch_tvmaze_results(query))
        if kind in {"all", "movie"}:
            results.extend(fetch_movie_results(query))
        if kind in {"all", "book"}:
            results.extend(fetch_book_results(query))
    except requests.RequestException as error:
        return jsonify({"error": f"Metadata search failed: {error}"}), 502

    ranked = dedupe_and_rank_metadata_results(query, results)
    return jsonify({"results": ranked[:12]})


@app.route("/api/metadata/episodes")
@login_required
def api_metadata_episodes():
    source_id = (request.args.get("sourceId") or "").strip()
    if not source_id:
        return jsonify({"episodes": []})

    try:
        payload = fetch_tvmaze_episode_options(source_id)
    except requests.RequestException as error:
        return jsonify({"error": f"Episode lookup failed: {error}"}), 502

    return jsonify(payload)


@app.route("/api/image")
def api_image_proxy():
    image_url = (request.args.get("url") or "").strip()
    if not image_url:
        abort(400)

    parsed = urlparse(image_url)
    if parsed.scheme not in {"http", "https"}:
        abort(400)
    if not parsed.netloc or parsed.hostname not in ALLOWED_REMOTE_IMAGE_HOSTS:
        abort(403)

    response = requests.get(image_url, headers=HTTP_HEADERS, timeout=12)
    response.raise_for_status()
    content_type = response.headers.get("Content-Type", "")
    if not content_type.startswith("image/"):
        abort(415)

    proxied = app.response_class(response.content, mimetype=content_type)
    proxied.headers["Cache-Control"] = "public, max-age=86400"
    return proxied


@app.route("/api/ratings/lookup", methods=["POST"])
@login_required
def api_ratings_lookup():
    if not ratings_provider_configured():
        return jsonify({"ratings": [], "imdbId": "", "ratingUpdatedAt": None, "externalUrl": "", "configured": False})

    payload = request.get_json(silent=True) or {}
    title = (payload.get("title") or "").strip()
    if not title and not (payload.get("imdbId") or "").strip():
        return jsonify({"error": "Title or IMDb id is required for rating lookup."}), 400

    try:
        result = fetch_omdb_ratings(
            title=title,
            year=parse_year(payload.get("year")),
            kind=(payload.get("kind") or "").strip().lower(),
            imdb_id=(payload.get("imdbId") or "").strip() or None,
        )
    except requests.RequestException as error:
        return jsonify({"error": f"Ratings lookup failed: {error}"}), 502

    return jsonify({**result, "configured": True})


@app.route("/api/tokens", methods=["GET"])
@login_required
def api_get_tokens():
    return jsonify({"tokens": get_api_tokens_for_user(g.current_user["id"])})


@app.route("/api/tokens", methods=["POST"])
@login_required
def api_create_token():
    limited = enforce_rate_limit("token-create", 20, 600)
    if limited:
        return limited

    payload = request.get_json(silent=True) or {}
    label = (payload.get("label") or "").strip() or "Browser companion"
    raw_token = secrets.token_urlsafe(24)
    preview = f"{raw_token[:6]}...{raw_token[-4:]}"
    get_db().execute(
        """
        INSERT INTO api_tokens (user_id, label, token_hash, token_preview, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (g.current_user["id"], label, token_hash(raw_token), preview, utc_now(), None),
    )
    get_db().commit()
    tokens = get_api_tokens_for_user(g.current_user["id"])
    created = tokens[0] if tokens else None
    return jsonify({"token": raw_token, "created": created})


@app.route("/api/tokens/<int:token_id>", methods=["DELETE"])
@login_required
def api_delete_token(token_id):
    get_db().execute(
        "DELETE FROM api_tokens WHERE id = ? AND user_id = ?",
        (token_id, g.current_user["id"]),
    )
    get_db().commit()
    return jsonify({"tokens": get_api_tokens_for_user(g.current_user["id"])})


@app.route("/api/ingest/observation", methods=["OPTIONS", "POST"])
def api_ingest_observation():
    if request.method == "OPTIONS":
        return ("", 204)

    limited = enforce_rate_limit("ingest", 120, 60)
    if limited:
        return limited

    raw_token = get_bearer_token()
    if not raw_token:
        return jsonify({"error": "Missing ingest token."}), 401

    owner = get_token_owner(raw_token)
    if not owner:
        return jsonify({"error": "Invalid ingest token."}), 401

    payload = request.get_json(silent=True) or {}
    try:
        result, state = ingest_payload_for_owner(owner, payload)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify({"ok": True, "result": result, "state": state})


@app.route("/api/integrations/plex/webhook", methods=["POST"])
def api_plex_webhook():
    limited = enforce_rate_limit("plex-webhook", 240, 60)
    if limited:
        return limited

    payload = parse_json_object(request.form.get("payload"))
    if not payload:
        payload = request.get_json(silent=True) or {}

    raw_token = get_request_token(payload)
    if not raw_token:
        return jsonify({"error": "Missing ingest token."}), 401

    owner = get_token_owner(raw_token)
    if not owner:
        return jsonify({"error": "Invalid ingest token."}), 401

    observation = build_plex_observation(payload)
    if not observation:
        return jsonify({"ok": True, "ignored": True, "reason": "Unsupported Plex event."})

    try:
        result, state = ingest_payload_for_owner(owner, observation)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify({"ok": True, "result": result, "state": state})


@app.route("/api/integrations/tautulli/webhook", methods=["POST"])
def api_tautulli_webhook():
    limited = enforce_rate_limit("tautulli-webhook", 240, 60)
    if limited:
        return limited

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = request.form.to_dict(flat=True)

    nested_payload = parse_json_object(payload.get("payload")) or parse_json_object(payload.get("data"))
    if nested_payload:
        payload = {**payload, **nested_payload}

    raw_token = get_request_token(payload)
    if not raw_token:
        return jsonify({"error": "Missing ingest token."}), 401

    owner = get_token_owner(raw_token)
    if not owner:
        return jsonify({"error": "Invalid ingest token."}), 401

    observation = build_tautulli_observation(payload)
    if not observation:
        return jsonify({"ok": True, "ignored": True, "reason": "Unsupported Tautulli event."})

    try:
        result, state = ingest_payload_for_owner(owner, observation)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify({"ok": True, "result": result, "state": state})


@app.route("/")
def index():
    return send_from_directory(ROOT_DIR, "index.html")


@app.route("/<path:path>")
def serve_static(path):
    if path.startswith("api/") or path.startswith("auth/"):
        abort(404)
    normalized = path.replace("\\", "/")
    if normalized not in ALLOWED_STATIC_FILES:
        abort(404)
    return send_from_directory(ROOT_DIR, normalized)


def create_app():
    init_db()
    register_oauth_clients()
    return app


create_app()


if __name__ == "__main__":
    host = env_value("LUMATRACK_HOST") or "127.0.0.1"
    port = int(env_value("LUMATRACK_PORT") or "5000")
    app.run(host=host, port=port, debug=False)
