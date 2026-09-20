import asyncio
import logging
import time

import httpx

from ..presence.manager import PresenceManager

log = logging.getLogger(__name__)


class DeliveryError(Exception):
    def __init__(self, retry_after: float = 0):
        super().__init__("Telegram delivery failed")
        self.retry_after = retry_after


class Telegram:
    def __init__(self, client: httpx.AsyncClient, token: str, chat_id: str):
        self.client, self._token, self._chat_id = client, token, chat_id

    async def send(self, message: str) -> None:
        try:
            async with asyncio.timeout(20):
                response = await self.client.post(
                    f"https://api.telegram.org/bot{self._token}/sendMessage",
                    json={"chat_id": self._chat_id, "text": message},
                )
            data = response.json()
            if response.is_success and data.get("ok") is True:
                return
            retry = data.get("parameters", {}).get("retry_after", 0)
            retry = float(retry) if isinstance(retry, (int, float)) and 0 < retry < 86400 else 0
            raise DeliveryError(retry)
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError, AttributeError):
            # HTTP exceptions contain the token in their request URL; never log them.
            raise DeliveryError() from None


async def deliver_notifications(manager: PresenceManager, telegram: Telegram) -> None:
    while True:
        item = manager.claim(time.time(), time.monotonic())
        if item is None:
            await asyncio.sleep(1)
            continue
        try:
            await telegram.send(item.message)
        except DeliveryError as error:
            log.warning("Telegram error for tag %s; retry scheduled", item.tag_id)
            manager.failed(item, time.time(), error.retry_after)
        else:
            manager.delivered(item)
