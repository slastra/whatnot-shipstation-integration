export const ADD_TRACKING_CODE = `
  mutation AddTracking($input: AddTrackingCodeInput!) {
    addTrackingCode(input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`;
