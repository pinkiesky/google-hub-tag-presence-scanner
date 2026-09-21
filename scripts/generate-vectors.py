"""Run with the retained Python environment; uses only synthetic keys."""
import json
from pathlib import Path
from cat_tracker.fhn.eid import calculate_eid

vectors = []
for key in (bytes(range(32)), bytes([1]) * 32):
    for clock in (-2049, -1024, -1, 0, 1023, 1024, 2048, 0x12345400, 2**32 - 1, 2**32 + 1024):
        for size in (20, 32):
            pair_date = 1789900000
            vectors.append(dict(eik=key.hex(), pairDate=pair_date,
                                timestamp=pair_date + clock, size=size,
                                expectedEid=calculate_eid(key, clock, size).hex()))
Path('test/fixtures/python-eids.json').write_text(json.dumps(vectors, indent=2) + '\n')

# A real database dump made by the existing Store, including pending notifications.
from cat_tracker.storage.sqlite import Store
from cat_tracker.models import Tag
from cat_tracker.presence.manager import PresenceManager
from cat_tracker.config import Settings
store = Store(':memory:')
manager = PresenceManager(store, [Tag('a', 'Cat A', 10000, bytes(range(32))),
                                  Tag('b', 'Cat B', 10000, bytes([1]) * 32)],
                          Settings(startup_grace_seconds=0), 0, 0)
manager.observe('a', 100, -63)
manager.tick(3701, 3701)
manager.delivered(manager.claim(3701, 3701))
Path('test/fixtures/python-state.sql').write_text('\n'.join(store.db.iterdump()) + '\n')
store.close()
