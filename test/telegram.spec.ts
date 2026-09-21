import { TelegramService, DeliveryError } from '../src/notifications/telegram.service';
import { PresenceWatchdogService } from '../src/presence/presence-watchdog.service';
import { LifecycleService } from '../src/lifecycle.service';
import { config, manager } from './helpers';
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
test.each([
  [200, { ok: true }, true], [200, { ok: false }, false], [401, { ok: false }, false],
  [429, { ok: false, parameters: { retry_after: 90 } }, false], [500, { ok: false }, false],
] as const)('HTTP %i delivery controls alert confirmation', async (status, body, success) => {
  jest.useFakeTimers({ now: 0 });
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const telegram = new TelegramService(config()), m = manager();
  try {
    m.tick(3601, 3601); const item = m.claim(3601, 3601)!;
    try { await telegram.send(item.message); m.delivered(item); }
    catch (error) {
      expect(error).toBeInstanceOf(DeliveryError); expect(String(error)).not.toContain('test-secret-token');
      m.failed(item, 3601, (error as DeliveryError).retryAfter);
    }
    expect(m.states.get('a')!.alert_sent).toBe(success);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
  } finally { m.store.onApplicationShutdown(); }
});
test.each(['network', 'json', 'timeout'])('sanitizes %s errors', async kind => {
  const mock = jest.spyOn(global, 'fetch');
  if (kind === 'json') mock.mockResolvedValue(new Response('bad gateway', { status: 502 }));
  else mock.mockRejectedValue(new Error('https://api.telegram.org/bottest-secret-token/sendMessage'));
  await expect(new TelegramService(config()).send('test')).rejects.toThrow('Telegram delivery failed');
});
test('worker delivers recovery once and keeps failures queued', async () => {
  jest.useFakeTimers({ now: 0 });
  const m = manager(), telegram = new TelegramService(config());
  const send = jest.spyOn(telegram, 'send').mockRejectedValueOnce(new DeliveryError(90)).mockResolvedValue();
  const worker = new PresenceWatchdogService(m, telegram, new LifecycleService());
  try {
    m.observe('b', 3601, -70); m.tick(3601, 3601); jest.setSystemTime(3601000);
    await worker.deliver(); expect(m.states.get('a')!.alert_sent).toBe(false);
    jest.setSystemTime(3691000); await worker.deliver(); expect(m.states.get('a')!.alert_sent).toBe(true);
    m.observe('a', 3700, -50); await worker.deliver(); await worker.deliver();
    expect(send).toHaveBeenCalledTimes(3); expect(send.mock.calls[2][0]).toContain('detected again');
  } finally { m.store.onApplicationShutdown(); }
});
