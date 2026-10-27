"""This edition offers no third-party accounts: nothing is listed, connectable or
reachable by an agent, while the local-disk rules still apply."""
import pytest

from viewer import integrations


@pytest.fixture(autouse=True)
def edition_catalog(monkeypatch):
    monkeypatch.setattr(integrations, "OFFERED", frozenset())


def test_owner_page_lists_no_provider():
    assert integrations.view([], {}, "")["providers"] == []


def test_agent_sees_no_account_and_nothing_to_connect():
    conn = {"id": "c1", "kind": "google", "config": {}, "status": "active"}
    av = integrations.agent_view([conn], integrations.LOCAL_DEFAULT)
    assert av["services"] == [] and av["not_connected"] == []
    assert av["this_machine"]["folders"] == ["~"]


@pytest.mark.parametrize("call", [lambda: integrations.provider("google"),
                                  lambda: integrations.service("google.drive")])
def test_unoffered_provider_is_unknown(call):
    with pytest.raises(integrations.IntegrationError) as e:
        call()
    assert e.value.status == 404
