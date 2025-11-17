#include "esp_event.h"
#include "esp_log.h"
#include "esp_psram.h"

#include "asic_result_task.h"
#include "asic_task.h"
#include "create_jobs_task.h"
#include "hashrate_monitor_task.h"
#include "statistics_task.h"
#include "system.h"
#include "http_server.h"
#include "serial.h"
#include "stratum_task.h"
#include "i2c_bitaxe.h"
#include "adc.h"
#include "nvs_config.h"
#include "self_test.h"
#include "asic.h"
#include "bap/bap.h"
#include "device_config.h"
#include "connect.h"
#include "asic_reset.h"
#include "asic_init.h"

static GlobalState GLOBAL_STATE;

static const char * TAG = "bitaxe";

void app_main(void)
{
    ESP_LOGI(TAG, "Welcome to the bitaxe - FOSS || GTFO!");

    if (!esp_psram_is_initialized()) {
        ESP_LOGE(TAG, "No PSRAM available on ESP32 device!");
        GLOBAL_STATE.psram_is_available = false;
    } else {
        GLOBAL_STATE.psram_is_available = true;
    }

    // Init I2C
    ESP_ERROR_CHECK(i2c_bitaxe_init());
    ESP_LOGI(TAG, "I2C initialized successfully");
    
    // Initialize RST pin to low early to minimize ASIC power consumption
    ESP_ERROR_CHECK(asic_hold_reset_low());
    ESP_LOGI(TAG, "RST pin initialized to low");

    //wait for I2C to init
    vTaskDelay(100 / portTICK_PERIOD_MS);

    //Init ADC
    ADC_init();

    //initialize the ESP32 NVS
    if (nvs_config_init() != ESP_OK){
        ESP_LOGE(TAG, "Failed to init NVS");
        return;
    }

    if (device_config_init(&GLOBAL_STATE) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init device config");
        return;
    }

    if (self_test(&GLOBAL_STATE)) return;

    SYSTEM_init_system(&GLOBAL_STATE);

    // Initialize network infrastructure ONCE before any interface init
    network_infrastructure_init();

    // Read network mode to determine which interface to initialize
    char *network_mode_str = nvs_config_get_string(NVS_CONFIG_NETWORK_MODE);
    bool use_ethernet = (strcmp(network_mode_str, "ethernet") == 0);
    free(network_mode_str);

    if (use_ethernet) {
        ESP_LOGI(TAG, "Network mode: Ethernet - Initializing...");
        // Try to init Ethernet
        ethernet_init(&GLOBAL_STATE);
        ESP_LOGI(TAG, "DEBUG: After ethernet_init, eth_available = %d", GLOBAL_STATE.ETHERNET_MODULE.eth_available);

        // Wait for Ethernet to get IP and update is_connected flag
        if (GLOBAL_STATE.ETHERNET_MODULE.eth_available) {
            ESP_LOGI(TAG, "Waiting for Ethernet IP address...");
            int retry_count = 0;
            while (retry_count < 100) {  // Wait up to 10 seconds
                ethernet_update_status(&GLOBAL_STATE);
                if (GLOBAL_STATE.SYSTEM_MODULE.is_connected) {
                    ESP_LOGI(TAG, "Ethernet connected with IP: %s", GLOBAL_STATE.ETHERNET_MODULE.eth_ip_addr_str);
                    break;
                }
                vTaskDelay(100 / portTICK_PERIOD_MS);
                retry_count++;
            }
            if (!GLOBAL_STATE.SYSTEM_MODULE.is_connected) {
                ESP_LOGW(TAG, "Ethernet timeout, falling back to WiFi");
                wifi_init(&GLOBAL_STATE);
            }
        } else {
            ESP_LOGW(TAG, "Ethernet unavailable, initializing WiFi fallback");
            wifi_init(&GLOBAL_STATE);
        }
    } else {
        ESP_LOGI(TAG, "Network mode: WiFi");
        // init AP and connect to wifi
        wifi_init(&GLOBAL_STATE);
        // init Ethernet detection (but not full init)
        ethernet_init(&GLOBAL_STATE);
        ESP_LOGI(TAG, "DEBUG: After ethernet_init, eth_available = %d", GLOBAL_STATE.ETHERNET_MODULE.eth_available);
    }

    if (SYSTEM_init_peripherals(&GLOBAL_STATE) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init peripherals");
        return;
    }

    if (xTaskCreate(POWER_MANAGEMENT_task, "power management", 8192, (void *) &GLOBAL_STATE, 10, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating power management task");
    }

    //start the API for AxeOS
    start_rest_server((void *) &GLOBAL_STATE);

    // Initialize BAP interface if enabled in config
    #ifdef CONFIG_ENABLE_BAP
        esp_err_t bap_ret = BAP_init(&GLOBAL_STATE);
        if (bap_ret != ESP_OK) {
            ESP_LOGE(TAG, "Failed to initialize BAP interface: %d", bap_ret);
            // Continue anyway, as BAP is not critical for core functionality
        }
    #endif

    while (!GLOBAL_STATE.SYSTEM_MODULE.is_connected) {
        vTaskDelay(100 / portTICK_PERIOD_MS);
    }

    queue_init(&GLOBAL_STATE.stratum_queue);
    queue_init(&GLOBAL_STATE.ASIC_jobs_queue);

    if (asic_initialize(&GLOBAL_STATE, ASIC_INIT_COLD_BOOT, 0) == 0) {
        return;
    }

    if (xTaskCreate(stratum_task, "stratum admin", 8192, (void *) &GLOBAL_STATE, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating stratum admin task");
    }
    if (xTaskCreate(create_jobs_task, "stratum miner", 8192, (void *) &GLOBAL_STATE, 10, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating stratum miner task");
    }
    if (xTaskCreate(ASIC_task, "asic", 8192, (void *) &GLOBAL_STATE, 10, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating asic task");
    }
    if (xTaskCreate(ASIC_result_task, "asic result", 8192, (void *) &GLOBAL_STATE, 15, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Error creating asic result task");
    }
    if (xTaskCreateWithCaps(hashrate_monitor_task, "hashrate monitor", 8192, (void *) &GLOBAL_STATE, 5, NULL, MALLOC_CAP_SPIRAM) != pdPASS) {
        ESP_LOGE(TAG, "Error creating hashrate monitor task");
    }
    if (xTaskCreateWithCaps(statistics_task, "statistics", 8192, (void *) &GLOBAL_STATE, 3, NULL, MALLOC_CAP_SPIRAM) != pdPASS) {
        ESP_LOGE(TAG, "Error creating statistics task");
    }
}
