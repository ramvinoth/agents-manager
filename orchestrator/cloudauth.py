"""How a token connection proves who it is to its vendor.

integrations.py builds the request (where it goes, what it says); this module
adds the credential, last, right before the request leaves. Five styles:

- bearer / bot / basic — the pasted token, as is (Cloudflare, Discord, Mixpanel…)
- github_app — the pasted private key signs a JWT, traded for a one-hour
  installation token (GitHub Apps; no personal token can be scoped to repos
  as tightly)
- google_sa — the pasted service-account JSON key signs a JWT, traded for a
  one-hour access token (Google Cloud)
- azure — client credentials (tenant, client id, the pasted secret) traded for
  a one-hour token (Azure Resource Manager)
- aws — every request signed with Signature Version 4 from the access key id
  and the pasted secret key; no token exchange

Exchanged tokens are cached in memory only — never written to the database —
and renewed a minute before they lapse. A refused exchange is a 400 the owner
reads on the account: the pasted secret is wrong, not the network.
"""
import datetime
import hashlib
import hmac
import json
import re
import threading
import time
import urllib.parse

_CACHE = {}
_LOCK = threading.Lock()
_EARLY = 60    # renew this many seconds before a token lapses


class AuthError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def authorize(p, token, fields, method, url, headers, data, http):
    """`headers` plus the credential for one request. `p` is the provider
    entry, `token` the pasted secret, `fields` the owner's other inputs, and
    `http` the network seam (drives._http) used for token exchanges."""
    style = p.get("header", "bearer")
    h = dict(headers)
    if style == "aws":
        return sign_aws(fields.get("access_key_id", ""), token, method, url, h, data)
    if style == "basic":
        import base64
        h["Authorization"] = "Basic " + base64.b64encode(
            ("%s:%s" % (fields.get("username", ""), token)).encode()).decode()
    elif style == "bot":
        h["Authorization"] = "Bot " + token
    elif style in _EXCHANGES:
        h["Authorization"] = "Bearer " + _cached(style, token, fields, http)
    else:
        h["Authorization"] = "Bearer " + token
    return h


# --- exchanged tokens --------------------------------------------------------

def _key(style, secret, fields):
    return style, hashlib.sha256((secret + json.dumps(fields, sort_keys=True)).encode()).hexdigest()


def forget(p, secret, fields):
    """Drop this connection's cached exchanged token. True when it is an
    exchanged style (a fresh exchange is worth one retry), False otherwise."""
    style = p.get("header", "bearer")
    if style not in _EXCHANGES:
        return False
    with _LOCK:
        _CACHE.pop(_key(style, secret, fields), None)
    return True


def _cached(style, secret, fields, http):
    key = _key(style, secret, fields)
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and hit[1] - _EARLY > time.time():
            return hit[0]
    tok, ttl = _EXCHANGES[style](secret, fields, http)
    with _LOCK:
        _CACHE[key] = (tok, time.time() + ttl)
    return tok


def _post(http, url, headers, data, what):
    status, _, raw = http("POST", url, headers, data, timeout=20)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        body = {}
    if not 200 <= status < 300 or not isinstance(body, dict):
        msg = body.get("error_description") or body.get("message") or body.get("error") \
            if isinstance(body, dict) else ""
        raise AuthError("%s refused the credentials (HTTP %d)%s" % (what, status, ": %s" % msg if msg else ""))
    return body


def pem(text):
    """A private key as pasted, rebuilt to valid PEM: forms and phones often
    flatten the newlines (or turn them into literal \\n)."""
    text = (text or "").replace("\\n", "\n").strip()
    m = re.match(r"(-----BEGIN [A-Z ]+-----)(.*?)(-----END [A-Z ]+-----)", text, re.S)
    if not m:
        raise AuthError("That is not a private key — paste the whole .pem file, BEGIN and END lines included")
    body = re.sub(r"\s+", "", m.group(2))
    return "\n".join([m.group(1)] + [body[i:i + 64] for i in range(0, len(body), 64)] + [m.group(3)]) + "\n"


def _jwt(claims, key):
    import jwt
    try:
        return jwt.encode(claims, pem(key), algorithm="RS256")
    except AuthError:
        raise
    except Exception as e:
        raise AuthError("The private key could not sign: %s" % e)


def _github_app(key, fields, http):
    now = int(time.time())
    app_jwt = _jwt({"iat": now - 60, "exp": now + 540, "iss": str(fields.get("app_id", ""))}, key)
    body = _post(http, "https://api.github.com/app/installations/%s/access_tokens"
                 % urllib.parse.quote(str(fields.get("installation_id", "")), safe=""),
                 {"Authorization": "Bearer " + app_jwt, "Accept": "application/vnd.github+json",
                  "User-Agent": "Harman"}, b"", "GitHub")
    exp = body.get("expires_at") or ""
    try:
        ttl = datetime.datetime.strptime(exp, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc).timestamp() - time.time()
    except ValueError:
        ttl = 3000
    return body["token"], ttl


def service_account(text):
    """The parsed Google service-account key, or a 400 saying what to paste."""
    try:
        k = json.loads(text or "")
    except ValueError:
        k = None
    if not isinstance(k, dict) or k.get("type") != "service_account" or not k.get("private_key") \
            or not k.get("client_email"):
        raise AuthError("Paste the whole service-account key file (JSON, with \"type\": \"service_account\")")
    return k


def _google_sa(text, fields, http):
    k = service_account(text)
    now = int(time.time())
    assertion = _jwt({"iss": k["client_email"], "scope": "https://www.googleapis.com/auth/cloud-platform",
                      "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 3600},
                     k["private_key"])
    body = _post(http, "https://oauth2.googleapis.com/token",
                 {"Content-Type": "application/x-www-form-urlencoded"},
                 urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                         "assertion": assertion}).encode(), "Google")
    return body["access_token"], int(body.get("expires_in") or 3600)


def _azure(secret, fields, http):
    body = _post(http, "https://login.microsoftonline.com/%s/oauth2/v2.0/token"
                 % urllib.parse.quote(str(fields.get("tenant", "")), safe=""),
                 {"Content-Type": "application/x-www-form-urlencoded"},
                 urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": fields.get("client_id", ""),
                                         "client_secret": secret,
                                         "scope": "https://management.azure.com/.default"}).encode(), "Microsoft")
    return body["access_token"], int(body.get("expires_in") or 3600)


_EXCHANGES = {"github_app": _github_app, "google_sa": _google_sa, "azure": _azure}


# --- AWS Signature Version 4 -------------------------------------------------

def _q(s, safe="-_.~"):
    return urllib.parse.quote(s, safe=safe)


def aws_scope(host):
    """(service, region) from an AWS endpoint host: ec2.us-west-2.amazonaws.com
    → (ec2, us-west-2); a global one (iam.amazonaws.com) signs as us-east-1."""
    parts = host.split(":")[0].split(".")
    if parts[-2:] != ["amazonaws", "com"] or len(parts) < 3:
        raise AuthError("Not an AWS endpoint: %s" % host)
    return parts[0], (parts[1] if len(parts) > 3 else "us-east-1")


def sign_aws(key_id, secret, method, url, headers, data, now=None):
    """`headers` plus SigV4's Authorization and X-Amz-Date for this exact
    request (and X-Amz-Content-Sha256, which only S3 requires)."""
    u = urllib.parse.urlsplit(url)
    service, region = aws_scope(u.netloc)
    t = now or datetime.datetime.now(datetime.timezone.utc)
    amz, day = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y%m%d")
    payload = hashlib.sha256(data or b"").hexdigest()
    h = dict(headers, **{"X-Amz-Date": amz})
    if service == "s3":
        h["X-Amz-Content-Sha256"] = payload
    signed = {"host": u.netloc}
    signed.update({k.lower(): " ".join(str(v).split()) for k, v in h.items()
                   if k.lower() in ("content-type", "x-amz-date", "x-amz-content-sha256", "x-amz-target")})
    names = ";".join(sorted(signed))
    path = u.path or "/"
    path = _q(path, safe="/-_.~") if service == "s3" else _q(_q(path, safe="/-_.~"), safe="/-_.~")
    query = "&".join("%s=%s" % (_q(k), _q(v)) for k, v in
                     sorted(urllib.parse.parse_qsl(u.query, keep_blank_values=True)))
    canonical = "\n".join([method, path, query, "".join("%s:%s\n" % (k, signed[k]) for k in sorted(signed)),
                           names, payload])
    scope = "%s/%s/%s/aws4_request" % (day, region, service)
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = ("AWS4" + secret).encode()
    for part in (day, region, service, "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    h["Authorization"] = "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (
        key_id, scope, names, sig)
    return h
