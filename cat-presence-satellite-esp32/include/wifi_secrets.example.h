#pragma once

constexpr char WIFI_SSID[] = "your-network-name";
constexpr char WIFI_PASSWORD[] = "your-password";

// Mock UDP receiver; replace with the real receiver address and port.
constexpr char UDP_SERVER_IP[] = "192.0.2.1";
constexpr uint16_t UDP_SERVER_PORT = 9000;

// Set a unique name for each satellite (1-16 UTF-8 bytes).
// Shorter names are zero-padded in UDP packets.
#define SATELLITE_NAME "living-room"
