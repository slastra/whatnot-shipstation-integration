import { GET_ORDERS, GET_ORDER_ITEMS } from '../graphql/orders.js';
import { ADD_TRACKING_CODE } from '../graphql/tracking.js';
import { loadCursor, saveCursor } from '../utils/cursor-management.js';
import { createWhatnotClient, executeQuery } from '../utils/graphql-client.js';

class WhatnotService {
    constructor(accountId, token, startAt = null) {
        if (!token) {
            throw new Error('Whatnot API token is required');
        }
        if (!accountId) {
            throw new Error('Account ID is required');
        }
        
        this.apiKey = token;
        this.accountId = accountId;
        this.startAt = startAt;
        this.client = createWhatnotClient(token);

        // Only check for WHATNOT_INITIAL_SYNC_DATE if startAt is not provided
        if (!this.startAt) {
            this.initialSyncDate = process.env.WHATNOT_INITIAL_SYNC_DATE;
            if (!this.initialSyncDate) {
                throw new Error('WHATNOT_INITIAL_SYNC_DATE must be set in environment variables when startAt is not provided');
            }
        }
    }

    /**
     * Execute a GraphQL query or mutation
     * @param {string} query - GraphQL query string
     * @param {Object} variables - Variables for the query
     * @returns {Promise<Object>} Query result data
     */
    async executeQuery(query, variables = {}) {
        return executeQuery(this.client, query, variables);
    }

    /**
     * Fetch all items for a specific order
     * @param {string} orderId - ID of the order
     * @returns {Promise<Array>} Array of order items
     */
    async getAllOrderItems(orderId) {
        const items = [];
        let hasNextPage = true;
        let afterCursor = null;
        const ITEMS_BATCH_SIZE = 50;

        try {
            while (hasNextPage) {
                const variables = {
                    orderId,
                    first: ITEMS_BATCH_SIZE,
                    after: afterCursor
                };

                const data = await this.executeQuery(GET_ORDER_ITEMS, variables);
                const { edges, pageInfo } = data.order.items;

                if (!edges || edges.length === 0) {
                    break;
                }

                items.push(...edges.map(edge => edge.node));
                hasNextPage = pageInfo.hasNextPage;
                afterCursor = pageInfo.endCursor;
            }

            return items;
        } catch (error) {
            console.error(`Error fetching items for order ${orderId}:`, error);
            throw error;
        }
    }

    /**
     * Fetch orders from Whatnot API with pagination
     * @returns {Promise<Array>} Array of orders
     */
    async getOrders() {
        const BATCH_SIZE = 50;
        let cursor = await loadCursor(this.accountId);

        if (!cursor) {
            const startDate = this.startAt || this.initialSyncDate;
            console.log(`No cursor found for account ${this.accountId}. Starting from date: ${startDate}`);
        } else {
            console.log(`Resuming sync for account ${this.accountId} from cursor: ${cursor}`);
        }

        const orders = [];
        let hasNextPage = true;
        let afterCursor = cursor;

        try {
            while (hasNextPage) {
                const variables = {
                    first: BATCH_SIZE,
                    after: afterCursor,
                    filter: {
                        createdAt: {
                            gt: this.startAt || this.initialSyncDate
                        }
                    }
                };

                console.log(`Fetching batch of ${BATCH_SIZE} orders ${afterCursor ? 'after cursor: ' + afterCursor : `from date: ${variables.filter.createdAt.gt}`}`);

                const data = await this.executeQuery(GET_ORDERS, variables);
                const { edges, pageInfo } = data.orders;

                if (!edges || edges.length === 0) {
                    console.log('No more orders found');
                    break;
                }

                orders.push(...edges.map(edge => edge.node));
                console.log(`Fetched ${edges.length} orders. Total orders: ${orders.length}`);

                hasNextPage = pageInfo.hasNextPage;
                afterCursor = pageInfo.endCursor;

                await saveCursor(this.accountId, afterCursor);

                if (hasNextPage) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        } catch (error) {
            console.error('Error fetching orders:', error);
            throw error;
        }

        return orders;
    }

    /**
     * Add tracking code to order(s)
     * @param {Array<string>} orderIds - Array of order IDs
     * @param {string} trackingCode - Tracking code
     * @param {string} courier - Courier name (e.g., "usps", "ups")
     * @returns {Promise<Object>} Result of the mutation
     */
    async addTrackingCode(orderIds, trackingCode, courier) {
        const variables = {
            input: {
                orderIds,
                trackingCode,
                courier
            }
        };

        const result = await this.executeQuery(ADD_TRACKING_CODE, variables);

        const userErrors = result.addTrackingCode.userErrors;
        if (userErrors && userErrors.length > 0) {
            const errorMessages = userErrors.map(error =>
                `${error.field.join('.')}: ${error.message}`
            ).join('; ');

            throw new Error(`Failed to add tracking code: ${errorMessages}`);
        }

        return result;
    }

    /**
     * Update tracking information for multiple orders
     * @param {Array<Object>} orders - Array of order objects
     * @param {string} trackingCode - Tracking code to add
     * @param {string} courier - Courier name
     * @returns {Promise<Object>} Results of the tracking updates
     */
    async updateOrdersTracking(orders, trackingCode, courier) {
        const results = {
            successful: [],
            failed: []
        };

        for (const order of orders) {
            try {
                const orderIds = order.originalOrderIds || [order.id];
                const result = await this.addTrackingCode(orderIds, trackingCode, courier);
                results.successful.push({
                    orderIds,
                    trackingCode,
                    courier,
                    success: true,
                    result
                });
            } catch (error) {
                results.failed.push({
                    orderIds: order.originalOrderIds || [order.id],
                    trackingCode,
                    courier,
                    success: false,
                    error: error.message
                });
            }
        }

        if (results.failed.length > 0) {
            console.error('Some tracking updates failed:', results.failed);
        }

        return results;
    }
}

export default WhatnotService;