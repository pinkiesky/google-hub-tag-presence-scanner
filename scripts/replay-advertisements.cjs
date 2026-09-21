// Compare real Python-captured advertisements using Node's parser and matcher.
const fs = require('node:fs');
const { Logger } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { TrackerConfig } = require('../dist/config/config.service');
const { loadConfiguration } = require('../dist/config/configuration');
const { EidService } = require('../dist/fhn/eid.service');
const { FhnParserService } = require('../dist/fhn/fhn-parser.service');
const { TagMatcherService } = require('../dist/fhn/tag-matcher.service');
Logger.overrideLogger(false);
try {
  const config = new TrackerConfig(
    new ConfigService({ tracker: loadConfiguration(process.env, ['--debug-scan']) }),
  );
  const matcher = new TagMatcherService(config, new EidService());
  const parser = new FhnParserService();
  const observations = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const matched = new Set();
  if (!observations.length) throw new Error();
  for (const item of observations) {
    matcher.refresh(item.timestamp);
    const eid = parser.parse([
      { uuid: 'feaa', data: Buffer.concat([Buffer.from([0x40]), Buffer.from(item.eid, 'hex')]) },
    ]);
    if (matcher.match(eid) !== item.tag) throw new Error();
    matched.add(item.tag);
  }
  console.log(
    `PASS: ${observations.length} captured Python observations match Node; tag IDs: ${[...matched].sort().join(', ')}`,
  );
} catch {
  console.error('Captured advertisement parity check failed (no secret details logged).');
  process.exitCode = 1;
}
