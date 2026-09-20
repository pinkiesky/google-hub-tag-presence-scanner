from collections.abc import Mapping

FHN_UUID = "0000feaa-0000-1000-8000-00805f9b34fb"


def parse_service_data(service_data: Mapping[str, bytes]) -> bytes | None:
    data = next((v for k, v in service_data.items() if k.lower() == FHN_UUID), b"")
    if not data or data[0] not in (0x40, 0x41):
        return None
    # Hashed flags may be omitted only in normal (0x40) mode.
    if len(data) in (22, 34):
        return data[1:-1]
    if data[0] == 0x40 and len(data) in (21, 33):
        return data[1:]
    return None
