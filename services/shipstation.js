import axios from 'axios';
import rateLimit from 'axios-rate-limit';
import { loadSyncTime, saveSyncTime } from '../utils/sync-management.js';
import { groupOrders } from '../utils/order-grouping.js';
import { mapWhatnotToShipStation } from '../utils/mapping.js';

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * ShipStation API service
 */
class ShipStationService {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.SHIPSTATION_API_KEY;
    this.apiSecret = config.apiSecret || process.env.SHIPSTATION_API_SECRET;
    this.baseUrl = 'https://ssapi.shipstation.com';
    this.maxRetries = config.maxRetries || 3;

    if (!this.apiKey || !this.apiSecret) {
      throw new Error('ShipStation API credentials are required');
    }

    const auth = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');

    // Create base axios instance
    const baseClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    // Apply rate limiting
    this.client = rateLimit(baseClient, {
      maxRequests: 40,
      perMilliseconds: 60000,
      maxRPS: 0.66
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      async error => {
        if (error.response?.status === 401) {
          throw new Error('Invalid ShipStation API credentials');
        }
        if (error.response?.status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after'] || '60');
          throw new Error(`Rate limit exceeded. Retry after ${retryAfter} seconds`);
        }
        throw error;
      }
    );
  }

  async executeRequest(operation) {
    let retries = 0;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (error.response?.status === 429 && retries < this.maxRetries) {
          retries++;
          const retryAfter = parseInt(error.response.headers['retry-after'] || '60');
          console.warn(`Rate limit hit, retrying in ${retryAfter} seconds (attempt ${retries}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Create orders in ShipStation from Whatnot orders
   * @param {Array} whatnotOrders - Array of Whatnot orders
   * @param {string} whatnotToken - Whatnot API token
   * @param {string|number} storeId - ShipStation store ID
   * @param {Function} [progressCallback] - Optional callback for reporting progress
   * @returns {Object} Results of order creation
   */
  async createOrders(whatnotOrders, whatnotToken, storeId, progressCallback = null) {
    if (!Array.isArray(whatnotOrders) || whatnotOrders.length === 0) {
      throw new Error('whatnotOrders must be a non-empty array');
    }
    if (!storeId) {
      throw new Error('storeId is required');
    }

    const results = {
      successful: [],
      failed: []
    };

    const groupedOrders = groupOrders(whatnotOrders);
    const groupedCount = groupedOrders.length;
    console.log(`Grouped ${whatnotOrders.length} orders into ${groupedCount} combined orders`);
  
    // Initial call to progressCallback with the actual grouped count
    if (progressCallback && typeof progressCallback === 'function') {
      progressCallback({
        created: 0,
        total: groupedCount,
        failed: 0,
        groupedCount: groupedCount // This is the key to accurate progress tracking
      });
    }

    for (let i = 0; i < groupedOrders.length; i++) {
      const orderGroup = groupedOrders[i];
      try {
        const mappedOrder = mapWhatnotToShipStation(orderGroup);
        mappedOrder.advancedOptions.storeId = storeId;

        const response = await this.executeRequest(() =>
          this.client.post('/orders/createorder', mappedOrder)
        );
        console.log(`Created order ${response.data.orderNumber} for stream ${orderGroup.streamId}`);
        results.successful.push({
          whatnotIds: orderGroup.orders.map(o => o.id),
          shipstationId: response.data.orderId,
          orderNumber: response.data.orderNumber,
          streamId: orderGroup.streamId
        });
        
        // Call progress callback if provided
        if (progressCallback && typeof progressCallback === 'function') {
          progressCallback({
            created: results.successful.length,
            total: groupedCount,
            failed: results.failed.length,
            groupedCount: groupedCount
          });
        }
      } catch (error) {
        const errorDetails = error.response?.data || error.message;
        console.error('ShipStation API error:', {
          operation: 'createOrder',
          orderGroup: {
            streamId: orderGroup.streamId,
            orderCount: orderGroup.orders.length,
            whatnotIds: orderGroup.orders.map(o => o.id)
          },
          error: errorDetails
        });

        results.failed.push({
          whatnotIds: orderGroup.orders.map(o => o.id),
          streamId: orderGroup.streamId,
          error: errorDetails
        });
        
        // Call progress callback on failures too
        if (progressCallback && typeof progressCallback === 'function') {
          progressCallback({
            created: results.successful.length,
            total: groupedCount,
            failed: results.failed.length,
            groupedCount: groupedCount
          });
        }
      }
    }

    return results;
  }

  /**
   * Get a list of active users from ShipStation
   * @returns {Promise<Array>} List of ShipStation users
   */
  async getUsers() {
    try {
      console.log('Fetching active ShipStation users...');
      const response = await this.executeRequest(() =>
        this.client.get('/users?showInactive=false')
      );
      console.log(`Fetched ${response.data.length} active users.`);
      return response.data; // Assuming the response is an array of users
    } catch (error) {
      console.error('Error fetching ShipStation users:', {
        operation: 'getUsers',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get shipments within a date range, including items (across all stores)
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} timezone - Timezone for date range (default: UTC)
   * @returns {Promise<Array>} Array of shipment objects
   */
  async getShipmentsByDateRange(startDate, endDate, timezone = 'UTC') {
    if (!startDate || !endDate) {
      throw new Error("startDate and endDate are required");
    }

    try {
      // Ensure timezone is valid, default to UTC if not or invalid
      let effectiveTimezone = 'UTC';
      try {
        // Attempt a conversion to validate the timezone string
        fromZonedTime(new Date(), timezone); 
        effectiveTimezone = timezone;
      } catch (e) {
        console.warn(`Invalid timezone provided: "${timezone}". Defaulting to UTC. Error: ${e.message}`);
        effectiveTimezone = 'UTC';
      }

      // Calculate UTC start and end times based on the provided timezone's day boundaries
      const startOfDayLocal = new Date(`${startDate}T00:00:00`);
      const endOfDayLocal = new Date(`${endDate}T23:59:59.999`);

      const utcStart = fromZonedTime(startOfDayLocal, effectiveTimezone);
      const utcEnd = fromZonedTime(endOfDayLocal, effectiveTimezone);

      // Format for ShipStation API (YYYY-MM-DD HH:MM:SS)
      const shipstationStartDate = formatInTimeZone(utcStart, 'UTC', 'yyyy-MM-dd HH:mm:ss');
      const shipstationEndDate = formatInTimeZone(utcEnd, 'UTC', 'yyyy-MM-dd HH:mm:ss');

      console.log(`Fetching ShipStation shipments from ${shipstationStartDate} to ${shipstationEndDate} UTC (Based on ${effectiveTimezone} timezone for dates ${startDate} to ${endDate})`);

      const shipmentParams = new URLSearchParams({
        createDateStart: shipstationStartDate,
        createDateEnd: shipstationEndDate,
        includeShipmentItems: 'true',
        pageSize: '500',
      });

      let allShipments = [];
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        shipmentParams.set('page', page.toString());

        const response = await this.executeRequest(() =>
          this.client.get(`/shipments?${shipmentParams.toString()}`)
        );

        const { shipments, pages } = response.data;

        if (!shipments || shipments.length === 0) {
          break;
        }

        console.log(`Fetched page ${page}/${pages} with ${shipments.length} shipments`);
        allShipments.push(...shipments);

        hasMorePages = page < pages;
        page++;
      }

      console.log(`Found a total of ${allShipments.length} shipments across all stores.`);
      return allShipments;

    } catch (error) {
      console.error('Error fetching shipments by date range:', {
        operation: 'getShipmentsByDateRange',
        dateRange: { startDate, endDate },
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get shipped orders with tracking information
   * @param {string|number} storeId - ShipStation store ID
   * @param {Object} options - Options for fetching
   * @param {string} [options.startDate] - Start date (YYYY-MM-DD)
   * @param {string} [options.endDate] - End date (YYYY-MM-DD)
   * @returns {Object} Shipped orders with tracking information
   */
  async getShippedOrdersWithTracking(storeId, { startDate, endDate } = {}) {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 7);
    startDate = startDate || yesterday.toISOString().split('T')[0];
    endDate = endDate || today.toISOString().split('T')[0];

    try {
      const shipmentParams = new URLSearchParams({
        storeId: storeId.toString(),
        createDateStart: `${startDate} 00:00:00`,
        createDateEnd: `${endDate} 23:59:59`,
        includeShipmentItems: 'true',
        pageSize: '500'
      });

      let results = [];
      let page = 1;
      let hasMorePages = true;

      console.log('Fetching shipments with tracking information...');

      while (hasMorePages) {
        shipmentParams.set('page', page.toString());

        const response = await this.executeRequest(() =>
          this.client.get(`/shipments?${shipmentParams.toString()}`)
        );

        const { shipments, pages } = response.data;

        if (!shipments || shipments.length === 0) {
          break;
        }

        console.log(`Processing shipments page ${page} with ${shipments.length} shipments`);

        // Process each shipment
        for (const shipment of shipments) {
          if (shipment.voided || !shipment.trackingNumber) {
            continue;
          }

          // Get Whatnot order IDs from shipment items' SKUs
          const whatnotOrderIds = shipment.shipmentItems
            ?.map(item => item.sku)
            .filter(Boolean);

          if (whatnotOrderIds?.length > 0) {
            results.push({
              shipmentId: shipment.shipmentId,
              orderId: shipment.orderId,
              orderNumber: shipment.orderNumber,
              trackingNumber: shipment.trackingNumber,
              carrierCode: shipment.carrierCode,
              createDate: shipment.createDate,
              shipDate: shipment.shipDate,
              whatnotOrderIds
            });
          }
        }

        hasMorePages = page < pages;
        page++;
      }

      console.log(`Found ${results.length} shipments with Whatnot order IDs`);

      return {
        orders: results,
        total: results.length
      };

    } catch (error) {
      console.error('Error fetching shipments with tracking:', {
        operation: 'getShippedOrdersWithTracking',
        storeId,
        dateRange: { startDate, endDate },
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get or update the last sync time for a store
   * @param {string|number} storeId - ShipStation store ID
   * @returns {Promise<string>} ISO timestamp of the last sync time
   */
  async getLastSyncTime(storeId) {
    return loadSyncTime(storeId);
  }

  /**
   * Save the last sync time for a store
   * @param {string|number} storeId - ShipStation store ID
   * @param {string} lastSyncTime - ISO timestamp of the last sync time
   */
  async saveLastSyncTime(storeId, lastSyncTime) {
    return saveSyncTime(storeId, lastSyncTime);
  }
}

export default ShipStationService;