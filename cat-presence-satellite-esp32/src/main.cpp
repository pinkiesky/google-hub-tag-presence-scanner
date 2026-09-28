#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <freertos/queue.h>
#include <esp_random.h>

#include <cstring>

#include "wifi_secrets.h"

#ifndef SATELLITE_NAME
#error "Define SATELLITE_NAME in wifi_secrets.h"
#endif

namespace {
constexpr size_t SATELLITE_NAME_LENGTH = sizeof(SATELLITE_NAME) - 1;
static_assert(SATELLITE_NAME_LENGTH > 0 && SATELLITE_NAME_LENGTH <= 16,
              "SATELLITE_NAME must contain 1 to 16 bytes");
constexpr uint8_t LED_PIN = 8;
constexpr uint8_t LED_ON = LOW;  // The onboard LED is active-low.
constexpr uint8_t LED_OFF = HIGH;
constexpr uint32_t LED_BLINK_MS = 60;
bool udpBlinkActive = false;
uint32_t udpBlinkStarted = 0;
BLEUUID targetService(static_cast<uint16_t>(0xFEAA));
BLEScan* scanner = nullptr;
WiFiUDP udp;
IPAddress udpServerIp;
QueueHandle_t reportQueue = nullptr;
bool scanning = false;
bool udpConfigured = false;
uint64_t bootId = 0;
uint64_t nextSequence = 0;

struct ServiceReport {
    uint8_t address[6];
    int8_t rssi;
    uint8_t dataLength;
    uint8_t data[255];
};

bool hasTargetService(BLEAdvertisedDevice& device) {
    if (device.isAdvertisingService(targetService)) {
        return true;
    }

    // Some advertisements carry the UUID only in their service-data field.
    for (int i = 0; i < device.getServiceDataUUIDCount(); ++i) {
        if (device.getServiceDataUUID(i).equals(targetService)) {
            return true;
        }
    }
    return false;
}

class FeaaCallbacks : public BLEAdvertisedDeviceCallbacks {
    void onResult(BLEAdvertisedDevice device) override {
        if (!hasTargetService(device)) {
            return;
        }

        Serial.printf("FEAA detected: %s, RSSI %d dBm\n",
                      device.getAddress().toString().c_str(), device.getRSSI());

        // Copy the binary service data while the scan result is valid.
        const int count = device.getServiceDataCount();
        for (int i = 0; i < count && i < device.getServiceDataUUIDCount(); ++i) {
            if (!device.getServiceDataUUID(i).equals(targetService)) {
                continue;
            }

            const std::string data = device.getServiceData(i);
            ServiceReport report{};
            if (data.size() > sizeof(report.data)) {
                continue;
            }

            BLEAddress address = device.getAddress();
            std::memcpy(report.address, *address.getNative(), sizeof(report.address));
            report.rssi = static_cast<int8_t>(device.getRSSI());
            report.dataLength = static_cast<uint8_t>(data.size());
            std::memcpy(report.data, data.data(), data.size());
            xQueueSend(reportQueue, &report, 0);
        }
    }
};

void writeBigEndian64(uint8_t* destination, uint64_t value) {
    for (int i = 7; i >= 0; --i) {
        destination[i] = static_cast<uint8_t>(value);
        value >>= 8;
    }
}

void sendQueuedReports() {
    if (WiFi.status() != WL_CONNECTED || !udpConfigured) {
        return;
    }

    ServiceReport report;
    while (xQueueReceive(reportQueue, &report, 0) == pdTRUE) {
        // Version 7: magic (1), version (1), zero-padded satellite name (16),
        // boot ID (8), sequence (8), UUID (2), address (6), RSSI (1),
        // data length (1), then service data.
        // RSSI is signed int8 in dBm, encoded as two's complement.
        // Multi-byte integers are big endian. Sequence starts at zero.
        uint8_t header[44] = {};
        header[0] = 0xCA;
        header[1] = 7;
        std::memcpy(header + 2, SATELLITE_NAME, SATELLITE_NAME_LENGTH);
        writeBigEndian64(header + 18, bootId);
        writeBigEndian64(header + 26, nextSequence++);
        header[34] = 0xFE;
        header[35] = 0xAA;
        std::memcpy(header + 36, report.address, sizeof(report.address));
        header[42] = static_cast<uint8_t>(report.rssi);
        header[43] = report.dataLength;

        if (udp.beginPacket(udpServerIp, UDP_SERVER_PORT)) {
            udp.write(header, sizeof(header));
            udp.write(report.data, report.dataLength);
            if (udp.endPacket() == 1 && !udpBlinkActive) {
                udpBlinkStarted = millis();
                udpBlinkActive = true;
            }
        }
    }
}

const char* wifiStatusName(wl_status_t status) {
    switch (status) {
        case WL_IDLE_STATUS: return "idle";
        case WL_NO_SSID_AVAIL: return "SSID not found";
        case WL_SCAN_COMPLETED: return "scan completed";
        case WL_CONNECTED: return "connected";
        case WL_CONNECT_FAILED: return "connection failed";
        case WL_CONNECTION_LOST: return "connection lost";
        case WL_DISCONNECTED: return "disconnected";
        default: return "unknown";
    }
}

FeaaCallbacks callbacks;
}  // namespace

void setup() {
    digitalWrite(LED_PIN, LED_OFF);
    pinMode(LED_PIN, OUTPUT);

    Serial.begin(115200);
    delay(1000);

    reportQueue = xQueueCreate(16, sizeof(ServiceReport));
    if (reportQueue == nullptr) {
        Serial.println("Could not allocate BLE report queue");
        return;
    }
    udpConfigured = udpServerIp.fromString(UDP_SERVER_IP) && UDP_SERVER_PORT != 0;
    if (!udpConfigured) {
        Serial.println("Set UDP_SERVER_IP and UDP_SERVER_PORT in wifi_secrets.h");
    }

    WiFi.mode(WIFI_STA);
    WiFi.setTxPower(WIFI_POWER_11dBm);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    BLEDevice::init("");
    // Wi-Fi and BLE are enabled, so esp_random uses hardware entropy.
    bootId = (static_cast<uint64_t>(esp_random()) << 32) | esp_random();
    scanner = BLEDevice::getScan();
    scanner->setActiveScan(false);
    scanner->setAdvertisedDeviceCallbacks(&callbacks, true);

    Serial.println("Continuously scanning for BLE advertisements with service UUID FEAA...");
}

void loop() {
    if (reportQueue == nullptr) {
        delay(1000);
        return;
    }

    if (!scanning) {
        scanning = scanner->start(0, nullptr);  // Zero seconds means scan indefinitely.
        if (!scanning) {
            Serial.println("Could not start BLE scan; retrying...");
        }
    }

    sendQueuedReports();

    const uint32_t blinkElapsed = millis() - udpBlinkStarted;
    // Allow an equally long on phase so continuous traffic still visibly blinks.
    if (udpBlinkActive && blinkElapsed >= 2 * LED_BLINK_MS) {
        udpBlinkActive = false;
    }
    const bool blinkOff = udpBlinkActive && blinkElapsed < LED_BLINK_MS;
    const bool ledEnabled = scanning && WiFi.status() == WL_CONNECTED && !blinkOff;
    digitalWrite(LED_PIN, ledEnabled ? LED_ON : LED_OFF);

    static int lastWifiStatus = -1;
    const wl_status_t status = WiFi.status();
    if (static_cast<int>(status) != lastWifiStatus) {
        Serial.printf("Wi-Fi: %s\n", wifiStatusName(status));
        lastWifiStatus = static_cast<int>(status);
    }

    // Drain queued reports promptly while BLE and Wi-Fi callbacks run.
    delay(5);
}
