#pragma once

constexpr char WIFI_SSID[] = "your-network-name";
constexpr char WIFI_PASSWORD[] = "your-password";

// Mock UDP receiver; replace with the real receiver address and port.
constexpr char UDP_SERVER_IP[] = "192.0.2.1";
constexpr uint16_t UDP_SERVER_PORT = 9000;

// Set a unique ID for each satellite (0-65535).
constexpr uint16_t SATELLITE_ID = 60001;
