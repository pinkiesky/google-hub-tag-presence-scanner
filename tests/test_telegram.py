import httpx
import pytest
from test_presence import manager

from cat_tracker.notifications.telegram import DeliveryError, Telegram


@pytest.mark.parametrize(
    "status,data,success",
    [
        (200, {"ok": True, "result": {"message_id": 1}}, True),
        (200, {"ok": False}, False),
        (401, {"ok": False}, False),
        (429, {"ok": False, "parameters": {"retry_after": 90}}, False),
        (500, {"ok": False}, False),
    ],
)
async def test_confirmed_delivery_controls_state(status, data, success):
    def handle(request):
        assert request.method == "POST"
        return httpx.Response(status, json=data)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        telegram = Telegram(client, "secret-token", "123")
        m = manager(grace=0)
        m.tick(3601, 3601)
        item = m.claim(3601, 3601)
        try:
            await telegram.send(item.message)
        except DeliveryError as error:
            assert "secret-token" not in str(error)
            m.failed(item, 3601, error.retry_after)
        else:
            m.delivered(item)
        assert bool(m.states["a"].alert_sent) is success
        m.store.close()


async def test_network_failure_is_sanitized():
    def handle(request):
        raise httpx.ConnectError(str(request.url), request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(DeliveryError) as error:
            await Telegram(client, "secret-token", "123").send("test")
        assert "secret-token" not in str(error.value)


async def test_invalid_response():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(502, text="bad gateway"))
    ) as client:
        with pytest.raises(DeliveryError):
            await Telegram(client, "secret-token", "123").send("test")
