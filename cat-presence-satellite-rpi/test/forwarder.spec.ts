import { Forwarder } from '../src/forwarder';
import { Observation } from '../src/protocol';

const observation: Observation = {
  satelliteId: 'pi-1',
  serviceUuid: 'feaa',
  serviceDataHex: '400001feff',
  rssi: -63,
};
let forwarder: Forwarder;
let send: jest.MockedFunction<typeof fetch>;
const ok = () => new Response(null, { status: 204 });
beforeEach(() => {
  jest.useFakeTimers();
  send = jest.fn().mockResolvedValue(ok()) as jest.MockedFunction<typeof fetch>;
  forwarder = new Forwarder('http://mother:15432', send);
  forwarder.start();
});
afterEach(async () => {
  await forwarder.stop();
  jest.useRealTimers();
});

test('forwards exact JSON to the versioned endpoint', async () => {
  forwarder.enqueue(observation);
  await jest.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  const [url, options] = send.mock.calls[0];
  expect(String(url)).toBe('http://mother:15432/api/v1/observations');
  expect(options).toMatchObject({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'error',
  });
  expect(JSON.parse(options!.body as string)).toEqual(observation);
});

test('one request in flight and at most 100 queued; overflow drops oldest', async () => {
  let finish!: (response: Response) => void;
  send.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  forwarder.enqueue(observation);

  for (let i = 0; i < 105; i++) {
    forwarder.enqueue({ ...observation, rssi: i });
  }

  expect(send).toHaveBeenCalledTimes(1);
  finish(ok());
  await jest.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(101);
  expect(JSON.parse(send.mock.calls[1][1]!.body as string).rssi).toBe(5);
});

test.each([500, 400])(
  'HTTP %s pauses sending, expires old data and never replays failures',
  async (status) => {
    send.mockResolvedValueOnce(new Response(null, { status }));
    forwarder.enqueue(observation);
    await jest.advanceTimersByTimeAsync(0);
    forwarder.enqueue({ ...observation, rssi: -70 });
    await jest.advanceTimersByTimeAsync(4900);
    expect(send).toHaveBeenCalledTimes(1);
    forwarder.enqueue({ ...observation, rssi: -80 });
    await jest.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1][1]!.body as string).rssi).toBe(-80);
  },
);

function hangUntilAborted(
  _url: Parameters<typeof fetch>[0],
  options?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('hung requests time out after two seconds and resume after cooldown', async () => {
  send.mockImplementationOnce(hangUntilAborted);
  forwarder.enqueue(observation);
  const signal = send.mock.calls[0][1]!.signal!;
  await jest.advanceTimersByTimeAsync(1999);
  expect(signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(5000);
  forwarder.enqueue(observation);
  await jest.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(2);
});

test('shutdown aborts transport and drops queued work', async () => {
  send.mockImplementationOnce(hangUntilAborted);
  forwarder.enqueue(observation);
  forwarder.enqueue(observation);
  await forwarder.stop();
  expect(send.mock.calls[0][1]!.signal!.aborted).toBe(true);
  forwarder.enqueue(observation);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(send).toHaveBeenCalledTimes(1);
});
