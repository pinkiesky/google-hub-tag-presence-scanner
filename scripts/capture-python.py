"""Capture matched observations with the retained Python scanner (no EIK output).
Stop the normal service first. Usage: python capture-python.py OUTPUT [SECONDS]
"""
import asyncio
import json
import os
import sys
from pathlib import Path
from cat_tracker.config import load_config
from cat_tracker.ble_scanner import scan
from cat_tracker.fhn.matcher import Matcher

async def main():
    os.umask(0o077)
    config = load_config(Path(os.environ.get('TAG_CONFIG_PATH', '/etc/cat-tracker/config.toml')), debug_scan=True)
    observations = []
    class CapturingMatcher(Matcher):
        latest = None
        def match(self, eid):
            self.latest = eid.hex()
            return super().match(eid)
    matcher = CapturingMatcher(config.tags, config.service.drift_windows)
    def observe(tag, now, rssi):
        observations.append(dict(tag=tag, timestamp=now, rssi=rssi, eid=matcher.latest))
    task = asyncio.create_task(scan(matcher, config.service, observe))
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=float(sys.argv[2]) if len(sys.argv) > 2 else 30)
    except TimeoutError:
        pass
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    Path(sys.argv[1]).write_text(json.dumps(observations))
    print(f'Captured {len(observations)} observations; tags: {sorted({o["tag"] for o in observations})}')

asyncio.run(main())
