export const GET_ORDERS = `
  query($first: Int, $after: String, $filter: OrderFilterInput) {
    orders(
        first: $first
        after: $after
        sortKey: CREATED_AT
        filter: $filter
    ) {
        edges {
            __typename
            cursor
            node {
                id
                createdAt
                cancelledAt
                status
                customer {
                    id
                    username
                    displayName
                    countryCode
                }
                isGiveaway
                shippingAddress {
                    __typename
                    fullName
                    line1
                    line2
                    city
                    state
                    postalCode
                    phoneNumber
                    countryCode
                }
                subtotal {
                    amount
                    currencyCode
                }
                shippingPrice {
                    amount
                    currencyCode
                }
                taxation {
                    amount
                    currencyCode
                }
                total {
                    amount
                    currencyCode
                }
                salesChannel {
                    type
                    reference
                }
                trackingInfo {
                    trackingCode
                    courier
                }
                shippingPrice {
                    amount
                }
                items(first: 50) {
                    edges {
                        node {
                            id
                            isPickup
                            variant {
                                sku
                                options {
                                    name
                                    value
                                }
                            }
                            price {
                                amount
                            }
                            product {
                                title
                                externalId
                            }
                            quantity
                        }
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }
        }
        pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
        }
    }
  }
`;

export const GET_ORDER_ITEMS = `
  query GetOrderItems($orderId: ID!, $first: Int!, $after: String) {
    order(id: $orderId) {
        items(first: $first, after: $after) {
            edges {
                node {
                    id
                    price {
                        amount
                    }
                    product {
                        title
                    }
                    quantity
                    isPickup
                    variant {
                        sku
                    }
                }
            }
            pageInfo {
                hasNextPage
                endCursor
            }
        }
    }
  }
`;
