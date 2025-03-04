/**
 * Formats a timestamp into a stream ID in the format "YYMMDD-HHa/p"
 * @param {string|Date} timestamp - Timestamp to format
 * @returns {string} Formatted stream ID
 */
export function formatStreamId(timestamp) {
    const date = new Date(timestamp);
    const yy = date.getFullYear().toString().slice(-2);
    const mm = (date.getMonth() + 1).toString().padStart(2, '0');
    const dd = date.getDate().toString().padStart(2, '0');
    const hour = date.getHours();
    const hour12 = hour % 12 || 12;
    const ampm = hour < 12 ? 'a' : 'p';
    return `${yy}${mm}${dd}-${hour12.toString().padStart(2, '0')}${ampm}`;
  }
  
  /**
   * Converts cents to dollars with 2 decimal places
   * @param {number} cents - Amount in cents
   * @returns {string} Amount in dollars formatted with 2 decimal places
   */
  export function centsToDollars(cents) {
    return (cents / 100).toFixed(2);
  }
  
  /**
   * Formats cents as a USD currency string
   * @param {number} cents - Amount in cents
   * @returns {string} Formatted currency string (e.g., "$10.99")
   */
  export function formatUSD(cents) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(cents / 100);
  }