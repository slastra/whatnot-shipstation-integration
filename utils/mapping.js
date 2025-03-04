import { centsToDollars, formatUSD } from './formatting.js';

/**
 * Maps a Whatnot order group to ShipStation order format
 * @param {Object} orderGroup - Group of Whatnot orders to map
 * @returns {Object} Order data in ShipStation format
 */
export function mapWhatnotToShipStation(orderGroup) {
  if (!orderGroup?.orders?.length) {
    throw new Error('No orders provided');
  }

  const { streamId, orders } = orderGroup;
  const firstOrder = orders[0];

  let totalAmount = 0;
  let totalShipping = 0;
  let totalTax = 0;

  const items = orders.flatMap(order => {
    totalAmount += order.total.amount;
    totalShipping += order.shippingPrice.amount;
    totalTax += order.taxation.amount;

    return order.items.edges.map(edge => ({
      sku: order.id,
      lineItemKey: `${order.id}-${edge.node.id}`,
      name: edge.node.product?.title || 'Whatnot Item',
      quantity: edge.node.quantity,
      unitPrice: centsToDollars(edge.node.price.amount),
      productId: edge.node.product?.id || null,
    }));
  });

  const orderKey = `wn-${streamId}-${firstOrder.customer.username}_`

  return {
    orderNumber: orderKey,
    orderKey,
    orderDate: firstOrder.createdAt,
    orderStatus: 'awaiting_shipment',
    customerUsername: firstOrder.customer.username,

    billTo: {
      name: firstOrder.shippingAddress.fullName,
      street1: firstOrder.shippingAddress.line1,
      street2: firstOrder.shippingAddress.line2,
      city: firstOrder.shippingAddress.city,
      state: firstOrder.shippingAddress.state,
      postalCode: firstOrder.shippingAddress.postalCode,
      country: firstOrder.shippingAddress.countryCode,
      phone: firstOrder.shippingAddress.phoneNumber,
      residential: true
    },

    shipTo: {
      name: firstOrder.shippingAddress.fullName,
      street1: firstOrder.shippingAddress.line1,
      street2: firstOrder.shippingAddress.line2,
      city: firstOrder.shippingAddress.city,
      state: firstOrder.shippingAddress.state,
      postalCode: firstOrder.shippingAddress.postalCode,
      country: firstOrder.shippingAddress.countryCode,
      phone: firstOrder.shippingAddress.phoneNumber,
      residential: true
    },

    items,

    amountPaid: centsToDollars(totalAmount),
    taxAmount: centsToDollars(totalTax),
    shippingAmount: centsToDollars(totalShipping),

    gift: false,
    paymentMethod: 'Other',
    requestedShippingService: firstOrder.trackingInfo?.courier?.toUpperCase() || null,
    internalNotes: orders.map(order => order.id).join(','),
    advancedOptions: {
      storeId: null,
      customField1: streamId,
      customField2: formatUSD(totalShipping),
      source: 'Whatnot',
      mergedOrSplit: orders.length > 1
    }
  };
}