import json

import pytest

from cat_tracker.config import load_config


def test_bad_tag_isolated_and_secrets_not_logged(tmp_path, caplog):
    (tmp_path / "good.json").write_text(
        json.dumps({"name": "Cat", "pair_date": 1000, "eik_hex": "ab" * 32})
    )
    (tmp_path / "bad.json").write_text('{"eik_hex":"SECRET"}')
    config = tmp_path / "config.toml"
    config.write_text(
        '[[tags]]\nid="good"\nsecret_file="good.json"\n[[tags]]\nid="bad"\nsecret_file="bad.json"\n'
    )
    result = load_config(config, debug_scan=True)
    assert len(result.tags) == 1
    assert "SECRET" not in caplog.text
    assert "ab" * 32 not in repr(result)
    with pytest.raises(ValueError):
        load_config(config)


def test_invalid_settings(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text("[service]\nwatchdog_interval_seconds=0\n")
    with pytest.raises(ValueError):
        load_config(path, debug_scan=True)
