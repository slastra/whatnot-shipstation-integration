# Whatnot ShipStation Integration Guidelines

## Commands
- `npm run sync` - Run order sync between Whatnot and ShipStation
- `npm run track` - Update tracking information
- `node scripts/test-integration.js` - Run integration tests

## Code Style Guidelines
- **Imports**: ES modules with .js extension (`import X from 'y.js'`), group by external/internal
- **Formatting**: 2-space indentation, semicolons required
- **Error Handling**: Use try/catch blocks with specific error messages
- **Documentation**: JSDoc comments for functions with @param and @returns
- **Classes**: Use ES6 class syntax with constructor parameter validation
- **Naming**: camelCase for variables/functions, PascalCase for classes
- **Async**: Use async/await pattern instead of raw promises

## Project Structure
- `services/` - API client services (Whatnot, ShipStation)
- `utils/` - Utility functions and helpers
- `graphql/` - GraphQL queries and mutations
- `scripts/` - Executable scripts for syncing and tracking

## Environment
This project requires Node.js v18+ and uses environment variables for configuration.