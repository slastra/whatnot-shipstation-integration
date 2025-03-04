class OrderValidator {
  constructor() {
    // No need for REZ API client anymore
  }

  async validateOrder(order) {
    const errors = [];

    // Check if order is cancelled
    if (order.cancelledAt) {
      errors.push('Order is cancelled');
    }

    // Check if order already has tracking
    if (order.trackingInfo?.trackingCode) {
      errors.push('Order already has tracking code');
    }

    // Check order status - we only want PROCESSING orders
    if (order.status !== 'PROCESSING') {
      errors.push(`Invalid order status: ${order.status || 'unknown'} (expected PROCESSING)`);
    }

    // Check if order has items
    if (!order.items?.edges || order.items.edges.length === 0) {
      errors.push('Order has no items');
      return errors; // No need to check further if there are no items
    }

    // Check pickup flag and SKUs on all items
    for (const edge of order.items.edges) {
      // Skip validation for pickup items
      if (edge.node.isPickup) {
        errors.push('Order contains pickup items which should be fulfilled in person');
        continue;
      }

      // Ensure item has a SKU
      const sku = edge.node.variant?.sku;
      if (!sku) {
        errors.push(`Missing SKU for item ${edge.node.id || 'unknown'}`);
      }
    }

    return errors;
  }

  async validateOrders(orders) {
    const validationResults = {
      valid: [],
      invalid: []
    };

    // Validate each order individually
    for (const order of orders) {
      const errors = await this.validateOrder(order);

      if (errors.length === 0) {
        validationResults.valid.push(order);
      } else {
        validationResults.invalid.push({
          order,
          errors
        });
      }
    }

    console.log(`Validation complete: ${validationResults.valid.length} valid orders, ${validationResults.invalid.length} invalid orders`);
    return validationResults;
  }
}

export default OrderValidator;
