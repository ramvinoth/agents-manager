"""Tests for viewer.cloudauth: the credential each vendor expects, added last.
No network: token exchanges go through a fake `http` seam."""
import datetime
import json
import urllib.parse

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from viewer import cloudauth as C


@pytest.fixture(autouse=True)
def _fresh_cache():
    C._CACHE.clear()
    yield
    C._CACHE.clear()


def _rsa():
    k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                           serialization.NoEncryption()).decode()
    return priv, k.public_key()


class _HTTP:
    def __init__(self, status, body):
        self.status, self.body, self.calls = status, body, []

    def __call__(self, method, url, headers=None, data=None, timeout=60):
        self.calls.append((method, url, headers, data))
        return self.status, {}, json.dumps(self.body).encode()


def test_sigv4_matches_the_aws_documented_example():
    # docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html (IAM ListUsers example)
    h = C.sign_aws("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "GET",
                   "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
                   {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"}, None,
                   now=datetime.datetime(2015, 8, 30, 12, 36, tzinfo=datetime.timezone.utc))
    assert h["X-Amz-Date"] == "20150830T123600Z"
    assert h["Authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=content-type;host;x-amz-date, "
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7")
    assert "X-Amz-Content-Sha256" not in h


def test_sigv4_signs_s3_payload_and_json_target():
    h = C.sign_aws("A", "S", "GET", "https://s3.eu-west-1.amazonaws.com/", {}, None)
    assert h["X-Amz-Content-Sha256"] == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    assert "/eu-west-1/s3/" in h["Authorization"] and "x-amz-content-sha256" in h["Authorization"]
    h = C.sign_aws("A", "S", "POST", "https://logs.us-east-2.amazonaws.com/",
                   {"X-Amz-Target": "Logs_20140328.DescribeLogGroups"}, b"{}")
    assert "x-amz-target" in h["Authorization"]


def test_aws_scope_and_refusal():
    assert C.aws_scope("ec2.us-west-2.amazonaws.com") == ("ec2", "us-west-2")
    assert C.aws_scope("iam.amazonaws.com") == ("iam", "us-east-1")
    with pytest.raises(C.AuthError):
        C.aws_scope("evil.example.com")


def test_plain_styles():
    assert C.authorize({}, "T", {}, "GET", "u", {"A": "1"}, None, None) == {"A": "1", "Authorization": "Bearer T"}
    assert C.authorize({"header": "bot"}, "B", {}, "GET", "u", {}, None, None)["Authorization"] == "Bot B"
    assert C.authorize({"header": "basic"}, "s", {"username": "u"}, "GET", "u", {}, None, None)["Authorization"] == "Basic dTpz"


def test_pem_rebuilds_a_flattened_key_and_refuses_junk():
    priv, _ = _rsa()
    flat = priv.replace("\n", " ")
    assert C.pem(flat) == priv
    assert C.pem(priv.replace("\n", "\\n")) == priv
    with pytest.raises(C.AuthError):
        C.pem("not a key")


def test_github_app_trades_a_signed_jwt_and_caches_it():
    priv, pub = _rsa()
    http = _HTTP(201, {"token": "ghs_X", "expires_at": "2099-01-01T00:00:00Z"})
    p, f = {"header": "github_app"}, {"app_id": "42", "installation_id": "7"}
    for _ in range(2):
        assert C.authorize(p, priv, f, "GET", "u", {}, None, http)["Authorization"] == "Bearer ghs_X"
    assert len(http.calls) == 1                                   # second call came from the cache
    m, url, h, _ = http.calls[0]
    assert (m, url) == ("POST", "https://api.github.com/app/installations/7/access_tokens")
    claims = jwt.decode(h["Authorization"][7:], pub, algorithms=["RS256"])
    assert claims["iss"] == "42" and claims["exp"] - claims["iat"] <= 600   # GitHub's 10-minute cap


def test_google_service_account_exchange():
    priv, pub = _rsa()
    key = json.dumps({"type": "service_account", "private_key": priv, "client_email": "a@p.iam.gserviceaccount.com"})
    http = _HTTP(200, {"access_token": "ya29", "expires_in": 3599})
    assert C.authorize({"header": "google_sa"}, key, {}, "GET", "u", {}, None, http)["Authorization"] == "Bearer ya29"
    m, url, h, data = http.calls[0]
    form = dict(urllib.parse.parse_qsl(data.decode()))
    assert url == "https://oauth2.googleapis.com/token" and form["grant_type"].endswith("jwt-bearer")
    claims = jwt.decode(form["assertion"], pub, algorithms=["RS256"], audience="https://oauth2.googleapis.com/token")
    assert claims["iss"] == "a@p.iam.gserviceaccount.com" and claims["scope"].endswith("/cloud-platform")
    with pytest.raises(C.AuthError):
        C.service_account('{"type": "authorized_user"}')


def test_azure_client_credentials_and_a_refused_secret():
    http = _HTTP(200, {"access_token": "eyA", "expires_in": 3600})
    f = {"tenant": "t-1", "client_id": "c-1"}
    assert C.authorize({"header": "azure"}, "sec", f, "GET", "u", {}, None, http)["Authorization"] == "Bearer eyA"
    m, url, h, data = http.calls[0]
    form = dict(urllib.parse.parse_qsl(data.decode()))
    assert url == "https://login.microsoftonline.com/t-1/oauth2/v2.0/token"
    assert form == {"grant_type": "client_credentials", "client_id": "c-1", "client_secret": "sec",
                    "scope": "https://management.azure.com/.default"}
    bad = _HTTP(401, {"error": "invalid_client", "error_description": "AADSTS7000215: Invalid client secret"})
    with pytest.raises(C.AuthError) as e:
        C.authorize({"header": "azure"}, "wrong", f, "GET", "u", {}, None, bad)
    assert "Microsoft refused" in str(e.value) and "AADSTS7000215" in str(e.value) and e.value.status == 400


def test_forget_drops_only_an_exchanged_token():
    p = {"header": "azure"}
    k = C._key("azure", "s", {})
    C._CACHE[k] = ("t", 9e9)
    assert C.forget(p, "s", {}) is True and k not in C._CACHE
    assert C.forget({"header": "bearer"}, "s", {}) is False
