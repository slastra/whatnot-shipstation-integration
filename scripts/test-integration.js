import ShipStationService from '../services/shipstation.js';
import WhatnotService from '../services/whatnot.js';
import OrderValidator from '../utils/validation.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load account configuration from accounts.json
 */
async function loadAccounts() {
  try {
    const accountsPath = join(__dirname, '../accounts.json');
    const data = await readFile(accountsPath, 'utf-8');
    return JSON.parse(data).accounts;
  } catch (error) {
    console.error('Error loading accounts:', error);
    throw error;
  }
}

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate() {
  const today = new Date();
  return today.toISOString().split('T')[0];
}

/**
 * Test the ShipStation integration by fetching today's shipments
 */
async function testShipStation(account) {
  console.log('\n----- TESTING SHIPSTATION INTEGRATION -----');
  
  try {
    const shipstation = new ShipStationService();
    const today = getTodayDate();
    
    console.log(`Fetching shipments for ${account.name} (Store ID: ${account.shipstationStoreId}) from ${today}`);
    
    const { orders, total } = await shipstation.getShippedOrdersWithTracking(
      account.shipstationStoreId, 
      { startDate: today, endDate: today }
    );
    
    console.log(`Found ${total} shipments for today`);
    
    if (orders.length > 0) {
      console.log('\nSample shipment:');
      console.log(JSON.stringify(orders[0], null, 2));
    }
    
    return orders;
  } catch (error) {
    console.error('ShipStation test failed:', error);
    throw error;
  }
}

/**
 * Test the Whatnot integration by fetching recent orders
 */
async function testWhatnot(account) {
  console.log('\n----- TESTING WHATNOT INTEGRATION -----');
  
  try {
    // Set start time to 24 hours ago
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const startAt = yesterday.toISOString();
    
    console.log(`Fetching Whatnot orders for ${account.name} from ${startAt}`);
    
    const whatnot = new WhatnotService(account.name, account.whatnotToken, startAt);
    const orders = await whatnot.getOrders();
    
    console.log(`Found ${orders.length} Whatnot orders`);
    
    if (orders.length > 0) {
      console.log('\nSample order:');
      // Print a subset of the order to avoid huge output
      const sampleOrder = orders[0];
      console.log(JSON.stringify({
        id: sampleOrder.id,
        status: sampleOrder.status,
        createdAt: sampleOrder.createdAt,
        customerUsername: sampleOrder.customer?.username,
        itemCount: sampleOrder.items?.edges?.length || 0
      }, null, 2));
    }
    
    return orders;
  } catch (error) {
    console.error('Whatnot test failed:', error);
    throw error;
  }
}

/**
 * Test order validation
 */
async function testValidation(orders) {
  console.log('\n----- TESTING ORDER VALIDATION -----');
  
  try {
    const validator = new OrderValidator();
    console.log(`Validating ${orders.length} orders`);
    
    const { valid, invalid } = await validator.validateOrders(orders);
    
    console.log(`Validation results: ${valid.length} valid, ${invalid.length} invalid`);
    
    if (invalid.length > 0) {
      console.log('\nSample validation errors:');
      for (let i = 0; i < Math.min(3, invalid.length); i++) {
        console.log(`- Order ${invalid[i].order.id}: ${invalid[i].errors.join(', ')}`);
      }
    }
    
    return { valid, invalid };
  } catch (error) {
    console.error('Validation test failed:', error);
    throw error;
  }
}

/**
 * Main test function
 */
async function runTests() {
  console.log('Starting integration tests...');
  
  try {
    const accounts = await loadAccounts();
    
    // Filter to just use the first enabled account for testing
    const testAccount = accounts.find(account => account.enabled);
    
    if (!testAccount) {
      console.error('No enabled accounts found. Please check your accounts.json file.');
      return;
    }
    
    console.log(`Using account: ${testAccount.name}`);
    
    // Test ShipStation integration
    const shipments = await testShipStation(testAccount);
    
    // Test Whatnot integration
    const orders = await testWhatnot(testAccount);
    
    // Test order validation
    if (orders.length > 0) {
      const validationResults = await testValidation(orders);
    }
    
    console.log('\n----- INTEGRATION TESTS COMPLETED SUCCESSFULLY -----');
  } catch (error) {
    console.error('\n----- INTEGRATION TESTS FAILED -----');
    console.error(error);
    process.exit(1);
  }
}

// Run the tests
runTests().catch(console.error);