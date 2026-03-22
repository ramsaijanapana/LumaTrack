import hashlib
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import quote

import requests
from authlib.integrations.flask_client import OAuth
from flask import Flask, abort, g, jsonify, redirect, request, send_from_directory, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash


ROOT_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT_DIR / "lumatrack.db"
SECRET_PATH = ROOT_DIR / ".lumatrack.secret"
SCHEMA_VERSION = 2
HTTP_HEADERS = {"User-Agent": "LumaTrack/0.1 (local watch tracker)"}

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
        "defaultMode": "Browser companion",
        "summary": "Extension-assisted capture for Netflix browsing and playback pages.",
        "capabilities": ["Companion capture", "Manual fallback", "Activity merge"],
    },
    {
        "id": "prime-video",
        "name": "Prime Video",
        "shortName": "Prime",
        "accent": "#00a8e1",
        "defaultMode": "Browser companion",
        "summary": "Companion capture and imported sessions for Prime Video activity.",
        "capabilities": ["Companion capture", "Import bundle", "Queue sync"],
    },
    {
        "id": "disney-plus",
        "name": "Disney+",
        "shortName": "Disney+",
        "accent": "#113ccf",
        "defaultMode": "Browser companion",
        "summary": "Browser page detection and manual progress for Disney+ titles.",
        "capabilities": ["Companion capture", "Manual fallback", "Watchlist merge"],
    },
    {
        "id": "max",
        "name": "Max",
        "shortName": "Max",
        "accent": "#0057ff",
        "defaultMode": "Browser companion",
        "summary": "Companion capture for Max playback pages and queue updates.",
        "capabilities": ["Companion capture", "Continue watching", "Manual fallback"],
    },
    {
        "id": "apple-tv",
        "name": "Apple TV+",
        "shortName": "Apple TV+",
        "accent": "#333333",
        "defaultMode": "Import or manual",
        "summary": "Manual and import-based tracking for Apple TV+ titles.",
        "capabilities": ["Manual fallback", "Import bundle", "Drive sync"],
    },
    {
        "id": "plex",
        "name": "Plex / Jellyfin",
        "shortName": "Plex",
        "accent": "#d99000",
        "defaultMode": "Companion or webhook",
        "summary": "Local media playback can be ingested through the same event path.",
        "capabilities": ["Companion capture", "Webhook-ready", "Auto scrobble"],
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


def load_or_create_secret():
    env_secret = os.environ.get("LUMATRACK_SECRET_KEY")
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
oauth = OAuth(app)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def init_db():
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(
            """
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
        )


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_error):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def register_oauth_clients():
    for provider, definition in PROVIDER_CONFIG.items():
        client_id = os.environ.get(definition["client_id_env"])
        client_secret = os.environ.get(definition["client_secret_env"])
        if not client_id or not client_secret:
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
        client_id = os.environ.get(definition["client_id_env"])
        client_secret = os.environ.get(definition["client_secret_env"])
        configured = bool(client_id and client_secret)
        statuses.append(
            {
                "id": provider,
                "label": definition["label"],
                "configured": configured,
                "loginUrl": url_for("login_provider", provider=provider) if configured else None,
            }
        )
    return statuses


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
            "appName": "LumaTrack",
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
    state["meta"].setdefault("appName", "LumaTrack")
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
    state["meta"]["appName"] = "LumaTrack"
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
    cursor = get_db().execute(
        """
        INSERT INTO users (email, display_name, password_hash, avatar_url, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (normalize_email(email) or None, display_name, password_hash, avatar_url, now, now),
    )
    user_id = cursor.lastrowid
    get_db().commit()
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


def apply_observation_to_state(state, observation):
    title_name = (observation.get("title") or "").strip()
    if not title_name:
        raise ValueError("Observation must include a title.")

    platform_id = observation.get("platformId") or "netflix"
    kind = observation.get("kind") or "show"
    current_unit = observation.get("currentUnit") or ("S1 E1" if kind == "show" else "Movie")
    duration_min = int(observation.get("durationMin") or (44 if kind == "show" else 96))
    progress_delta = int(observation.get("progressDelta") or (16 if kind == "show" else 22))

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
            "genres": observation.get("genres") or [],
            "currentUnit": current_unit,
            "summary": observation.get("summary") or "Added from browser companion capture.",
            "lastActivityAt": utc_now(),
            "favorite": False,
            "source": observation.get("source") or "companion",
        }
        titles.insert(0, target)

    progress_before = max(0, min(100, int(target.get("progress") or 0)))
    progress_after = max(progress_before, min(100, progress_before + progress_delta))
    started_at = utc_now()
    target["progress"] = progress_after
    target["status"] = "completed" if progress_after >= 100 else "watching"
    target["lastActivityAt"] = started_at
    target["platformId"] = platform_id
    target["kind"] = kind
    target["currentUnit"] = observation.get("currentUnit") or target.get("currentUnit") or current_unit
    target["summary"] = observation.get("summary") or target.get("summary") or "Tracked in LumaTrack."
    if observation.get("year"):
        target["year"] = observation["year"]
    if observation.get("genres"):
        target["genres"] = observation["genres"]

    session_entry = {
        "id": create_id("session"),
        "titleId": target["id"],
        "platformId": platform_id,
        "startedAt": started_at,
        "durationMin": duration_min,
        "progressBefore": progress_before,
        "progressAfter": progress_after,
        "sourceType": "auto",
        "sourceLabel": observation.get("sourceLabel") or "Browser companion",
        "device": observation.get("device") or "Browser extension",
        "summary": observation.get("sessionSummary")
        or f"Browser companion captured {target['title']} from {platform_id}.",
    }
    sessions.insert(0, session_entry)
    state["sessions"] = sessions[:80]

    for connector in connectors:
        if connector.get("id") == platform_id:
            connector["status"] = "connected"
            connector["autoTrack"] = True
            connector["health"] = "live"
            connector["lastSeenAt"] = started_at
            break

    return {"title": target, "session": session_entry}


def fetch_tvmaze_results(query):
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
        results.append(
            {
                "id": f"tvmaze:{show.get('id')}",
                "kind": "show",
                "title": show.get("name"),
                "year": parse_year(show.get("premiered")),
                "summary": strip_html(show.get("summary")),
                "genres": show.get("genres") or [],
                "image": (show.get("image") or {}).get("medium") or (show.get("image") or {}).get("original"),
                "externalUrl": show.get("url"),
                "platformHint": (show.get("webChannel") or {}).get("name") or (show.get("network") or {}).get("name"),
                "currentUnit": "S1 E1",
                "source": "tvmaze",
            }
        )
    return results


def fetch_movie_results(query):
    response = requests.get(
        "https://www.wikidata.org/w/api.php",
        params={
            "action": "wbsearchentities",
            "search": query,
            "language": "en",
            "format": "json",
            "type": "item",
            "limit": 10,
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
        filtered = search_results[:6]
    ids = [item.get("id") for item in filtered[:6] if item.get("id")]
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
    for item in filtered[:6]:
        entity = details.get(item.get("id"), {})
        image_name = claim_string(entity, "P18")
        results.append(
            {
                "id": f"wikidata:{item.get('id')}",
                "kind": "movie",
                "title": item.get("label"),
                "year": parse_year(claim_time(entity, "P577")),
                "summary": item.get("description") or entity_description(entity) or "Film metadata from Wikidata.",
                "genres": [],
                "image": f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(image_name)}" if image_name else None,
                "externalUrl": item.get("concepturi"),
                "platformHint": None,
                "currentUnit": "Movie",
                "source": "wikidata",
            }
        )
    return results


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
    return request.headers.get("X-LumaTrack-Token", "").strip()


@app.after_request
def apply_headers(response):
    if request.path.startswith("/api/ingest/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-LumaTrack-Token"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return response


@app.route("/api/bootstrap")
def api_bootstrap():
    user = get_current_user()
    payload = {
        "auth": {
            "authenticated": bool(user),
            "user": serialize_user(user) if user else None,
            "providers": provider_status(),
        },
        "app": {
            "baseUrl": request.host_url.rstrip("/"),
            "schemaVersion": SCHEMA_VERSION,
            "companionReady": True,
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
    payload = request.get_json(silent=True) or {}
    email = normalize_email(payload.get("email"))
    password = payload.get("password") or ""
    display_name = (payload.get("displayName") or "").strip() or email.split("@")[0]

    if not email or "@" not in email:
        return jsonify({"error": "A valid email address is required."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400

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
        }
    )


@app.route("/api/auth/login", methods=["POST"])
def api_login():
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
        }
    )


@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/auth/login/<provider>")
def login_provider(provider):
    client = oauth.create_client(provider)
    if client is None:
        abort(404)

    redirect_uri = url_for("auth_callback", provider=provider, _external=True)
    return client.authorize_redirect(redirect_uri)


@app.route("/auth/callback/<provider>")
def auth_callback(provider):
    client = oauth.create_client(provider)
    if client is None:
        abort(404)

    token = client.authorize_access_token()
    if provider in {"google", "apple"}:
        userinfo = token.get("userinfo")
        if not userinfo:
            userinfo = client.parse_id_token(token)
    else:
        response = client.get("me?fields=id,name,email,picture.type(large)")
        response.raise_for_status()
        userinfo = response.json()

    user_id = resolve_oauth_user(provider, userinfo)
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
    except requests.RequestException as error:
        return jsonify({"error": f"Metadata search failed: {error}"}), 502

    return jsonify({"results": results[:12]})


@app.route("/api/tokens", methods=["GET"])
@login_required
def api_get_tokens():
    return jsonify({"tokens": get_api_tokens_for_user(g.current_user["id"])})


@app.route("/api/tokens", methods=["POST"])
@login_required
def api_create_token():
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

    raw_token = get_bearer_token()
    if not raw_token:
        return jsonify({"error": "Missing ingest token."}), 401

    owner = get_token_owner(raw_token)
    if not owner:
        return jsonify({"error": "Invalid ingest token."}), 401

    payload = request.get_json(silent=True) or {}
    state = load_state_for_user(owner["user_id"], owner["display_name"])
    try:
        result = apply_observation_to_state(state, payload)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    save_state_for_user(owner["user_id"], state)
    mark_token_used(owner["id"])
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
    host = os.environ.get("LUMATRACK_HOST", "127.0.0.1")
    port = int(os.environ.get("LUMATRACK_PORT", "5000"))
    app.run(host=host, port=port, debug=False)
