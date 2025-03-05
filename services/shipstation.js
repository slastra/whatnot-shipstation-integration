import axios from 'axios';
import rateLimit from 'axios-rate-limit';
import { loadSyncTime, saveSyncTime } from '../utils/sync-management.js';
import { groupOrders } from '../utils/order-grouping.js';
import { mapWhatnotToShipStation } from '../utils/mapping.js';

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
              carrierCode: shipment.carrierCode.toUpperCase() === 'UPS' ? 'UPS' : 'USPS',
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