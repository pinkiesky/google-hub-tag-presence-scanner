import { createSocket, type Socket } from 'node:dgram';

import { Logger } from '@nestjs/common';

import { LifecycleService } from '../src/lifecycle.service';
import { UdpService } from '../src/udp/udp.service';
import { config } from './helpers';

test('UDP listener logs parsed frame fields and bounded service data, then closes', async () => {
  const messages: string[] = [];
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
    messages.push(String(message));
  });
  const service = new UdpService(config({ udpPort: 0 }), new LifecycleService());
  const client = createSocket('udp4');

  try {
    await service.onApplicationBootstrap();
    const listener = Reflect.get(service, 'socket') as Socket;
    const port = listener.address().port;
    const payload = Buffer.alloc(29 + 65, 0xab);
    payload[0] = 0xca;
    payload[1] = 5;
    payload.writeUInt16BE(0x1234, 2);
    payload.writeBigUInt64BE(0x0123456789abcdefn, 4);
    payload.writeBigUInt64BE(0n, 12);
    payload.writeUInt16BE(0xfeaa, 20);
    Buffer.from([1, 2, 3, 4, 5, 6]).copy(payload, 22);
    payload[28] = 65;
    const received = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('UDP packet not received')), 1000);
      const original = log.getMockImplementation();
      log.mockImplementation((message: unknown) => {
        original?.(message);

        if (String(message).startsWith('CatTag UDP from ')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      client.send(payload, port, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
    });
    await received;
    expect(messages.at(-1)).toMatch(/^CatTag UDP from 127\.0\.0\.1:\d+:/);
    expect(messages.at(-1)).toContain(
      'satelliteId=4660 bootId=0x0123456789abcdef sequence=0 uuid=feaa address=010203040506 dataLength=65',
    );
    expect(messages.at(-1)).toContain(`serviceData=${'ab'.repeat(64)}…`);
  } finally {
    client.close();
    await service.beforeApplicationShutdown();
    log.mockRestore();
  }
});

test('UDP listener rejects a port that is already in use', async () => {
  const occupied = createSocket('udp4');
  await new Promise<void>((resolve) => occupied.bind(0, '127.0.0.1', resolve));
  const service = new UdpService(
    config({ udpPort: occupied.address().port }),
    new LifecycleService(),
  );

  try {
    await expect(service.onApplicationBootstrap()).rejects.toThrow('UDP listener failed to bind');
  } finally {
    occupied.close();
    await service.beforeApplicationShutdown();
  }
});
