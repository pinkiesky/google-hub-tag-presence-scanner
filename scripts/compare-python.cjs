// Run on the Pi: node scripts/compare-python.cjs /opt/cat-tracker/.venv/bin/python
// Both implementations read keys locally; only aggregate comparisons are printed.
const { spawnSync } = require('node:child_process');
const { EidService } = require('../dist/fhn/eid.service');
const { loadConfiguration } = require('../dist/config/configuration');
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
const path = process.env.TAG_CONFIG_PATH || '/etc/cat-tracker/config.toml';
const python = process.argv[2] || '.venv/bin/python';
const now = Math.floor(Date.now() / 1000);
try {
  const config = loadConfiguration(process.env, ['--debug-scan', '--config', path]);
  const script = `
import json,sys
from pathlib import Path
from cat_tracker.config import load_config
from cat_tracker.fhn.eid import calculate_eid
config=load_config(Path(sys.argv[1]),debug_scan=True)
now=int(sys.argv[2])
print(json.dumps([{'id':t.id,'clock':int(now-t.pair_date+t.clock_offset_seconds)+offset,'size':size,'eid':calculate_eid(t.eik,int(now-t.pair_date+t.clock_offset_seconds)+offset,size).hex()} for t in config.tags for offset in (-16384,0,16384) for size in (20,32)]))
`;
  const result = spawnSync(python, ['-c', script, path, String(now)], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error();
  const vectors = JSON.parse(result.stdout);
  for (const vector of vectors) {
    const tag = config.tags.find(t => t.id === vector.id);
    if (!tag || new EidService().calculate(tag.eik, vector.clock, vector.size).toString('hex') !== vector.eid) throw new Error();
  }
  console.log(`PASS: ${vectors.length} Python/Node EID comparisons across ${config.tags.length} configured tags; keys remain private.`);
} catch { console.error('Parity check failed; verify Python environment and configuration. No secret details logged.'); process.exitCode = 1; }
