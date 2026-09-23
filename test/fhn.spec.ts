import { EidService } from '../src/fhn/eid.service';
import { FHN_UUID, FhnParserService } from '../src/fhn/fhn-parser.service';
import { TagMatcherService } from '../src/fhn/tag-matcher.service';
import vectors from './fixtures/eid-vectors.json';
import { config, tags } from './helpers';

const eid = new EidService();
test.each(vectors)('Known EID vector size=$size timestamp=$timestamp key=$eik', (v) => {
  expect(
    eid.calculate(Buffer.from(v.eik, 'hex'), v.timestamp - v.pairDate, v.size).toString('hex'),
  ).toBe(v.expectedEid);
});
test('rejects invalid key and EID size', () => {
  expect(() => eid.calculate(Buffer.alloc(2), 0)).toThrow();
  expect(() => eid.calculate(Buffer.alloc(32), 0, 16)).toThrow();
});
test.each([20, 32])('parser preserves frame rules for size %i', (size) => {
  const parser = new FhnParserService(),
    bytes = Buffer.alloc(size, 7);

  for (const uuid of [FHN_UUID, FHN_UUID.toUpperCase(), 'feaa', 'FEAA']) {
    for (const frame of [0x40, 0x41]) {
      expect(
        parser.parse([
          { uuid, data: Buffer.concat([Buffer.from([frame]), bytes, Buffer.from([18])]) },
        ]),
      ).toEqual(bytes);
    }

    expect(parser.parse([{ uuid, data: Buffer.concat([Buffer.from([0x40]), bytes]) }])).toEqual(
      bytes,
    );
    expect(parser.parse([{ uuid, data: Buffer.concat([Buffer.from([0x41]), bytes]) }])).toBeNull();
  }

  for (const data of [
    Buffer.alloc(0),
    Buffer.concat([Buffer.from([0]), bytes]),
    Buffer.concat([Buffer.from([0x40]), bytes.subarray(1)]),
    Buffer.concat([Buffer.from([0x40]), bytes, Buffer.alloc(3)]),
  ]) {
    expect(parser.parse([{ uuid: FHN_UUID, data }])).toBeNull();
  }

  expect(
    parser.parse([{ uuid: 'other', data: Buffer.concat([Buffer.from([0x40]), bytes]) }]),
  ).toBeNull();
});
test('matches both cats, drift edges, unknowns and refreshes only at rotation', () => {
  const matcher = new TagMatcherService(config(), eid, { observe: jest.fn() }),
    now = 10000 + 32 * 1024;

  for (const tag of tags) {
    for (const delta of [-16, 0, 16]) {
      for (const size of [20, 32]) {
        expect(matcher.match(eid.calculate(tag.eik, (32 + delta) * 1024, size), now)).toBe(tag.id);
      }
    }
  }

  expect(matcher.match(eid.calculate(tags[0].eik, 49 * 1024), now)).toBeNull();
  expect(matcher.match(Buffer.alloc(20, 23), now)).toBeNull();
  const spy = jest.spyOn(eid, 'calculate');
  matcher.match(Buffer.alloc(20, 23), now + 50);
  expect(spy).not.toHaveBeenCalled();
  matcher.match(Buffer.alloc(20, 23), now + 1024);
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
  expect(matcher.match(eid.calculate(tags[0].eik, 49 * 1024), now + 1024)).toBe('a');
});
test('negative clock truncation, offset, wraparound and last tag wins for duplicate EIDs', () => {
  const tag = { ...tags[0], clockOffsetSeconds: -1024 };
  const matcher = new TagMatcherService(config({ driftWindows: 1 }, { tags: [tag] }), eid, {
    observe: jest.fn(),
  });
  expect(matcher.match(eid.calculate(tag.eik, -1024), tag.pairDate - 0.5)).toBe('a');
  expect(eid.calculate(tag.eik, -1024)).toEqual(eid.calculate(tag.eik, 2 ** 32 - 1024));
  const duplicate = new TagMatcherService(
    config({}, { tags: [tag, { ...tag, id: 'duplicate' }] }),
    eid,
    { observe: jest.fn() },
  );
  expect(duplicate.match(eid.calculate(tag.eik, -1024), tag.pairDate)).toBe('duplicate');
});
