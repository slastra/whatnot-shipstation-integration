import { formatStreamId } from './formatting.js';

/**
 * Groups orders by stream reference and extracts stream information
 * @param {Array} orders - Array of Whatnot orders
 * @returns {Map} Map of stream references to stream information
 */
export function getStreamInfo(orders) {
  const streamGroups = new Map();

  // First, group orders by stream reference
  for (const order of orders) {
    if (order.cancelledAt) continue;

    const streamRef = order.salesChannel.reference;
    if (!streamRef) continue;

    if (!streamGroups.has(streamRef)) {
      streamGroups.set(streamRef, []);
    }
    streamGroups.get(streamRef).push(order);
  }

  // Then, create stream information objects
  const streamInfo = new Map();
  for (const [streamRef, streamOrders] of streamGroups) {
    const sortedOrders = streamOrders.sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt)
    );

    const firstOrder = sortedOrders[0];
    streamInfo.set(streamRef, {
      streamId: formatStreamId(firstOrder.createdAt),
      firstOrder,
      orders: sortedOrders
    });
  }

  return streamInfo;
}

/**
 * Groups orders by stream and customer for consolidation
 * @param {Array} orders - Array of Whatnot orders
 * @returns {Array} Array of order groups, each containing a streamId and orders array
 */
export function groupOrders(orders) {
  const streamInfo = getStreamInfo(orders);
  const groupedOrders = new Map();

  for (const order of orders) {
    if (order.cancelledAt) continue;

    const streamRef = order.salesChannel.reference;
    if (!streamRef || !streamInfo.has(streamRef)) continue;

    const { streamId } = streamInfo.get(streamRef);
    const key = `${streamId}:${order.customer.username}`;

    if (!groupedOrders.has(key)) {
      groupedOrders.set(key, {
        streamId,
        orders: []
      });
    }
    groupedOrders.get(key).orders.push(order);
  }

  return Array.from(groupedOrders.values());
}