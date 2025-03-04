import axios from 'axios';

/**
 * Creates a configured GraphQL client for Whatnot API
 * @param {string} token - Whatnot API token 
 * @returns {Object} GraphQL client object
 */
export function createWhatnotClient(token) {
  if (!token) {
    throw new Error('Whatnot API token is required');
  }

  return axios.create({
    baseURL: 'https://api.whatnot.com/seller-api/graphql',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Executes a GraphQL query against the Whatnot API
 * @param {Object} client - Axios client for Whatnot
 * @param {string} query - GraphQL query or mutation
 * @param {Object} variables - Variables for the query
 * @returns {Promise<Object>} Query result data
 */
export async function executeQuery(client, query, variables = {}) {
  try {
    const response = await client.post('', {
      query,
      variables
    });

    if (response.data.errors) {
      const error = new Error(response.data.errors[0].message);
      error.graphQLErrors = response.data.errors;
      throw error;
    }

    return response.data.data;
  } catch (error) {
    // Add more context to the error
    if (error.graphQLErrors) {
      console.error('GraphQL errors:', error.graphQLErrors);
    } else if (error.response) {
      console.error('GraphQL API error:', error.response.status, error.response.statusText);
    } else {
      console.error('GraphQL request failed:', error.message);
    }
    throw error;
  }
}